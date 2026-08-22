/**
 * Recorded stores whose every statement is captured — one Postgres-speaking,
 * one SQLite-speaking — for suites that assert statement ORDER or COUNT rather
 * than outcomes.
 *
 * ## PostgreSQL
 *
 * Captured with drizzle's `logger` rather than a backend-method Proxy: the
 * logger sees every statement the engine is actually asked to run, including
 * ones a Proxy over the port would miss (advisory locks, probes issued inside
 * a backend method, statements a nested overlay forwards).
 *
 * The engine is PGlite — in-process, no Docker, real PostgreSQL semantics. It
 * is single-connection and serial, so a genuine two-writer race is NOT
 * constructible here; what these stores certify is which statements a write
 * emits and in what ORDER. Outcome-under-contention belongs in
 * `tests/backends/postgres/**`, which needs a server for the same reason.
 *
 * ## SQLite
 *
 * Drizzle's `logger` sees NOTHING for a managed write here: SQLite writes run
 * through the prepared-statement fast path
 * (`src/backend/drizzle/execution/sqlite-execution.ts`), which drives the
 * `better-sqlite3` client directly and bypasses drizzle's session entirely —
 * measured, not assumed: `drizzle(betterSqlite3Db, { logger })` logs zero
 * statements for `store.nodes.X.create()`.
 *
 * Capture instead wraps the CLIENT: a Proxy over the raw `better-sqlite3`
 * `Database` whose `prepare(sql)` returns a Proxy recording every
 * `all`/`run`/`get`/`iterate` EXECUTION. Execution, not `prepare()` calls — the
 * backend caches prepared statements in its own LRU
 * (`getOrCreatePreparedStatement`), so a statement issued twice against one
 * cache entry must count twice, and counting `prepare()` calls would miss both.
 * This also surfaces `BEGIN IMMEDIATE` / `COMMIT`, which
 * `tests/perf/statement-classes.ts` classifies as `transactionControl` rather
 * than payload.
 *
 * ## Schema mode
 *
 * `RecordedStoreOptions.schema` selects which store constructor builds the
 * recorded store. `"uncommitted"` (the default, `createRecordedPostgresStore`'s
 * unchanged behavior) is `createStore` — no schema is committed, so
 * `lockSchemaVersionForStoreWrite` returns before issuing anything
 * (`schemaVersion` is `undefined`). `"committed"` is `createStoreWithSchema`,
 * which commits a schema version and makes every subsequent managed write pay
 * the schema-version fence — the shape `tests/perf/write-pipeline-statement-
 * budget.test.ts` and `tests/perf/claim-fence-overhead.test.ts` need, since a
 * budget measured against an unmanaged store would silently omit that
 * statement.
 *
 * Every client is closed after the test that created it, so a suite only has
 * to import this module to inherit the cleanup.
 */
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach } from "vitest";

import { type GraphDef } from "../src";
import {
  generatePostgresDDL,
  generateSqliteDDL,
} from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { createSqliteBackend } from "../src/backend/sqlite";
import { type GraphBackend } from "../src/backend/types";
import { createStore, createStoreWithSchema, type Store } from "../src/store";

/** One statement as drizzle's logger — or the SQLite recording Proxy — reports it. */
export type LoggedStatement = Readonly<{
  query: string;
  params: readonly unknown[];
}>;

export type RecordedStore<TGraph extends GraphDef> = Readonly<{
  store: Store<TGraph>;
  backend: GraphBackend;
  /** Every statement recorded since the last `reset()`, in issue order. */
  statements: readonly LoggedStatement[];
  /** Drops the recording so the next assertion sees one write's statements. */
  reset: () => void;
}>;

/** Kept for existing callers: every one of them wants the PostgreSQL shape. */
export type RecordedPostgresStore<TGraph extends GraphDef> =
  RecordedStore<TGraph>;

export type RecordedStoreOptions = Readonly<{
  /**
   * `"uncommitted"` (default): `createStore`, unchanged from this module's
   * original behavior. `"committed"`: `createStoreWithSchema`, so
   * `schemaVersion` is defined and every managed write pays the
   * schema-version fence.
   */
  schema?: "committed" | "uncommitted";
}>;

/** Any client this module opens, closed the same way regardless of driver. */
type RecordedClient = Readonly<{ close: () => unknown }>;

const clients: RecordedClient[] = [];

afterEach(async () => {
  const pending = clients.splice(0);
  for (const client of pending.toReversed()) await client.close();
});

async function buildStore<TGraph extends GraphDef>(
  graph: TGraph,
  backend: GraphBackend,
  options: RecordedStoreOptions,
): Promise<Store<TGraph>> {
  if ((options.schema ?? "uncommitted") === "committed") {
    const [store] = await createStoreWithSchema(graph, backend);
    return store;
  }
  return createStore(graph, backend);
}

/** A fresh PGlite client with TypeGraph's schema, and a backend over it — no store. */
export type RecordedPglite = Readonly<{
  client: PGlite;
  backend: GraphBackend;
  /** Every statement recorded since the last `reset()`, in issue order. */
  statements: readonly LoggedStatement[];
  /** Drops the recording so the next assertion sees one write's statements. */
  reset: () => void;
}>;

/**
 * Creates a fresh PGlite database with TypeGraph's schema and a Postgres
 * backend over it, recording every statement issued through drizzle's
 * `logger`. One owner of PGlite creation, DDL application, logger wiring and
 * client cleanup: {@link createRecordedPostgresStore} delegates to this
 * rather than repeating the setup with a store bolted on.
 *
 * Exposes the raw `client` because `EXPLAIN` needs to run directly against
 * it — a store's backend has no `EXPLAIN` surface, and a captured statement's
 * SQL text is exactly what `client.query("EXPLAIN ... " + sql, params)` wants.
 */
export async function createRecordedPglite(): Promise<RecordedPglite> {
  const client = await PGlite.create();
  clients.push(client);
  await client.exec(generatePostgresDDL().join("\n\n"));

  const statements: LoggedStatement[] = [];
  const backend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(query: string, params: unknown[]): void {
          statements.push({ query, params });
        },
      },
    }),
    { vector: false },
  );

  return {
    client,
    backend,
    statements,
    reset: () => {
      statements.splice(0);
    },
  };
}

/**
 * Creates a fresh PGlite database with TypeGraph's schema, a Postgres backend
 * over it, and a live store for `graph` — recording every statement issued.
 * Delegates to {@link createRecordedPglite} for the client/backend/logger
 * setup rather than repeating it, so PGlite creation has exactly one owner.
 */
export async function createRecordedPostgresStore<TGraph extends GraphDef>(
  graph: TGraph,
  options: RecordedStoreOptions = {},
): Promise<RecordedStore<TGraph>> {
  const { backend, statements, reset } = await createRecordedPglite();

  return {
    store: await buildStore(graph, backend, options),
    backend,
    statements,
    reset,
  };
}

/**
 * The one `Database` method every executed statement passes through, wrapped
 * with recording. `iterate()` is included even though the managed write paths
 * never call it: omitting it would silently under-record a caller that does.
 */
const RECORDED_STATEMENT_METHODS = ["all", "run", "get", "iterate"] as const;
type RecordedStatementMethod = (typeof RECORDED_STATEMENT_METHODS)[number];

/**
 * Patches ONE prepared statement's own `all`/`run`/`get`/`iterate` properties
 * so every call records its execution before delegating to the real method,
 * then returns the SAME object.
 *
 * Deliberately a monkey-patch, never a `Proxy`: better-sqlite3's `Statement`
 * is a native binding, and some of its methods (`raw()`, `pluck()`) return
 * `this` rather than a new object. A `Proxy` wrapper breaks BOTH ways on that
 * shape — calling a native method through the proxy receiver throws "Illegal
 * invocation" (measured: `stmt.raw().all(...)`, which drizzle's own array-mode
 * read path uses, fails exactly this way), and even where the native call
 * tolerates it, `raw()`'s `this`-returning contract would hand back the
 * UNWRAPPED statement, silently losing the wrapper for every call chained off
 * it. Assigning own properties keeps one object throughout, so a chained call
 * off `raw()` still lands on ITS SAME patched `all`.
 *
 * The backend caches whatever `prepare()` returns (see the LRU in
 * `sqlite-execution.ts`), so patching here — once, at `prepare()` — makes
 * every later cache hit record too, which is what turns this into an
 * EXECUTION count rather than a `prepare()` count.
 */
function recordPreparedStatement(
  prepared: Database.Statement,
  sqlText: string,
  statements: LoggedStatement[],
): Database.Statement {
  const mutable = prepared as unknown as Record<
    RecordedStatementMethod,
    (...params: readonly unknown[]) => unknown
  >;
  for (const method of RECORDED_STATEMENT_METHODS) {
    const original = mutable[method].bind(prepared);
    mutable[method] = (...params: readonly unknown[]): unknown => {
      statements.push({ query: sqlText, params });
      return original(...params);
    };
  }
  return prepared;
}

/**
 * Patches the raw `better-sqlite3` client's own `prepare` property so every
 * call returns a recording-patched prepared statement, then returns the SAME
 * client. Every other member (`pragma`, `exec`, `transaction`, …) is
 * untouched — this module owns the client outright (built fresh for one
 * recorded store), so mutating it in place carries no aliasing risk, and
 * leaving the rest of the surface genuinely native is what keeps this client
 * indistinguishable from the real one to `resolveSqliteClient` /
 * `isBetterSqlite3Client` in `src/backend/drizzle/execution/sqlite-execution.ts`.
 */
function recordingSqliteClient(
  real: Database.Database,
  statements: LoggedStatement[],
): Database.Database {
  const originalPrepare = real.prepare.bind(real);
  const mutable = real as unknown as Record<
    "prepare",
    (sqlText: string) => Database.Statement
  >;
  mutable.prepare = (sqlText: string): Database.Statement =>
    recordPreparedStatement(originalPrepare(sqlText), sqlText, statements);
  return real;
}

/**
 * Creates a fresh in-memory `better-sqlite3` database with TypeGraph's schema,
 * a SQLite backend over a recording client, and a live store for `graph` —
 * recording every STATEMENT EXECUTION issued (see the module doc for why this
 * cannot be drizzle's `logger`, as the PostgreSQL constructor above uses).
 */
export async function createRecordedSqliteStore<TGraph extends GraphDef>(
  graph: TGraph,
  options: RecordedStoreOptions = {},
): Promise<RecordedStore<TGraph>> {
  const client = new Database(":memory:");
  clients.push(client);
  for (const statement of generateSqliteDDL()) client.exec(statement);

  const statements: LoggedStatement[] = [];
  const backend = createSqliteBackend(
    drizzleSqlite(recordingSqliteClient(client, statements)),
    { executionProfile: { isSync: true } },
  );

  const store = await buildStore(graph, backend, options);
  return {
    store,
    backend,
    statements,
    reset: () => {
      statements.splice(0);
    },
  };
}
