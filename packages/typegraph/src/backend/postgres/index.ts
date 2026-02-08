/**
 * PostgreSQL backend for TypeGraph.
 *
 * Re-exports from the Drizzle implementation for backwards compatibility.
 *
 * @example
 * ```typescript
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { Pool } from "pg";
 * import { createPostgresBackend, tables } from "@nicia-ai/typegraph/postgres";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = drizzle(pool);
 * const backend = createPostgresBackend(db, { tables });
 * ```
 */

// Re-export everything from the Drizzle PostgreSQL implementation
export {
  createPostgresBackend,
  createPostgresTables,
  type PostgresBackendOptions,
  type PostgresTables,
  type TableNames,
  tables,
} from "../drizzle/postgres";

// Re-export individual tables for schema usage
export {
  edges,
  embeddings,
  nodes,
  schemaVersions,
  uniques,
} from "../drizzle/schema/postgres";

// Re-export migration SQL generation
export { getPostgresMigrationSQL } from "../drizzle/test-helpers";
