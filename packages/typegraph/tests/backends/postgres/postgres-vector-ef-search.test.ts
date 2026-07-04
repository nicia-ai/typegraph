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
import { asCompiledRowsSql, defineGraph, defineNode } from "../../../src/index";
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
          asCompiledRowsSql(
            sql`SELECT current_setting('hnsw.ef_search') AS ef`,
          ),
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
          asCompiledRowsSql(
            sql`SELECT current_setting('hnsw.ef_search') AS ef`,
          ),
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

/**
 * Whether the connected pgvector defines `hnsw.iterative_scan` (>= 0.8).
 * The assertions that require it degrade to a skip on older servers so
 * external POSTGRES_URL runners don't fail on a version difference. Probed
 * via extversion — the GUC itself registers only after the extension
 * library loads into a session.
 */
async function iterativeScanAvailable(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ v: string | null }>(
    "SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'",
  );
  const version = result.rows[0]?.v;
  if (typeof version !== "string") return false;
  const [major = 0, minor = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return major > 0 || (major === 0 && minor >= 8);
}

describe("Postgres iterative scan — hnsw.iterative_scan on filtered searches", () => {
  it("applies strict_order transaction-locally on HNSW searches and skips brute-force slots", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    if (!(await iterativeScanAvailable(pool))) {
      ctx.skip();
      return;
    }
    await seed(pool, "iter_scan_apply");

    // `set_config` is fully parameterized (`SELECT set_config($1, $2, true)`),
    // so the GUC name only appears in the bind params — capture both.
    const statements: { query: string; params: unknown[] }[] = [];
    const backend = createPostgresBackend(
      drizzle(pool, {
        logger: {
          logQuery(query: string, params: unknown[]) {
            statements.push({ query, params });
          },
        },
      }),
    );

    const params = {
      graphId: "iter_scan_apply",
      nodeKind: "Doc",
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      dimensions: 4,
      limit: 3,
    } as const;

    await backend.vectorSearch!({ ...params, indexType: "hnsw" });
    const hnswSetCalls = statements.filter((statement) =>
      statement.query.includes("set_config"),
    );
    expect(
      hnswSetCalls.some(
        (statement) =>
          statement.params[0] === "hnsw.iterative_scan" &&
          statement.params[1] === "strict_order",
      ),
      "HNSW search must apply hnsw.iterative_scan = strict_order",
    ).toBe(true);

    statements.length = 0;
    await backend.vectorSearch!({ ...params, indexType: "ivfflat" });
    const ivfflatSetCalls = statements.filter((statement) =>
      statement.query.includes("set_config"),
    );
    expect(
      ivfflatSetCalls.some(
        (statement) =>
          statement.params[0] === "ivfflat.iterative_scan" &&
          statement.params[1] === "relaxed_order",
      ),
      "IVFFlat search must apply ivfflat.iterative_scan = relaxed_order",
    ).toBe(true);
    // The IVFFlat SQL re-sorts the relaxed candidate set in a
    // MATERIALIZED wrapper so relaxed_order cannot leak misordered rows.
    const ivfflatSelect = statements.find((statement) =>
      statement.query.includes("tg_vec_relaxed"),
    );
    expect(
      ivfflatSelect?.query,
      "IVFFlat search must re-sort via the MATERIALIZED wrapper",
    ).toContain("AS MATERIALIZED");

    statements.length = 0;
    await backend.vectorSearch!({ ...params, indexType: "none" });
    expect(
      statements.filter((statement) => statement.query.includes("set_config")),
      "brute-force slot must not touch GUCs",
    ).toEqual([]);
  });

  it("does not leak hnsw.iterative_scan to the next query on the same connection", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    if (!(await iterativeScanAvailable(pool))) {
      ctx.skip();
      return;
    }
    const pinned = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      await seed(pinned, "iter_scan_leak");
      const backend = createPostgresBackend(drizzle(pinned));

      const readIterativeScan = async () => {
        const result = await pinned.query<{ v: string }>(
          "SELECT current_setting('hnsw.iterative_scan') AS v",
        );
        return result.rows[0]?.v;
      };

      const baseline = await readIterativeScan();
      await backend.vectorSearch!({
        graphId: "iter_scan_leak",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "hnsw",
        limit: 3,
      });
      const afterSearch = await readIterativeScan();

      expect(baseline).toBeDefined();
      expect(afterSearch).toBe(baseline);
      expect(afterSearch).not.toBe("strict_order");
    } finally {
      await pinned.end();
    }
  });

  it("restores the setting inside a caller transaction", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    if (!(await iterativeScanAvailable(pool))) {
      ctx.skip();
      return;
    }
    const { backend } = await seed(pool, "iter_scan_tx");

    await backend.transaction(async (tx) => {
      const readIterativeScan = async () => {
        const rows = await tx.execute<{ v: string }>(
          asCompiledRowsSql(
            sql`SELECT current_setting('hnsw.iterative_scan') AS v`,
          ),
        );
        return rows[0]?.v;
      };
      const baseline = await readIterativeScan();
      await tx.vectorSearch!({
        graphId: "iter_scan_tx",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "hnsw",
        limit: 3,
      });
      expect(await readIterativeScan()).toBe(baseline);
      expect(await readIterativeScan()).not.toBe("strict_order");
    });
  });
});
