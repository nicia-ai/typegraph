import { type SQL } from "drizzle-orm";
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

export type AnySqliteDatabase = BaseSQLiteDatabase<"sync" | "async", unknown>;

export type SqliteExecutionProfile = Readonly<{
  isD1: boolean;
  isSync: boolean;
  supportsCompiledExecution: boolean;
}>;

export type SqliteExecutionAdapter = Readonly<
  SqlExecutionAdapter & {
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

function isD1Database(db: AnySqliteDatabase): boolean {
  return getSessionName(db) === "SQLiteD1Session";
}

function isSyncDatabase(db: AnySqliteDatabase): boolean {
  const sessionName = getSessionName(db);
  return (
    sessionName === "BetterSQLiteSession" || sessionName === "BunSQLiteSession"
  );
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
  statementCacheMax: number = DEFAULT_PREPARED_STATEMENT_CACHE_MAX,
): SqliteExecutionAdapter {
  const profileBase: Readonly<{
    isD1: boolean;
    isSync: boolean;
    sqliteClient: SqliteClientWithPrepare | undefined;
  }> = {
    isD1: isD1Database(db),
    isSync: isSyncDatabase(db),
    sqliteClient: resolveSqliteClient(db),
  };

  const supportsCompiledExecution =
    profileBase.isSync &&
    !profileBase.isD1 &&
    profileBase.sqliteClient !== undefined;

  const profile: SqliteExecutionProfile = {
    isD1: profileBase.isD1,
    isSync: profileBase.isSync,
    supportsCompiledExecution,
  };

  const compile = (query: SQL): CompiledSqlQuery =>
    compileQueryWithDialect(db, query, "SQLite");

  if (supportsCompiledExecution) {
    const sqliteClient = profileBase.sqliteClient;
    const statementCache = new Map<string, PreparedAllStatement>();

    function executeCompiled<TRow>(
      compiledQuery: CompiledSqlQuery,
    ): Promise<readonly TRow[]> {
      const preparedStatement = getOrCreatePreparedStatement(
        statementCache,
        sqliteClient,
        compiledQuery.sql,
        statementCacheMax,
      );
      const rows = preparedStatement.all(...compiledQuery.params);
      return Promise.resolve(rows as readonly TRow[]);
    }

    return {
      compile,
      execute<TRow>(query: SQL): Promise<readonly TRow[]> {
        const compiledQuery = compile(query);
        return executeCompiled<TRow>(compiledQuery);
      },
      executeCompiled,
      prepare(sqlText: string): PreparedSqlStatement {
        return createPreparedStatementExecutor(
          sqliteClient,
          statementCache,
          sqlText,
          statementCacheMax,
        );
      },
      profile,
    };
  }

  return {
    compile,
    execute<TRow>(query: SQL): Promise<readonly TRow[]> {
      return executeDrizzleQuery<TRow>(db, query);
    },
    profile,
  };
}
