import { type SQL } from "drizzle-orm";

export type CompiledSqlQuery = Readonly<{
  params: readonly unknown[];
  sql: string;
}>;

export type PreparedSqlStatement = Readonly<{
  execute: <TRow>(params: readonly unknown[]) => Promise<readonly TRow[]>;
}>;

export type SqlExecutionAdapter = Readonly<{
  compile: (query: SQL) => CompiledSqlQuery;
  execute: <TRow>(query: SQL) => Promise<readonly TRow[]>;
  executeCompiled?: <TRow>(
    compiledQuery: CompiledSqlQuery,
  ) => Promise<readonly TRow[]>;
  prepare?: (sqlText: string) => PreparedSqlStatement;
  /**
   * Runs `critical` with exclusive use of the connection: no statement from
   * anywhere else can interleave with the ones it issues.
   *
   * Statement-at-a-time serialization is not enough for a *sequence* that must
   * be atomic. `SET LOCAL` around a query is the motivating case — snapshot,
   * set, select, restore. Two searches whose statements merely take turns can
   * still interleave as `A snapshot → B snapshot → A set → B set → A select`,
   * and `A` then runs under `B`'s settings.
   *
   * `critical` is handed the unqueued adapter, so it must not attempt to
   * re-enter the queue. Present only on transaction-scoped (serialized)
   * adapters; a pooled adapter needs no exclusion because every statement gets
   * its own connection.
   */
  runExclusive?: <T>(
    critical: (connection: SqlExecutionAdapter) => Promise<T>,
  ) => Promise<T>;
}>;

type SqlCompiler = Readonly<{
  sqlToQuery: (query: SQL) => CompiledSqlQuery;
}>;

type DatabaseWithCompiler = Readonly<{
  dialect?: SqlCompiler;
}>;

export function compileQueryWithDialect(
  db: unknown,
  query: SQL,
  backendName: string,
): CompiledSqlQuery {
  const databaseWithCompiler = db as DatabaseWithCompiler;
  const compiler = databaseWithCompiler.dialect;
  if (compiler === undefined) {
    throw new Error(`${backendName} backend is missing a SQL compiler`);
  }
  return compiler.sqlToQuery(query);
}
