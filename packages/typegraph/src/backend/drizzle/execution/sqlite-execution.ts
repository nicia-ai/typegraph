import { type SQL, sql } from "drizzle-orm";
import { type BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import {
  D1_MAX_BIND_PARAMETERS,
  DURABLE_OBJECT_MAX_BIND_PARAMETERS,
  MODERN_SQLITE_MAX_BIND_PARAMETERS,
  SQLITE_MAX_BIND_PARAMETERS,
} from "../../types";
import { getOrCreateLru } from "./lru";
import {
  type CompiledSqlQuery,
  compileQueryWithDialect,
  type PreparedSqlStatement,
  type SqlExecutionAdapter,
} from "./types";

const DEFAULT_PREPARED_STATEMENT_CACHE_MAX = 256;

type PreparedAllStatement = Readonly<{
  all: (...params: readonly unknown[]) => readonly unknown[];
  /**
   * Executes a statement that returns no rows. better-sqlite3 and
   * bun:sqlite both expose it; better-sqlite3 additionally REQUIRES it for
   * non-reader statements (`all()` on those throws).
   */
  run?: (...params: readonly unknown[]) => unknown;
  /**
   * better-sqlite3's "does this statement return rows" flag. bun:sqlite
   * has no equivalent; `undefined` is treated as non-reader on the run
   * path (bun's `run()` accepts any statement).
   */
  reader?: boolean;
}>;

type SqliteClientWithPrepare = Readonly<{
  prepare: (sqlText: string) => PreparedAllStatement;
}>;

type SqliteClientCarrier = Readonly<{ $client?: unknown }>;

type DurableObjectSqlApi = Readonly<{
  exec: (...args: readonly unknown[]) => unknown;
}>;

/**
 * Runtime shape of the Durable Object storage client exposed as
 * `drizzle(ctx.storage).$client`. Structural because Drizzle does not export
 * this client type and constructor names are not stable under bundling.
 */
export type DurableObjectStorageClient = Readonly<{
  sql: DurableObjectSqlApi;
  transaction: <Result>(run: () => Promise<Result>) => Promise<Result>;
  transactionSync: <Result>(run: () => Result) => Result;
}>;

export type SqliteHostedPlatform = "d1" | "durable-object";

type SessionLike = Readonly<{
  constructor?: Readonly<{
    name?: string;
  }>;
}>;

type DatabaseWithSession = Readonly<{
  _?: Readonly<{
    session?: SessionLike;
  }>;
  session?: SessionLike;
}>;

/**
 * Controls how the backend manages SQLite transactions.
 *
 * - `"sql"`:     TypeGraph issues BEGIN / COMMIT / ROLLBACK SQL directly on
 *                the connection. Default for sync drivers (better-sqlite3,
 *                bun:sqlite); also selected by `createLibsqlBackend` for
 *                local `@libsql/client` connections (`file:` / `:memory:`),
 *                whose `client.transaction()` permanently abandons the
 *                current connection — fatal for an in-memory database.
 * - `"drizzle"`: Delegates to Drizzle's `db.transaction()` method.
 *                Default for async drivers (remote libsql/Turso, sql.js).
 * - `"do-sqlite"`: Delegates to the Cloudflare Durable Objects async
 *                storage transaction runner (`db.$client.transaction`,
 *                i.e. `ctx.storage.transaction(async ...)`). Drizzle's
 *                own `db.transaction()` on DO is
 *                `ctx.storage.transactionSync` and cannot span `await`,
 *                so it is deliberately not used. Auto-detected for
 *                `drizzle(ctx.storage)` (#140).
 * - `"none"`:    Transactions disabled. Default for Cloudflare D1
 *                (`D1Database.batch` is transactional but not an
 *                interactive runner — tracked separately).
 */
export type SqliteTransactionMode = "sql" | "drizzle" | "none" | "do-sqlite";

export type SqliteExecutionProfileHints = Readonly<{
  isSync?: boolean;
  transactionMode?: SqliteTransactionMode;
}>;

type SqliteExecutionAdapterOptions = Readonly<{
  profileHints?: SqliteExecutionProfileHints;
  statementCacheMax?: number;
}>;

export type AnySqliteDatabase = BaseSQLiteDatabase<"sync" | "async", unknown>;

export type SqliteExecutionProfile = Readonly<{
  /** Hosted runtime detected independently of caller-supplied hints. */
  hostedPlatform?: SqliteHostedPlatform;
  /** Platform ceiling that capability overrides may lower but never raise. */
  hardMaxBindParameters?: number;
  isSync: boolean;
  /**
   * Detected per-statement bound-parameter ceiling for this connection:
   * Cloudflare's documented D1 / Durable Objects cap, the probed
   * `SQLITE_MAX_VARIABLE_NUMBER` on synchronous drivers, or the conservative
   * 999 floor when the limit cannot be probed (async/remote drivers).
   */
  maxBindParameters: number;
  supportsCompiledExecution: boolean;
  transactionMode: SqliteTransactionMode;
}>;

export type SqliteExecutionAdapter = Readonly<
  SqlExecutionAdapter & {
    clearStatementCache: () => void;
    profile: SqliteExecutionProfile;
    /**
     * Executes a compiled statement that returns no rows through the
     * prepared-statement cache. Present only on synchronous drivers with a
     * preparable client — the CRUD write path falls back to drizzle's
     * `db.run()` when absent.
     */
    executeCompiledRun?: (compiledQuery: CompiledSqlQuery) => Promise<void>;
    /** Rebinds one cached non-reader statement for every parameter row. */
    executePreparedRunBatch?: (
      sqlText: string,
      params: readonly (readonly unknown[])[],
    ) => Promise<void>;
  }
>;

function getSessionName(db: AnySqliteDatabase): string | undefined {
  const databaseWithSession = db as DatabaseWithSession;
  const primarySessionName = databaseWithSession.session?.constructor?.name;
  if (primarySessionName !== undefined) {
    return primarySessionName;
  }

  return databaseWithSession._?.session?.constructor?.name;
}

function isD1DatabaseBySessionName(db: AnySqliteDatabase): boolean {
  return getSessionName(db) === "SQLiteD1Session";
}

function isDurableObjectBySessionName(db: AnySqliteDatabase): boolean {
  const sessionName = getSessionName(db);
  // drizzle-orm/durable-sqlite's session class is `SQLiteDOSession`
  // (verified drizzle 0.45.x). `SQLiteDurableObjectSession` is kept as
  // a defensive alias against future drizzle renames.
  return (
    sessionName === "SQLiteDOSession" ||
    sessionName === "SQLiteDurableObjectSession"
  );
}

function isDurableObjectStorageClient(
  value: unknown,
): value is DurableObjectStorageClient {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const sqlApi = candidate.sql;
  return (
    typeof candidate.transaction === "function" &&
    typeof candidate.transactionSync === "function" &&
    typeof sqlApi === "object" &&
    sqlApi !== null &&
    typeof (sqlApi as Record<string, unknown>).exec === "function"
  );
}

/**
 * Returns the real Durable Object storage client when the Drizzle connection
 * exposes its distinctive async + sync transaction runners and SQL API.
 * Requiring the full shape avoids mistaking better-sqlite3's transaction
 * wrapper factory for the Durable Object async runner.
 */
export function getDurableObjectStorageClient(
  db: AnySqliteDatabase,
): DurableObjectStorageClient | undefined {
  const client = (db as SqliteClientCarrier).$client;
  return isDurableObjectStorageClient(client) ? client : undefined;
}

function detectHostedPlatform(
  db: AnySqliteDatabase,
): SqliteHostedPlatform | undefined {
  if (
    getDurableObjectStorageClient(db) !== undefined ||
    isDurableObjectBySessionName(db)
  ) {
    return "durable-object";
  }
  if (isD1DatabaseBySessionName(db)) return "d1";
  return undefined;
}

function isSyncDatabaseBySessionName(db: AnySqliteDatabase): boolean {
  const sessionName = getSessionName(db);
  return (
    sessionName === "BetterSQLiteSession" || sessionName === "BunSQLiteSession"
  );
}

function detectSyncProfile(
  db: AnySqliteDatabase,
  profileHints: SqliteExecutionProfileHints,
  hostedPlatform: SqliteHostedPlatform | undefined,
): boolean {
  if (hostedPlatform === "durable-object") return true;
  if (hostedPlatform === "d1") return false;
  if (profileHints.isSync !== undefined) {
    return profileHints.isSync;
  }

  const sessionName = getSessionName(db);
  if (
    sessionName === "BetterSQLiteSession" ||
    sessionName === "BunSQLiteSession"
  ) {
    return true;
  }

  try {
    const probeResult = db.get(sql`SELECT 1 AS __typegraph_sync_probe__`);
    return !(probeResult instanceof Promise);
  } catch {
    return isSyncDatabaseBySessionName(db);
  }
}

function detectTransactionMode(
  profileHints: SqliteExecutionProfileHints,
  isSync: boolean,
  hostedPlatform: SqliteHostedPlatform | undefined,
): SqliteTransactionMode {
  // Hosted platform identity is authoritative. A stale hint must not disable
  // Durable Object rollback or opt D1 into unsupported interactive writes.
  if (hostedPlatform === "durable-object") return "do-sqlite";
  if (hostedPlatform === "d1") return "none";
  if (profileHints.transactionMode !== undefined) {
    return profileHints.transactionMode;
  }
  // Neither D1 nor Durable Object SQLite supports raw BEGIN/COMMIT SQL
  // through Drizzle's db.run(), and Drizzle's own db.transaction() on
  // Durable Objects is `ctx.storage.transactionSync` (cannot span an
  // await). Durable Objects expose an async storage transaction runner
  // (`ctx.storage.transaction(async ...)`, surfaced by Drizzle as
  // `db.$client.transaction`) — route those through "do-sqlite" (#140).
  // D1 has no equivalent interactive runner (only batch); it stays
  // "none" pending a separate batch-mode investigation.
  if (isSync) return "sql";
  return "drizzle";
}

// SQLITE_MAX_VARIABLE_NUMBER's compiled-in default rose from 999 to 32,766
// in SQLite 3.32.0. Builds that override the default list it in
// `PRAGMA compile_options`; builds that keep it do not, so the version
// decides the fallback.
const MAX_VARIABLE_NUMBER_COMPILE_OPTION = /^MAX_VARIABLE_NUMBER=(\d+)$/;
const FIRST_MODERN_BIND_LIMIT_MAJOR = 3;
const FIRST_MODERN_BIND_LIMIT_MINOR = 32;

function parseCompiledMaxVariableNumber(
  rows: readonly unknown[],
): number | undefined {
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const option = (row as Record<string, unknown>).compile_options;
    if (typeof option !== "string") continue;
    const match = MAX_VARIABLE_NUMBER_COMPILE_OPTION.exec(option);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

function hasModernBindLimitByVersion(rows: readonly unknown[]): boolean {
  const first = rows[0];
  if (typeof first !== "object" || first === null) return false;
  const version = (first as Record<string, unknown>).version;
  if (typeof version !== "string") return false;
  const [major = 0, minor = 0] = version
    .split(".")
    .map(Number);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return (
    major > FIRST_MODERN_BIND_LIMIT_MAJOR ||
    (major === FIRST_MODERN_BIND_LIMIT_MAJOR &&
      minor >= FIRST_MODERN_BIND_LIMIT_MINOR)
  );
}

/**
 * Resolves the connection's per-statement bound-parameter ceiling. Batch
 * chunk math derives from this value, so too high breaks batched writes at
 * runtime and too low wastes round trips (999 vs 32,766 is ~33× more
 * chunks per bulk insert).
 */
function detectHardMaxBindParameters(
  transactionMode: SqliteTransactionMode,
  hostedPlatform: SqliteHostedPlatform | undefined,
): number | undefined {
  if (
    hostedPlatform === "durable-object" ||
    transactionMode === "do-sqlite"
  ) {
    return DURABLE_OBJECT_MAX_BIND_PARAMETERS;
  }
  if (hostedPlatform === "d1") return D1_MAX_BIND_PARAMETERS;
  return undefined;
}

function detectMaxBindParameters(
  sqliteClient: SqliteClientWithPrepare | undefined,
  hardMaxBindParameters: number | undefined,
): number {
  if (hardMaxBindParameters !== undefined) return hardMaxBindParameters;
  if (sqliteClient === undefined) return SQLITE_MAX_BIND_PARAMETERS;
  try {
    const compiled = parseCompiledMaxVariableNumber(
      sqliteClient.prepare("PRAGMA compile_options").all(),
    );
    if (compiled !== undefined) return compiled;
    const isModern = hasModernBindLimitByVersion(
      sqliteClient.prepare("SELECT sqlite_version() AS version").all(),
    );
    return isModern ?
        MODERN_SQLITE_MAX_BIND_PARAMETERS
      : SQLITE_MAX_BIND_PARAMETERS;
  } catch {
    // A client that can't answer the probes keeps the conservative floor.
    return SQLITE_MAX_BIND_PARAMETERS;
  }
}

function resolveSqliteClient(
  db: AnySqliteDatabase,
): SqliteClientWithPrepare | undefined {
  const sqliteClient = (db as SqliteClientCarrier).$client;
  if (typeof sqliteClient !== "object" || sqliteClient === null) return;
  const candidate = sqliteClient as Record<string, unknown>;
  if (typeof candidate.prepare !== "function") return;
  return sqliteClient as SqliteClientWithPrepare;
}

function getOrCreatePreparedStatement(
  cache: Map<string, PreparedAllStatement>,
  sqliteClient: SqliteClientWithPrepare,
  sqlText: string,
  cacheMax: number,
): PreparedAllStatement {
  return getOrCreateLru(cache, sqlText, cacheMax, () =>
    sqliteClient.prepare(sqlText),
  );
}

// Uses unconditional `await` because Drizzle returns SQLiteRaw thenables
// that fail `instanceof Promise` checks (drizzle-team/drizzle-orm#2275).
async function executeDrizzleQuery<TRow>(
  db: AnySqliteDatabase,
  query: SQL,
): Promise<readonly TRow[]> {
  return (await db.all(query));
}

function createPreparedStatementExecutor(
  sqliteClient: SqliteClientWithPrepare,
  cache: Map<string, PreparedAllStatement>,
  sqlText: string,
  cacheMax: number,
): PreparedSqlStatement {
  return {
    execute<TRow>(params: readonly unknown[]): Promise<readonly TRow[]> {
      const preparedStatement = getOrCreatePreparedStatement(
        cache,
        sqliteClient,
        sqlText,
        cacheMax,
      );
      const rows = preparedStatement.all(...params);
      return Promise.resolve(rows as readonly TRow[]);
    },
  };
}

export function createSqliteExecutionAdapter(
  db: AnySqliteDatabase,
  statementCacheMaxOrOptions: number | SqliteExecutionAdapterOptions = {},
): SqliteExecutionAdapter {
  const options: SqliteExecutionAdapterOptions =
    typeof statementCacheMaxOrOptions === "number"
      ? { statementCacheMax: statementCacheMaxOrOptions }
      : statementCacheMaxOrOptions;
  const statementCacheMax =
    options.statementCacheMax ?? DEFAULT_PREPARED_STATEMENT_CACHE_MAX;
  const profileHints = options.profileHints ?? {};

  const hostedPlatform = detectHostedPlatform(db);
  const isSync = detectSyncProfile(db, profileHints, hostedPlatform);
  const sqliteClient = isSync ? resolveSqliteClient(db) : undefined;
  const transactionMode = detectTransactionMode(
    profileHints,
    isSync,
    hostedPlatform,
  );
  const hardMaxBindParameters = detectHardMaxBindParameters(
    transactionMode,
    hostedPlatform,
  );
  const maxBindParameters = detectMaxBindParameters(
    sqliteClient,
    hardMaxBindParameters,
  );

  const profile: SqliteExecutionProfile = {
    ...(hostedPlatform === undefined ? {} : { hostedPlatform }),
    ...(hardMaxBindParameters === undefined ?
      {}
    : { hardMaxBindParameters }),
    isSync,
    maxBindParameters,
    supportsCompiledExecution: sqliteClient !== undefined,
    transactionMode,
  };

  const compile = (query: SQL): CompiledSqlQuery =>
    compileQueryWithDialect(db, query, "SQLite");

  if (sqliteClient !== undefined) {
    const client = sqliteClient;
    const statementCache = new Map<string, PreparedAllStatement>();

    function executeCompiled<TRow>(
      compiledQuery: CompiledSqlQuery,
    ): Promise<readonly TRow[]> {
      const preparedStatement = getOrCreatePreparedStatement(
        statementCache,
        client,
        compiledQuery.sql,
        statementCacheMax,
      );
      const rows = preparedStatement.all(...compiledQuery.params);
      return Promise.resolve(rows as readonly TRow[]);
    }

    function executeCompiledRun(compiledQuery: CompiledSqlQuery): Promise<void> {
      const preparedStatement = getOrCreatePreparedStatement(
        statementCache,
        client,
        compiledQuery.sql,
        statementCacheMax,
      );
      // better-sqlite3 rejects run() on reader statements and all() on
      // non-reader statements, so pick by the statement's own flag; a
      // client without run() (or without the reader flag but returning
      // rows) drains through all() and discards.
      if (preparedStatement.run === undefined || preparedStatement.reader === true) {
        preparedStatement.all(...compiledQuery.params);
      } else {
        preparedStatement.run(...compiledQuery.params);
      }
      return Promise.resolve();
    }

    function executePreparedRunBatch(
      sqlText: string,
      parameterRows: readonly (readonly unknown[])[],
    ): Promise<void> {
      const preparedStatement = getOrCreatePreparedStatement(
        statementCache,
        client,
        sqlText,
        statementCacheMax,
      );
      if (preparedStatement.run === undefined) {
        throw new Error(
          "Trusted SQLite import requires a prepared statement run() method.",
        );
      }
      for (const params of parameterRows) {
        preparedStatement.run(...params);
      }
      return Promise.resolve();
    }

    return {
      clearStatementCache() {
        statementCache.clear();
      },
      compile,
      execute<TRow>(query: SQL): Promise<readonly TRow[]> {
        const compiledQuery = compile(query);
        return executeCompiled<TRow>(compiledQuery);
      },
      executeCompiled,
      executeCompiledRun,
      executePreparedRunBatch,
      prepare(sqlText: string): PreparedSqlStatement {
        return createPreparedStatementExecutor(
          client,
          statementCache,
          sqlText,
          statementCacheMax,
        );
      },
      profile,
    };
  }

  return {
    clearStatementCache() {
      // No-op: no statement cache in async/D1 mode
    },
    compile,
    execute<TRow>(query: SQL): Promise<readonly TRow[]> {
      return executeDrizzleQuery<TRow>(db, query);
    },
    profile,
  };
}
