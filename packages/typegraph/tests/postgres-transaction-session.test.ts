import { describe, expect, it } from "vitest";

import { type AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import { createPostgresTransactionSession } from "../src/backend/drizzle/execution/postgres-transaction-session";
import { CompilerInvariantError } from "../src/errors";
import { requireDefined } from "../src/utils/presence";

/**
 * A Drizzle transaction over a postgres-js-shaped client. Every statement the
 * pinned client runs is logged with the name of the scope that ran it, and a
 * nested `transaction()` hands out a child scope named after its parent.
 */
function fakePostgresJsTransaction(name: string, log: string[]): AnyPgDatabase {
  let children = 0;
  const client = Object.assign((): undefined => undefined, {
    unsafe: (sqlText: string): Promise<readonly unknown[]> => {
      log.push(`${name}: ${sqlText}`);
      return Promise.resolve([]);
    },
    savepoint: (): never => {
      throw new Error("The session must open scopes through Drizzle.");
    },
  });
  const transaction = {
    session: { client },
    execute: (): Promise<readonly unknown[]> => Promise.resolve([]),
    transaction: <T>(
      callback: (nested: AnyPgDatabase) => Promise<T>,
    ): Promise<T> => {
      children += 1;
      return callback(fakePostgresJsTransaction(`${name}.${children}`, log));
    },
  };
  return transaction as unknown as AnyPgDatabase;
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: requireDefined(resolve) };
}

function createRecordedSession() {
  const log: string[] = [];
  const session = createPostgresTransactionSession(
    fakePostgresJsTransaction("outer", log),
    undefined,
  );
  const executeCompiled = requireDefined(session.compiled.executeCompiled);
  return {
    log,
    run: async (sqlText: string): Promise<void> => {
      await executeCompiled({ sql: sqlText, params: [] });
    },
    enterDriverScope: requireDefined(session.enterDriverScope),
  };
}

describe("PostgreSQL transaction session driver scopes", () => {
  it("routes statements through the innermost open driver scope and back out", async () => {
    const { log, run, enterDriverScope } = createRecordedSession();

    await run("before");
    await enterDriverScope(async () => {
      await run("in scope");
      await enterDriverScope(() => run("in nested scope"));
      await run("back in scope");
    });
    await run("after");

    expect(log).toEqual([
      "outer: before",
      "outer.1: in scope",
      "outer.1.1: in nested scope",
      "outer.1: back in scope",
      "outer: after",
    ]);
  });

  it("refuses overlapping driver scopes instead of routing statements outside or into an ended scope", async () => {
    const { log, run, enterDriverScope } = createRecordedSession();
    const firstGate = deferred();
    const secondGate = deferred();

    const first = enterDriverScope(() => firstGate.promise);
    const second = enterDriverScope(async () => {
      await run("in second");
      await secondGate.promise;
    });

    firstGate.resolve();
    const firstFailure = await first.catch((error: unknown) => error);
    expect(firstFailure).toBeInstanceOf(CompilerInvariantError);
    expect(firstFailure).toMatchObject({
      details: { code: "OVERLAPPING_SAVEPOINT_SCOPES" },
    });

    // The scope opened second is still open, so it keeps its own statements.
    await run("while second is open");
    secondGate.resolve();
    await second;

    // Its exit uncovers the ended first scope: nothing may run there or leak
    // to the outer handle.
    await expect(run("after both")).rejects.toMatchObject({
      details: { code: "OVERLAPPING_SAVEPOINT_SCOPES" },
    });
    expect(log).toEqual([
      "outer.1.1: in second",
      "outer.1.1: while second is open",
    ]);
  });
});
