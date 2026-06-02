/**
 * Postgres `efSearch` (HNSW `hnsw.ef_search` override) mechanism tests.
 *
 * These assert the *mechanism*, not a statistical recall lift (which
 * depends on HNSW build randomness + corpus size and belongs in a
 * benchmark, not a flaky CI assertion):
 *
 * - The override is applied transaction-locally and does NOT leak to the
 *   next query on a pooled connection — the load-bearing property of
 *   `SET LOCAL`. Issued in autocommit it would roll off with the
 *   statement and the next pooled query would see the session default.
 * - The transactional path still returns correct nearest-neighbor rows.
 * - A transaction-less backend (`transactions: false`) warns once and
 *   ignores the option rather than emitting an unscoped `SET`.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { embedding } from "../../../src/core/embedding";
import { defineGraph, defineNode } from "../../../src/index";
import { createStoreWithSchema } from "../../../src/store";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let sharedPool: Pool | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): { pool: Pool } {
  if (!isPostgresAvailable || sharedPool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { pool: sharedPool };
}

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await pool.query("SELECT 1");
    sharedPool = pool;
    isPostgresAvailable = true;
    await pool.query(`
      DROP TABLE IF EXISTS typegraph_node_embeddings CASCADE;
      DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
      DROP TABLE IF EXISTS typegraph_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
    `);
    await pool.query(generatePostgresMigrationSQL());
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await pool.end().catch(() => {});
  }
});

afterAll(async () => {
  if (sharedPool !== undefined) await sharedPool.end();
});

beforeEach(async () => {
  if (sharedPool === undefined) return;
  await sharedPool.query(
    `TRUNCATE typegraph_node_uniques,
              typegraph_nodes,
              typegraph_edges,
              typegraph_schema_versions CASCADE`,
  );
  // The strategy's per-(kind, field) vector table is created lazily, so
  // truncate any that exist to keep embedding rows from leaking across
  // tests that reuse the `Doc.embedding` slot under different graph ids.
  const { rows } = await sharedPool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const row of rows) {
    await sharedPool.query(`TRUNCATE "${row.tablename}" CASCADE`);
  }
});

const Document = defineNode("Doc", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(4),
  }),
});

async function seed(pool: Pool, graphId: string) {
  const graph = defineGraph({
    id: graphId,
    nodes: { Doc: { type: Document } },
    edges: {},
  });
  const backend = createPostgresBackend(drizzle(pool));
  const [store] = await createStoreWithSchema(graph, backend);
  await store.nodes.Doc.create({ title: "alpha", embedding: [1, 0, 0, 0] });
  await store.nodes.Doc.create({ title: "beta", embedding: [0, 1, 0, 0] });
  await store.nodes.Doc.create({ title: "gamma", embedding: [0, 0, 1, 0] });
  return { graph, backend, store };
}

describe("Postgres efSearch — SET LOCAL transaction scoping", () => {
  it("does not leak hnsw.ef_search to the next query on the same connection", async (ctx) => {
    requirePostgres(ctx);
    // max:1 pins one backend connection so the post-search read lands on
    // the same connection the override ran on. SET LOCAL must have rolled
    // off with the committed transaction; a (buggy) session-level SET
    // would still be visible here.
    const pinned = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      const backend = createPostgresBackend(drizzle(pinned));
      const graph = defineGraph({
        id: "ef_leak",
        nodes: { Doc: { type: Document } },
        edges: {},
      });
      const [store] = await createStoreWithSchema(graph, backend);
      await store.nodes.Doc.create({ title: "alpha", embedding: [1, 0, 0, 0] });

      const readEfSearch = async () => {
        const rows = await backend.execute<{ ef: string }>(
          sql`SELECT current_setting('hnsw.ef_search') AS ef`,
        );
        return rows[0]?.ef;
      };

      const baseline = await readEfSearch();
      await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        limit: 5,
        efSearch: 256,
      });
      const afterOverride = await readEfSearch();

      expect(baseline).toBeDefined();
      expect(afterOverride).toBe(baseline);
      expect(afterOverride).not.toBe("256");
    } finally {
      await pinned.end();
    }
  });

  it("restores the override inside a caller transaction so later searches don't inherit it", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const { backend } = await seed(pool, "ef_tx_restore");

    await backend.transaction(async (tx) => {
      const readEfSearch = async () => {
        const rows = await tx.execute<{ ef: string }>(
          sql`SELECT current_setting('hnsw.ef_search') AS ef`,
        );
        return rows[0]?.ef;
      };
      const baseline = await readEfSearch();
      const params = {
        graphId: "ef_tx_restore",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "hnsw",
        limit: 3,
      } as const;

      await tx.vectorSearch!({ ...params, efSearch: 256 });

      // The override was restored within the same transaction: a later
      // search without efSearch must not inherit 256.
      expect(await readEfSearch()).toBe(baseline);
      expect(await readEfSearch()).not.toBe("256");
      const hits = await tx.vectorSearch!(params);
      expect(hits.length).toBeGreaterThan(0);
      expect(await readEfSearch()).toBe(baseline);
    });
  });

  it("returns correct nearest-neighbor rows on the transactional path", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const { store } = await seed(pool, "ef_functional");

    const hits = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      limit: 3,
      efSearch: 200,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect((hits[0]!.node as unknown as { title: string }).title).toBe("alpha");
  });
});

describe("Postgres efSearch — transaction-less backend", () => {
  it("warns once and ignores the override instead of leaking a session SET", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    // Seed via a normal (transactional) backend — a transaction-less
    // backend can't bootstrap schema (commitSchemaVersion needs atomicity).
    await seed(pool, "ef_txless");

    const noTxBackend = createPostgresBackend(drizzle(pool), {
      capabilities: { transactions: false },
    });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const params = {
        graphId: "ef_txless",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "hnsw",
        limit: 3,
        efSearch: 256,
      } as const;

      const first = await noTxBackend.vectorSearch!(params);
      const second = await noTxBackend.vectorSearch!(params);

      // The query still runs (override silently dropped, not fatal).
      expect(Array.isArray(first)).toBe(true);
      expect(Array.isArray(second)).toBe(true);
      // Warned exactly once across both calls.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/efSearch.*ignored/s);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
