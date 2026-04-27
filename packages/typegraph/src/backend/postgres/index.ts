/**
 * PostgreSQL backend for TypeGraph.
 *
 * Provides the Drizzle-based PostgreSQL backend and DDL generation utilities.
 * Use `generatePostgresMigrationSQL()` to get the full DDL including
 * `CREATE EXTENSION IF NOT EXISTS vector` for pgvector support.
 *
 * `createPostgresBackend` is driver-agnostic. It accepts any Drizzle
 * PostgreSQL database instance, so the same backend works across:
 *
 * - `drizzle-orm/node-postgres` (pg) — long-lived Node servers
 * - `drizzle-orm/postgres-js` (postgres-js) — Node serverless, Bun,
 *   lower per-query overhead
 * - `drizzle-orm/neon-serverless` (@neondatabase/serverless Pool over
 *   WebSockets) — edge runtimes; supports transactions
 * - `drizzle-orm/neon-http` (@neondatabase/serverless `neon(url)` over
 *   HTTP) — edge runtimes with no persistent session. Transactions are
 *   auto-disabled (HTTP can't hold a session); single-statement reads,
 *   writes, and migrations work normally. Use neon-serverless if you
 *   need atomic multi-statement operations.
 *
 * @example node-postgres
 * ```typescript
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { Pool } from "pg";
 * import { createPostgresBackend, tables } from "@nicia-ai/typegraph/postgres";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = drizzle(pool);
 * const backend = createPostgresBackend(db, { tables });
 * ```
 *
 * @example postgres-js
 * ```typescript
 * import { drizzle } from "drizzle-orm/postgres-js";
 * import postgres from "postgres";
 * import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL);
 * const backend = createPostgresBackend(drizzle(sql));
 * ```
 *
 * @example Neon serverless (edge runtimes)
 * ```typescript
 * import { Pool } from "@neondatabase/serverless";
 * import { drizzle } from "drizzle-orm/neon-serverless";
 * import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
 *
 * const pool = new Pool({ connectionString: env.NEON_DATABASE_URL });
 * const backend = createPostgresBackend(drizzle(pool));
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
