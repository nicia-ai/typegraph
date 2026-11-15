/**
 * Connection, schema and per-test reset for the node-postgres lane's test
 * database.
 *
 * One owner for the node-postgres backend suite and every slice of that lane's
 * shared integration suite: each file provisions its own database, and all of
 * them must prepare and reset it identically.
 */
import { Pool } from "pg";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { TRUNCATE_RESETTABLE_TABLES_SQL } from "./managed-tables";

const CONNECT_MAX_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 1000;
const CONNECT_TIMEOUT_MS = 5000;

const PER_FIELD_VECTOR_TABLES_SQL = String.raw`SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`;

/**
 * Opens a pool on `databaseUrl`, retrying to absorb CI startup timing.
 * Returns `undefined` when the server never answers.
 */
export async function connectPostgresLanePool(
  databaseUrl: string,
): Promise<Pool | undefined> {
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
    const pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });

    try {
      await pool.query("SELECT 1");
      return pool;
    } catch {
      await pool.end().catch(() => {
        // Ignore cleanup errors
      });

      if (attempt < CONNECT_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, CONNECT_RETRY_DELAY_MS),
        );
      }
    }
  }

  return undefined;
}

/**
 * Drops and re-creates the TypeGraph tables, leaving a clean schema.
 */
export async function recreatePostgresLaneTables(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS typegraph_revision_origins CASCADE;
    DROP TABLE IF EXISTS typegraph_recorded_clock CASCADE;
    DROP TABLE IF EXISTS typegraph_recorded_edges CASCADE;
    DROP TABLE IF EXISTS typegraph_recorded_nodes CASCADE;
    DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
    DROP TABLE IF EXISTS typegraph_edges CASCADE;
    DROP TABLE IF EXISTS typegraph_nodes CASCADE;
    DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
  `);

  // Per-(kind, field) vector tables are created lazily with a fixed,
  // dimension-typed embedding column (`vector(N)`). They are not in the
  // base migration, so the base DROP above leaves them behind. Truncating
  // (as `clearPostgresLaneData` does for row isolation) keeps the column type,
  // so a leftover `vector(3)` table from a prior run would reject a later
  // test's `vector(4)` insert. DROP them here — once, before any backend/latch
  // is created for the file — so the suite is re-runnable against a persistent
  // database (e.g. the shared dev Postgres) and order-independent across the
  // PG test files.
  await dropPerFieldVectorTables(pool);

  await pool.query(generatePostgresMigrationSQL());
}

/**
 * Drops every strategy-owned per-field vector table (`tg_vec_*`), including
 * its DiskANN/HNSW index. Used at file setup to clear stale typed tables
 * whose embedding dimension may differ from this run's schema.
 */
async function dropPerFieldVectorTables(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    PER_FIELD_VECTOR_TABLES_SQL,
  );
  for (const row of rows) {
    await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
  }
}

/**
 * Clears all data from TypeGraph tables.
 */
export async function clearPostgresLaneData(pool: Pool): Promise<void> {
  // Fulltext tables have no FKs to typegraph_nodes, so truncating the
  // parent tables alone leaves orphaned rows that leak into subsequent
  // integration tests (particularly fulltext search, where orphan rows
  // can outrank fresh ones and cause missing hits). The materialization
  // status tables also carry graph-id scoped completion markers, so stale
  // rows there can make a fresh graph cleanup look already completed.
  //
  // The durable contribution markers (#135) are cleared alongside the data so
  // each test starts genuinely un-provisioned and the integration suite's
  // per-test createStoreWithSchema re-materializes every per-field vector
  // table + marker in lockstep. Otherwise a marker could outlive a dropped
  // table and a later boot in this database would skip the CREATE.
  await pool.query(TRUNCATE_RESETTABLE_TABLES_SQL);

  // Per-(kind, field) vector tables are materialized per field, so enumerate
  // and truncate any that exist to keep embedding rows from leaking across
  // tests that reuse graph ids; createStoreWithSchema re-creates any missing.
  await truncatePerFieldVectorTables(pool);
}

/**
 * Truncates every strategy-owned per-field vector table (`tg_vec_*`)
 * currently present. Used by test cleanup since the tables are
 * materialized lazily and there is no single shared embeddings table.
 */
async function truncatePerFieldVectorTables(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    PER_FIELD_VECTOR_TABLES_SQL,
  );
  for (const row of rows) {
    await pool.query(`TRUNCATE "${row.tablename}" CASCADE`);
  }
}
