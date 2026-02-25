import { type SQL, sql } from "drizzle-orm";
import { type BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import {
  type CompiledSqlQuery,
  compileQueryWithDialect,
  type PreparedSqlStatement,
  type SqlExecutionAdapter,
} from "./types";

const DEFAULT_PREPARED_STATEMENT_CACHE_MAX = 256;

type PreparedAllStatement = Readonly<{
  all: (...params: readonly unknown[]) => readonly unknown[];
}>;

type SqliteClientWithPrepare = Readonly<{
  prepare: (sqlText: string) => PreparedAllStatement;
}>;

type SqliteClientCarrier = Readonly<{
  $client?: SqliteClientWithPrepare;
}>;

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
 * - `"sql"`:     TypeGraph issues BEGIN / COMMIT / ROLLBACK SQL directly.
 *                Default for sync drivers (better-sqlite3, bun:sqlite).
 * - `"drizzle"`: Delegates to Drizzle's `db.transaction()` method.
 *                Default for async drivers (libsql, sql.js).
 * - `"none"`:    Transactions disabled.
 *                Default for Cloudflare D1 and Durable Objects.
 */
export type SqliteTransactionMode = "sql" | "drizzle" | "none";

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
  isSync: boolean;
  supportsCompiledExecution: boolean;
  transactionMode: SqliteTransactionMode;
}>;

export type SqliteExecutionAdapter = Readonly<
  SqlExecutionAdapter & {
    clearStatementCache: () => void;
    profile: SqliteExecutionProfile;
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
  return sessionName === "SQLiteDurableObjectSession";
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
): boolean {
  if (profileHints.isSync !== undefined) {
    return profileHints.isSync;
  }

  const sessionName = getSessionName(db);
  if (sessionName === "BetterSQLiteSession" || sessionName === "BunSQLiteSession") {
    return true;
  }
  if (sessionName === "SQLiteD1Session") {
    return false;
  }

  try {
    const probeResult = db.get(sql`SELECT 1 AS __typegraph_sync_probe__`);
    return !(probeResult instanceof Promise);
  } catch {
    return isSyncDatabaseBySessionName(db);
  }
}

function detectTransactionMode(
  db: AnySqliteDatabase,
  profileHints: SqliteExecutionProfileHints,
  isSync: boolean,
): SqliteTransactionMode {
  if (profileHints.transactionMode !== undefined) {
    return profileHints.transactionMode;
  }
  // D1 and Durable Object SQLite do not support raw BEGIN/COMMIT SQL
  // through Drizzle's db.run(). Default to "none" because async
  // transaction callbacks are not reliably supported across sync
  // Drizzle drivers. Users can opt in to "drizzle" mode explicitly if
  // their runtime's db.transaction() handles async callbacks.
  if (isD1DatabaseBySessionName(db) || isDurableObjectBySessionName(db)) {
    return "none";
  }
  if (isSync) return "sql";
  return "drizzle";
}

function resolveSqliteClient(
  db: AnySqliteDatabase,
): SqliteClientWithPrepare | undefined {
  const databaseWithClient = db as SqliteClientCarrier;
  const sqliteClient = databaseWithClient.$client;
  if (sqliteClient?.prepare === undefined) {
    return undefined;
  }
  return sqliteClient;
}

function getOrCreatePreparedStatement(
  cache: Map<string, PreparedAllStatement>,
  sqliteClient: SqliteClientWithPrepare,
  sqlText: string,
  cacheMax: number,
): PreparedAllStatement {
  const cachedStatement = cache.get(sqlText);
  if (cachedStatement !== undefined) {
    // Promote to most-recently-used position for LRU eviction
    cache.delete(sqlText);
    cache.set(sqlText, cachedStatement);
    return cachedStatement;
  }

  const preparedStatement = sqliteClient.prepare(sqlText);
  cache.set(sqlText, preparedStatement);

  if (cache.size > cacheMax) {
    const oldestSqlText = cache.keys().next().value;
    if (typeof oldestSqlText === "string") {
      cache.delete(oldestSqlText);
    }
  }

  return preparedStatement;
}

async function executeDrizzleQuery<TRow>(
  db: AnySqliteDatabase,
  query: SQL,
): Promise<readonly TRow[]> {
  const rows = db.all(query);
  return (rows instanceof Promise ? await rows : rows) as readonly TRow[];
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

  const isSync = detectSyncProfile(db, profileHints);
  const sqliteClient = isSync ? resolveSqliteClient(db) : undefined;
  const transactionMode = detectTransactionMode(db, profileHints, isSync);

  const profile: SqliteExecutionProfile = {
    isSync,
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
