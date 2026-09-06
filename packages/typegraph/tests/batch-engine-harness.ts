/**
 * Real-engine harnesses for the two bundled "closed batch" transports: D1
 * (`D1Database.batch`) and Neon HTTP (`NeonQueryFunction.transaction`).
 *
 * Every existing D1/Neon test fixture in this package is a hand-scripted
 * mock: `batch()`/`transaction()` return canned rows chosen by matching
 * substrings of the SQL text. That proves the SQL a program emits, never
 * that the transport actually behaves the way the design relies on — in
 * particular, that a failing statement rolls back every statement that ran
 * earlier in the same batch. These harnesses back the driver-level surface
 * each transport exposes with a REAL engine (better-sqlite3 for D1, PGlite
 * for Neon HTTP), wrapped by the bundled factories exactly as a production
 * D1 or Neon HTTP deployment would be, so the atomicity, error shapes, and
 * row contents under test are the engine's own.
 *
 * Each harness also hands back a second, genuinely INTERACTIVE backend over
 * the SAME physical database — real `drizzle-orm/better-sqlite3` /
 * `drizzle-orm/pglite`, not the batch-shaped client — because schema commits
 * and version bumps refuse on a backend with no interactive transactions.
 * Tests that need to move the active schema version out from under the
 * batch-shaped backend do it through this second handle.
 */
import { PGlite } from "@electric-sql/pglite";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3 } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";

import { markBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
import {
  generateSqliteMigrationSQL,
  generateVectorlessPostgresMigrationSQL,
} from "../src/backend/drizzle/ddl";
import { type AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import { type AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import {
  createPostgresBackend,
  type PostgresBackendOptions,
  type PostgresTables,
  tables as defaultPostgresTables,
} from "../src/backend/drizzle/postgres";
import {
  createSqliteBackend,
  type SqliteBackendOptions,
  type SqliteTables,
  tables as defaultSqliteTables,
} from "../src/backend/drizzle/sqlite";
import { type GraphBackend } from "../src/backend/types";

/** A backend under test, paired with an interactive handle over the same engine. */
export type BatchEngineHarness = Readonly<{
  /** The bundled backend over the batch-shaped driver: no interactive transactions. */
  backend: GraphBackend;
  /**
   * A real interactive backend over the SAME physical database. Schema
   * commits and version bumps run through this handle — `backend` above
   * refuses them, exactly as a production D1/Neon HTTP deployment would.
   */
  interactiveBackend: GraphBackend;
  close: () => Promise<void>;
}>;

// ============================================================
// D1: prepare(sql).bind(...params) / batch(statements)
// ============================================================

/**
 * The bound-statement shape Cloudflare's `D1PreparedStatement.bind(...)`
 * returns: an object usable both as an independent statement (`.all()` /
 * `.run()` / `.raw()`) and, unexecuted, as one member of a
 * `D1Database.batch()` array. `raw()` is D1's column-array result mode —
 * `drizzle-orm/d1`'s session uses it for a typed `.select()` query (as
 * `adoptBaseSchemaStorage`'s base-schema-marker read does), never for
 * TypeGraph's own raw-SQL `db.execute()` path.
 */
type D1HarnessBoundStatement = Readonly<{
  sql: string;
  params: readonly unknown[];
  all: () => Promise<D1HarnessResult>;
  run: () => Promise<D1HarnessResult>;
  raw: () => Promise<readonly (readonly unknown[])[]>;
}>;

type D1HarnessResult = Readonly<{
  results: readonly unknown[];
  success: true;
}>;

/**
 * Runs one statement against a real better-sqlite3 connection. Mirrors the
 * reader/non-reader choice `sqlite-execution.ts`'s `executeCompiledRun` makes
 * for the bundled synchronous backend: better-sqlite3 rejects `.all()` on a
 * statement with no result columns and `.run()` on one that has them.
 */
function runD1HarnessStatement(
  sqlite: Database.Database,
  sqlText: string,
  params: readonly unknown[],
): readonly unknown[] {
  const statement = sqlite.prepare(sqlText);
  if (statement.reader) {
    return statement.all(...params);
  }
  statement.run(...params);
  return [];
}

function bindD1HarnessStatement(
  sqlite: Database.Database,
  sqlText: string,
  params: readonly unknown[],
): D1HarnessBoundStatement {
  function execute(): Promise<D1HarnessResult> {
    return Promise.resolve({
      results: runD1HarnessStatement(sqlite, sqlText, params),
      success: true,
    });
  }
  function raw(): Promise<readonly (readonly unknown[])[]> {
    const rows = sqlite
      .prepare(sqlText)
      .raw()
      .all(...params) as readonly (readonly unknown[])[];
    return Promise.resolve(rows);
  }
  return { sql: sqlText, params, all: execute, run: execute, raw };
}

/**
 * Cloudflare's documented `D1Database.batch()` contract: every statement runs
 * in order; if any statement fails, the whole batch is aborted and none of
 * its writes are applied. Modeled here as one `BEGIN` / `COMMIT` /
 * `ROLLBACK` around the real connection driving every other statement this
 * harness runs, so a failing statement rolls back its own chunk AND every
 * chunk that ran earlier in the SAME `batch()` call — not a canned
 * per-statement result standing in for that guarantee.
 */
function runD1HarnessBatch(
  sqlite: Database.Database,
  statements: readonly D1HarnessBoundStatement[],
): Promise<readonly D1HarnessResult[]> {
  sqlite.exec("BEGIN");
  try {
    const results = statements.map((statement) => ({
      results: runD1HarnessStatement(sqlite, statement.sql, statement.params),
      success: true as const,
    }));
    sqlite.exec("COMMIT");
    return Promise.resolve(results);
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

/**
 * A fake `D1Database`, backed by a real better-sqlite3 connection instead of
 * a canned response. `prepare` mirrors D1's two-step prepare-then-bind API;
 * `batch` mirrors D1's documented all-or-nothing transport (see
 * {@link runD1HarnessBatch}).
 */
function createD1HarnessClient(sqlite: Database.Database) {
  return {
    prepare(sqlText: string) {
      return {
        bind(...params: readonly unknown[]): D1HarnessBoundStatement {
          return bindD1HarnessStatement(sqlite, sqlText, params);
        },
      };
    },
    batch(statements: readonly D1HarnessBoundStatement[]) {
      return runD1HarnessBatch(sqlite, statements);
    },
  };
}

export type D1BatchHarnessOptions = Readonly<{
  tables?: SqliteTables;
  capabilities?: SqliteBackendOptions["capabilities"];
}>;

/**
 * Builds a D1-shaped batch backend and a real interactive SQLite backend
 * over the SAME in-memory better-sqlite3 connection.
 *
 * `createSqliteBackend` detects the harness client as D1 through
 * `drizzle-orm/d1`'s OWN session — its class is genuinely named
 * `SQLiteD1Session`, not a spoofed marker — so `hostedPlatform`,
 * `transactionMode: "none"`, and `capabilities.execution.unitOfWork:
 * "batch"` are the library's real detection running against a real driver
 * shape, exactly as it would against Cloudflare's own D1Database.
 */
export function createD1BatchEngineHarness(
  options: D1BatchHarnessOptions = {},
): BatchEngineHarness {
  const tables = options.tables ?? defaultSqliteTables;
  const sqlite = new Database(":memory:");
  sqlite.exec(generateSqliteMigrationSQL(tables, false));

  const interactiveDb = drizzleBetterSqlite3(sqlite);
  const interactiveBackend = createSqliteBackend(interactiveDb, {
    tables,
    fulltext: false,
    executionProfile: { isSync: true },
  });

  const d1Client = createD1HarnessClient(sqlite);
  const d1Db = drizzleD1(
    d1Client as unknown as Parameters<typeof drizzleD1>[0],
  );
  const backend = markBundledRootAutocommitEligible(
    createSqliteBackend(d1Db as unknown as AnySqliteDatabase, {
      tables,
      fulltext: false,
      ...(options.capabilities === undefined ?
        {}
      : { capabilities: options.capabilities }),
    }),
  );

  return {
    backend,
    interactiveBackend,
    close: () => {
      sqlite.close();
      return Promise.resolve();
    },
  };
}

// ============================================================
// Neon HTTP: query(sql, params) / transaction(queries)
// ============================================================

type NeonHarnessQuerySpec = Readonly<{
  sqlText: string;
  params: readonly unknown[];
  /**
   * Mirrors the real driver's `arrayMode` query option: `drizzle-orm/neon-http`
   * passes it whenever it drives a typed `.select()` (fields are known and
   * zipped against column-array rows) and leaves it off for TypeGraph's own
   * raw-SQL `db.execute()` path, which reads named columns off object rows.
   */
  arrayMode: boolean;
}>;

type NeonHarnessRows = Readonly<{ rows: readonly unknown[] }>;

/**
 * The lazy handle `@neondatabase/serverless`'s tagged-template driver
 * returns from `.query(sql, params)`: calling it does not execute yet.
 * Awaiting it directly runs the statement autocommit (one round trip);
 * passing an array of these to `.transaction()` instead runs every one of
 * them, in order, inside ONE server-side transaction without ever resolving
 * this promise on its own — Neon's documented all-or-nothing primitive.
 * `then` is the only member either consumer needs: ordinary Drizzle reads
 * `await` it directly, and `.transaction()` below reads `__harnessQuerySpec`
 * without ever calling `.then()`, so a query passed to `.transaction()` runs
 * exactly once.
 */
type NeonHarnessQuery = PromiseLike<NeonHarnessRows> &
  Readonly<{ __harnessQuerySpec: NeonHarnessQuerySpec }>;

/** The narrow slice of PGlite's `query`/transaction-`query` this harness drives. */
type NeonHarnessSqlTarget = Readonly<{
  query: (
    sqlText: string,
    params: unknown[],
    options?: Readonly<{ rowMode?: "array" | "object" }>,
  ) => Promise<NeonHarnessRows>;
}>;

async function runNeonHarnessStatement(
  target: NeonHarnessSqlTarget,
  spec: NeonHarnessQuerySpec,
): Promise<NeonHarnessRows> {
  const result = await target.query(spec.sqlText, [...spec.params], {
    rowMode: spec.arrayMode ? "array" : "object",
  });
  return { rows: result.rows };
}

function makeNeonHarnessQuery(
  client: PGlite,
  sqlText: string,
  params: readonly unknown[],
  arrayMode: boolean,
): NeonHarnessQuery {
  const spec: NeonHarnessQuerySpec = { sqlText, params, arrayMode };
  let autocommit: Promise<NeonHarnessRows> | undefined;
  return {
    __harnessQuerySpec: spec,
    // Deliberately modeling @neondatabase/serverless's own lazy query
    // handle: awaiting it directly runs the statement autocommit, and
    // `runNeonHarnessTransaction` below never calls `.then()` on it, reading
    // `__harnessQuerySpec` instead — so a query passed to `.transaction()`
    // still runs exactly once.
    // eslint-disable-next-line unicorn/no-thenable
    then(onFulfilled, onRejected) {
      autocommit ??= runNeonHarnessStatement(client, spec);
      return autocommit.then(onFulfilled, onRejected);
    },
  };
}

/**
 * Neon's documented `transaction(queries)`: every query runs, in order,
 * inside one server-side transaction; if any fails, none of the writes are
 * applied. Modeled here as PGlite's own `transaction(callback)` — a real
 * `BEGIN`/`COMMIT`/`ROLLBACK` — driving the SAME statements the caller built
 * via {@link makeNeonHarnessQuery}, rather than a canned per-query result.
 */
async function runNeonHarnessTransaction(
  client: PGlite,
  queries: readonly NeonHarnessQuery[],
): Promise<readonly NeonHarnessRows[]> {
  return client.transaction(async (tx) => {
    const results: NeonHarnessRows[] = [];
    for (const query of queries) {
      results.push(await runNeonHarnessStatement(tx, query.__harnessQuerySpec));
    }
    return results;
  });
}

/**
 * A fake Neon HTTP client, backed by a real PGlite engine instead of a
 * canned response. Callable + `.transaction()` + no `.begin()` is exactly
 * what `isNeonHttpClient` (`postgres-execution.ts`) detects; the callable
 * form itself is a fragment-builder in the real driver and TypeGraph never
 * invokes it, so it is left unmodeled here.
 */
function createNeonHarnessClient(client: PGlite) {
  function query(
    sqlText: string,
    params: readonly unknown[] = [],
    options?: Readonly<{ arrayMode?: boolean }>,
  ): NeonHarnessQuery {
    return makeNeonHarnessQuery(
      client,
      sqlText,
      params,
      options?.arrayMode ?? false,
    );
  }
  function transaction(
    queries: readonly NeonHarnessQuery[],
  ): Promise<readonly NeonHarnessRows[]> {
    return runNeonHarnessTransaction(client, queries);
  }
  return Object.assign(
    () => {
      throw new Error(
        "This harness models @neondatabase/serverless's query()/transaction() surface only; the tagged-template call form is unused by TypeGraph.",
      );
    },
    { query, transaction },
  );
}

export type NeonHttpBatchHarnessOptions = Readonly<{
  tables?: PostgresTables;
  capabilities?: PostgresBackendOptions["capabilities"];
}>;

/**
 * Builds a Neon-HTTP-shaped batch backend and a real interactive PostgreSQL
 * backend over the SAME in-process PGlite engine.
 *
 * `createPostgresBackend` detects the harness client via `isNeonHttpClient`
 * (callable, `.transaction`, no `.begin`) exactly as it would a real
 * `neon(url)` client, so `interactiveTransactions: false`,
 * `capabilities.execution.atomicBatch: "root"`, and
 * `capabilities.execution.unitOfWork: "batch"` are the library's real
 * detection, not an asserted fixture value.
 */
export async function createNeonHttpBatchEngineHarness(
  options: NeonHttpBatchHarnessOptions = {},
): Promise<BatchEngineHarness> {
  const tables = options.tables ?? defaultPostgresTables;
  const client = await PGlite.create();
  await client.exec(generateVectorlessPostgresMigrationSQL(tables, false));

  const interactiveDb = drizzlePglite(client);
  const interactiveBackend = createPostgresBackend(interactiveDb, {
    tables,
    vector: false,
    fulltext: false,
  });

  const neonClient = createNeonHarnessClient(client);
  const neonDb = drizzleNeonHttp({
    client: neonClient as unknown as NeonQueryFunction<false, false>,
  });
  const backend = markBundledRootAutocommitEligible(
    createPostgresBackend(neonDb as unknown as AnyPgDatabase, {
      tables,
      vector: false,
      fulltext: false,
      ...(options.capabilities === undefined ?
        {}
      : { capabilities: options.capabilities }),
    }),
  );

  return {
    backend,
    interactiveBackend,
    close: () => client.close(),
  };
}
