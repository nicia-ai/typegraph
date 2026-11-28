/**
 * `createTransactionView` — the one owner of when a transaction's view of its
 * connection stops accepting statements — and the SQLite adapter wrapper that
 * admits every statement member through it.
 *
 * The bundled SQLite drivers cannot make the drain observable end to end:
 * better-sqlite3 runs each statement synchronously and libSQL serializes its
 * transaction's statements itself. So the drain is pinned here, against an
 * adapter whose statements stay in flight until the test releases them, and
 * against a `sqlite-proxy` database on the manual BEGIN / COMMIT frame, where
 * the drain's place relative to COMMIT / ROLLBACK and to the transaction's
 * published token is observable.
 */
import { sql } from "drizzle-orm";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";

import { admitHandleStatementDirectly } from "../src/backend/drizzle/execution/handle-statement";
import type {
  AnySqliteDatabase,
  SqliteExecutionAdapter,
} from "../src/backend/drizzle/execution/sqlite-execution";
import { createSqliteTransactionExecutionView } from "../src/backend/drizzle/execution/sqlite-execution";
import {
  createTransactionView,
  openTransactionView,
} from "../src/backend/drizzle/execution/transaction-view";
import {
  recordEngineSavepoint,
  resolveNativeTransactionHandle,
} from "../src/backend/native-transaction-handle";
import { createSqliteBackend } from "../src/backend/sqlite";
import { TransactionClosedError } from "../src/errors";
import { sql as portableSql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
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

/** `view.admit` of a no-op, as its outcome: `"admitted"` or the error name. */
function admitOutcome(view: ReturnType<typeof createTransactionView>) {
  return view
    .admit(() => Promise.resolve("admitted"))
    .catch((error: unknown) =>
      error instanceof Error ? error.name : String(error),
    );
}

describe("openTransactionView", () => {
  it("hands an adoption of a transaction its owner's view, closed by the owner", async () => {
    const nativeTransaction = {};
    const owner = openTransactionView("owner", nativeTransaction, {});
    const adoption = openTransactionView("adoption", nativeTransaction, {});
    const held = createGate();
    const adopted = adoption.admit(() => held.opened.then(() => "adopted"));
    const drained = owner.drainAndClose();
    // The owner's drain waits for the adoption's statement.
    expect(await hasSettled(drained)).toBe(false);
    held.open();
    await drained;
    expect({
      adopted: await adopted,
      late: await admitOutcome(adoption),
    }).toEqual({ adopted: "adopted", late: "TransactionClosedError" });
  });

  it("gives an adoption with no proven owner a view nothing closes", async () => {
    const owner = openTransactionView("owner", {}, {});
    await owner.drainAndClose();
    expect({
      unidentified: await admitOutcome(
        openTransactionView("adoption", undefined, {}),
      ),
      unowned: await admitOutcome(openTransactionView("adoption", {}, {})),
    }).toEqual({ unidentified: "admitted", unowned: "admitted" });
  });

  it("does not register an engine savepoint's view for the transaction it encloses", async () => {
    const enclosing = {};
    const savepoint = {};
    recordEngineSavepoint(savepoint, {
      kind: "transaction",
      handle: enclosing,
    });
    // A caller's transaction TypeGraph opened a savepoint on, and one it
    // opened itself.
    const savepointView = openTransactionView("owner", enclosing, savepoint);
    await savepointView.drainAndClose();
    const callerAdoption = openTransactionView("adoption", enclosing, {});
    expect(await admitOutcome(callerAdoption)).toBe("admitted");
  });
});

/** A statement that stays in flight until the named member's gate opens. */
type HeldStatement = (member: string) => () => Promise<unknown>;

/**
 * Every statement member of the adapter, each called the way a backend calls
 * it. `admitHandleStatement` is handed a held statement composed on the
 * Drizzle handle, as `runHandleStatement` hands it one.
 */
const STATEMENT_MEMBER_CALLS = {
  admitHandleStatement: (adapter, heldStatement) =>
    adapter.admitHandleStatement(heldStatement("admitHandleStatement")),
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
  (
    adapter: SqliteExecutionAdapter,
    heldStatement: HeldStatement,
  ) => Promise<unknown>
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
  const gates = new Map<string, ReturnType<typeof createGate>>(
    STATEMENT_MEMBERS.map((member) => [member, createGate()] as const),
  );
  const ran: string[] = [];
  function held(member: string) {
    return async () => {
      ran.push(member);
      await requireDefined(gates.get(member)).opened;
      return [];
    };
  }
  const adapter = {
    // A root adapter's member: the statement it is handed holds itself.
    admitHandleStatement: admitHandleStatementDirectly,
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
  return { adapter, held, release, ran };
}

describe("createSqliteTransactionExecutionView", () => {
  it.each(STATEMENT_MEMBERS)(
    "waits for a held %s before it closes",
    async (member) => {
      const { adapter, held, release, ran } = heldAdapter();
      const view = createSqliteTransactionExecutionView(
        adapter,
        createTransactionView(),
      );
      // Every other member is in flight too, and released first: the drain
      // must still wait on this one alone.
      const inFlight = STATEMENT_MEMBERS.map((each) =>
        STATEMENT_MEMBER_CALLS[each](view.adapter, held),
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
      const { adapter, held, ran } = heldAdapter();
      const view = createSqliteTransactionExecutionView(
        adapter,
        createTransactionView(),
      );
      await view.drainAndClose();
      await expect(
        STATEMENT_MEMBER_CALLS[member](view.adapter, held),
      ).rejects.toThrow(TransactionClosedError);
      expect(ran).toEqual([]);
    },
  );

  it("passes members that touch no connection through after it closes", async () => {
    const { adapter, ran } = heldAdapter();
    const view = createSqliteTransactionExecutionView(
      adapter,
      createTransactionView(),
    );
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

/**
 * A SQLite database whose every statement arrives at `onStatement` as text,
 * through `sqlite-proxy` (an async bring-your-own-driver adapter), so a
 * statement admitted into a transaction's view can be held in flight.
 */
function createProxyDatabase(
  onStatement: (query: string) => Promise<void>,
): AnySqliteDatabase {
  return drizzleSqliteProxy(async (query: string) => {
    await onStatement(query);
    return { rows: [] };
  });
}

const HELD_STATEMENT = "SELECT 'held' AS held";

describe("a SQLite transaction TypeGraph frames itself", () => {
  // The manual BEGIN / COMMIT frame publishes the transaction's token on the
  // connection for the span BEGIN → COMMIT / ROLLBACK
  // (`publishConnectionNativeTransaction`); the view's drain sits inside that
  // span. One ordering, whichever way the callback settles: callback settles,
  // the statement it left in flight settles, COMMIT / ROLLBACK runs while the
  // token is still published, and only then is the token withdrawn.
  it.each([
    ["commits", "COMMIT", undefined],
    ["rolls back", "ROLLBACK", new Error("the callback fails")],
  ] as const)(
    "drains the view before it %s, and withdraws the token after",
    async (_outcome, frameEnd, failure) => {
      const events: string[] = [];
      const heldArrived = createGate();
      const heldRelease = createGate();
      let token: object | undefined;
      let opener: object | undefined;
      /**
       * Whether the transaction's token is still published. `sqlite-proxy`
       * reports no transaction state, so the token resolves only through the
       * opener's own bind, and only until its span ends.
       */
      function published(): boolean {
        return (
          token !== undefined &&
          opener !== undefined &&
          resolveNativeTransactionHandle(opener) === token
        );
      }
      const database = createProxyDatabase(async (query) => {
        if (query === HELD_STATEMENT) {
          heldArrived.open();
          await heldRelease.opened;
          events.push("held statement settles");
          return;
        }
        if (query === "COMMIT" || query === "ROLLBACK") {
          events.push(`${query} (token published: ${String(published())})`);
        }
      });
      const backend = createSqliteBackend(database, {
        executionProfile: { isSync: false, transactionMode: "sql" },
      });
      try {
        const settled = backend.transaction(async (tx) => {
          opener = tx;
          token = resolveNativeTransactionHandle(tx);
          void tx.execute(asCompiledRowsSql(portableSql.raw(HELD_STATEMENT)));
          await heldArrived.opened;
          events.push("callback settles");
          if (failure !== undefined) throw failure;
        });
        // The drain is still waiting on the held statement: no frame end yet.
        await new Promise((resolve) => setTimeout(resolve, 0));
        events.push("held statement released");
        heldRelease.open();
        const outcome = await settled.then(
          () => "fulfilled",
          (error: unknown) => error,
        );
        events.push(`token published after: ${String(published())}`);
        expect({ outcome, token: token !== undefined, events }).toEqual({
          outcome: failure ?? "fulfilled",
          token: true,
          events: [
            "callback settles",
            "held statement released",
            "held statement settles",
            `${frameEnd} (token published: true)`,
            "token published after: false",
          ],
        });
      } finally {
        await backend.close();
      }
    },
  );
});
