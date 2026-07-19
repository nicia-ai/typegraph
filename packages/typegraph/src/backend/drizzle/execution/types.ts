import { type SQL as DrizzleSql, sql as drizzleSql } from "drizzle-orm";

import { bindSqlValue } from "../../../query/dialect/profile";
import { type SqlDialect } from "../../../query/dialect/types";
import {
  isSqlFragment,
  renderSql,
  type SqlFragment,
  throwUnsupportedSqlChunk,
} from "../../../query/sql-fragment";

export type ExecutableSql = DrizzleSql | SqlFragment;

export type CompiledSqlQuery = Readonly<{
  params: readonly unknown[];
  sql: string;
}>;

export type PreparedSqlStatement = Readonly<{
  execute: <TRow>(params: readonly unknown[]) => Promise<readonly TRow[]>;
}>;

export type SqlExecutionAdapter = Readonly<{
  compile: (query: ExecutableSql) => CompiledSqlQuery;
  execute: <TRow>(query: ExecutableSql) => Promise<readonly TRow[]>;
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
  sqlToQuery: (query: DrizzleSql) => CompiledSqlQuery;
}>;

type DatabaseWithCompiler = Readonly<{
  dialect?: SqlCompiler;
}>;

type BackendName = "PostgreSQL" | "SQLite";

const DIALECT_BY_BACKEND_NAME = {
  PostgreSQL: "postgres",
  SQLite: "sqlite",
} as const satisfies Record<BackendName, SqlDialect>;

export function compileQueryWithDialect(
  db: unknown,
  query: ExecutableSql,
  backendName: BackendName,
): CompiledSqlQuery {
  if (isSqlFragment(query)) {
    return renderSql(query, DIALECT_BY_BACKEND_NAME[backendName]);
  }
  const databaseWithCompiler = db as DatabaseWithCompiler;
  const compiler = databaseWithCompiler.dialect;
  if (compiler === undefined) {
    throw new Error(`${backendName} backend is missing a SQL compiler`);
  }
  return compiler.sqlToQuery(query);
}

/**
 * Translates TypeGraph's fragment IR into Drizzle's adapter-native SQL object.
 *
 * Most execution paths render directly to text and parameters. Async SQLite
 * drivers expose only Drizzle's execution method, so that adapter needs this
 * lossless bridge at its final boundary.
 */
export function toDrizzleSql(
  fragment: SqlFragment,
  dialect: SqlDialect,
): DrizzleSql {
  const chunks = fragment.chunks.map((chunk) => {
    switch (chunk.kind) {
      case "text": {
        return drizzleSql.raw(chunk.value);
      }
      case "identifier": {
        // Drizzle's schema builders treat Name chunks as bare index-column
        // references and omit dialect quoting. Preserve the portable IR's
        // identifier semantics by handing the adapter an already-quoted,
        // trusted SQL token instead.
        return drizzleSql.raw(`"${chunk.value.replaceAll('"', '""')}"`);
      }
      case "parameter": {
        return drizzleSql.param(bindSqlValue(chunk.value, dialect));
      }
      case "placeholder": {
        return drizzleSql.placeholder(chunk.value.name);
      }
      default: {
        return throwUnsupportedSqlChunk(chunk);
      }
    }
  });
  return drizzleSql.join(chunks);
}
