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

function heldAdapter() {
  const release = createGate();
  const ran: string[] = [];
  function held(name: string) {
    return async () => {
      ran.push(name);
      await release.opened;
      return [];
    };
  }
  const adapter = {
    clearStatementCache: () => {
      ran.push("clearStatementCache");
    },
    compile: () => ({ sql: "SELECT 1", params: [] }),
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
    prepare: () => ({ execute: held("prepare().execute") }),
    profile: {
      isSync: false,
      maxBindParameters: 999,
      orderedAggregates: false,
      supportsCompiledExecution: false,
      transactionMode: "drizzle",
    },
  } as unknown as SqliteExecutionAdapter;
  return { adapter, release, ran };
}

function callEveryStatementMember(
  adapter: SqliteExecutionAdapter,
): readonly Promise<unknown>[] {
  const query = sql`SELECT 1`;
  const compiled = { sql: "SELECT 1", params: [] };
  return [
    adapter.execute(query),
    adapter.executeAtomicBatch?.([compiled]) ?? Promise.resolve(),
    adapter.executeCompiled?.(compiled) ?? Promise.resolve(),
    adapter.executeCompiledRun?.(compiled) ?? Promise.resolve(),
    adapter.executePreparedRunBatch?.("SELECT 1", [[]]) ?? Promise.resolve(),
    adapter.executeRun(query),
    adapter.prepare?.("SELECT 1").execute([]) ?? Promise.resolve(),
  ];
}

describe("createSqliteTransactionExecutionView", () => {
  it("drains every statement member before it closes, then refuses each without running it", async () => {
    const { adapter, release, ran } = heldAdapter();
    const view = createSqliteTransactionExecutionView(adapter);
    const inFlight = callEveryStatementMember(view.adapter);
    expect(ran).toHaveLength(7);
    const drained = view.drainAndClose();
    expect(await hasSettled(drained)).toBe(false);
    release.open();
    await drained;
    await Promise.all(inFlight);

    ran.length = 0;
    const refused = await Promise.all(
      callEveryStatementMember(view.adapter).map((pending) =>
        pending.then(
          () => "fulfilled",
          (error: unknown) => error instanceof TransactionClosedError,
        ),
      ),
    );
    expect({ refused, ran }).toEqual({
      refused: Array.from({ length: 7 }, () => true),
      ran: [],
    });
  });

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
