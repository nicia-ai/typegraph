/**
 * Drizzle ORM adapters for TypeGraph.
 *
 * Provides backend implementations that work with any Drizzle-supported database.
 *
 * @example
 * ```typescript
 * // SQLite
 * import { createSqliteBackend, tables } from "@nicia-ai/typegraph/drizzle/sqlite";
 *
 * // PostgreSQL
 * import { createPostgresBackend, tables } from "@nicia-ai/typegraph/drizzle/postgres";
 * ```
 */

// SQLite exports
export {
  createSqliteBackend,
  createSqliteTables,
  type SqliteBackendOptions,
  type SqliteTables,
  tables as sqliteTables,
} from "./sqlite";

// PostgreSQL exports
export {
  createPostgresBackend,
  createPostgresTables,
  type PostgresBackendOptions,
  type PostgresTables,
  tables as postgresTables,
} from "./postgres";
