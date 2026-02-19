import { type SQL } from "drizzle-orm";
import { type PgDatabase, type PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  type CompiledSqlQuery,
  compileQueryWithDialect,
  type PreparedSqlStatement,
  type SqlExecutionAdapter,
} from "./types";

type PgQueryResult = Readonly<{
  rows: readonly unknown[];
}>;

type PgQueryClient = Readonly<{
  query: (sqlText: string, params: readonly unknown[]) => Promise<PgQueryResult>;
}>;

type PgClientCarrier = Readonly<{
  $client?: PgQueryClient;
}>;

export type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export type PostgresExecutionAdapter = SqlExecutionAdapter;

function resolvePgClient(db: AnyPgDatabase): PgQueryClient | undefined {
  const databaseWithClient = db as PgClientCarrier;
  const pgClient = databaseWithClient.$client;
  if (pgClient?.query === undefined) {
    return undefined;
  }
  return pgClient;
}

async function executeDrizzleQuery<TRow>(
  db: AnyPgDatabase,
  query: SQL,
): Promise<readonly TRow[]> {
  const result = (await db.execute(query)) as Readonly<{
    rows: readonly TRow[];
  }>;
  return result.rows;
}

function createPgPreparedStatement(
  pgClient: PgQueryClient,
  sqlText: string,
): PreparedSqlStatement {
  return {
    async execute<TRow>(params: readonly unknown[]): Promise<readonly TRow[]> {
      const result = await pgClient.query(sqlText, params);
      return result.rows as readonly TRow[];
    },
  };
}

export function createPostgresExecutionAdapter(
  db: AnyPgDatabase,
): PostgresExecutionAdapter {
  const pgClient = resolvePgClient(db);

  function compile(query: SQL): CompiledSqlQuery {
    return compileQueryWithDialect(db, query, "PostgreSQL");
  }

  if (pgClient === undefined) {
    return {
      compile,
      async execute<TRow>(query: SQL): Promise<readonly TRow[]> {
        return executeDrizzleQuery<TRow>(db, query);
      },
    };
  }

  const pgQueryClient = pgClient;

  async function executeCompiled<TRow>(
    compiledQuery: CompiledSqlQuery,
  ): Promise<readonly TRow[]> {
    const result = await pgQueryClient.query(
      compiledQuery.sql,
      compiledQuery.params,
    );
    return result.rows as readonly TRow[];
  }

  return {
    compile,
    async execute<TRow>(query: SQL): Promise<readonly TRow[]> {
      return executeDrizzleQuery<TRow>(db, query);
    },
    executeCompiled,
    prepare(sqlText: string): PreparedSqlStatement {
      return createPgPreparedStatement(pgQueryClient, sqlText);
    },
  };
}
