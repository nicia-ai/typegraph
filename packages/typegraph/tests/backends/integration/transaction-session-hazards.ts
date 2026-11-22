/**
 * Hazards of one transaction session shared by several TypeGraph calls,
 * reproduced on main.
 *
 * A static design review listed ways a call on a transaction session can
 * outlive, overlap or escape the boundary that is supposed to govern it. Each
 * case here drives one of them on every lane. Its setup and its interception
 * run as ordinary assertions; its end state is ONE observation, checked with
 * `expectObservation` (`tests/helpers/known-defect.ts`) against the CORRECT
 * value: a call reports success only for writes that commit, a receipt or
 * recorded capture agrees with the rows, and nothing lands outside the
 * transaction that issued it. Where more than one end state is correct (a late
 * call may be refused, or may finish and be counted), the observation is
 * `ACCEPTED` for exactly those and the raw end state otherwise.
 *
 * Where main violates a case on a driver, the case names the hazard as a known
 * defect on exactly those drivers, with the exact end state main produces
 * there today. A repair flips the observation to the correct value and fails
 * the case with "defect fixed, flip this marker"; any other change fails it
 * as a changed defect. A hazard that reproduces nowhere is an ordinary case
 * pinning the safe behaviour.
 *
 * Interleavings are forced, never timed: `gatedBackend` runs a test step right
 * after a chosen transaction-scoped backend member resolves, so a late call is
 * always cut between the same two statements. A late call is held until the
 * callback that started it has returned, never until its transaction settles,
 * so a repair that waits for in-flight calls before committing can still
 * finish. Cases that need a savepoint which fails on demand, around a call no
 * public unit can contain, open it through `runRecordedTransactionSavepoint`,
 * the one helper every TypeGraph unit (hard-delete batches, import rounds,
 * merge apply) runs through.
 */
import { isDeepStrictEqual } from "node:util";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { statementExecutionVerdict } from "../../../src/backend/capabilities/resolve";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import { GRAPH_BACKEND_PROJECTION_KEYS } from "../../../src/backend/graph-backend-keys";
import { createPostgresBackend } from "../../../src/backend/postgres";
import type {
  AdapterBackend,
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { defineGraphExtension } from "../../../src/graph-extension";
import { branch } from "../../../src/graph-merge/branch";
import {
  applyMergePlanInTransaction,
  planMerge,
} from "../../../src/graph-merge/merge";
import { asBranchId } from "../../../src/graph-merge/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { runRecordedTransactionSavepoint } from "../../../src/store/recorded-capture";
import { transactionBackend } from "../../../src/store/runtime-port";
import type { StoreHooks } from "../../../src/store/types";
import { requireDefined } from "../../../src/utils/presence";
import { unwrap } from "../../../src/utils/result";
import { createGate, type Gate } from "../../concurrency-utils";
import {
  expectObservation,
  type KnownDefect,
} from "../../helpers/known-defect";
import type {
  IntegrationLaneDriver,
  IntegrationTestContext,
} from "./test-context";

const HzItem = defineNode("HzItem", {
  schema: z.object({ label: z.string() }),
});
const HzNote = defineNode("HzNote", {
  schema: z.object({ body: z.string() }),
});

let graphCounter = 0;

/** A fresh graph id per case; `HzItem.label` is unique, so a row has a claim. */
function buildGraph() {
  graphCounter += 1;
  return defineGraph({
    id: `transaction_session_hazards_${graphCounter}`,
    nodes: {
      HzItem: {
        type: HzItem,
        unique: [
          {
            name: "hz_item_label",
            fields: ["label"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      HzNote: { type: HzNote },
    },
    edges: {},
  });
}

const ALL_DRIVERS: readonly IntegrationLaneDriver[] = [
  "better-sqlite3",
  "libsql",
  "pglite",
  "node-postgres",
  "postgres-js",
];
const POSTGRES_DRIVERS: readonly IntegrationLaneDriver[] = [
  "pglite",
  "node-postgres",
  "postgres-js",
];

/**
 * Asserts a case's one observation on this lane: the correct value, or the
 * exact value a known defect produces on the drivers it names.
 */
function expectOnLane<TValue>(
  context: IntegrationTestContext,
  observed: TValue,
  correct: NoInfer<TValue>,
  defects: readonly KnownDefect<NoInfer<TValue>>[] = [],
): void {
  expectObservation({
    lane: { driver: context.driver },
    observed,
    correct,
    defects,
  });
}

/** The observation of an end state that is one of a case's correct ones. */
const ACCEPTED = "an accepted end state";

/** `ACCEPTED` when `observed` is one of `accepted`, else `observed` itself. */
function acceptedOr<TValue>(
  observed: TValue,
  accepted: readonly NoInfer<TValue>[],
): TValue | typeof ACCEPTED {
  return accepted.some((state) => isDeepStrictEqual(state, observed)) ? ACCEPTED
    : observed;
}

type Status = "fulfilled" | "rejected";

function statusOf(pending: Promise<unknown>): Promise<Status> {
  return pending.then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  );
}

/** A typed error as its name, code, identifying details and typed cause. */
type TypedError = Readonly<{
  error: string;
  code: string;
  details: Readonly<Record<string, unknown>>;
  cause?: TypedError | string;
}>;

/** A refusal as a {@link TypedError}, or what else `pending` did. */
type Refusal = TypedError | Readonly<{ fulfilled: true }> | string;

/** The details that name what a capability refusal is about. */
const IDENTIFYING_DETAILS = new Set(["bundle", "member", "code", "capability"]);

function typedErrorOf(error: unknown): TypedError | string {
  if (!(error instanceof TypeGraphError)) return String(error);
  const details = Object.fromEntries(
    Object.entries(error.details).filter(([key]) =>
      IDENTIFYING_DETAILS.has(key),
    ),
  );
  return {
    error: error.name,
    code: error.code,
    details,
    ...(error.cause === undefined ? {} : { cause: typedErrorOf(error.cause) }),
  };
}

function refusalOf(pending: Promise<unknown>): Promise<Refusal> {
  return pending.then(
    (): Refusal => ({ fulfilled: true }),
    (error: unknown): Refusal => typedErrorOf(error),
  );
}

/**
 * The refusal of a unit whose transaction target lacks `executeStatement`:
 * the statement-execution bundle the root resolved cannot bind to it.
 */
const STATEMENT_EXECUTION_REFUSAL: TypedError = {
  error: "ConfigurationError",
  code: "CONFIGURATION_ERROR",
  details: {
    bundle: "statementExecution",
    member: "executeStatement",
    code: "BUNDLE_PORT_SURFACE_MISMATCH",
  },
};

/** How a transaction settled, with its receipt's write total when it committed. */
type TransactionSettlement =
  | Readonly<{ status: "fulfilled"; receiptTotal: number }>
  | Readonly<{ status: "rejected" }>;

function settlementOf(
  pending: Promise<
    Readonly<{ receipt: Readonly<{ writes: Readonly<{ total: number }> }> }>
  >,
): Promise<TransactionSettlement> {
  return pending.then(
    (outcome): TransactionSettlement => ({
      status: "fulfilled",
      receiptTotal: outcome.receipt.writes.total,
    }),
    (): TransactionSettlement => ({ status: "rejected" }),
  );
}

/** `callback`, opening `returned` the moment its promise settles. */
function openingOnReturn<TArgument, TResult>(
  returned: Gate,
  callback: (argument: TArgument) => Promise<TResult>,
): (argument: TArgument) => Promise<TResult> {
  return (argument) =>
    callback(argument).finally(() => {
      returned.open();
    });
}

async function countOf(
  find: () => Promise<readonly unknown[]>,
): Promise<number> {
  const rows = await find();
  return rows.length;
}

async function ids(
  find: () => Promise<readonly Readonly<{ id: string }>[]>,
): Promise<readonly string[]> {
  const rows = await find();
  return rows.map((row) => row.id).toSorted();
}

type ItemCreator = Readonly<{
  nodes: Readonly<{
    HzItem: Readonly<{
      create: (props: { label: string }) => Promise<unknown>;
    }>;
  }>;
}>;

/** Whether a new `HzItem` may take `label`: false while a claim holds it. */
async function labelIsFree(
  store: ItemCreator,
  label: string,
): Promise<boolean> {
  return (await statusOf(store.nodes.HzItem.create({ label }))) === "fulfilled";
}

/**
 * The live uniqueness claims each of `nodeIds` owns: 1 for a live `HzItem`,
 * 0 for a deleted one. A surviving node that lost its claim, or a deleted
 * node whose claim stayed behind, shows here when its row does not.
 */
async function liveClaims(
  backend: GraphBackend,
  graphId: string,
  nodeIds: readonly string[],
): Promise<Readonly<Record<string, number>>> {
  const tables = requireDefined(backend.tableNames);
  const claims: Record<string, number> = {};
  for (const nodeId of nodeIds) {
    const rows = await backend.execute<{ count: number | string }>(
      asCompiledRowsSql(sql`
        SELECT COUNT(*) AS count
        FROM ${sql.identifier(requireDefined(tables.uniques))}
        WHERE graph_id = ${graphId} AND node_id = ${nodeId}
          AND deleted_at IS NULL
      `),
    );
    claims[nodeId] = Number(requireDefined(rows[0]).count);
  }
  return claims;
}

async function countRows(
  backend: GraphBackend,
  table: "nodes" | "recordedNodes",
  graphId: string,
): Promise<number> {
  const tables = requireDefined(backend.tableNames);
  const rows = await backend.execute<{ count: number | string }>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${sql.identifier(requireDefined(tables[table]))}
      WHERE graph_id = ${graphId}
    `),
  );
  return Number(requireDefined(rows[0]).count);
}

async function activeSchemaVersion(
  backend: GraphBackend,
  graphId: string,
): Promise<number> {
  const tables = requireDefined(backend.tableNames);
  const rows = await backend.execute<{ version: number | string }>(
    asCompiledRowsSql(sql`
      SELECT version
      FROM ${sql.identifier(requireDefined(tables.schemaVersions))}
      WHERE graph_id = ${graphId} AND is_active = TRUE
    `),
  );
  return Number(requireDefined(rows[0]).version);
}

/** Runs after a transaction-scoped backend member resolves, before its caller resumes. */
type AfterMember = (args: readonly unknown[]) => void | Promise<void>;

type GatedBackendOptions = Readonly<{
  /** Project `executeStatement` away from every transaction-scoped backend. */
  withoutTransactionStatements?: boolean;
  after?: Readonly<Partial<Record<string, AfterMember>>>;
}>;

/**
 * `backend`, whose transactions hand out a decorated transaction backend:
 * every member call is appended to `calls`, and `after[member]` runs once
 * that member resolves — before the TypeGraph code that called it resumes.
 */
function gatedBackend(
  backend: GraphBackend,
  options: GatedBackendOptions,
): Readonly<{ backend: GraphBackend; calls: string[] }> {
  const calls: string[] = [];
  function decorate(raw: TransactionBackend): TransactionBackend {
    const target =
      options.withoutTransactionStatements === true ?
        (projectBackendWithout(raw, [
          "executeStatement",
        ]) as unknown as TransactionBackend)
      : raw;
    const overrides: Record<string, unknown> = {};
    for (const key of GRAPH_BACKEND_PROJECTION_KEYS) {
      const member: unknown = (target as unknown as Record<string, unknown>)[
        key
      ];
      if (typeof member !== "function") continue;
      overrides[key] = async (...args: unknown[]) => {
        calls.push(key);
        const result: unknown = await (
          member as (...memberArguments: unknown[]) => Promise<unknown>
        ).apply(target, args);
        await options.after?.[key]?.(args);
        return result;
      };
    }
    return deriveBackend(target, overrides as never);
  }
  return {
    calls,
    backend: deriveBackend(backend, {
      transaction: (callback, transactionOptions) =>
        backend.transaction(
          (raw) => callback(decorate(raw)),
          transactionOptions,
        ),
    }),
  };
}

/** Rejections no handler claimed while `run` was in flight. */
async function unhandledRejectionsDuring(
  run: () => Promise<void>,
): Promise<readonly string[]> {
  const unhandled: string[] = [];
  const listener = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", listener);
  try {
    await run();
    // One macrotask lets Node report a rejection orphaned by the last await.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return unhandled;
}

function savepointStatements(backend: GraphBackend) {
  const statements = statementExecutionVerdict(backend);
  if (!statements.supported) {
    throw new Error("Every integration lane provides statement execution.");
  }
  return statements;
}

/**
 * A merge plan creating `m1` and `m2` into a revision-tracked target. Once
 * `arm` is called, the target's next transaction fails right after the
 * apply has written both rows, so the adopted apply's savepoint rolls them
 * back.
 */
async function failingMerge(
  context: IntegrationTestContext,
  hooks: StoreHooks,
) {
  const graph = buildGraph();
  // Every driver writes the plan's claims in one batch after both rows.
  let armed = false;
  const gated = gatedBackend(context.getBackend(), {
    after: {
      insertUniqueBatch: () => {
        if (!armed) return;
        armed = false;
        throw new Error("injected failure after the merged rows landed");
      },
    },
  });
  const [target] = await createStoreWithSchema(graph, gated.backend, {
    revisionTracking: true,
    hooks,
  });
  const source = unwrap(
    await branch(target, () => context.createIsolatedBackend(), {
      id: asBranchId(`hazards-${graph.id}`),
    }),
  );
  await source.store.nodes.HzItem.create({ label: "m1" }, { id: "m1" });
  await source.store.nodes.HzItem.create({ label: "m2" }, { id: "m2" });
  const artifact = unwrap(await planMerge(target, [source]));
  return {
    target,
    artifact,
    arm: () => {
      armed = true;
    },
  };
}

/** A transaction context a hook captured, as the hook calls it. */
type CapturedTransaction = Readonly<{
  nodes: Readonly<{
    HzNote: Readonly<{
      create: (props: { body: string }) => Promise<unknown>;
    }>;
    HzItem: Readonly<{
      bulkHardDelete: (ids: readonly string[]) => Promise<unknown>;
    }>;
  }>;
}>;

export function registerTransactionSessionHazardTests(
  context: IntegrationTestContext,
): void {
  describe("transaction session hazards", () => {
    describe("a re-adopted binding of a read-only transaction", () => {
      it("cannot write through store.withTransaction(tx.sql)", async () => {
        const graph = buildGraph();
        const [store] = await createAdapterStoreWithSchema(
          graph,
          context.getBackend(),
        );
        let aliasWrite: Status | undefined;
        // PostgreSQL refuses the alias's statement itself, and postgres-js
        // then rejects the transaction too: its outcome is not the question.
        await statusOf(
          store.transaction(
            async (tx) => {
              const alias = store.withTransaction(
                requireDefined((tx as Readonly<{ sql?: unknown }>).sql),
              );
              aliasWrite = await statusOf(
                alias.nodes.HzNote.create(
                  { body: "through the alias" },
                  { id: "alias" },
                ),
              );
            },
            { accessMode: "read_only" },
          ),
        );
        expectOnLane(
          context,
          { aliasWrite, notes: await ids(() => store.nodes.HzNote.find()) },
          { aliasWrite: "rejected", notes: [] },
          [
            {
              label: "hazard 1",
              on: { driver: ["better-sqlite3", "libsql"] },
              today: { aliasWrite: "fulfilled", notes: ["alias"] },
            },
          ],
        );
      });
    });

    describe("a call that outlives its callback", () => {
      it("commits all of a create cut between its node and claim statements, counted, or none of it", async () => {
        const graph = buildGraph();
        const nodesWritten = createGate();
        const callbackReturned = createGate();
        const gated = gatedBackend(context.getBackend(), {
          after: {
            insertNodesBatchReturning: async () => {
              nodesWritten.open();
              await callbackReturned.opened;
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        let late: Promise<Status> = Promise.resolve("rejected");
        let transaction: TransactionSettlement | undefined;
        const unhandled = await unhandledRejectionsDuring(async () => {
          transaction = await settlementOf(
            store.transactionWithReceipt(
              openingOnReturn(callbackReturned, async (tx) => {
                late = statusOf(
                  tx.nodes.HzItem.bulkCreate([
                    { props: { label: "n1" }, id: "n1" },
                    { props: { label: "n2" }, id: "n2" },
                  ]),
                );
                await nodesWritten.opened;
              }),
            ),
          );
          await late;
        });
        expectOnLane(
          context,
          acceptedOr(
            {
              transaction,
              late: await late,
              items: await ids(() => store.nodes.HzItem.find()),
              n1Free: await labelIsFree(store, "n1"),
              unhandled,
            },
            [
              {
                transaction: { status: "fulfilled", receiptTotal: 2 },
                late: "fulfilled",
                items: ["n1", "n2"],
                n1Free: false,
                unhandled: [],
              },
              {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "rejected",
                items: [],
                n1Free: true,
                unhandled: [],
              },
              {
                transaction: { status: "rejected" },
                late: "rejected",
                items: [],
                n1Free: true,
                unhandled: [],
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 2a",
              on: { driver: ["better-sqlite3", "libsql"] },
              today: {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "fulfilled",
                items: ["n1", "n2"],
                n1Free: false,
                unhandled: [],
              },
            },
          ],
        );
      });

      it("commits nothing of a create orphaned by a Promise.all whose sibling rejected", async () => {
        const graph = buildGraph();
        const nodesWritten = createGate();
        const callbackReturned = createGate();
        const gated = gatedBackend(context.getBackend(), {
          after: {
            insertNodesBatchReturning: async () => {
              nodesWritten.open();
              await callbackReturned.opened;
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        let late: Promise<Status> = Promise.resolve("rejected");
        let transaction: Status | undefined;
        const unhandled = await unhandledRejectionsDuring(async () => {
          transaction = await statusOf(
            store.transaction(
              openingOnReturn(callbackReturned, async (tx) => {
                const work = tx.nodes.HzItem.bulkCreate([
                  { props: { label: "n1" }, id: "n1" },
                  { props: { label: "n2" }, id: "n2" },
                ]);
                late = statusOf(work);
                await Promise.all([
                  work,
                  nodesWritten.opened.then(() => {
                    throw new Error("a sibling rejects");
                  }),
                ]);
              }),
            ),
          );
          await late;
        });
        expectOnLane(
          context,
          {
            transaction,
            late: await late,
            items: await ids(() => store.nodes.HzItem.find()),
            n1Free: await labelIsFree(store, "n1"),
            unhandled,
          },
          {
            transaction: "rejected",
            late: "rejected",
            items: [],
            n1Free: true,
            unhandled: [],
          },
          [
            {
              label: "hazard 2b",
              on: { driver: ALL_DRIVERS },
              today: {
                transaction: "rejected",
                late: "fulfilled",
                items: [],
                n1Free: true,
                unhandled: [],
              },
            },
          ],
        );
      });

      it("commits all of a bulkHardDelete cut inside its savepoint, counted, or none of it", async () => {
        const graph = buildGraph();
        const rowsDeleted = createGate();
        const callbackReturned = createGate();
        const gated = gatedBackend(context.getBackend(), {
          after: {
            hardDeleteNodesBatch: async () => {
              rowsDeleted.open();
              await callbackReturned.opened;
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        await store.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
          { props: { label: "s2" }, id: "s2" },
          { props: { label: "s3" }, id: "s3" },
        ]);
        let late: Promise<Status> = Promise.resolve("rejected");
        let transaction: TransactionSettlement | undefined;
        const unhandled = await unhandledRejectionsDuring(async () => {
          transaction = await settlementOf(
            store.transactionWithReceipt(
              openingOnReturn(callbackReturned, async (tx) => {
                late = statusOf(
                  tx.nodes.HzItem.bulkHardDelete([
                    asNodeId("s1"),
                    asNodeId("s2"),
                  ]),
                );
                await rowsDeleted.opened;
              }),
            ),
          );
          await late;
        });
        const untouched = {
          items: ["s1", "s2", "s3"],
          claims: { s1: 1, s2: 1 },
          unhandled: [],
        };
        expectOnLane(
          context,
          acceptedOr(
            {
              transaction,
              late: await late,
              items: await ids(() => store.nodes.HzItem.find()),
              claims: await liveClaims(context.getBackend(), graph.id, [
                "s1",
                "s2",
              ]),
              unhandled,
            },
            [
              {
                transaction: { status: "fulfilled", receiptTotal: 2 },
                late: "fulfilled",
                items: ["s3"],
                claims: { s1: 0, s2: 0 },
                unhandled: [],
              },
              {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "rejected",
                ...untouched,
              },
              {
                transaction: { status: "rejected" },
                late: "rejected",
                ...untouched,
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 2c",
              on: { driver: ["better-sqlite3", "libsql"] },
              today: {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "fulfilled",
                items: ["s3"],
                claims: { s1: 0, s2: 0 },
                unhandled: [],
              },
            },
            {
              label: "hazard 2c",
              on: { driver: ["postgres-js"] },
              today: {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "rejected",
                items: ["s3"],
                claims: { s1: 0, s2: 0 },
                unhandled: [],
              },
            },
          ],
        );
      });

      it("never lands in the next transaction on the connection", async () => {
        const graph = buildGraph();
        const firstReturned = createGate();
        const secondSubmitted = createGate();
        let armed = true;
        const gated = gatedBackend(context.getBackend(), {
          after: {
            lockSchemaVersionForWrite: async () => {
              if (!armed) return;
              armed = false;
              await secondSubmitted.opened;
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        let late: Promise<Status> = Promise.resolve("rejected");
        const first = statusOf(
          store.transaction(
            openingOnReturn(firstReturned, (tx) => {
              late = statusOf(
                tx.nodes.HzItem.bulkCreate([
                  { props: { label: "n1" }, id: "n1" },
                  { props: { label: "n2" }, id: "n2" },
                ]),
              );
              return Promise.resolve();
            }),
          ),
        );
        // The second transaction is asked for as soon as the first callback
        // returns, whether or not the first transaction has settled; the late
        // call resumes only once it has been asked for.
        await firstReturned.opened;
        const abort = new Error("the second transaction rolls back");
        let seenInSecond: readonly string[] | undefined;
        const second = store.transaction(async (tx) => {
          await late;
          seenInSecond = await ids(() => tx.nodes.HzItem.find());
          throw abort;
        });
        secondSubmitted.open();
        await expect(second).rejects.toBe(abort);
        // Where the late call's rows landed: seen by the second transaction
        // and gone after its rollback means they were written inside it.
        expectOnLane(
          context,
          acceptedOr(
            {
              first: await first,
              late: await late,
              seenInSecond,
              items: await ids(() => store.nodes.HzItem.find()),
            },
            [
              {
                first: "fulfilled",
                late: "rejected",
                seenInSecond: [],
                items: [],
              },
              {
                first: "fulfilled",
                late: "fulfilled",
                seenInSecond: ["n1", "n2"],
                items: ["n1", "n2"],
              },
              {
                first: "rejected",
                late: "rejected",
                seenInSecond: [],
                items: [],
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 2d",
              on: { driver: ["better-sqlite3"] },
              today: {
                first: "fulfilled",
                late: "fulfilled",
                seenInSecond: ["n1", "n2"],
                items: [],
              },
            },
          ],
        );
      });
    });

    describe("a call re-entered from a hook", () => {
      it("never reports a write that merge apply's rollback removed", async () => {
        let captured: CapturedTransaction | undefined;
        let child: Promise<Status> = Promise.resolve("rejected");
        const { target, artifact, arm } = await failingMerge(context, {
          onOperationStart: (operation) => {
            if (operation.id !== "m1" || captured === undefined) return;
            child = statusOf(
              captured.nodes.HzNote.create({ body: "from a hook" }),
            );
          },
        });
        let apply: Status | undefined;
        arm();
        await target.transaction(async (tx) => {
          captured = tx as unknown as CapturedTransaction;
          apply = await statusOf(
            applyMergePlanInTransaction(target, tx, artifact),
          );
          captured = undefined;
          await child;
        });
        expectOnLane(
          context,
          acceptedOr(
            {
              apply,
              child: await child,
              notes: await countOf(() => target.nodes.HzNote.find()),
              items: await ids(() => target.nodes.HzItem.find()),
            },
            [
              { apply: "rejected", child: "rejected", notes: 0, items: [] },
              { apply: "rejected", child: "fulfilled", notes: 1, items: [] },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 3a",
              on: { driver: ALL_DRIVERS },
              today: {
                apply: "rejected",
                child: "fulfilled",
                notes: 0,
                items: [],
              },
            },
          ],
        );
      });

      it("commits and counts a write a discard hook starts after merge apply rolled back", async () => {
        let captured: CapturedTransaction | undefined;
        let child: Promise<Status> = Promise.resolve("rejected");
        const { target, artifact, arm } = await failingMerge(context, {
          onError: () => {
            if (captured === undefined) return;
            const tx = captured;
            captured = undefined;
            child = statusOf(tx.nodes.HzNote.create({ body: "from onError" }));
          },
        });
        arm();
        const { result, receipt } = await target.transactionWithReceipt(
          async (tx) => {
            captured = tx as unknown as CapturedTransaction;
            const apply = await statusOf(
              applyMergePlanInTransaction(target, tx, artifact),
            );
            return { apply, child: await child };
          },
        );
        expect({
          ...result,
          receiptNotes: receipt.writes.nodes["HzNote"],
          notes: await countOf(() => target.nodes.HzNote.find()),
        }).toEqual({
          apply: "rejected",
          child: "fulfilled",
          receiptNotes: 1,
          notes: 1,
        });
      });

      it("applies both of two bulkHardDelete units one hook starts at once", async () => {
        const graph = buildGraph();
        let captured: CapturedTransaction | undefined;
        const children: Promise<Status>[] = [];
        const [store] = await createStoreWithSchema(
          graph,
          context.getBackend(),
          {
            hooks: {
              onOperationStart: (operation: Readonly<{ kind: string }>) => {
                if (operation.kind !== "HzNote" || captured === undefined)
                  return;
                const tx = captured;
                captured = undefined;
                children.push(
                  statusOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s1")])),
                  statusOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s2")])),
                );
              },
            },
          },
        );
        await store.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
          { props: { label: "s2" }, id: "s2" },
        ]);
        const { result, receipt } = await store.transactionWithReceipt(
          async (tx) => {
            captured = tx as unknown as CapturedTransaction;
            const note = await statusOf(
              tx.nodes.HzNote.create({ body: "starts the children" }),
            );
            return { note, children: await Promise.all(children) };
          },
        );
        expectOnLane(
          context,
          {
            ...result,
            receiptTotal: receipt.writes.total,
            items: await ids(() => store.nodes.HzItem.find()),
            claims: await liveClaims(context.getBackend(), graph.id, [
              "s1",
              "s2",
            ]),
            notes: await countOf(() => store.nodes.HzNote.find()),
          },
          {
            note: "fulfilled",
            children: ["fulfilled", "fulfilled"],
            receiptTotal: 3,
            items: [],
            claims: { s1: 0, s2: 0 },
            notes: 1,
          },
          [
            {
              label: "hazard 3c",
              on: { driver: ["postgres-js"] },
              today: {
                note: "fulfilled",
                children: ["rejected", "rejected"],
                receiptTotal: 1,
                items: ["s1", "s2"],
                claims: { s1: 1, s2: 1 },
                notes: 0,
              },
            },
          ],
        );
      });

      it("never reports a sibling write that a failing bulkHardDelete's rollback removed", async () => {
        const graph = buildGraph();
        const insideUnit = createGate();
        const siblingStarted = createGate();
        let sibling: Promise<Status> = Promise.resolve("rejected");
        const gated = gatedBackend(context.getBackend(), {
          after: {
            hardDeleteNodesBatch: async () => {
              insideUnit.open();
              await siblingStarted.opened;
              await sibling;
              throw new Error("injected failure after the delete");
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        await store.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
        ]);
        const result = await store.transaction(async (tx) => {
          const unit = statusOf(
            tx.nodes.HzItem.bulkHardDelete([asNodeId("s1")]),
          );
          // Started while the unit's savepoint is open.
          await insideUnit.opened;
          sibling = statusOf(
            tx.nodes.HzNote.create({ body: "sibling" }, { id: "sibling" }),
          );
          siblingStarted.open();
          return { unit: await unit, sibling: await sibling };
        });
        expectOnLane(
          context,
          acceptedOr(
            {
              ...result,
              notes: await ids(() => store.nodes.HzNote.find()),
              items: await ids(() => store.nodes.HzItem.find()),
            },
            [
              {
                unit: "rejected",
                sibling: "fulfilled",
                notes: ["sibling"],
                items: ["s1"],
              },
              {
                unit: "rejected",
                sibling: "rejected",
                notes: [],
                items: ["s1"],
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 3d",
              on: { driver: ALL_DRIVERS },
              today: {
                unit: "rejected",
                sibling: "fulfilled",
                notes: [],
                items: ["s1"],
              },
            },
          ],
        );
      });
    });

    describe("two bindings of one native transaction", () => {
      it("leaves no recorded row or receipt for a history write a plain binding's savepoint rolled back", async () => {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [plain] = await createAdapterStoreWithSchema(graph, backend);
        const [history] = await createAdapterStoreWithSchema(graph, backend, {
          history: true,
        });
        const statements = savepointStatements(backend);
        const outcome = await backend.transactionWithNative((_target, native) =>
          history.withRecordedTransaction(native, async (tx) =>
            statusOf(
              runRecordedTransactionSavepoint(
                transactionBackend(plain.withTransaction(native)),
                statements,
                "hazard_plain_unit",
                async () => {
                  await tx.nodes.HzItem.create({ label: "h1" }, { id: "h1" });
                  throw new Error("the plain binding's unit fails");
                },
              ),
            ),
          ),
        );
        expectOnLane(
          context,
          {
            unit: outcome.result,
            receiptTotal: outcome.receipt.writes.total,
            receiptRecorded: outcome.receipt.recorded !== undefined,
            live: await countRows(backend, "nodes", graph.id),
            recorded: await countRows(backend, "recordedNodes", graph.id),
          },
          {
            unit: "rejected",
            receiptTotal: 0,
            receiptRecorded: false,
            live: 0,
            recorded: 0,
          },
          [
            {
              label: "hazard 4a",
              on: { driver: ALL_DRIVERS },
              today: {
                unit: "rejected",
                receiptTotal: 1,
                receiptRecorded: true,
                live: 0,
                recorded: 1,
              },
            },
          ],
        );
      });

      it("never reports a plain binding's write that a history binding's savepoint rolled back", async () => {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [plain] = await createAdapterStoreWithSchema(graph, backend);
        const [history] = await createAdapterStoreWithSchema(graph, backend, {
          history: true,
        });
        const statements = savepointStatements(backend);
        let plainWrite: Status | undefined;
        await backend.transactionWithNative((_target, native) => {
          const plainTx = plain.withTransaction(native);
          return history.withRecordedTransaction(native, (tx) =>
            statusOf(
              runRecordedTransactionSavepoint(
                transactionBackend(tx),
                statements,
                "hazard_history_unit",
                async () => {
                  plainWrite = await statusOf(
                    plainTx.nodes.HzItem.create({ label: "p1" }, { id: "p1" }),
                  );
                  throw new Error("the history binding's unit fails");
                },
              ),
            ),
          );
        });
        expectOnLane(
          context,
          acceptedOr(
            { plainWrite, items: await ids(() => plain.nodes.HzItem.find()) },
            [
              { plainWrite: "fulfilled", items: ["p1"] },
              { plainWrite: "rejected", items: [] },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 4a",
              on: { driver: ALL_DRIVERS },
              today: { plainWrite: "fulfilled", items: [] },
            },
          ],
        );
      });

      async function withTransactionStore(
        run: (store: ItemCreatorWithTransaction) => Promise<void>,
      ): Promise<readonly string[]> {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [setup] = await createAdapterStoreWithSchema(graph, backend);
        await setup.nodes.HzItem.create({ label: "taken" }, { id: "taken" });
        await backend.transactionWithNative(async (_target, native) => {
          const [store] = await createAdapterStoreWithSchema(
            graph,
            createPostgresBackend(native as never) as AdapterBackend<unknown>,
          );
          await run(store as unknown as ItemCreatorWithTransaction);
        });
        return ids(() => setup.nodes.HzItem.find());
      }

      // SQLite has no factory for a backend over a caller's transaction.
      describe.runIf(POSTGRES_DRIVERS.includes(context.driver))(
        "a Store over createPostgresTransactionBackend",
        () => {
          it("commits two overlapping creates", async () => {
            let creates: readonly Status[] = [];
            const items = await withTransactionStore(async (store) => {
              creates = await Promise.all([
                statusOf(
                  store.nodes.HzItem.create({ label: "a" }, { id: "a" }),
                ),
                statusOf(
                  store.nodes.HzItem.create({ label: "b" }, { id: "b" }),
                ),
              ]);
            });
            expect({ creates, items }).toEqual({
              creates: ["fulfilled", "fulfilled"],
              items: ["a", "b", "taken"],
            });
          });

          it("commits a create that succeeded beside an overlapping create that failed", async () => {
            let creates: readonly Status[] = [];
            const items = await withTransactionStore(async (store) => {
              creates = await Promise.all([
                statusOf(
                  store.nodes.HzItem.create({ label: "c" }, { id: "c" }),
                ),
                statusOf(
                  store.nodes.HzItem.create({ label: "taken" }, { id: "d" }),
                ),
              ]);
            });
            expectOnLane(
              context,
              { creates, items },
              { creates: ["fulfilled", "rejected"], items: ["c", "taken"] },
              [
                {
                  label: "hazard 4b",
                  on: { driver: POSTGRES_DRIVERS },
                  today: {
                    creates: ["fulfilled", "rejected"],
                    items: ["taken"],
                  },
                },
              ],
            );
          });

          it("commits a create that overlapped a nested store.transaction() that rolled back", async () => {
            let outcomes: readonly Status[] = [];
            const items = await withTransactionStore(async (store) => {
              const innerWritten = createGate();
              const siblingStarted = createGate();
              let sibling: Promise<Status> = Promise.resolve("rejected");
              const nested = statusOf(
                store.transaction(async (tx) => {
                  await tx.nodes.HzItem.create({ label: "e" }, { id: "e" });
                  innerWritten.open();
                  await siblingStarted.opened;
                  await sibling;
                  throw new Error("the nested transaction fails");
                }),
              );
              await innerWritten.opened;
              sibling = statusOf(
                store.nodes.HzItem.create({ label: "f" }, { id: "f" }),
              );
              siblingStarted.open();
              outcomes = await Promise.all([nested, sibling]);
            });
            expectOnLane(
              context,
              { outcomes, items },
              { outcomes: ["rejected", "fulfilled"], items: ["f", "taken"] },
              [
                {
                  label: "hazard 4c",
                  on: { driver: POSTGRES_DRIVERS },
                  today: {
                    outcomes: ["rejected", "fulfilled"],
                    items: ["taken"],
                  },
                },
              ],
            );
          });
        },
      );
    });

    describe("an adopted callback inside another binding's savepoint", () => {
      it("withRecordedTransaction never returns a receipt for writes the savepoint rolled back", async () => {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [plain] = await createAdapterStoreWithSchema(graph, backend);
        const [history] = await createAdapterStoreWithSchema(graph, backend, {
          history: true,
        });
        const statements = savepointStatements(backend);
        let adopted:
          Readonly<{ status: Status; receiptTotal?: number }> | undefined;
        await backend.transactionWithNative((_target, native) =>
          statusOf(
            runRecordedTransactionSavepoint(
              transactionBackend(plain.withTransaction(native)),
              statements,
              "hazard_plain_unit",
              async () => {
                adopted = await history
                  .withRecordedTransaction(native, async (tx) => {
                    await tx.nodes.HzItem.create({ label: "r1" }, { id: "r1" });
                  })
                  .then(
                    ({ receipt }) => ({
                      status: "fulfilled" as const,
                      receiptTotal: receipt.writes.total,
                    }),
                    () => ({ status: "rejected" as const }),
                  );
                throw new Error("the plain binding's unit fails");
              },
            ),
          ),
        );
        expectOnLane(
          context,
          acceptedOr(
            {
              adopted,
              live: await countRows(backend, "nodes", graph.id),
              recorded: await countRows(backend, "recordedNodes", graph.id),
            },
            [
              { adopted: { status: "rejected" }, live: 0, recorded: 0 },
              {
                adopted: { status: "fulfilled", receiptTotal: 1 },
                live: 1,
                recorded: 1,
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 5",
              on: { driver: ALL_DRIVERS },
              today: {
                adopted: { status: "fulfilled", receiptTotal: 1 },
                live: 0,
                recorded: 0,
              },
            },
          ],
        );
      });

      // The evolved receipt is provisional until the caller commits
      // (graph-extensions.md, `EvolvedTransactionOutcome`), and this caller
      // rolls the containing savepoint back: success followed by the original
      // version is the documented contract, not a defect. What the contract
      // does promise is that nothing of the rolled-back version survives and
      // `refreshSchema` refuses to treat the provisional version as committed.
      // libSQL has no adopted schema write transaction and refuses the call.
      it("withEvolvedTransaction's provisional schema version does not survive the savepoint's rollback", async () => {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [plain] = await createAdapterStoreWithSchema(graph, backend);
        const [adopter] = await createAdapterStoreWithSchema(graph, backend);
        const plan = await adopter.planEvolution(
          defineGraphExtension({
            nodes: { HzTag: { properties: { label: { type: "string" } } } },
          }),
        );
        if (plan.status !== "change") throw new Error("Expected a change.");
        const statements = savepointStatements(backend);
        let evolved:
          | Readonly<{ receiptVersion: number; result: string }>
          | Refusal
          | undefined;
        await backend.transactionWithNative((_target, native) =>
          statusOf(
            runRecordedTransactionSavepoint(
              transactionBackend(plain.withTransaction(native)),
              statements,
              "hazard_plain_unit",
              async () => {
                evolved = await adopter
                  .withEvolvedTransaction(native, plan, () =>
                    Promise.resolve("evolved"),
                  )
                  .then(
                    (outcome) => ({
                      receiptVersion: outcome.receipt.schema.version,
                      result: outcome.result,
                    }),
                    (error: unknown) => typedErrorOf(error),
                  );
                throw new Error("the plain binding's unit fails");
              },
            ),
          ),
        );
        expect({
          evolved,
          version: await activeSchemaVersion(backend, graph.id),
          refresh: await refusalOf(
            plain.refreshSchema({ minVersion: plan.result.version }),
          ),
        }).toEqual({
          evolved:
            context.driver === "libsql" ?
              {
                error: "UnsupportedBackendCapabilityError",
                code: "UNSUPPORTED_BACKEND_CAPABILITY",
                details: { capability: "adoptSchemaWriteTransaction" },
              }
            : { receiptVersion: plan.result.version, result: "evolved" },
          version: plan.result.version - 1,
          refresh: {
            error: "ConfigurationError",
            code: "CONFIGURATION_ERROR",
            details: { code: "SCHEMA_REFRESH_VERSION_UNAVAILABLE" },
          },
        });
      });
    });

    describe("a unit on a target without statement execution", () => {
      it("bulkHardDelete refuses before its first row write when only the transaction target lacks it", async () => {
        const graph = buildGraph();
        const gated = gatedBackend(context.getBackend(), {
          withoutTransactionStatements: true,
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        await store.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
        ]);
        gated.calls.length = 0;
        const attempt = await store.transaction((tx) =>
          refusalOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s1")])),
        );
        expect({
          attempt,
          rowWrites: gated.calls.filter((member) =>
            member.startsWith("hardDelete"),
          ),
          items: await ids(() => store.nodes.HzItem.find()),
        }).toEqual({
          attempt: STATEMENT_EXECUTION_REFUSAL,
          rowWrites: [],
          items: ["s1"],
        });
      });

      it("bulkHardDelete keeps nothing of a failure after its first write when the root lacks it", async () => {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [setup] = await createStoreWithSchema(graph, backend);
        await setup.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
          { props: { label: "s2" }, id: "s2" },
        ]);
        const gated = gatedBackend(
          projectBackendWithout(backend, ["executeStatement"]),
          {
            withoutTransactionStatements: true,
            after: {
              hardDeleteNodesBatch: () => {
                throw new Error("injected failure after the delete");
              },
            },
          },
        );
        const [store] = await createStoreWithSchema(graph, gated.backend);
        const attempt = await store.transaction((tx) =>
          statusOf(
            tx.nodes.HzItem.bulkHardDelete([asNodeId("s1"), asNodeId("s2")]),
          ),
        );
        expectOnLane(
          context,
          {
            attempt,
            items: await ids(() => setup.nodes.HzItem.find()),
            claims: await liveClaims(backend, graph.id, ["s1", "s2"]),
          },
          {
            attempt: "rejected",
            items: ["s1", "s2"],
            claims: { s1: 1, s2: 1 },
          },
          [
            {
              label: "hazard 6b",
              on: { driver: ALL_DRIVERS },
              today: {
                attempt: "rejected",
                items: [],
                claims: { s1: 0, s2: 0 },
              },
            },
          ],
        );
      });

      it("merge apply refuses before any statement when the transaction target lacks it", async () => {
        const graph = buildGraph();
        const gated = gatedBackend(context.getBackend(), {
          withoutTransactionStatements: true,
        });
        const [target] = await createStoreWithSchema(graph, gated.backend, {
          revisionTracking: true,
        });
        const source = unwrap(
          await branch(target, () => context.createIsolatedBackend(), {
            id: asBranchId(`hazards-${graph.id}`),
          }),
        );
        await source.store.nodes.HzItem.create({ label: "m1" }, { id: "m1" });
        const artifact = unwrap(await planMerge(target, [source]));
        gated.calls.length = 0;
        const apply = await target.transaction((tx) =>
          refusalOf(applyMergePlanInTransaction(target, tx, artifact)),
        );
        expect({
          apply,
          calls: gated.calls,
          items: await ids(() => target.nodes.HzItem.find()),
        }).toEqual({
          apply: {
            error: "MergeError",
            code: "GRAPH_MERGE_ERROR",
            details: {},
            cause: STATEMENT_EXECUTION_REFUSAL,
          },
          calls: [],
          items: [],
        });
      });
    });

    describe("deferred execution", () => {
      // Each stream page is a fresh query on the transaction (cursor
      // pagination, queries/execute.md "Batch Size"), so a page read after
      // the transaction's own delete sees that delete, and a later rollback
      // cannot change pages already delivered. The stream promises no
      // snapshot: this pins the read-your-writes page it does promise.
      it("a stream advanced during a bulkHardDelete reads the transaction's own delete, which then rolls back", async () => {
        const graph = buildGraph();
        const yielded: unknown[] = [];
        let iterator: AsyncIterator<unknown> | undefined;
        const gated = gatedBackend(context.getBackend(), {
          after: {
            hardDeleteNodesBatch: async () => {
              const stream = requireDefined(iterator);
              for (;;) {
                const next = await stream.next();
                if (next.done === true) break;
                yielded.push(next.value);
              }
              throw new Error("injected failure after the delete");
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        await store.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
          { props: { label: "s2" }, id: "s2" },
          { props: { label: "s3" }, id: "s3" },
        ]);
        const unit = await store.transaction(async (tx) => {
          iterator = tx
            .query()
            .from("HzItem", "item")
            .select((select) => select.item.id)
            .orderBy("item", "id")
            .stream({ batchSize: 1 })
            [Symbol.asyncIterator]();
          const first = await iterator.next();
          yielded.push(first.value);
          return statusOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s2")]));
        });
        expect({
          unit,
          yielded,
          items: await ids(() => store.nodes.HzItem.find()),
          claims: await liveClaims(context.getBackend(), graph.id, ["s2"]),
        }).toEqual({
          unit: "rejected",
          yielded: ["s1", "s3"],
          items: ["s1", "s2", "s3"],
          claims: { s2: 1 },
        });
      });

      it("a prepared query and a stream kept past their callback never read a later transaction's writes", async () => {
        const graph = buildGraph();
        const [store] = await createStoreWithSchema(
          graph,
          context.getBackend(),
        );
        await store.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
          { props: { label: "s2" }, id: "s2" },
        ]);
        const { prepared, stream } = await store.transaction(async (tx) => {
          const query = () =>
            tx
              .query()
              .from("HzItem", "item")
              .select((select) => select.item.id)
              .orderBy("item", "id");
          const iterator = query()
            .stream({ batchSize: 1 })
            [Symbol.asyncIterator]();
          await iterator.next();
          return { prepared: query().prepare(), stream: iterator };
        });
        const seen: unknown[] = [];
        const abort = new Error("the later transaction rolls back");
        await expect(
          store.transaction(async (tx) => {
            await tx.nodes.HzItem.create({ label: "x1" }, { id: "x1" });
            await prepared.execute().then(
              (rows) => seen.push(...rows),
              () => 0,
            );
            for (;;) {
              // A refused advance ends the stream, as exhaustion does.
              const next = await stream.next().then(
                (result) => result,
                (): IteratorResult<unknown> => ({
                  done: true,
                  value: undefined,
                }),
              );
              if (next.done === true) break;
              seen.push(next.value);
            }
            throw abort;
          }),
        ).rejects.toBe(abort);
        expectOnLane(
          context,
          { sawUncommittedRow: seen.includes("x1") },
          { sawUncommittedRow: false },
          [
            {
              label: "hazard 7b",
              on: { driver: ["better-sqlite3"] },
              today: { sawUncommittedRow: true },
            },
          ],
        );
      });
    });
  });
}

/** A Store over a caller's transaction, as these cases call it. */
type ItemCreatorWithTransaction = Readonly<{
  nodes: Readonly<{
    HzItem: Readonly<{
      create: (
        props: { label: string },
        options?: { id: string },
      ) => Promise<unknown>;
    }>;
  }>;
  transaction: (
    fn: (tx: ItemCreatorWithTransaction) => Promise<unknown>,
  ) => Promise<unknown>;
}>;
