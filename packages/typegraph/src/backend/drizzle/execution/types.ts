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
