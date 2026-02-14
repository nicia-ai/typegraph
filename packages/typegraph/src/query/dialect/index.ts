/**
 * SQL Dialect Module
 *
 * Provides dialect adapters for different SQL databases.
 * Use `getDialect()` to get the appropriate adapter for a dialect name.
 */

export { postgresDialect } from "./postgres";
export { sqliteDialect } from "./sqlite";
export type {
  DialectAdapter,
  DialectCapabilities,
  DialectRecursiveQueryStrategy,
  DialectSetOperationStrategy,
  DialectStandardQueryStrategy,
  DialectVectorPredicateStrategy,
  SqlDialect,
} from "./types";

import { postgresDialect } from "./postgres";
import { sqliteDialect } from "./sqlite";
import { type DialectAdapter, type SqlDialect } from "./types";

/**
 * Map of dialect names to their adapters.
 */
const DIALECT_ADAPTERS: Record<SqlDialect, DialectAdapter> = {
  sqlite: sqliteDialect,
  postgres: postgresDialect,
};

/**
 * Gets the dialect adapter for a given dialect name.
 *
 * @param dialect - The dialect name ("sqlite" or "postgres")
 * @returns The dialect adapter
 *
 * @example
 * ```typescript
 * const adapter = getDialect("postgres");
 * const sql = adapter.jsonExtract(column, "/name");
 * ```
 */
export function getDialect(dialect: SqlDialect): DialectAdapter {
  return DIALECT_ADAPTERS[dialect];
}

/**
 * Default dialect used when none is specified.
 */
export const DEFAULT_DIALECT: SqlDialect = "sqlite";
