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

import { createConnectionStatementQueue } from "../src/backend/drizzle/execution/connection-statement-queue";
import type {
  AnySqliteDatabase,
  SqliteExecutionAdapter,
} from "../src/backend/drizzle/execution/sqlite-execution";
import { createSqliteTransactionExecutionView } from "../src/backend/drizzle/execution/sqlite-execution";
import { createTransactionView } from "../src/backend/drizzle/execution/transaction-view";
import { resolveNativeTransactionHandle } from "../src/backend/native-transaction-handle";
import { createSqliteBackend } from "../src/backend/sqlite";
import {
  ConfigurationError,
  TransactionClosedError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
} from "../src/errors";
import { sql as portableSql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";
import { createGate } from "./concurrency-utils";

type Status = "fulfilled" | "rejected";

function statusOf(pending: Promise<unknown>): Promise<Status> {
  return pending.then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  );
}

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
  it("starts a task admitted while another is in flight only once that one has settled, in admission order", async () => {
    const view = createTransactionView();
    const first = createGate();
    const events: string[] = [];
    const held = view.admit(async () => {
      events.push("first starts");
      await first.opened;
      events.push("first settles");
    });
    const second = view.admit(() => {
      events.push("second starts");
      return Promise.resolve();
    });
    const third = view.admit(() => {
      events.push("third starts");
      return Promise.reject(new Error("third failed"));
    });
    expect(await hasSettled(second)).toBe(false);
    first.open();
    await held;
    await second;
    await expect(third).rejects.toThrow("third failed");
    expect(events).toEqual([
      "first starts",
      "first settles",
      "second starts",
      "third starts",
    ]);
  });

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

/** A view whose probe reports the transaction open until `end()`. */
function probedView() {
  const state = { open: true, probes: 0 };
  const view = createTransactionView({
    stateAfterFailure: () => {
      state.probes += 1;
      return state.open ? "open" : "ended";
    },
  });
  return {
    view,
    state,
    end: () => {
      state.open = false;
    },
  };
}

function rejectsWith(failure: Error): () => Promise<never> {
  return () => Promise.reject(failure);
}

describe("createTransactionView after a statement failure", () => {
  it("refuses every later statement with TransactionRolledBackError once a failure ended the transaction, and makes it the outcome", async () => {
    const { view, end } = probedView();
    const failure = new Error("trigger raised ROLLBACK");
    await expect(
      view.admit(() => {
        end();
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    let ran = false;
    const later = view.admit(() => {
      ran = true;
      return Promise.resolve();
    });
    await expect(later).rejects.toThrow(TransactionRolledBackError);
    await expect(later).rejects.toMatchObject({
      details: { detectedBy: "statement-failure", conflict: false },
      cause: failure,
    });
    expect(ran).toBe(false);
    const outcome = await view.drainAndClose();
    expect(outcome).toBeInstanceOf(TransactionRolledBackError);
    expect(outcome?.cause).toBe(failure);
    // Closed by the boundary: a statement after it is a late one.
    await expect(view.admit(() => Promise.resolve())).rejects.toThrow(
      TransactionClosedError,
    );
  });

  it("observes a failure a synchronous driver throws from the call itself, and rethrows it synchronously", async () => {
    const { view, end } = probedView();
    const failure = new Error("thrown by a synchronous driver");
    expect(() =>
      view.admit(() => {
        end();
        throw failure;
      }),
    ).toThrow(failure);
    await expect(view.admit(() => Promise.resolve())).rejects.toThrow(
      TransactionRolledBackError,
    );
  });

  it("keeps admitting after a failure that left the transaction open, and asks only after failures", async () => {
    const { view, state } = probedView();
    await view.admit(() => Promise.resolve());
    expect(state.probes).toBe(0);
    await expect(
      view.admit(rejectsWith(new Error("constraint failed"))),
    ).rejects.toThrow("constraint failed");
    expect(state.probes).toBe(1);
    await expect(view.admit(() => Promise.resolve("row"))).resolves.toBe("row");
    await expect(view.drainAndClose()).resolves.toBeUndefined();
  });

  it.each([
    ["answers unknown", () => "unknown" as const],
    [
      "throws",
      (): never => {
        throw new Error("the probe failed");
      },
    ],
  ])(
    "refuses every later statement when the probe %s: no proof the transaction is open",
    async (_answer, stateAfterFailure) => {
      const view = createTransactionView({ stateAfterFailure });
      const failure = new Error("statement failed");
      await expect(view.admit(rejectsWith(failure))).rejects.toBe(failure);
      await expect(view.admit(() => Promise.resolve())).rejects.toThrow(
        TransactionRolledBackError,
      );
      const outcome = await view.drainAndClose();
      expect(outcome?.cause).toBe(failure);
    },
  );

  it.each([
    ["a rejection", "reject"],
    ["a synchronous throw", "throw"],
  ] as const)(
    "starts no sibling admitted in the same turn as %s until the probe has answered",
    async (_failure, mode) => {
      const answer = createGate();
      const events: string[] = [];
      const view = createTransactionView({
        stateAfterFailure: async () => {
          events.push("probe asked");
          await answer.opened;
          events.push("probe answered");
          return "ended" as const;
        },
      });
      const failure = new Error("trigger raised ROLLBACK");
      function failing(): Promise<never> {
        events.push("failing statement");
        if (mode === "throw") throw failure;
        return Promise.reject(failure);
      }
      // A synchronous throw leaves the call itself; a rejection settles later.
      let failed: Promise<Status> = Promise.resolve("rejected");
      let thrown: unknown;
      try {
        failed = statusOf(view.admit(failing));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(mode === "throw" ? failure : undefined);
      let siblingRan = false;
      const sibling = view.admit(() => {
        siblingRan = true;
        return Promise.resolve();
      });
      // The failure itself reaches its caller once the probe has answered
      // (a synchronous throw at once), and the sibling has not started.
      expect(await hasSettled(sibling)).toBe(false);
      expect(siblingRan).toBe(false);
      answer.open();
      expect(await failed).toBe("rejected");
      await expect(sibling).rejects.toThrow(TransactionRolledBackError);
      expect({ siblingRan, events }).toEqual({
        siblingRan: false,
        events: ["failing statement", "probe asked", "probe answered"],
      });
    },
  );

  it("without a probe, a failure never ends the view", async () => {
    const view = createTransactionView();
    await expect(
      view.admit(rejectsWith(new Error("statement failed"))),
    ).rejects.toThrow("statement failed");
    await expect(view.admit(() => Promise.resolve("row"))).resolves.toBe("row");
    await expect(view.drainAndClose()).resolves.toBeUndefined();
  });
});

/** A view whose engine reports the transaction open until `end()`. */
function engineView() {
  const state = { open: true, reads: 0, afterFailure: 0 };
  const view = createTransactionView({
    engineState: () => {
      state.reads += 1;
      return state.open ? "open" : "ended";
    },
    stateAfterFailure: () => {
      state.afterFailure += 1;
      return "open";
    },
  });
  return {
    view,
    state,
    end: () => {
      state.open = false;
    },
  };
}

describe("createTransactionView with the engine's own state", () => {
  it("reads the engine before every statement starts", async () => {
    const { view, state } = engineView();
    await view.admit(() => Promise.resolve());
    await view.admit(() => Promise.resolve());
    expect(state.reads).toBe(2);
  });

  it("refuses a statement after an end it never observed with TransactionOutcomeUnknownError, runs nothing, and makes it the outcome", async () => {
    const { view, end } = engineView();
    await view.admit(() => Promise.resolve());
    // A statement the view never sees (the native handle) ends the
    // transaction.
    end();
    let ran = false;
    const later = view.admit(() => {
      ran = true;
      return Promise.resolve();
    });
    await expect(later).rejects.toThrow(TransactionOutcomeUnknownError);
    await expect(later).rejects.toMatchObject({
      details: { reason: "transaction-ended" },
    });
    expect(ran).toBe(false);
    await expect(view.drainAndClose()).resolves.toBeInstanceOf(
      TransactionOutcomeUnknownError,
    );
  });

  it("finds at the boundary an end that no later statement found", async () => {
    const { view, end } = engineView();
    await view.admit(() => Promise.resolve());
    end();
    await expect(view.drainAndClose()).resolves.toBeInstanceOf(
      TransactionOutcomeUnknownError,
    );
  });

  it("attributes an end found right after a failure to that failure, asking the engine rather than the after-failure probe", async () => {
    const { view, state, end } = engineView();
    const failure = new Error("trigger raised ROLLBACK");
    await expect(
      view.admit(() => {
        end();
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    const later = view.admit(() => Promise.resolve());
    await expect(later).rejects.toThrow(TransactionRolledBackError);
    await expect(later).rejects.toMatchObject({ cause: failure });
    expect(state.afterFailure).toBe(0);
  });

  it("refuses when the engine read throws: no proof the transaction is open", async () => {
    const view = createTransactionView({
      engineState: () => {
        throw new Error("the database is closed");
      },
    });
    await expect(view.admit(() => Promise.resolve())).rejects.toThrow(
      TransactionOutcomeUnknownError,
    );
  });
});

describe("createTransactionView and typed refusals", () => {
  it("never asks the after-failure probe for a TypeGraph refusal raised after a statement succeeded", async () => {
    let asked = 0;
    const view = createTransactionView({
      stateAfterFailure: () => {
        asked += 1;
        return "unknown";
      },
    });
    const refusal = new ConfigurationError("marker missing");
    await expect(view.admit(() => Promise.reject(refusal))).rejects.toBe(
      refusal,
    );
    await expect(view.admit(() => Promise.resolve("row"))).resolves.toBe("row");
    expect(asked).toBe(0);
    await expect(view.drainAndClose()).resolves.toBeUndefined();
  });
});

describe("two views of one connection", () => {
  it("start their statements in submission order across views", async () => {
    const queue = createConnectionStatementQueue();
    const first = createTransactionView({ queue });
    const second = createTransactionView({ queue });
    const release = createGate();
    const started: string[] = [];
    function statement(name: string, held = false): () => Promise<void> {
      return async () => {
        started.push(name);
        if (held) await release.opened;
      };
    }
    const a1 = first.admit(statement("A1", true));
    const a2 = first.admit(statement("A2"));
    const b1 = second.admit(statement("B1"));
    expect(started).toEqual(["A1"]);
    release.open();
    await Promise.all([a1, a2, b1]);
    expect(started).toEqual(["A1", "A2", "B1"]);
  });

  it("waits at one view's boundary for a statement the other view submitted before it", async () => {
    const queue = createConnectionStatementQueue();
    const owner = createTransactionView({ queue });
    const adopted = createTransactionView({ queue });
    const release = createGate();
    let adoptedSettled = false;
    void adopted
      .admit(async () => {
        await release.opened;
      })
      .then(() => {
        adoptedSettled = true;
      });
    const closing = owner.drainAndClose();
    expect(await hasSettled(closing)).toBe(false);
    release.open();
    await closing;
    expect(adoptedSettled).toBe(true);
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
    "admits a held %s in its turn and waits for it before it closes",
    async (member) => {
      const { adapter, release, ran } = heldAdapter();
      const view = createSqliteTransactionExecutionView(adapter);
      // Every other member is admitted first and released at once: each
      // starts in its turn, and the drain still waits on this one alone.
      const others = STATEMENT_MEMBERS.filter((each) => each !== member);
      for (const other of others) release(other);
      const inFlight = [...others, member].map((each) =>
        STATEMENT_MEMBER_CALLS[each](view.adapter),
      );
      const drained = view.drainAndClose();
      expect(await hasSettled(drained)).toBe(false);
      expect(ran).toEqual([...others, member]);
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
