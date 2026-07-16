/**
 * PostgreSQL Backend Integration Tests
 *
 * Tests the PostgreSQL adapter with a real database via Docker.
 * Requires: docker compose up -d
 *
 * Run: pnpm test:postgres
 *
 * These tests are automatically skipped if PostgreSQL is not available.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  NodeConstraintNotFoundError,
  subClassOf,
} from "../../../src";
import {
  generatePostgresDDL,
  generatePostgresMigrationSQL,
} from "../../../src/backend/drizzle/ddl";
import {
  createPostgresBackend,
  createPostgresTables,
} from "../../../src/backend/postgres";
import type {
  AdoptedTransaction,
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../../../src/backend/types";
import { rowPropsToObject } from "../../../src/backend/types";
import type { CompiledTemporaryStatementSql } from "../../../src/query/sql-intent";
import { createStore, createStoreWithSchema } from "../../../src/store";
import { createAdapterTestSuite } from "../adapter-test-suite";
import { createIntegrationTestSuite } from "../integration-test-suite";

// ============================================================
// Test Configuration
// ============================================================

// Use 127.0.0.1 instead of localhost to avoid IPv6 resolution issues
const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

// ============================================================
// Connection State
// ============================================================

let sharedPool: Pool | undefined;
let sharedDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

/**
 * Skips the current test if PostgreSQL is not available.
 * Returns narrowed pool and db references for use in the test.
 */
function requirePostgres(ctx: { skip: () => void }): {
  pool: Pool;
  db: NodePgDatabase;
} {
  if (!isPostgresAvailable || !sharedPool || !sharedDb) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { pool: sharedPool, db: sharedDb };
}

/**
 * Creates a new pool and db instance.
 * Used for tests that need isolated connections.
 */
function createConnection(): { pool: Pool; db: NodePgDatabase } {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  const db = drizzle(pool);
  return { pool, db };
}

/**
 * Checks if PostgreSQL is available and sets up the shared connection.
 * Retries connection to handle CI timing issues.
 */
async function initializePostgres(): Promise<boolean> {
  const maxRetries = 5;
  const retryDelayMs = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const testPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });

    try {
      await testPool.query("SELECT 1");
      sharedPool = testPool;
      sharedDb = drizzle(sharedPool);
      return true;
    } catch {
      await testPool.end().catch(() => {
        // Ignore cleanup errors
      });

      if (attempt < maxRetries) {
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  return false;
}

/**
 * Creates a clean test database.
 */
async function setupTestDatabase(): Promise<void> {
  if (!sharedPool) return;

  await sharedPool.query(`
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
  // (as `clearTestData` does for row isolation) keeps the column type, so a
  // leftover `vector(3)` table from a prior run would reject a later test's
  // `vector(4)` insert. DROP them here — once, before any backend/latch is
  // created for this file — so the suite is re-runnable against a persistent
  // database (e.g. the shared dev Postgres) and order-independent across the
  // serially-run PG test files.
  await dropPerFieldVectorTables(sharedPool);

  await sharedPool.query(generatePostgresMigrationSQL());
}

/**
 * Drops every strategy-owned per-field vector table (`tg_vec_*`), including
 * its DiskANN/HNSW index. Used at file setup to clear stale typed tables
 * whose embedding dimension may differ from this run's schema.
 */
async function dropPerFieldVectorTables(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const row of rows) {
    await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
  }
}

/**
 * Clears all data from TypeGraph tables.
 */
async function clearTestData(): Promise<void> {
  if (!sharedPool) return;

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
  // table on this shared database and a later boot would skip the CREATE.
  await sharedPool.query(
    `TRUNCATE typegraph_index_materializations,
              typegraph_contribution_materializations,
              typegraph_kind_removals,
              typegraph_reconciliation_markers,
              typegraph_node_fulltext,
              typegraph_revision_origins,
              typegraph_recorded_clock,
              typegraph_recorded_nodes,
              typegraph_recorded_edges,
              typegraph_nodes,
              typegraph_edges,
              typegraph_node_uniques,
              typegraph_contribution_materializations,
              typegraph_schema_versions CASCADE`,
  );

  // Per-(kind, field) vector tables are materialized per field, so enumerate
  // and truncate any that exist to keep embedding rows from leaking across
  // tests that reuse graph ids; createStoreWithSchema re-creates any missing.
  await truncatePerFieldVectorTables(sharedPool);
}

/**
 * Truncates every strategy-owned per-field vector table (`tg_vec_*`)
 * currently present. Used by test cleanup since the tables are
 * materialized lazily and there is no single shared embeddings table.
 */
async function truncatePerFieldVectorTables(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const row of rows) {
    await pool.query(`TRUNCATE "${row.tablename}" CASCADE`);
  }
}

// ============================================================
// Global Setup/Teardown
// ============================================================

beforeAll(async () => {
  // Only attempt to connect when POSTGRES_URL is explicitly set (i.e. via
  // `scripts/test-postgres.sh`). Without the gate, a developer with a
  // stray Docker Postgres container running would trigger the
  // DROP+CREATE schema setup below during `pnpm test:unit` and race with
  // other postgres test files sharing the same database.
  if (!process.env.POSTGRES_URL) return;
  isPostgresAvailable = await initializePostgres();
  if (isPostgresAvailable) {
    await setupTestDatabase();
  }
});

afterAll(async () => {
  if (sharedPool) {
    await sharedPool.end();
  }
});

// ============================================================
// Test Schema for Store Integration
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.email().optional(),
    age: z.number().int().positive().optional(),
  }),
});

const Organization = defineNode("Organization", {
  schema: z.object({
    name: z.string(),
    website: z.url().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    website: z.url().optional(),
    ticker: z.string().length(4).optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
});

const knows = defineEdge("knows");

const testGraph = defineGraph({
  id: "test_graph",
  nodes: {
    Person: { type: Person },
    Organization: { type: Organization },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Organization, Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
  ontology: [subClassOf(Company, Organization)],
});

function observeTemporaryAnalyzeStatements(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  statements: string[];
}> {
  const statements: string[] = [];
  return {
    statements,
    backend: {
      ...backend,
      transaction<T>(
        fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
        options?: TransactionOptions,
      ): Promise<T> {
        return backend.transaction(async (tx, adoptedTransaction) => {
          const observedTransaction: TransactionBackend = {
            ...tx,
            async executeTemporaryStatement(
              query: CompiledTemporaryStatementSql,
            ): Promise<void> {
              const statement = tx.compileSql!(query).sql;
              if (statement.startsWith("ANALYZE ")) statements.push(statement);
              await tx.executeTemporaryStatement!(query);
            },
          };
          return fn(observedTransaction, adoptedTransaction);
        }, options);
      },
    },
  };
}

// ============================================================
// Shared Adapter Test Suite
// ============================================================

describe("PostgreSQL Adapter", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("should be available for testing", (ctx) => {
    requirePostgres(ctx);
    expect(sharedPool).toBeDefined();
    expect(sharedDb).toBeDefined();
  });

  // Run the shared test suite using the shared connection
  describe.runIf(process.env.POSTGRES_URL)("Adapter Test Suite", () => {
    beforeEach(async () => {
      await clearTestData();
    });

    createAdapterTestSuite(
      "PostgreSQL",
      () => {
        // Create a fresh connection for each backend instance
        // This avoids issues with pool.end() being called by close()
        const { db } = createConnection();
        return createPostgresBackend(db);
      },
      { skipRawQueries: false },
    );
  });

  // Run the shared integration test suite for PostgreSQL
  describe.runIf(process.env.POSTGRES_URL)("Integration Test Suite", () => {
    beforeEach(async () => {
      await clearTestData();
    });

    createIntegrationTestSuite("PostgreSQL", () => {
      // Create a fresh connection for each backend instance
      const { pool, db } = createConnection();
      return {
        backend: createPostgresBackend(db),
        cleanup: async () => {
          await pool.end();
        },
      };
    });
  });
});

// ============================================================
// PostgreSQL-Specific Tests
// ============================================================

describe("PostgreSQL Backend - Adapter Specific", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  describe("createPostgresBackend()", () => {
    it("creates a backend with correct dialect and capabilities", (ctx) => {
      const { db } = requirePostgres(ctx);
      const backend = createPostgresBackend(db);

      expect(backend.dialect).toBe("postgres");
      expect(backend.capabilities.transactions).toBe(true);
    });

    it("runs non-vector CRUD with vector disabled (vector: false)", async (ctx) => {
      const { db } = requirePostgres(ctx);
      // A PGlite instance built without pgvector takes this path: the
      // backend must work end-to-end for ordinary graph operations — store
      // creation (schema commit + index materialization), writes, reads —
      // while advertising no vector support.
      const backend = createPostgresBackend(db, { vector: false });
      expect(backend.capabilities.vector).toBeUndefined();

      const store = createStore(testGraph, backend);
      const person = await store.nodes.Person.create({
        name: "Alice",
        email: "alice@example.com",
      });
      const fetched = await store.nodes.Person.getById(person.id);

      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Alice");
    });
  });

  describe("generatePostgresDDL()", () => {
    it("generates DDL that creates all required tables", () => {
      const ddl = generatePostgresDDL();
      const sql = ddl.join("\n");

      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "typegraph_nodes"');
      expect(sql).toContain('CREATE TABLE IF NOT EXISTS "typegraph_edges"');
      expect(sql).toContain(
        'CREATE TABLE IF NOT EXISTS "typegraph_node_uniques"',
      );
      expect(sql).toContain(
        'CREATE TABLE IF NOT EXISTS "typegraph_schema_versions"',
      );
    });

    it("uses JSONB for props columns", () => {
      const ddl = generatePostgresDDL();
      const sql = ddl.join("\n");

      expect(sql).toContain('"props" JSONB NOT NULL');
      expect(sql).toContain('"schema_doc" JSONB NOT NULL');
    });

    it("uses TIMESTAMPTZ for temporal columns", () => {
      const ddl = generatePostgresDDL();
      const sql = ddl.join("\n");

      expect(sql).toContain('"created_at" TIMESTAMPTZ NOT NULL');
      expect(sql).toContain('"valid_from" TIMESTAMPTZ');
    });

    it("includes necessary indexes", () => {
      const ddl = generatePostgresDDL();
      const sql = ddl.join("\n");

      expect(sql).toContain('"typegraph_nodes_kind_idx"');
      expect(sql).toContain('"typegraph_nodes_kind_created_idx"');
      // Bare-id node lookup (kind resolved by id) — see typegraph#280.
      expect(sql).toContain(
        '"typegraph_nodes_id_idx" ON "typegraph_nodes" ("graph_id", "id")',
      );
      expect(sql).toContain(
        '"typegraph_recorded_nodes_id_idx" ON "typegraph_recorded_nodes" ("graph_id", "id")',
      );
      expect(sql).toContain('"typegraph_edges_from_idx"');
      expect(sql).toContain('"typegraph_edges_to_idx"');
      expect(sql).toContain('"typegraph_edges_kind_created_idx"');
      expect(sql).toContain(
        '"typegraph_edges_from_idx" ON "typegraph_edges" ("graph_id", "from_kind", "from_id", "kind", "to_kind", "deleted_at", "valid_from", "valid_to", "to_id")',
      );
      expect(sql).toContain(
        '"typegraph_edges_to_idx" ON "typegraph_edges" ("graph_id", "to_kind", "to_id", "kind", "from_kind", "deleted_at", "valid_from", "valid_to", "from_id")',
      );
      expect(sql).toContain(
        '"typegraph_nodes_kind_created_idx" ON "typegraph_nodes" ("graph_id", "kind", "deleted_at", "created_at")',
      );
      expect(sql).toContain(
        '"typegraph_edges_kind_created_idx" ON "typegraph_edges" ("graph_id", "kind", "deleted_at", "created_at")',
      );
    });
  });

  describe("JSONB handling", () => {
    it("stores and retrieves complex JSON props", async (ctx) => {
      const { db } = requirePostgres(ctx);
      const backend = createPostgresBackend(db);

      const complexProps = {
        name: "Alice",
        nested: { a: 1, b: [2, 3] },
        array: ["x", "y"],
      };

      const inserted = await backend.insertNode({
        graphId: "test_graph",
        kind: "Person",
        id: "person-1",
        props: complexProps,
      });

      const parsed = rowPropsToObject(inserted.props);
      expect(parsed).toEqual(complexProps);

      const fetched = await backend.getNode("test_graph", "Person", "person-1");
      const fetchedProps = rowPropsToObject(fetched!.props);
      expect(fetchedProps).toEqual(complexProps);
    });
  });

  describe("Transaction isolation", () => {
    it("supports serializable transactions", async (ctx) => {
      const { db } = requirePostgres(ctx);
      const backend = createPostgresBackend(db);

      await backend.transaction(
        async (tx) => {
          await tx.insertNode({
            graphId: "test_graph",
            kind: "Person",
            id: "person-1",
            props: { name: "Alice" },
          });
        },
        { isolationLevel: "serializable" },
      );

      const fetched = await backend.getNode("test_graph", "Person", "person-1");
      expect(fetched).toBeDefined();
    });
  });

  describe("bootstrapTables() index adoption", () => {
    it("adds newly shipped indexes to an already-initialized database", async (ctx) => {
      const { db, pool } = requirePostgres(ctx);
      const backend = createPostgresBackend(db);
      await backend.bootstrapTables!();

      // Simulate a database initialized before the bare-id indexes shipped.
      // Bootstrap never re-runs automatically on an initialized database
      // (createStore is zero-DDL), so a one-time explicit
      // `backend.bootstrapTables()` is the documented adoption path — every
      // statement is CREATE … IF NOT EXISTS.
      await pool.query('DROP INDEX IF EXISTS "typegraph_nodes_id_idx"');
      await pool.query(
        'DROP INDEX IF EXISTS "typegraph_recorded_nodes_id_idx"',
      );

      await backend.bootstrapTables!();

      const adopted = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('typegraph_nodes', 'typegraph_recorded_nodes')`,
      );
      const names = adopted.rows.map((row) => row.indexname);
      expect(names).toContain("typegraph_nodes_id_idx");
      expect(names).toContain("typegraph_recorded_nodes_id_idx");
    });
  });

  describe("materializeSystemIndexes()", () => {
    it("adopts a physically missing system index via the CONCURRENTLY build path", async (ctx) => {
      const { db, pool } = requirePostgres(ctx);
      const backend = createPostgresBackend(db);
      const [store] = await createStoreWithSchema(testGraph, backend);

      // Simulate a database initialized by an older library version: the
      // index does not exist and no materialization row was recorded.
      await pool.query('DROP INDEX IF EXISTS "typegraph_nodes_id_idx"');
      await pool.query(
        `DELETE FROM typegraph_index_materializations WHERE index_name = 'typegraph_nodes_id_idx'`,
      );

      const { results } = await store.materializeSystemIndexes();
      const target = results.find(
        (result) => result.indexName === "typegraph_nodes_id_idx",
      );
      expect(target?.status).toBe("created");
      expect(target?.entity).toBe("system");
      // Everything else settles from the catalog without DDL or writes.
      for (const result of results) {
        expect(["created", "alreadyMaterialized"]).toContain(result.status);
      }

      const created = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'typegraph_nodes_id_idx'`,
      );
      expect(created.rows.length).toBe(1);

      const status = await pool.query<{ entity: string; kind: string }>(
        `SELECT entity, kind FROM typegraph_index_materializations WHERE index_name = 'typegraph_nodes_id_idx'`,
      );
      expect(status.rows[0]).toEqual({ entity: "system", kind: "nodes" });
    });
  });

  describe("refreshStatistics()", () => {
    it("runs ANALYZE on the default TypeGraph tables", async (ctx) => {
      const { db } = requirePostgres(ctx);
      const backend = createPostgresBackend(db);
      await expect(backend.refreshStatistics()).resolves.toBeUndefined();
    });

    it("works against backends configured with non-default table names", async (ctx) => {
      // Exercises the table-name parameterization path. Embedded-quote
      // safety in the emitted SQL comes from routing through
      // `quoteIdentifier`, which doubles `"` per the SQL spec — no
      // additional integration coverage needed beyond verifying that
      // custom names round-trip end-to-end.
      const { pool } = requirePostgres(ctx);
      const customTables = createPostgresTables({
        nodes: "tg_custom_nodes",
        edges: "tg_custom_edges",
        uniques: "tg_custom_uniques",
        fulltext: "tg_custom_fulltext",
        schemaVersions: "tg_custom_schema_versions",
      });

      const customDdl = generatePostgresDDL(customTables);
      try {
        for (const statement of customDdl) {
          await pool.query(statement);
        }
        const customBackend = createPostgresBackend(drizzle(pool), {
          tables: customTables,
        });
        await expect(
          customBackend.refreshStatistics(),
        ).resolves.toBeUndefined();
      } finally {
        await pool.query(`
          DROP TABLE IF EXISTS tg_custom_fulltext CASCADE;
          DROP TABLE IF EXISTS tg_custom_embeddings CASCADE;
          DROP TABLE IF EXISTS tg_custom_uniques CASCADE;
          DROP TABLE IF EXISTS tg_custom_edges CASCADE;
          DROP TABLE IF EXISTS tg_custom_nodes CASCADE;
          DROP TABLE IF EXISTS tg_custom_schema_versions CASCADE;
        `);
      }
    });

    it("tolerates a schema created before the recorded-time history tables existed", async (ctx) => {
      // A bring-your-own-pool database whose DDL predates recorded-time history
      // has no recorded relations. ANALYZE fails the whole statement on a
      // missing relation, so refreshStatistics() must skip the absent ones
      // rather than throw — the forward-compat guarantee clear() already makes.
      const { pool } = requirePostgres(ctx);
      const legacyTables = createPostgresTables({
        nodes: "tg_legacy_nodes",
        edges: "tg_legacy_edges",
        uniques: "tg_legacy_uniques",
        fulltext: "tg_legacy_fulltext",
        schemaVersions: "tg_legacy_schema_versions",
        recordedNodes: "tg_legacy_recorded_nodes",
        recordedEdges: "tg_legacy_recorded_edges",
        recordedClock: "tg_legacy_recorded_clock",
      });
      const legacyDdl = generatePostgresDDL(legacyTables);
      const dropRecorded = `
        DROP TABLE IF EXISTS tg_legacy_recorded_edges CASCADE;
        DROP TABLE IF EXISTS tg_legacy_recorded_nodes CASCADE;
        DROP TABLE IF EXISTS tg_legacy_recorded_clock CASCADE;
      `;
      try {
        for (const statement of legacyDdl) {
          await pool.query(statement);
        }
        await pool.query(dropRecorded);
        const legacyBackend = createPostgresBackend(drizzle(pool), {
          tables: legacyTables,
        });
        await expect(
          legacyBackend.refreshStatistics(),
        ).resolves.toBeUndefined();
      } finally {
        await pool.query(`
          ${dropRecorded}
          DROP TABLE IF EXISTS tg_legacy_fulltext CASCADE;
          DROP TABLE IF EXISTS tg_legacy_uniques CASCADE;
          DROP TABLE IF EXISTS tg_legacy_edges CASCADE;
          DROP TABLE IF EXISTS tg_legacy_nodes CASCADE;
          DROP TABLE IF EXISTS tg_legacy_schema_versions CASCADE;
        `);
      }
    });

    it("re-probes recorded tables that are created after an earlier missing refresh", async (ctx) => {
      const { pool } = requirePostgres(ctx);
      const tableNames = {
        nodes: "tg_reprobe_nodes",
        edges: "tg_reprobe_edges",
        recordedNodes: "tg_reprobe_recorded_nodes",
        recordedEdges: "tg_reprobe_recorded_edges",
        recordedClock: "tg_reprobe_recorded_clock",
        uniques: "tg_reprobe_uniques",
        schemaVersions: "tg_reprobe_schema_versions",
        fulltext: "tg_reprobe_fulltext",
        indexMaterializations: "tg_reprobe_index_materializations",
        contributionMaterializations:
          "tg_reprobe_contribution_materializations",
        kindRemovals: "tg_reprobe_kind_removals",
        reconciliationMarkers: "tg_reprobe_reconciliation_markers",
      } as const;
      const reprobeTables = createPostgresTables(tableNames);
      const ddl = generatePostgresDDL(reprobeTables);
      const dropRecorded = `
        DROP TABLE IF EXISTS tg_reprobe_recorded_edges CASCADE;
        DROP TABLE IF EXISTS tg_reprobe_recorded_nodes CASCADE;
        DROP TABLE IF EXISTS tg_reprobe_recorded_clock CASCADE;
      `;
      try {
        for (const statement of ddl) {
          await pool.query(statement);
        }
        await pool.query(dropRecorded);
        const backend = createPostgresBackend(drizzle(pool), {
          tables: reprobeTables,
        });

        await expect(backend.refreshStatistics()).resolves.toBeUndefined();
        for (const statement of ddl) {
          await pool.query(statement);
        }
        await expect(backend.refreshStatistics()).resolves.toBeUndefined();

        await pool.query("SELECT pg_stat_clear_snapshot()");
        const stats = await pool.query<{
          relname: string;
          last_analyze: Date | null;
        }>(
          `
          SELECT relname, last_analyze
          FROM pg_stat_all_tables
          WHERE schemaname = 'public'
            AND relname = ANY($1::text[])
        `,
          [
            [
              tableNames.recordedNodes,
              tableNames.recordedEdges,
              tableNames.recordedClock,
            ],
          ],
        );
        expect(stats.rows).toHaveLength(3);
        expect(stats.rows.every((row) => row.last_analyze !== null)).toBe(true);
      } finally {
        await pool.query(`
          DROP TABLE IF EXISTS tg_reprobe_fulltext CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_recorded_edges CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_recorded_nodes CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_recorded_clock CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_uniques CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_edges CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_nodes CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_schema_versions CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_index_materializations CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_contribution_materializations CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_kind_removals CASCADE;
          DROP TABLE IF EXISTS tg_reprobe_reconciliation_markers CASCADE;
        `);
      }
    });

    it("does not reuse recorded-table existence across search_path schemas", async (ctx) => {
      requirePostgres(ctx);

      const tenantA = "tg_cache_tenant_a";
      const tenantB = "tg_cache_tenant_b";
      const tableNames = {
        nodes: "tg_search_path_nodes",
        edges: "tg_search_path_edges",
        recordedNodes: "tg_search_path_recorded_nodes",
        recordedEdges: "tg_search_path_recorded_edges",
        recordedClock: "tg_search_path_recorded_clock",
        uniques: "tg_search_path_uniques",
        schemaVersions: "tg_search_path_schema_versions",
        fulltext: "tg_search_path_fulltext",
        indexMaterializations: "tg_search_path_index_materializations",
        contributionMaterializations:
          "tg_search_path_contribution_materializations",
        kindRemovals: "tg_search_path_kind_removals",
        reconciliationMarkers: "tg_search_path_reconciliation_markers",
      } as const;
      const tables = createPostgresTables(tableNames);
      const ddl = generatePostgresDDL(tables);
      const tenantPool = new Pool({
        connectionString: TEST_DATABASE_URL,
        max: 1,
      });
      const backend = createPostgresBackend(drizzle(tenantPool), { tables });

      async function setSearchPath(schemaName: string): Promise<void> {
        await tenantPool.query(`SET search_path TO "${schemaName}", public`);
      }

      async function createSchemaTables(schemaName: string): Promise<void> {
        await tenantPool.query(`CREATE SCHEMA "${schemaName}"`);
        await setSearchPath(schemaName);
        for (const statement of ddl) {
          await tenantPool.query(statement);
        }
      }

      try {
        await tenantPool.query(`DROP SCHEMA IF EXISTS "${tenantA}" CASCADE`);
        await tenantPool.query(`DROP SCHEMA IF EXISTS "${tenantB}" CASCADE`);

        await createSchemaTables(tenantA);
        await createSchemaTables(tenantB);
        await tenantPool.query(`
          DROP TABLE IF EXISTS ${tableNames.recordedEdges} CASCADE;
          DROP TABLE IF EXISTS ${tableNames.recordedNodes} CASCADE;
          DROP TABLE IF EXISTS ${tableNames.recordedClock} CASCADE;
        `);

        await setSearchPath(tenantA);
        await expect(backend.refreshStatistics()).resolves.toBeUndefined();
        await expect(backend.clearGraph("search_path_cache")).resolves.toBe(
          undefined,
        );

        await setSearchPath(tenantB);
        await expect(backend.refreshStatistics()).resolves.toBeUndefined();
        await expect(backend.clearGraph("search_path_cache")).resolves.toBe(
          undefined,
        );
      } finally {
        await tenantPool.query("RESET search_path");
        await tenantPool.query(`DROP SCHEMA IF EXISTS "${tenantA}" CASCADE`);
        await tenantPool.query(`DROP SCHEMA IF EXISTS "${tenantB}" CASCADE`);
        await tenantPool.end();
      }
    });
  });
});

// ============================================================
// Store Integration Tests
// ============================================================

describe("Store with PostgreSQL Backend", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("creates a store with PostgreSQL backend", (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    expect(store.graphId).toBe("test_graph");
    expect(store.registry).toBeDefined();
  });

  it("analyzes a bulk-seeded iterative working table once", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const observed = observeTemporaryAnalyzeStatements(
      createPostgresBackend(db),
    );
    const store = createStore(testGraph, observed.backend);
    await store.nodes.Person.bulkCreate(
      Array.from({ length: 64 }, (_, index) => ({
        props: { name: `WCC ${index}` },
      })),
    );

    const memberships = await store.algorithms.weaklyConnectedComponents({
      edges: ["knows"],
    });

    expect(memberships).toHaveLength(64);
    expect(observed.statements).toHaveLength(1);
  });

  it("re-analyzes a growing iterative working table at multiplicative thresholds", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const observed = observeTemporaryAnalyzeStatements(
      createPostgresBackend(db),
    );
    const store = createStore(testGraph, observed.backend);
    const root = await store.nodes.Person.create({ name: "Root" });
    const firstLayer = await store.nodes.Person.bulkCreate(
      Array.from({ length: 63 }, (_, index) => ({
        props: { name: `First ${index}` },
      })),
    );
    const secondLayer = await store.nodes.Person.bulkCreate(
      Array.from({ length: 192 }, (_, index) => ({
        props: { name: `Second ${index}` },
      })),
    );
    await store.edges.knows.bulkCreate([
      ...firstLayer.map((node) => ({ from: root, to: node, props: {} })),
      ...secondLayer.map((node, index) => ({
        from: firstLayer[index % firstLayer.length]!,
        to: node,
        props: {},
      })),
    ]);

    const reached = await store.algorithms.reachable(root, {
      edges: ["knows"],
      maxHops: 3,
    });

    expect(reached).toHaveLength(256);
    expect(observed.statements).toHaveLength(2);
    expect(
      observed.statements.every((statement) =>
        /^ANALYZE "typegraph_iterative_[^"]+"$/.test(statement),
      ),
    ).toBe(true);
  });

  it("creates and retrieves nodes through the store", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });

    expect(person.kind).toBe("Person");
    expect(person.name).toBe("Alice");
    expect(person.email).toBe("alice@example.com");
    expect(person.id).toBeDefined();

    const fetched = await store.nodes.Person.getById(person.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("Alice");
  });

  it("validates node props against schema", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    await expect(
      store.nodes.Person.create({ name: "Alice", email: "not-an-email" }),
    ).rejects.toThrow();
  });

  it("creates edges between nodes", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });
    const company = await store.nodes.Company.create({ name: "Acme Inc" });

    const createdEdge = await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Company", id: company.id },
      { role: "Engineer" },
    );

    expect(createdEdge.kind).toBe("worksAt");
    expect(createdEdge.fromId).toBe(person.id);
    expect(createdEdge.toId).toBe(company.id);
    expect(createdEdge.role).toBe("Engineer");
  });

  it("validates edge endpoint types using ontology", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });
    const company = await store.nodes.Company.create({ name: "Acme Inc" });

    const createdEdge = await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Company", id: company.id },
      { role: "Engineer" },
    );

    expect(createdEdge).toBeDefined();
  });

  it("rejects edges with invalid endpoint types", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    const person1 = await store.nodes.Person.create({ name: "Alice" });
    const person2 = await store.nodes.Person.create({ name: "Bob" });

    await expect(
      store.edges.worksAt.create(
        { kind: "Person", id: person1.id },
        { kind: "Person", id: person2.id } as unknown as {
          kind: "Company";
          id: string;
        },
        { role: "Engineer" },
      ),
    ).rejects.toThrow();
  });

  it("executes transactions atomically", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    const result = await store.transaction(async (tx) => {
      const person = await tx.nodes.Person.create({ name: "Alice" });
      const company = await tx.nodes.Company.create({ name: "Acme Inc" });

      const createdEdge = await tx.edges.worksAt.create(
        { kind: "Person", id: person.id },
        { kind: "Company", id: company.id },
        { role: "Engineer" },
      );

      return { person, company, edge: createdEdge };
    });

    expect(result.person.id).toBeDefined();
    expect(result.company.id).toBeDefined();
    expect(result.edge.id).toBeDefined();

    const fetchedPerson = await store.nodes.Person.getById(result.person.id);
    expect(fetchedPerson).toBeDefined();
  });

  it("updates nodes", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });

    const updated = await store.nodes.Person.update(person.id, {
      name: "Alice Smith",
      age: 30,
    });

    expect(updated.name).toBe("Alice Smith");
    expect(updated.age).toBe(30);
    expect(updated.meta.version).toBe(2);
  });

  it("soft deletes nodes", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(testGraph, backend);

    const person = await store.nodes.Person.create({ name: "Alice" });

    await store.nodes.Person.delete(person.id);

    const fetched = await store.nodes.Person.getById(person.id);
    expect(fetched).toBeUndefined();

    const fetchedWithTombstones = await store.nodes.Person.getById(person.id, {
      temporalMode: "includeTombstones",
    });
    expect(fetchedWithTombstones).toBeDefined();
    expect(fetchedWithTombstones!.meta.deletedAt).toBeDefined();
  });
});

// ============================================================
// getOrCreateByConstraint / bulkGetOrCreateByConstraint with PostgreSQL
// ============================================================

const Entity = defineNode("Entity", {
  schema: z.object({
    entityType: z.string(),
    name: z.string(),
    role: z.string().optional(),
  }),
});

const relatedTo = defineEdge("relatedTo");

const getOrCreateGraph = defineGraph({
  id: "pg_foc_test",
  nodes: {
    Entity: {
      type: Entity,
      unique: [
        {
          name: "entity_key",
          fields: ["entityType", "name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    relatedTo: {
      type: relatedTo,
      from: [Entity],
      to: [Entity],
      cardinality: "many",
    },
  },
  ontology: [],
});

describe("getOrCreateByConstraint with PostgreSQL", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("creates a node when none exists", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    const result = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "eng",
      },
    );

    expect(result.action).toBe("created");
    expect(result.node.entityType).toBe("Person");
    expect(result.node.name).toBe("Alice");
    expect(result.node.role).toBe("eng");
    expect(result.node.meta.version).toBe(1);
  });

  it("finds existing node with ifExists: return (default)", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    const first = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "eng",
      },
    );

    const second = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "manager",
      },
    );

    expect(second.action).toBe("found");
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("eng");
    expect(second.node.meta.version).toBe(1);
  });

  it("updates existing node with ifExists: update", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    const first = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "eng",
      },
    );

    const second = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      { entityType: "Person", name: "Alice", role: "manager" },
      { ifExists: "update" },
    );

    expect(second.action).toBe("updated");
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("manager");
    expect(second.node.meta.version).toBe(2);
  });

  it("resurrects a soft-deleted node", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    const first = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "eng",
      },
    );
    await store.nodes.Entity.delete(first.node.id);

    const second = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "resurrected",
      },
    );

    expect(second.action).toBe("resurrected");
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("resurrected");
    expect(second.node.meta.deletedAt).toBeUndefined();
  });

  it("throws NodeConstraintNotFoundError for invalid constraint name", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    await expect(
      // @ts-expect-error - testing runtime validation of nonexistent constraint
      store.nodes.Entity.getOrCreateByConstraint("nonexistent_constraint", {
        entityType: "Person",
        name: "Alice",
      }),
    ).rejects.toThrow(NodeConstraintNotFoundError);
  });
});

describe("bulkGetOrCreateByConstraint with PostgreSQL", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("returns empty array for empty input", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [],
    );
    expect(results).toEqual([]);
  });

  it("creates all new nodes", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [
        { props: { entityType: "Person", name: "Alice" } },
        { props: { entityType: "Person", name: "Bob" } },
        { props: { entityType: "Company", name: "Acme" } },
      ],
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.action).toBe("created");
    expect(results[0]!.node.name).toBe("Alice");
    expect(results[1]!.action).toBe("created");
    expect(results[1]!.node.name).toBe("Bob");
    expect(results[2]!.action).toBe("created");
    expect(results[2]!.node.name).toBe("Acme");
  });

  it("handles mixed creates and finds with correct ordering", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    const alice = await store.nodes.Entity.create({
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [
        { props: { entityType: "Person", name: "Bob" } },
        { props: { entityType: "Person", name: "Alice" } },
        { props: { entityType: "Company", name: "Acme" } },
      ],
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.action).toBe("created");
    expect(results[0]!.node.name).toBe("Bob");
    expect(results[1]!.action).toBe("found");
    expect(results[1]!.node.id).toBe(alice.id);
    expect(results[1]!.node.role).toBe("eng");
    expect(results[2]!.action).toBe("created");
    expect(results[2]!.node.name).toBe("Acme");
  });

  it("bulk with ifExists: update updates existing nodes", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    await store.nodes.Entity.create({
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [
        { props: { entityType: "Person", name: "Alice", role: "manager" } },
        { props: { entityType: "Person", name: "Bob", role: "intern" } },
      ],
      { ifExists: "update" },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("updated");
    expect(results[0]!.node.role).toBe("manager");
    expect(results[1]!.action).toBe("created");
    expect(results[1]!.node.role).toBe("intern");
  });

  it("bulk resurrects soft-deleted nodes", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    const alice = await store.nodes.Entity.create({
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });
    await store.nodes.Entity.delete(alice.id);

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [{ props: { entityType: "Person", name: "Alice", role: "resurrected" } }],
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("resurrected");
    expect(results[0]!.node.id).toBe(alice.id);
    expect(results[0]!.node.role).toBe("resurrected");
    expect(results[0]!.node.meta.deletedAt).toBeUndefined();
  });

  it("throws NodeConstraintNotFoundError for invalid constraint name", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(getOrCreateGraph, backend);

    await expect(
      // @ts-expect-error - testing runtime validation of nonexistent constraint
      store.nodes.Entity.bulkGetOrCreateByConstraint("nonexistent", [
        { props: { entityType: "Person", name: "Alice" } },
      ]),
    ).rejects.toThrow(NodeConstraintNotFoundError);
  });
});

// ============================================================
// Edge getOrCreateByEndpoints / bulkGetOrCreateByEndpoints with PostgreSQL
// ============================================================

const PgPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const PgCompany = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const pgWorksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    since: z.number().optional(),
  }),
});

const edgeFocGraph = defineGraph({
  id: "pg_edge_foc_test",
  nodes: {
    Person: { type: PgPerson },
    Company: { type: PgCompany },
  },
  edges: {
    worksAt: {
      type: pgWorksAt,
      from: [PgPerson],
      to: [PgCompany],
      cardinality: "many",
    },
  },
  ontology: [],
});

describe("edge getOrCreateByEndpoints with PostgreSQL", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("creates edge when none exists", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const result = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2020,
      },
    );

    expect(result.action).toBe("created");
    expect(result.edge.role).toBe("eng");
    expect(result.edge.since).toBe(2020);
  });

  it("finds existing with ifExists: return", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2020,
      },
    );
    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "manager",
        since: 2024,
      },
    );

    expect(second.action).toBe("found");
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("eng");
  });

  it("updates existing with ifExists: update", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2020,
      },
    );
    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      { role: "manager", since: 2024 },
      { ifExists: "update" },
    );

    expect(second.action).toBe("updated");
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("manager");
  });

  it("resurrects soft-deleted edge", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2020,
      },
    );
    await store.edges.worksAt.delete(first.edge.id);

    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "resurrected",
        since: 2025,
      },
    );

    expect(second.action).toBe("resurrected");
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("resurrected");
    expect(second.edge.meta.deletedAt).toBeUndefined();
  });

  it("matchOn distinguishes edges between same pair", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      { role: "eng" },
      { matchOn: ["role"] },
    );
    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      { role: "manager" },
      { matchOn: ["role"] },
    );
    const third = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      { role: "eng", since: 2025 },
      { matchOn: ["role"] },
    );

    expect(first.action).toBe("created");
    expect(second.action).toBe("created");
    expect(second.edge.id).not.toBe(first.edge.id);
    expect(third.action).toBe("found");
    expect(third.edge.id).toBe(first.edge.id);
  });
});

describe("edge bulkGetOrCreateByEndpoints with PostgreSQL", () => {
  beforeEach(async () => {
    if (!isPostgresAvailable) return;
    await clearTestData();
  });

  it("returns empty array for empty input", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([]);
    expect(results).toEqual([]);
  });

  it("creates all new edges", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
      { from: alice, to: acme, props: { role: "eng" } },
      { from: bob, to: acme, props: { role: "manager" } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("created");
    expect(results[1]!.action).toBe("created");
  });

  it("mixed creates and finds with correct ordering", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const existing = await store.edges.worksAt.create(alice, acme, {
      role: "eng",
      since: 2020,
    });

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
      { from: bob, to: acme, props: { role: "manager" } },
      { from: alice, to: acme, props: { role: "cto" } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("created");
    expect(results[1]!.action).toBe("found");
    expect(results[1]!.edge.id).toBe(existing.id);
  });

  it("within-batch duplicates", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints(
      [
        { from: alice, to: acme, props: { role: "eng", since: 2020 } },
        { from: alice, to: acme, props: { role: "eng", since: 2024 } },
      ],
      { matchOn: ["role"] },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("created");
    expect(results[1]!.action).toBe("found");
    expect(results[1]!.edge.id).toBe(results[0]!.edge.id);
  });

  it("resurrects soft-deleted edge", async (ctx) => {
    const { db } = requirePostgres(ctx);
    const backend = createPostgresBackend(db);
    const store = createStore(edgeFocGraph, backend);

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.create(alice, acme, {
      role: "eng",
      since: 2020,
    });
    await store.edges.worksAt.delete(first.id);

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
      { from: alice, to: acme, props: { role: "resurrected", since: 2025 } },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("resurrected");
    expect(results[0]!.edge.id).toBe(first.id);
    expect(results[0]!.edge.role).toBe("resurrected");
    expect(results[0]!.edge.meta.deletedAt).toBeUndefined();
  });
});

// ============================================================
// Vector Search Integration Tests
// ============================================================

/**
 * Checks if pgvector extension is available
 */
async function isPgvectorAvailable(): Promise<boolean> {
  if (!sharedPool) return false;

  try {
    await sharedPool.query("CREATE EXTENSION IF NOT EXISTS vector");
    return true;
  } catch {
    return false;
  }
}

/**
 * Sets up the embeddings table for vector tests
 */
async function setupEmbeddingsTable(): Promise<void> {
  if (!sharedPool) return;

  await sharedPool.query(`
    CREATE TABLE IF NOT EXISTS typegraph_embeddings (
      id TEXT PRIMARY KEY,
      graph_id TEXT NOT NULL,
      node_kind TEXT NOT NULL,
      node_id TEXT NOT NULL,
      field_path TEXT NOT NULL,
      embedding vector(4) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await sharedPool.query("TRUNCATE typegraph_embeddings");
}

describe("Vector Search with PostgreSQL", () => {
  let hasPgvector = false;

  beforeAll(async () => {
    if (!isPostgresAvailable) return;
    hasPgvector = await isPgvectorAvailable();
    if (hasPgvector) {
      await setupEmbeddingsTable();
    }
  });

  beforeEach(async () => {
    if (!isPostgresAvailable || !hasPgvector) return;
    await clearTestData();
    await sharedPool?.query("TRUNCATE typegraph_embeddings");
  });

  it("should detect pgvector availability", (ctx) => {
    requirePostgres(ctx);
    expect(hasPgvector).toBe(true);
  });

  it("should store embeddings in the embeddings table", async (ctx) => {
    const { pool } = requirePostgres(ctx);

    // Insert test embedding directly
    const testEmbedding = [0.1, 0.2, 0.3, 0.4];
    await pool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-1",
        "vector_test_graph",
        "Document",
        "doc-1",
        "/embedding",
        `[${testEmbedding.join(",")}]`,
      ],
    );

    // Verify it was stored
    const result = await pool.query(
      "SELECT * FROM typegraph_embeddings WHERE id = $1",
      ["emb-1"],
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].node_id).toBe("doc-1");
  });

  it("should compute cosine distance correctly", async (ctx) => {
    const { pool } = requirePostgres(ctx);

    // Insert test embeddings
    const embeddings = [
      { id: "doc-1", embedding: [1, 0, 0, 0] }, // Unit vector along x
      { id: "doc-2", embedding: [0, 1, 0, 0] }, // Unit vector along y (orthogonal)
      { id: "doc-3", embedding: [0.9, 0.1, 0, 0] }, // Close to doc-1
    ];

    for (const emb of embeddings) {
      await pool.query(
        `INSERT INTO typegraph_embeddings
         (id, graph_id, node_kind, node_id, field_path, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `emb-${emb.id}`,
          "vector_test_graph",
          "Document",
          emb.id,
          "/embedding",
          `[${emb.embedding.join(",")}]`,
        ],
      );
    }

    // Query for similar to [1, 0, 0, 0]
    const queryEmbedding = "[1,0,0,0]";
    const result = await pool.query(
      `SELECT node_id, embedding <=> $1::vector AS distance
       FROM typegraph_embeddings
       ORDER BY distance ASC`,
      [queryEmbedding],
    );

    expect(result.rows.length).toBe(3);
    // doc-1 should be first (distance 0 - identical)
    expect(result.rows[0].node_id).toBe("doc-1");
    expect(Number.parseFloat(result.rows[0].distance)).toBeCloseTo(0, 5);
    // doc-3 should be second (close to query)
    expect(result.rows[1].node_id).toBe("doc-3");
    // doc-2 should be last (orthogonal = max distance for cosine)
    expect(result.rows[2].node_id).toBe("doc-2");
  });

  it("should filter by minimum score", async (ctx) => {
    const { pool } = requirePostgres(ctx);

    // Insert test embeddings
    const embeddings = [
      { id: "doc-1", embedding: [1, 0, 0, 0] }, // Identical to query
      { id: "doc-2", embedding: [0.7, 0.7, 0, 0] }, // Somewhat similar
      { id: "doc-3", embedding: [0, 1, 0, 0] }, // Orthogonal
    ];

    for (const emb of embeddings) {
      await pool.query(
        `INSERT INTO typegraph_embeddings
         (id, graph_id, node_kind, node_id, field_path, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `emb-${emb.id}`,
          "vector_test_graph",
          "Document",
          emb.id,
          "/embedding",
          `[${emb.embedding.join(",")}]`,
        ],
      );
    }

    // Query with minScore filter (distance threshold = 1 - minScore)
    const queryEmbedding = "[1,0,0,0]";
    const minScore = 0.5; // Only results with similarity >= 0.5
    const threshold = 1 - minScore;

    const result = await pool.query(
      `SELECT node_id, 1 - (embedding <=> $1::vector) AS score
       FROM typegraph_embeddings
       WHERE (embedding <=> $1::vector) <= $2
       ORDER BY score DESC`,
      [queryEmbedding, threshold],
    );

    // Should exclude doc-3 (orthogonal = score ~0)
    expect(result.rows.length).toBe(2);
    expect(result.rows.map((r: { node_id: string }) => r.node_id)).toContain(
      "doc-1",
    );
    expect(result.rows.map((r: { node_id: string }) => r.node_id)).toContain(
      "doc-2",
    );
  });

  it("should limit results to k nearest", async (ctx) => {
    const { pool } = requirePostgres(ctx);

    // Insert 10 test embeddings
    for (let index = 0; index < 10; index++) {
      const emb = [Math.cos(index * 0.3), Math.sin(index * 0.3), 0, 0];
      await pool.query(
        `INSERT INTO typegraph_embeddings
         (id, graph_id, node_kind, node_id, field_path, embedding)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `emb-doc-${index}`,
          "vector_test_graph",
          "Document",
          `doc-${index}`,
          "/embedding",
          `[${emb.join(",")}]`,
        ],
      );
    }

    // Query for top 3
    const queryEmbedding = "[1,0,0,0]";
    const result = await pool.query(
      `SELECT node_id, embedding <=> $1::vector AS distance
       FROM typegraph_embeddings
       ORDER BY distance ASC
       LIMIT 3`,
      [queryEmbedding],
    );

    expect(result.rows.length).toBe(3);
  });

  it("should support L2 (Euclidean) distance", async (ctx) => {
    const { pool } = requirePostgres(ctx);

    // Insert test embeddings
    await pool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-1",
        "vector_test_graph",
        "Document",
        "doc-1",
        "/embedding",
        "[1,0,0,0]",
      ],
    );
    await pool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-2",
        "vector_test_graph",
        "Document",
        "doc-2",
        "/embedding",
        "[2,0,0,0]",
      ],
    );

    // Query using L2 distance operator <->
    const result = await pool.query(
      `SELECT node_id, embedding <-> '[1,0,0,0]'::vector AS distance
       FROM typegraph_embeddings
       ORDER BY distance ASC`,
    );

    expect(result.rows.length).toBe(2);
    // doc-1 should be first (distance 0)
    expect(result.rows[0].node_id).toBe("doc-1");
    expect(Number.parseFloat(result.rows[0].distance)).toBeCloseTo(0, 5);
    // doc-2 should have distance 1 (|[1,0,0,0] - [2,0,0,0]| = 1)
    expect(result.rows[1].node_id).toBe("doc-2");
    expect(Number.parseFloat(result.rows[1].distance)).toBeCloseTo(1, 5);
  });

  it("should support inner product distance", async (ctx) => {
    const { pool } = requirePostgres(ctx);

    // Insert test embeddings (normalized for inner product)
    await pool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-1",
        "vector_test_graph",
        "Document",
        "doc-1",
        "/embedding",
        "[1,0,0,0]",
      ],
    );
    await pool.query(
      `INSERT INTO typegraph_embeddings
       (id, graph_id, node_kind, node_id, field_path, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        "emb-2",
        "vector_test_graph",
        "Document",
        "doc-2",
        "/embedding",
        "[0,1,0,0]",
      ],
    );

    // Query using inner product operator <#>
    // Note: pgvector returns negative inner product, so lower = more similar
    const result = await pool.query(
      `SELECT node_id, embedding <#> '[1,0,0,0]'::vector AS neg_ip
       FROM typegraph_embeddings
       ORDER BY neg_ip ASC`,
    );

    expect(result.rows.length).toBe(2);
    // doc-1 should be first (inner product = 1, neg_ip = -1)
    expect(result.rows[0].node_id).toBe("doc-1");
    // doc-2 has inner product 0 with query
    expect(result.rows[1].node_id).toBe("doc-2");
  });
});

// ============================================================
// End-to-End Vector Search via Query Builder
// ============================================================

describe("Vector Search End-to-End (Query Builder)", () => {
  let hasPgvector = false;

  // Define a graph with embedding properties for end-to-end testing
  const Document = defineNode("Document", {
    schema: z.object({
      title: z.string(),
      content: z.string(),
      embedding: embedding(4), // 4-dimensional embedding for test
    }),
  });

  const vectorTestGraph = defineGraph({
    id: "vector_e2e_test",
    nodes: {
      Document: { type: Document },
    },
    edges: {},
  });

  beforeAll(async () => {
    if (!isPostgresAvailable) return;
    hasPgvector = await isPgvectorAvailable();
  });

  beforeEach(async () => {
    if (!isPostgresAvailable || !hasPgvector) return;
    await clearTestData();
  });

  it("should execute similarTo query via store.query()", async (ctx) => {
    const { db } = requirePostgres(ctx);

    const backend = createPostgresBackend(db);
    const [store] = await createStoreWithSchema(vectorTestGraph, backend);

    // Create documents with embeddings. The store's embedding-sync path
    // persists each through the pgvector strategy's per-field table —
    // no manual table or insert needed.
    await store.nodes.Document.create({
      title: "Machine Learning",
      content: "Neural networks and deep learning",
      embedding: [1, 0, 0, 0],
    });

    await store.nodes.Document.create({
      title: "Web Development",
      content: "React and TypeScript",
      embedding: [0, 1, 0, 0],
    });

    await store.nodes.Document.create({
      title: "AI Fundamentals",
      content: "Artificial intelligence basics",
      embedding: [0.9, 0.1, 0, 0], // Close to doc1
    });

    // Query for documents similar to [1, 0, 0, 0] (Machine Learning topic)
    const queryEmbedding = [1, 0, 0, 0];
    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.embedding.similarTo(queryEmbedding, 3, { metric: "cosine" }),
      )
      .select((ctx) => ({
        title: ctx.d.title,
        content: ctx.d.content,
      }))
      .execute();

    // Should return all 3 documents, ordered by similarity
    expect(results.length).toBe(3);

    // First result should be "Machine Learning" (exact match)
    expect(results[0]?.title).toBe("Machine Learning");

    // Second should be "AI Fundamentals" (close to query)
    expect(results[1]?.title).toBe("AI Fundamentals");

    // Third should be "Web Development" (orthogonal to query)
    expect(results[2]?.title).toBe("Web Development");
  });

  it("should filter by minScore", async (ctx) => {
    const { db } = requirePostgres(ctx);

    const backend = createPostgresBackend(db);
    const [store] = await createStoreWithSchema(vectorTestGraph, backend);

    // Create documents — embeddings persist through the strategy's
    // per-field table via the store's embedding-sync path.
    await store.nodes.Document.create({
      title: "Exact Match",
      content: "Identical embedding",
      embedding: [1, 0, 0, 0],
    });

    await store.nodes.Document.create({
      title: "Orthogonal",
      content: "Completely different",
      embedding: [0, 1, 0, 0],
    });

    // Query with high minScore - should only return exact match
    const queryEmbedding = [1, 0, 0, 0];
    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.embedding.similarTo(queryEmbedding, 10, {
          metric: "cosine",
          minScore: 0.9, // Only very similar results
        }),
      )
      .select((ctx) => ({
        title: ctx.d.title,
      }))
      .execute();

    // Should only return the exact match
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe("Exact Match");
  });
});
