/**
 * #135: durable, enforced fulltext materialization on PostgreSQL —
 * SQLite mirror at `tests/fulltext-bootstrap.test.ts`.
 *
 * `createStoreWithSchema` is the single canonical writer of the durable
 * `typegraph_contribution_materializations` marker. The sync
 * `createStore` path is attach-only: it never lazily materializes the
 * strategy-owned fulltext table. A fulltext read/write — or an adopted
 * transaction — against a database with no valid marker throws
 * `StoreNotInitializedError` rather than emitting DDL on the hot path
 * (the pre-#135 behavior). This also closes the drizzle-kit gap: the
 * strategy owns the fulltext DDL, so `bootstrapTables` bypasses it once
 * `schema_versions` exists; the durable boot step covers it.
 *
 * Skipped unless `POSTGRES_URL` is set (or `scripts/test-postgres.sh`).
 */
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
  StoreNotInitializedError,
  tsvectorStrategy,
} from "../../../src";
import {
  generatePostgresDDL,
  generatePostgresMigrationSQL,
} from "../../../src/backend/drizzle/ddl";
import {
  createPostgresBackend,
  tables as defaultTables,
} from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let pool: Pool | undefined;
let postgresAvailable = false;

const Document = defineNode("Doc", {
  schema: z.object({
    title: searchable({ language: "english" }),
  }),
});

const FtGraph = defineGraph({
  // Distinct graph id so this file can run alongside other postgres
  // suites without colliding on the shared schema_versions table.
  id: "pg_fulltext_bootstrap_gap",
  nodes: { Doc: { type: Document } },
  edges: {},
});

const CONTRIB_MAT_TABLE = getTableName(
  defaultTables.contributionMaterializations,
);

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  try {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query("SELECT 1");
    // Run the full migration once so other typegraph_* tables exist
    // for the full test database (other postgres suites share these
    // tables — see `postgres-fulltext.test.ts`).
    await pool.query(generatePostgresMigrationSQL());
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  }
});

afterAll(async () => {
  // Safety net for downstream postgres test files that share this
  // database (postgres-fulltext.test.ts truncates `typegraph_node_fulltext`
  // and assumes it exists). If a test in this file fails between
  // dropping the table and the bootstrap probe restoring it,
  // `--no-file-parallelism` carries that broken state into the next
  // file. Replaying the migration SQL (idempotent: every CREATE
  // uses `IF NOT EXISTS`) leaves the database in a known good state.
  if (pool && postgresAvailable) {
    await pool.query(generatePostgresMigrationSQL());
  }
  if (pool) await pool.end();
});

/**
 * Drops `typegraph_node_fulltext` to mimic the post-`drizzle-kit push`
 * state where every other typegraph table exists but the fulltext
 * table does not. This is the exact partial-bootstrap state the bug
 * report describes.
 */
async function dropFulltextTable(p: Pool): Promise<void> {
  await p.query(`DROP TABLE IF EXISTS ${defaultTables.fulltextTableName}`);
}

/**
 * Confirms `dropFulltextTable` actually left the table missing.
 * Each test calls this first so a silently-failing drop can't
 * mask a regression — the bug under test only reproduces when
 * the fulltext table is genuinely absent.
 */
async function expectFulltextTableMissing(): Promise<void> {
  if (!pool) throw new Error("postgres pool not initialized");
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_tables
       WHERE schemaname = 'public' AND tablename = $1
     ) AS exists`,
    [defaultTables.fulltextTableName],
  );
  expect(exists.rows[0]?.exists).toBe(false);
}

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL fulltext bootstrap gap",
  () => {
    const transientPools: Pool[] = [];

    function pooledBackend(): ReturnType<typeof createPostgresBackend> {
      const transientPool = new Pool({ connectionString: TEST_DATABASE_URL });
      transientPools.push(transientPool);
      return createPostgresBackend(drizzle(transientPool));
    }

    beforeEach(async () => {
      if (!postgresAvailable || !pool) return;
      await dropFulltextTable(pool);
      // Each test starts genuinely uninitialized: drop the durable
      // marker a prior test's createStoreWithSchema may have written.
      await pool.query(
        `DELETE FROM ${CONTRIB_MAT_TABLE} ` + `WHERE graph_id = $1`,
        [FtGraph.id],
      );
    });

    afterEach(async () => {
      // Per-test pools (one per pooledBackend() call) — flush them
      // so repeated suite runs don't accumulate Postgres backends.
      while (transientPools.length > 0) {
        const transientPool = requireDefined(transientPools.pop());
        await transientPool.end();
      }
    });

    it("createStoreWithSchema materializes the fulltext table and writes the durable marker", async () => {
      await expectFulltextTableMissing();

      const [store] = await createStoreWithSchema(FtGraph, pooledBackend());

      // The canonical boot path created the table.
      const exists = await requireDefined(pool).query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_tables
           WHERE schemaname = 'public' AND tablename = $1
         ) AS exists`,
        [defaultTables.fulltextTableName],
      );
      expect(exists.rows[0]?.exists).toBe(true);

      // The durable marker was recorded for this graph.
      const markers = await requireDefined(pool).query<{
        owner: string;
        materialized_at: string | null;
        last_error: string | null;
      }>(
        `SELECT owner, materialized_at, last_error
           FROM ${CONTRIB_MAT_TABLE}
          WHERE graph_id = $1 AND logical_name = 'fulltext'`,
        [FtGraph.id],
      );
      expect(markers.rows).toHaveLength(1);
      expect(markers.rows[0]?.owner).toBe(tsvectorStrategy.name);
      expect(markers.rows[0]?.materialized_at).not.toBeNull();
      expect(markers.rows[0]?.last_error).toBeNull();

      await store.nodes.Doc.create({ title: "renewable energy" });

      const rows = await requireDefined(pool).query<{ content: string }>(
        `SELECT content FROM ${defaultTables.fulltextTableName} WHERE graph_id = $1`,
        [FtGraph.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.content).toBe("renewable energy");
    });

    it("sync createStore path throws StoreNotInitializedError on a fulltext write", async () => {
      // createStore is attach-only and skips
      // loadActiveSchemaWithBootstrap. Against a database with no
      // durable marker the fulltext write refuses loudly rather than
      // self-healing.
      const store = createStore(FtGraph, pooledBackend());
      await expect(
        store.nodes.Doc.create({ title: "should not persist" }),
      ).rejects.toBeInstanceOf(StoreNotInitializedError);

      await expectFulltextTableMissing();
    });

    it("a fulltext write inside store.transaction() throws StoreNotInitializedError (no DDL in the business tx)", async () => {
      // The tx-scoped backend's fulltext methods assert the durable
      // marker at point of use — a cached SELECT, never DDL. The
      // uninitialized database makes the write refuse and roll back.
      const store = createStore(FtGraph, pooledBackend());
      await expect(
        store.transaction(async (tx) => {
          await tx.nodes.Doc.create({ title: "tx" });
        }),
      ).rejects.toBeInstanceOf(StoreNotInitializedError);

      await expectFulltextTableMissing();
    });

    it("createStore against an already-initialized database works without re-running boot", async () => {
      await createStoreWithSchema(FtGraph, pooledBackend());

      // A fresh backend instance (cold latch) attaches via the sync
      // createStore — the durable marker, not an in-memory boolean, is
      // what lets the hot path proceed DML-only.
      const store = createStore(FtGraph, pooledBackend());
      await store.nodes.Doc.create({ title: "attach path works" });

      const rows = await requireDefined(pool).query<{ content: string }>(
        `SELECT content FROM ${defaultTables.fulltextTableName} WHERE graph_id = $1`,
        [FtGraph.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.content).toBe("attach path works");
    });

    it("ensureFulltextTable(graphId) is the durable-marker writer and is idempotent", async () => {
      await expectFulltextTableMissing();

      const backend = pooledBackend();

      expect(backend.ensureFulltextTable).toBeTypeOf("function");

      await requireDefined(backend.ensureFulltextTable)(FtGraph.id);
      await requireDefined(backend.ensureFulltextTable)(FtGraph.id);
      await requireDefined(backend.ensureFulltextTable)(FtGraph.id);

      // Exactly one durable marker row, no error recorded.
      const markers = await requireDefined(pool).query<{
        last_error: string | null;
      }>(
        `SELECT last_error FROM ${CONTRIB_MAT_TABLE}
          WHERE graph_id = $1`,
        [FtGraph.id],
      );
      expect(markers.rows).toHaveLength(1);
      expect(markers.rows[0]?.last_error).toBeNull();

      // Sanity: the GIN index the strategy declares is also present
      // and idempotent (CREATE INDEX IF NOT EXISTS).
      const indexes = await requireDefined(pool).query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
        [defaultTables.fulltextTableName],
      );
      const names = indexes.rows.map((row) => row.indexname);
      expect(names).toContain(`${defaultTables.fulltextTableName}_tsv_idx`);
      expect(names).toContain(`${defaultTables.fulltextTableName}_kind_idx`);
    });

    it("DDL generated by tsvectorStrategy matches the bootstrap probe DDL", () => {
      // Drift sentinel: the strategy DDL and `generatePostgresDDL`
      // must agree on the trailing fulltext block. The typed Drizzle
      // table at `tables.fulltext` is intentionally skipped by
      // `generatePostgresDDL` (the column-walker can't reproduce the
      // GENERATED clause), so the strategy DDL should be the only
      // source of fulltext CREATE TABLE.
      const allDdl = generatePostgresDDL(defaultTables, tsvectorStrategy);
      const strategyDdl = tsvectorStrategy
        .ownedTables(defaultTables.fulltextTableName)
        .flatMap((contribution) => contribution.createDdl);
      const tail = allDdl.slice(allDdl.length - strategyDdl.length);
      expect(tail).toEqual(strategyDdl);
    });

    it("bootstrapTables is safe to run multiple times against the typed-fulltext schema", async () => {
      // Smoke: with the typed Drizzle fulltext table now part of
      // `createPostgresTables`, the DDL generator must not double-
      // emit the fulltext CREATE TABLE (the strategy DDL would IF
      // NOT EXISTS no-op, but the column-walked emit would produce
      // a column-incompatible CREATE without GENERATED). This
      // exercises the full bootstrap flow back-to-back.
      const backend = pooledBackend();

      await requireDefined(backend.bootstrapTables)();
      await requireDefined(backend.bootstrapTables)();
      await requireDefined(backend.bootstrapTables)();

      // Confirm the GENERATED column landed (would be missing if the
      // typed Drizzle table's CREATE had won the race).
      const generated = await requireDefined(pool).query<{
        generation_expression: string;
      }>(
        `SELECT generation_expression
           FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'tsv'`,
        [defaultTables.fulltextTableName],
      );
      expect(generated.rows[0]?.generation_expression).toMatch(/to_tsvector/i);
    });
  },
);
