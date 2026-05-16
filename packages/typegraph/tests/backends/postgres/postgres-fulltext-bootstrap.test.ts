/**
 * Regression tests for the drizzle-kit-managed fulltext bootstrap
 * gap on PostgreSQL — SQLite mirror at
 * `tests/fulltext-bootstrap.test.ts`. The strategy owns the
 * fulltext DDL (alternate Postgres stacks carry incompatible
 * schemas), so the `bootstrapTables` shortcut bypasses it once
 * `schema_versions` exists. `ensureFulltextTable` closes the gap.
 *
 * Skipped unless `POSTGRES_URL` is set (or `scripts/test-postgres.sh`).
 */
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

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
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

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
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

describe.runIf(process.env.POSTGRES_URL)(
  "PostgreSQL fulltext bootstrap gap",
  () => {
    const transientPools: Pool[] = [];

    function pooledBackend(): ReturnType<typeof createPostgresBackend> {
      const transientPool = new Pool({ connectionString: TEST_DATABASE_URL });
      transientPools.push(transientPool);
      return createPostgresBackend(drizzle(transientPool));
    }

    /**
     * Bootstraps a real schema row (so `createStore` CRUD passes
     * the no-schema gate) then drops the fulltext table again,
     * restoring the drizzle-kit-only state.
     */
    async function seedSchemaThenDropFulltext(): Promise<void> {
      await createStoreWithSchema(FtGraph, pooledBackend());
      await dropFulltextTable(pool!);
    }

    beforeEach(async () => {
      if (!postgresAvailable || !pool) return;
      await dropFulltextTable(pool);
    });

    afterEach(async () => {
      // Per-test pools (one per pooledBackend() call) — flush them
      // so repeated suite runs don't accumulate Postgres backends.
      while (transientPools.length > 0) {
        const transientPool = transientPools.pop()!;
        await transientPool.end();
      }
    });

    it("createStoreWithSchema bootstrap restores the missing fulltext table", async () => {
      await expectFulltextTableMissing();

      const [store] = await createStoreWithSchema(FtGraph, pooledBackend());

      // The bootstrap probe should have created the table.
      const exists = await pool!.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_tables
           WHERE schemaname = 'public' AND tablename = $1
         ) AS exists`,
        [defaultTables.fulltextTableName],
      );
      expect(exists.rows[0]?.exists).toBe(true);

      await store.nodes.Doc.create({ title: "renewable energy" });

      const rows = await pool!.query<{ content: string }>(
        `SELECT content FROM ${defaultTables.fulltextTableName} WHERE graph_id = $1`,
        [FtGraph.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.content).toBe("renewable energy");
    });

    it("sync createStore path materializes the fulltext table on first write", async () => {
      // createStore is sync and skips loadActiveSchemaWithBootstrap,
      // so the bootstrap-load probe can't help here — the backend's
      // wrapped write methods must self-ensure.
      await seedSchemaThenDropFulltext();
      const store = createStore(FtGraph, pooledBackend());
      await store.nodes.Doc.create({ title: "sync path works" });

      const rows = await pool!.query<{ content: string }>(
        `SELECT content FROM ${defaultTables.fulltextTableName} WHERE graph_id = $1`,
        [FtGraph.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.content).toBe("sync path works");
    });

    it("store.transaction() materializes the fulltext table before BEGIN", async () => {
      // The tx-scoped backend exposes raw fulltext methods, so
      // transaction() itself ensures the table BEFORE BEGIN runs
      // (avoiding CREATE-INDEX-inside-tx SHARE-lock contention and
      // keeping the table durable on rollback).
      await seedSchemaThenDropFulltext();
      const store = createStore(FtGraph, pooledBackend());
      await store.transaction(async (tx) => {
        await tx.nodes.Doc.create({ title: "tx path works" });
      });

      const rows = await pool!.query<{ content: string }>(
        `SELECT content FROM ${defaultTables.fulltextTableName} WHERE graph_id = $1`,
        [FtGraph.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.content).toBe("tx path works");
    });

    it("ensureFulltextTable is idempotent across repeat calls", async () => {
      await expectFulltextTableMissing();

      const backend = pooledBackend();

      expect(backend.ensureFulltextTable).toBeTypeOf("function");

      await backend.ensureFulltextTable!();
      await backend.ensureFulltextTable!();
      await backend.ensureFulltextTable!();

      // Sanity: the GIN index the strategy declares is also present
      // and idempotent (CREATE INDEX IF NOT EXISTS).
      const indexes = await pool!.query<{ indexname: string }>(
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

      await backend.bootstrapTables!();
      await backend.bootstrapTables!();
      await backend.bootstrapTables!();

      // Confirm the GENERATED column landed (would be missing if the
      // typed Drizzle table's CREATE had won the race).
      const generated = await pool!.query<{ generation_expression: string }>(
        `SELECT generation_expression
           FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'tsv'`,
        [defaultTables.fulltextTableName],
      );
      expect(generated.rows[0]?.generation_expression).toMatch(/to_tsvector/i);
    });
  },
);
