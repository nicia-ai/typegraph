/**
 * `createTransactionView` — the one owner of when a transaction's view of its
 * connection stops accepting statements — and the SQLite adapter wrapper that
 * admits every statement member through it.
 *
 * The bundled SQLite drivers cannot make the drain observable end to end:
 * better-sqlite3 runs each statement synchronously and libSQL serializes its
 * transaction's statements itself. So the drain is pinned here, against an
 * adapter whose statements stay in flight until the test releases them.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqliteExecutionAdapter } from "../src/backend/drizzle/execution/sqlite-execution";
import { createSqliteTransactionExecutionView } from "../src/backend/drizzle/execution/sqlite-execution";
import { createTransactionView } from "../src/backend/drizzle/execution/transaction-view";
import { TransactionClosedError } from "../src/errors";
import { requireDefined } from "../src/utils/presence";
import { createGate } from "./concurrency-utils";

/** Whether `pending` has settled after every queued microtask has run. */
async function hasSettled(pending: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

describe("createTransactionView", () => {
  it("starts an admitted task synchronously and returns its outcome", async () => {
    const view = createTransactionView();
    let started = false;
    const result = view.admit(() => {
      started = true;
      return Promise.resolve("row");
    });
    expect(started).toBe(true);
    await expect(result).resolves.toBe("row");
  });

  it("waits for every admitted task, fulfilled or rejected, before it closes", async () => {
    const view = createTransactionView();
    const first = createGate();
    const second = createGate();
    const fulfilled = view.admit(async () => {
      await first.opened;
      return "done";
    });
    const rejected = view.admit(async () => {
      await second.opened;
      throw new Error("statement failed");
    });
    const drained = view.drainAndClose();
    expect(await hasSettled(drained)).toBe(false);
    first.open();
    expect(await hasSettled(drained)).toBe(false);
    second.open();
    await expect(drained).resolves.toBeUndefined();
    await expect(fulfilled).resolves.toBe("done");
    await expect(rejected).rejects.toThrow("statement failed");
  });

  it("refuses every task after it closes without running it", async () => {
    const view = createTransactionView();
    await view.drainAndClose();
    let ran = false;
    await expect(
      view.admit(() => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow(TransactionClosedError);
    expect(ran).toBe(false);
    // Idempotent.
    await expect(view.drainAndClose()).resolves.toBeUndefined();
  });
});

/** Every statement member of the adapter, each called the way a backend calls it. */
const STATEMENT_MEMBER_CALLS = {
  execute: (adapter) => adapter.execute(sql`SELECT 1`),
  executeAtomicBatch: (adapter) =>
    requireDefined(adapter.executeAtomicBatch)([COMPILED]),
  executeCompiled: (adapter) =>
    requireDefined(adapter.executeCompiled)(COMPILED),
  executeCompiledRun: (adapter) =>
    requireDefined(adapter.executeCompiledRun)(COMPILED),
  executePreparedRunBatch: (adapter) =>
    requireDefined(adapter.executePreparedRunBatch)("SELECT 1", [[]]),
  executeRun: (adapter) => adapter.executeRun(sql`SELECT 1`),
  prepare: (adapter) => requireDefined(adapter.prepare)("SELECT 1").execute([]),
  runExclusive: (adapter) =>
    requireDefined(adapter.runExclusive)(() => Promise.resolve()),
} as const satisfies Record<
  string,
  (adapter: SqliteExecutionAdapter) => Promise<unknown>
>;

type StatementMember = keyof typeof STATEMENT_MEMBER_CALLS;

const STATEMENT_MEMBERS = Object.keys(
  STATEMENT_MEMBER_CALLS,
) as readonly StatementMember[];

const COMPILED = { sql: "SELECT 1", params: [] };

/**
 * An adapter whose statement members each stay in flight until that member's
 * own gate opens, so a drain that forgets one member is caught on that member.
 */
function heldAdapter() {
  const gates = new Map(
    STATEMENT_MEMBERS.map((member) => [member, createGate()] as const),
  );
  const ran: string[] = [];
  function held(member: StatementMember) {
    return async () => {
      ran.push(member);
      await requireDefined(gates.get(member)).opened;
      return [];
    };
  }
  const adapter = {
    clearStatementCache: () => {
      ran.push("clearStatementCache");
    },
    compile: () => COMPILED,
    execute: held("execute"),
    executeAtomicBatch: held("executeAtomicBatch"),
    executeCompiled: held("executeCompiled"),
    executeCompiledRun: async () => {
      await held("executeCompiledRun")();
    },
    executePreparedRunBatch: async () => {
      await held("executePreparedRunBatch")();
    },
    executeRun: async () => {
      await held("executeRun")();
    },
    prepare: () => ({ execute: held("prepare") }),
    runExclusive: held("runExclusive"),
    profile: {
      isSync: false,
      maxBindParameters: 999,
      orderedAggregates: false,
      supportsCompiledExecution: false,
      transactionMode: "drizzle",
    },
  } as unknown as SqliteExecutionAdapter;
  function release(member: StatementMember): void {
    requireDefined(gates.get(member)).open();
  }
  return { adapter, release, ran };
}

describe("createSqliteTransactionExecutionView", () => {
  it.each(STATEMENT_MEMBERS)(
    "waits for a held %s before it closes",
    async (member) => {
      const { adapter, release, ran } = heldAdapter();
      const view = createSqliteTransactionExecutionView(adapter);
      // Every other member is in flight too, and released first: the drain
      // must still wait on this one alone.
      const inFlight = STATEMENT_MEMBERS.map((each) =>
        STATEMENT_MEMBER_CALLS[each](view.adapter),
      );
      expect(ran).toEqual(STATEMENT_MEMBERS);
      const drained = view.drainAndClose();
      for (const other of STATEMENT_MEMBERS) {
        if (other !== member) release(other);
      }
      expect(await hasSettled(drained)).toBe(false);
      release(member);
      await drained;
      await Promise.all(inFlight);
    },
  );

  it.each(STATEMENT_MEMBERS)(
    "refuses %s after it closes without running it",
    async (member) => {
      const { adapter, ran } = heldAdapter();
      const view = createSqliteTransactionExecutionView(adapter);
      await view.drainAndClose();
      await expect(
        STATEMENT_MEMBER_CALLS[member](view.adapter),
      ).rejects.toThrow(TransactionClosedError);
      expect(ran).toEqual([]);
    },
  );

  it("passes members that touch no connection through after it closes", async () => {
    const { adapter, ran } = heldAdapter();
    const view = createSqliteTransactionExecutionView(adapter);
    await view.drainAndClose();
    view.adapter.clearStatementCache();
    expect({
      compiled: view.adapter.compile(sql`SELECT 1`),
      profile: view.adapter.profile,
      ran,
    }).toEqual({
      compiled: { sql: "SELECT 1", params: [] },
      profile: adapter.profile,
      ran: ["clearStatementCache"],
    });
  });
});
