/**
 * SQLite backend for TypeGraph.
 *
 * This module provides the Drizzle-based SQLite backend and DDL generation
 * utilities. It has no native dependencies and is safe to import in any
 * JavaScript runtime (Node.js, Cloudflare Workers, D1, Durable Objects).
 *
 * For a batteries-included local backend using `better-sqlite3`, import
 * from `@nicia-ai/typegraph/sqlite/local` instead.
 *
 * @example Drizzle backend with manual setup
 * ```typescript
 * import { drizzle } from "drizzle-orm/better-sqlite3";
 * import Database from "better-sqlite3";
 * import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";
 *
 * const sqlite = new Database("app.db");
 * sqlite.exec(generateSqliteMigrationSQL());
 * const db = drizzle(sqlite);
 * const backend = createSqliteBackend(db);
 * ```
 */

// Drizzle SQLite backend
export {
  createSqliteBackend,
  createSqliteTables,
  type SqliteBackendOptions,
  type SqliteTableNames,
  type SqliteTables,
  tables,
} from "../drizzle/sqlite";

// Schema: table definitions and factory options
export {
  type CreateSqliteTablesOptions,
  edges,
  embeddings,
  nodes,
  schemaVersions,
  uniques,
} from "../drizzle/schema/sqlite";

// DDL generation
export { generateSqliteDDL, generateSqliteMigrationSQL } from "../drizzle/ddl";
