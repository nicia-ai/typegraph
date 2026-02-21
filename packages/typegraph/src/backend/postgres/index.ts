/**
 * PostgreSQL backend for TypeGraph.
 *
 * Provides the Drizzle-based PostgreSQL backend and DDL generation utilities.
 * Use `generatePostgresMigrationSQL()` to get the full DDL including
 * `CREATE EXTENSION IF NOT EXISTS vector` for pgvector support.
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

// Drizzle PostgreSQL backend
export {
  createPostgresBackend,
  createPostgresTables,
  type PostgresBackendOptions,
  type PostgresTableNames,
  type PostgresTables,
  tables,
} from "../drizzle/postgres";

// Schema: table definitions and factory options
export {
  type CreatePostgresTablesOptions,
  edges,
  embeddings,
  nodes,
  schemaVersions,
  uniques,
} from "../drizzle/schema/postgres";

// DDL generation
export {
  generatePostgresDDL,
  generatePostgresMigrationSQL,
} from "../drizzle/ddl";
