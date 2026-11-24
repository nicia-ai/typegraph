/**
 * Transaction port-call budgets, run on every backend lane.
 *
 * Exact per-member counts of the calls a store makes on the transaction
 * port for four fixed scenarios: a schema-managed ten-write transaction, an
 * adopted capture loop, owned capture on an adapter store, and an
 * engine-native receipt transaction. A change to a fence lease, a lock memo
 * or which port members a write plan calls moves a count here before it
 * moves a benchmark.
 *
 * These are port-call budgets, not statement budgets: the count is taken at
 * the port, not the driver, because the suite runs against the lane's own
 * backend and only the port is observable without rebuilding it. The
 * statements a member issues internally (inside `insertNode`, `updateNode`,
 * `deleteNode`, ...) do not move a count here; `tests/write-shape-golden.test.ts`
 * owns those per dialect. Only `execute` calls carry their compiled statement,
 * which is how the graph-write lock statement is told apart.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type TransactionContext,
} from "../../../src";
import { RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE } from "../../../src/backend/advisory-lock-namespaces";
import type { EngineRecordedTimeMembers } from "../../../src/backend/capabilities/recorded-time";
import { generateVectorlessPostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createSqlBackend } from "../../../src/backend/drizzle/engine";
import { buildPostgresEngineProfile } from "../../../src/backend/drizzle/postgres";
import type {
  AdapterBackend,
  EngineRevision,
  TransactionBackend,
} from "../../../src/backend/types";
import { isSqlFragment, sql } from "../../../src/query/sql-fragment";
import { attachEngineNativeRecordedTime } from "../../engine-native-recorded-time-fixture";
import type { IntegrationTestContext } from "./test-context";

/** One call a store made on a transaction-scoped backend port. */
export type PortCall = Readonly<{
  member: string;
  /** Compiled SQL text and binds, for `execute` calls only. */
  statement?: Readonly<{ sql: string; params: readonly unknown[] }>;
}>;

/**
 * Every call the store makes on the transaction-scoped backends it is handed
 * — through `transaction`, `transactionWithNative`, `adoptTransaction` or
 * `adoptSchemaWriteTransaction` — recorded at the port, in issue order. Each
 * schema-write adoption is itself recorded too, since it takes the exclusive
 * schema fence before returning the backend the evolving body writes through.
 *
 * Recorded IN PLACE with spies rather than through a derived wrapper: fence
 * leases, lock memos and write sessions are keyed on the exact transaction
 * object, so a counting wrapper would change the very path it measures. A
 * member that cannot be replaced in place (non-writable or non-configurable)
 * is left unrecorded.
 */
export type PortCallRecorder = Readonly<{
  calls: readonly PortCall[];
  /**
   * Whether a transaction the backend itself opened (`transaction` or
   * `transactionWithNative`) has not settled yet, i.e. has neither committed
   * nor rolled back.
   */
  backendTransactionOpen: () => boolean;
  restore: () => void;
}>;

export function recordTransactionPortCalls(
  backend: AdapterBackend<unknown>,
): PortCallRecorder {
  const calls: PortCall[] = [];
  const spies: { mockRestore: () => void }[] = [];
  const compile = backend.compileSql;
  const instrumented = new WeakSet<object>();
  let openBackendTransactions = 0;

  function spyOnMember(
    owner: object,
    member: string,
    toCall: (args: readonly unknown[]) => PortCall,
  ): void {
    const descriptor = Object.getOwnPropertyDescriptor(owner, member);
    if (
      descriptor?.configurable !== true ||
      descriptor.writable !== true ||
      typeof descriptor.value !== "function"
    ) {
      return;
    }
    const original: unknown = descriptor.value;
    const invoke = original as (...args: unknown[]) => unknown;
    spies.push(
      vi
        .spyOn(owner as Record<string, (...args: unknown[]) => unknown>, member)
        .mockImplementation((...args: unknown[]) => {
          calls.push(toCall(args));
          return invoke(...args);
        }),
    );
  }

  function instrument<T extends TransactionBackend>(tx: T): T {
    if (instrumented.has(tx)) return tx;
    instrumented.add(tx);
    for (const member of Object.keys(tx)) {
      spyOnMember(tx, member, ([query]) =>
        member === "execute" && compile !== undefined && isSqlFragment(query) ?
          { member, statement: compile(query) }
        : { member },
      );
    }
    spyOnMember(tx.commands, "execute", ([command]) => ({
      member: `commands.execute:${(command as Readonly<{ kind: string }>).kind}`,
    }));
    return tx;
  }

  async function whileOpen<T>(open: () => Promise<T>): Promise<T> {
    openBackendTransactions += 1;
    try {
      return await open();
    } finally {
      openBackendTransactions -= 1;
    }
  }

  const transaction = backend.transaction;
  spies.push(
    vi
      .spyOn(backend, "transaction")
      .mockImplementation((fn, options) =>
        whileOpen(() => transaction((tx) => fn(instrument(tx)), options)),
      ),
  );
  const transactionWithNative = backend.transactionWithNative;
  spies.push(
    vi
      .spyOn(backend, "transactionWithNative")
      .mockImplementation((fn, options) =>
        whileOpen(() =>
          transactionWithNative(
            (tx, native) => fn(instrument(tx), native),
            options,
          ),
        ),
      ),
  );
  const adoptTransaction = backend.adoptTransaction;
  spies.push(
    vi
      .spyOn(backend, "adoptTransaction")
      .mockImplementation((native) => instrument(adoptTransaction(native))),
  );

  const adoptSchemaWriteTransaction = backend.adoptSchemaWriteTransaction;
  if (adoptSchemaWriteTransaction !== undefined) {
    spies.push(
      vi
        .spyOn(backend, "adoptSchemaWriteTransaction")
        .mockImplementation(async (native, graphId, options) => {
          calls.push({ member: "adoptSchemaWriteTransaction" });
          const adopted = await adoptSchemaWriteTransaction(
            native,
            graphId,
            options,
          );
          instrument(adopted.backend);
          return adopted;
        }),
    );
  }

  return {
    calls,
    backendTransactionOpen: () => openBackendTransactions > 0,
    restore: () => {
      for (const spy of spies.splice(0).toReversed()) spy.mockRestore();
    },
  };
}

/** Whether a recorded `execute` call is the portable graph-write-lock statement. */
function isGraphWriteLockStatement(call: PortCall): boolean {
  return (
    call.statement?.params.includes(
      RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE,
    ) ?? false
  );
}

/** A recorded call's budget key: its member, with the lock statement named. */
function budgetKey(call: PortCall): string {
  if (call.statement === undefined) return call.member;
  return isGraphWriteLockStatement(call) ?
      "execute:graph-write-lock"
    : "execute";
}

/** The recorded calls as per-key counts, keys sorted so a diff reads stably. */
function portCallBudget(
  calls: readonly PortCall[],
): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const key = budgetKey(call);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

const BudgetItem = defineNode("BudgetItem", {
  schema: z.object({ label: z.string() }),
});

function budgetGraph(id: string) {
  return defineGraph({
    id,
    nodes: { BudgetItem: { type: BudgetItem } },
    edges: {},
  });
}

type BudgetTransaction = TransactionContext<ReturnType<typeof budgetGraph>>;

/** Ten managed writes: four creates, three updates, three deletes. */
async function writeMixedTen(tx: BudgetTransaction): Promise<void> {
  const created = [];
  for (let index = 0; index < 4; index += 1) {
    created.push(await tx.nodes.BudgetItem.create({ label: `item-${index}` }));
  }
  for (const item of created.slice(0, 3)) {
    await tx.nodes.BudgetItem.update(item.id, { label: "updated" });
  }
  for (const item of created.slice(1)) {
    await tx.nodes.BudgetItem.delete(item.id);
  }
}

/** Ten managed creates. */
async function createTen(tx: BudgetTransaction): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await tx.nodes.BudgetItem.create({ label: `item-${index}` });
  }
}

type Budget = Readonly<Record<string, number>>;

/**
 * The budgets, per dialect. Every lane of one dialect shares a budget: the
 * port calls a store makes depend on the dialect's fence and command
 * profile, not on which driver carries the statements.
 */
const BUDGETS = {
  "schema-managed mixed ten-write transaction": {
    sqlite: {
      deleteNode: 3,
      findEdgesConnectedTo: 3,
      getNode: 6,
      insertNode: 3,
      insertNodeWithSchemaFence: 1,
      lockNodes: 3,
      updateNode: 3,
    },
    postgres: {
      deleteNode: 3,
      findEdgesConnectedTo: 3,
      getNode: 6,
      insertNode: 3,
      insertNodeWithSchemaFence: 1,
      lockNodes: 3,
      updateNode: 3,
    },
  },
  "adopted capture ten-write loop": {
    sqlite: {
      execute: 3,
      executeStatement: 5,
      insertNode: 10,
      lockSchemaVersionForWrite: 1,
    },
    postgres: {
      execute: 5,
      "execute:graph-write-lock": 1,
      executeStatement: 4,
      insertNode: 10,
      lockSchemaVersionForWrite: 1,
    },
  },
  "owned capture on an adapter store": {
    sqlite: {
      execute: 3,
      executeStatement: 4,
      insertNode: 10,
      lockSchemaVersionForWrite: 1,
    },
    postgres: {
      execute: 5,
      executeStatement: 4,
      insertNode: 10,
      lockSchemaVersionAndGraphWrite: 1,
      lockSchemaVersionForWrite: 1,
    },
  },
} as const satisfies Record<string, Record<"sqlite" | "postgres", Budget>>;

/** The engine-native budget; see {@link runsEngineNativeScenarios}. */
const ENGINE_NATIVE_RECEIPT_BUDGET: Budget = {
  insertNode: 9,
  insertNodeWithSchemaFence: 1,
};

const ENGINE_REVISION = {
  revision: "engine-budget-r1",
  recordedAt: "2026-01-01T00:00:00.000Z",
} as const;

/**
 * Whether this lane runs the engine-native scenarios. They never touch the
 * lane's backend: each builds {@link createEngineNativeBackend} over its own
 * in-process PostgreSQL. So they run once, on the in-process PostgreSQL lane
 * (the PostgreSQL-dialect lane whose connections are not independent server
 * connections), instead of repeating the identical run on every lane.
 */
export function runsEngineNativeScenarios(
  context: IntegrationTestContext,
): boolean {
  return (
    context.getBackend().dialect === "postgres" &&
    !context.serverLaneConcurrency
  );
}

/**
 * A scripted engine-native profile over its own in-process PostgreSQL: the
 * lane's backend cannot be rebuilt with engine-owned recorded time.
 * `revisionNow` replaces the scripted pending-revision read.
 */
export async function createEngineNativeBackend(
  client: PGlite,
  revisionNow: EngineRecordedTimeMembers["revisionNow"] = () =>
    Promise.resolve(ENGINE_REVISION),
): Promise<AdapterBackend<unknown>> {
  await client.exec(generateVectorlessPostgresMigrationSQL());
  const profile = buildPostgresEngineProfile(drizzle(client), {
    vector: false,
  });
  const recordedTime: EngineRecordedTimeMembers = {
    source: (table) => sql.raw(`__engine_native_${table}__`),
    revisionNow,
  };
  attachEngineNativeRecordedTime(profile.provisioning, recordedTime, {
    revision: () => Promise.resolve("engine-budget-r0" as EngineRevision),
    changesSince: () => Promise.resolve({ kind: "unbounded" }),
  });
  return createSqlBackend(profile) as AdapterBackend<unknown>;
}

async function measure(
  backend: AdapterBackend<unknown>,
  run: () => Promise<unknown>,
): Promise<Budget> {
  const recorder = recordTransactionPortCalls(backend);
  try {
    await run();
    return portCallBudget(recorder.calls);
  } finally {
    recorder.restore();
  }
}

function budgetFor(
  scenario: keyof typeof BUDGETS,
  backend: AdapterBackend<unknown>,
): Budget {
  return BUDGETS[scenario][backend.dialect];
}

export function registerTransactionPortCallBudgetTests(
  context: IntegrationTestContext,
): void {
  describe("Transaction port-call budgets", () => {
    const engines: PGlite[] = [];

    afterEach(async () => {
      for (const engine of engines.splice(0)) await engine.close();
    });

    it("schema-managed mixed ten-write transaction", async () => {
      const backend = context.getBackend();
      const [store] = await createStoreWithSchema(
        budgetGraph("budget_schema_managed"),
        backend,
      );

      const budget = await measure(backend, () =>
        store.transaction((tx) => writeMixedTen(tx)),
      );

      expect(budget).toEqual(
        budgetFor("schema-managed mixed ten-write transaction", backend),
      );
    });

    it("adopted capture ten-write loop", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(
        budgetGraph("budget_adopted_capture"),
        backend,
        { history: true },
      );

      const budget = await measure(backend, () =>
        backend.transactionWithNative((_tx, native) =>
          store.withRecordedTransaction(native, (tx) => createTen(tx)),
        ),
      );

      expect(budget).toEqual(
        budgetFor("adopted capture ten-write loop", backend),
      );
    });

    it("owned capture on an adapter store", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(
        budgetGraph("budget_owned_capture"),
        backend,
        { history: true },
      );

      const budget = await measure(backend, () =>
        store.transaction((tx) => createTen(tx)),
      );

      expect(budget).toEqual(
        budgetFor("owned capture on an adapter store", backend),
      );
    });

    it("engine-native receipt transaction", async (ctx) => {
      if (!runsEngineNativeScenarios(context)) ctx.skip();
      const engine = await PGlite.create();
      engines.push(engine);
      const backend = await createEngineNativeBackend(engine);
      const [store] = await createStoreWithSchema(
        budgetGraph("budget_engine_native"),
        backend,
        { history: true },
      );

      let recorded: unknown;
      const budget = await measure(backend, async () => {
        const outcome = await store.transactionWithReceipt((tx) =>
          createTen(tx),
        );
        recorded = outcome.receipt.recorded;
      });

      expect(recorded).toBeDefined();
      expect(budget).toEqual(ENGINE_NATIVE_RECEIPT_BUDGET);
    });
  });
}
