/**
 * One fault injector for tests that exercise the store's retry owner against
 * a REAL backend (better-sqlite3 or PGlite), with two independent triggers
 * that both produce a genuine rollback rather than a simulated one. Neither
 * trigger evaluates anything until {@link TransactionFaultInjector.arm} is
 * called: schema bootstrap issues writes of its own (a fresh graph's schema
 * commit included) before a test's own transaction ever runs, and those must
 * complete undisturbed — call `arm()` once the store is built and the test
 * is about to run the transaction under test.
 *
 * - `failAtStatementCall`: the Nth write statement (`INSERT`/`UPDATE`/`DELETE`
 *   — reads and transaction-control statements do not count, so the two
 *   engines' differing bookkeeping reads around a managed write, such as the
 *   schema-version fence check, never shift the count) the underlying driver
 *   executes after arming, counted across every attempt, throws before the
 *   driver runs it. A managed write dispatches through whichever backend
 *   member its atomic mutation program resolves to (`insertNodeIfAbsent`,
 *   `commands.execute`, the query builder's `execute`, …), and each of those
 *   ultimately issues its SQL through the one underlying connection, so
 *   patching the driver — the way `lock-fence-test-utils.ts` patches it to
 *   log statements — is the one place that sees every one of them regardless
 *   of which member issued it. This is the shape of a conflict detected mid
 *   transaction.
 * - `failCommits`: the first N `.transaction()` invocations after arming run
 *   their callback to completion for real, then throw instead of returning —
 *   forcing the real backend to roll back a transaction that otherwise did
 *   everything right. Built through {@link deriveBackend}, over the backend
 *   the statement patch above already produced. This is the shape of a
 *   conflict an engine only discovers at COMMIT.
 */
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3 } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";

import { type GraphBackend } from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  generateSqliteMigrationSQL,
  generateVectorlessPostgresMigrationSQL,
} from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createPostgresBackend } from "../src/backend/postgres";

/** SQLSTATEs and message-only shapes the tests need to inject. */
type InjectedFaultShape = "40001" | "40P01" | "23505" | "message-only";

/**
 * Builds the error `createTransactionFaultInjector` throws at each trigger.
 * `message-only` carries no `code` at all, so `isSerializationFailure` must
 * fall back to the PostgreSQL message pattern it recognizes when no link in
 * the chain carries a code.
 */
function injectedFault(shape: InjectedFaultShape): Error {
  if (shape === "message-only") {
    return new Error("could not serialize access due to concurrent update");
  }
  const error = new Error(`injected ${shape} fault`);
  (error as Error & { code: string }).code = shape;
  return error;
}

/**
 * What `failAtStatementCall` counts: a statement that mutates a row. Reads
 * (schema/version fence checks, the query builder's own SELECTs) and
 * transaction-control statements (`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`/
 * `RELEASE`) are bookkeeping, not the unit of work under test, and the two
 * engines differ in how much of it a managed write issues.
 */
const WRITE_STATEMENT_PATTERN = /^\s*(INSERT|UPDATE|DELETE)\b/i;

export type TransactionFaultOptions = Readonly<{
  /** Shape of the error thrown at every trigger below. */
  shape: InjectedFaultShape;
  /**
   * Leading `.transaction()` invocations (1-based, counted across every
   * attempt) whose callback runs for real and then fails at the commit
   * boundary. Omit to never fail a commit.
   */
  failCommits?: number;
  /**
   * The 1-based write statement (counted across every attempt) that
   * throws before the driver runs it. Omit to never fail a statement.
   */
  failAtStatementCall?: number;
}>;

export type TransactionFaultInjector = Readonly<{
  backend: GraphBackend;
  /** Disposes the underlying engine. */
  close: () => Promise<void>;
  /**
   * Starts both triggers counting from zero. Neither fires before this is
   * called — schema bootstrap (a fresh graph's own schema commit included)
   * issues `.transaction()` calls and write statements of its own, and arming
   * only once the store under test is built and about to run the transaction
   * under test is what makes `failAtStatementCall: 1` mean that
   * transaction's own first statement rather than one of bootstrap's.
   */
  arm: () => void;
  /** Number of `.transaction()` invocations run since {@link arm}. */
  commitAttempts: () => number;
  /** Number of write statements observed since {@link arm}. */
  statementCalls: () => number;
  /** The most recently thrown fault, or `undefined` before any trigger fires. */
  lastFault: () => Error | undefined;
}>;

/** Engines {@link createTransactionFaultInjector} can build. */
export type FaultInjectableEngine = "sqlite" | "pglite";

/**
 * Builds a fresh, already-migrated backend for `engine` and wraps it with
 * both fault triggers above, disarmed until {@link TransactionFaultInjector.arm}
 * is called.
 */
export async function createTransactionFaultInjector(
  engine: FaultInjectableEngine,
  options: TransactionFaultOptions,
): Promise<TransactionFaultInjector> {
  let armed = false;
  let commitAttempts = 0;
  let statementCalls = 0;
  let lastFault: Error | undefined;

  function throwFault(): never {
    const fault = injectedFault(options.shape);
    lastFault = fault;
    throw fault;
  }

  /** Called by the driver patch below before it runs a statement. */
  function maybeFailStatement(sqlText: string): void {
    if (!armed || !WRITE_STATEMENT_PATTERN.test(sqlText)) return;
    statementCalls += 1;
    if (statementCalls === options.failAtStatementCall) throwFault();
  }

  const { target, close } = await createPatchedTargetBackend(
    engine,
    maybeFailStatement,
  );

  const backend = deriveBackend(target, {
    transaction: (fn, txOptions) =>
      target.transaction(async (tx) => {
        if (!armed) return fn(tx);
        commitAttempts += 1;
        const commitAttemptNumber = commitAttempts;
        const result = await fn(tx);
        if (
          options.failCommits !== undefined &&
          commitAttemptNumber <= options.failCommits
        ) {
          throwFault();
        }
        return result;
      }, txOptions),
  });

  return {
    backend,
    close,
    arm: () => {
      armed = true;
    },
    commitAttempts: () => commitAttempts,
    statementCalls: () => statementCalls,
    lastFault: () => lastFault,
  };
}

/**
 * Constructs `engine`'s backend over a driver whose every statement call
 * first reports through `onStatement` — the same interception point
 * `createLoggedPostgresBackend` / `createLoggedSqliteBackend`
 * (`lock-fence-test-utils.ts`) use to log statements, reused here to gate
 * them instead.
 */
async function createPatchedTargetBackend(
  engine: FaultInjectableEngine,
  onStatement: (sqlText: string) => void,
): Promise<Readonly<{ target: GraphBackend; close: () => Promise<void> }>> {
  if (engine === "sqlite") {
    const client = new Database(":memory:");
    client.exec(generateSqliteMigrationSQL());
    const originalPrepare = client.prepare.bind(client);
    client.prepare = ((sqlText: string) => {
      const statement = originalPrepare(sqlText);
      const originalAll = statement.all.bind(statement);
      const originalRun = statement.run.bind(statement);
      const originalGet = statement.get.bind(statement);
      statement.all = (...params: unknown[]) => {
        onStatement(sqlText);
        return originalAll(...params);
      };
      statement.run = (...params: unknown[]) => {
        onStatement(sqlText);
        return originalRun(...params);
      };
      statement.get = (...params: unknown[]) => {
        onStatement(sqlText);
        return originalGet(...params);
      };
      return statement;
    }) as typeof client.prepare;
    return {
      target: createSqliteBackend(drizzleBetterSqlite3(client)),
      close: () => {
        client.close();
        return Promise.resolve();
      },
    };
  }

  const client = await PGlite.create();
  await client.exec(generateVectorlessPostgresMigrationSQL());
  // A root-level statement reaches `client.query` directly; a statement
  // inside `schemaWriteTransaction`'s callback or a `store.transaction`
  // routes through Drizzle's own session instead, which only the `logger`
  // option observes — see `lock-fence-test-utils.ts`'s
  // `createLoggedPostgresBackend` for the same split.
  const originalQuery = client.query.bind(client);
  client.query = (<T>(
    sqlText: string,
    params?: unknown[],
    queryOptions?: Parameters<typeof client.query>[2],
  ) => {
    onStatement(sqlText);
    return originalQuery<T>(sqlText, params, queryOptions);
  }) as typeof client.query;
  return {
    target: createPostgresBackend(
      drizzlePglite(client, {
        logger: {
          logQuery(sqlText: string): void {
            onStatement(sqlText);
          },
        },
      }),
      { vector: false },
    ),
    close: () => client.close(),
  };
}
