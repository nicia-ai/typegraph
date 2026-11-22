/**
 * SQLite backend for TypeGraph.
 *
 * This module provides the Drizzle-based SQLite backend and DDL generation
 * utilities. It has no native dependencies and is safe to import in any
 * JavaScript runtime (Node.js, Cloudflare Workers, D1, Durable Objects).
 *
 * For a batteries-included local backend using `better-sqlite3`, import
 * from `@nicia-ai/typegraph/adapters/drizzle/sqlite/local` instead.
 *
 * @example Drizzle backend with manual setup
 * ```typescript
 * import { drizzle } from "drizzle-orm/better-sqlite3";
 * import Database from "better-sqlite3";
 * import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
 *
 * const sqlite = new Database("app.db");
 * sqlite.exec(generateSqliteMigrationSQL());
 * const db = drizzle(sqlite);
 * const backend = createSqliteBackend(db);
 * ```
 */

// Drizzle SQLite backend
export type { AnySqliteDatabase } from "../drizzle/execution";
export {
  createSqliteBackend,
  createSqliteTables,
  type SqliteBackendOptions,
  type SqliteTableNames,
  type SqliteTables,
  type SqliteTransactionMode,
  tables,
} from "../drizzle/sqlite";

// Fulltext and vector strategies for createSqliteBackend
export { fts5Strategy } from "../../query/dialect/fulltext-strategy";
export { sqliteVecStrategy } from "../../query/dialect/vector/sqlite-vec-strategy";
export type { SerializedResourceDeclaration } from "../transaction-resource";
export type {
  BundledBackendCapabilityOverrides,
  ContributionDiagnostic,
  ContributionDiagnosticState,
  ContributionRepairEntry,
  ContributionRepairResult,
} from "../types";

// Schema: table definitions and factory options
export {
  type CreateSqliteTablesOptions,
  edgeClaims,
  edges,
  nodes,
  recordedClock,
  recordedEdges,
  recordedNodes,
  schemaVersions,
  uniques,
} from "../drizzle/schema/sqlite";

// DDL generation
export type { GraphIdentityConfig } from "../../core/define-graph";
export { generateSqliteDDL, generateSqliteMigrationSQL } from "../drizzle/ddl";

/**
 * Types the public declarations name without being everyday API: exported so
 * a consumer's declaration emit can spell an inferred type through a public
 * specifier. Entrypoints whose declarations name them load this entrypoint's
 * declarations (contract 3 in `tests/public-type-reachability.test.ts`).
 */
export type { SqliteExecutionProfileHints } from "../drizzle/execution/sqlite-execution";
