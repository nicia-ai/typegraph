/**
 * pgvector strategy — executable verification.
 *
 * Runs the SQL `pgvectorStrategy` generates against a real PostgreSQL +
 * pgvector connection, isolating the per-field strategy methods the way
 * `tests/backends/sqlite/sqlite-vec-strategy.test.ts` does for sqlite-vec:
 * the per-`(kind, field)` `vector(N)` DDL, the upsert, brute-force ranking
 * across cosine / l2 / inner_product (pgvector's exclusive metric), minScore,
 * partition-correct multi-graph filtering, delete, the HNSW / IVFFlat
 * `buildCreateIndex` DDL, and `buildDropStorage`.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type VectorSearchParams } from "../../../src/backend/types";
import { pgvectorStrategy } from "../../../src/query/dialect/vector/pgvector-strategy";
import { type VectorSlot } from "../../../src/query/dialect/vector-strategy";
import {
  renderPostgres,
  type SqlFragment,
} from "../../../src/query/sql-fragment";
import { requireDefined } from "../../../src/utils/presence";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const GRAPH = "g1";
const TS = "2026-06-01T00:00:00.000Z";

let sharedPool: Pool | undefined;
let isPostgresAvailable = false;

function requirePool(ctx: { skip: () => void }): Pool {
  if (!isPostgresAvailable || sharedPool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return sharedPool;
}

async function run(
  pool: Pool,
  query: SqlFragment,
): Promise<readonly Record<string, unknown>[]> {
  const compiled = renderPostgres(query);
  const result = await pool.query<Record<string, unknown>>(compiled.sql, [
    ...compiled.params,
  ]);
  return result.rows;
}

async function execAll(
  pool: Pool,
  queries: readonly SqlFragment[],
): Promise<void> {
  for (const query of queries) {
    const compiled = renderPostgres(query);
    await pool.query(compiled.sql, [...compiled.params]);
  }
}

function slot(
  indexType: VectorSlot["indexType"],
  metric: VectorSlot["metric"] = "cosine",
): VectorSlot {
  return {
    graphId: GRAPH,
    nodeKind: "Document",
    fieldPath: "embedding",
    dimensions: 3,
    metric,
    indexType,
  };
}

function searchParams(
  queryEmbedding: readonly number[],
  overrides: Partial<VectorSearchParams> = {},
): VectorSearchParams {
  return {
    graphId: GRAPH,
    nodeKind: "Document",
    fieldPath: "embedding",
    queryEmbedding,
    metric: "cosine",
    dimensions: 3,
    indexType: "none",
    limit: 10,
    ...overrides,
  };
}

async function createStorage(pool: Pool, s: VectorSlot): Promise<void> {
  for (const contribution of pgvectorStrategy.ownedTables(s)) {
    for (const ddl of contribution.createDdl) {
      await pool.query(ddl);
    }
  }
}

async function upsert(
  pool: Pool,
  s: VectorSlot,
  nodeId: string,
  embedding: readonly number[],
  graphId = GRAPH,
): Promise<void> {
  await execAll(
    pool,
    pgvectorStrategy.buildUpsert(
      s,
      {
        graphId,
        nodeKind: s.nodeKind,
        nodeId,
        fieldPath: s.fieldPath,
        embedding,
        dimensions: s.dimensions,
        metric: s.metric,
        indexType: s.indexType,
      },
      TS,
    ),
  );
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await pool.query("SELECT 1");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    sharedPool = pool;
    isPostgresAvailable = true;
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
  const tables = await sharedPool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const { tablename } of tables.rows) {
    await sharedPool.query(`DROP TABLE IF EXISTS "${tablename}" CASCADE`);
  }
});

describe("pgvectorStrategy (executed against PostgreSQL + pgvector)", () => {
  it("creates a per-field vector table named from (graphId, kind, field)", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none");
    await createStorage(pool, s);
    const table = pgvectorStrategy.tableName(GRAPH, "Document", "embedding");
    // Readable prefix + an exact-tuple hash suffix (collision-safe).
    expect(table).toMatch(/^tg_vec_g1_document_embedding_[0-9a-f]{8}$/u);
    const info = await pool.query(
      "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1",
      [table],
    );
    expect(info.rowCount).toBe(1);
  });

  it("brute-force search ranks by cosine similarity (closest first)", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none");
    await createStorage(pool, s);
    await upsert(pool, s, "d1", [1, 0, 0]);
    await upsert(pool, s, "d2", [0, 1, 0]);
    await upsert(pool, s, "d3", [0.9, 0.1, 0]);

    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    const ids = rows.map((r) => r["node_id"] as string);
    expect(ids).toEqual(["d1", "d3", "d2"]);
    expect(Number(rows[0]?.["score"])).toBeCloseTo(1, 5);
  });

  it("upsert replaces an existing embedding for the same node", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none");
    await createStorage(pool, s);
    await upsert(pool, s, "d1", [0, 1, 0]);
    await upsert(pool, s, "d1", [1, 0, 0]);
    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]?.["score"])).toBeCloseTo(1, 5);
  });

  it("minScore filters out dissimilar rows (cosine)", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none");
    await createStorage(pool, s);
    await upsert(pool, s, "d1", [1, 0, 0]);
    await upsert(pool, s, "d2", [0, 1, 0]); // orthogonal → similarity 0
    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { minScore: 0.5 }),
      ),
    );
    expect(rows.map((r) => r["node_id"] as string)).toEqual(["d1"]);
  });

  it("delete removes a node's embedding", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none");
    await createStorage(pool, s);
    await upsert(pool, s, "d1", [1, 0, 0]);
    await execAll(
      pool,
      pgvectorStrategy.buildDelete(s, {
        graphId: GRAPH,
        nodeKind: s.nodeKind,
        nodeId: "d1",
        fieldPath: s.fieldPath,
        dimensions: s.dimensions,
        metric: s.metric,
        indexType: s.indexType,
      }),
    );
    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(rows.length).toBe(0);
  });

  it("l2 metric ranks by euclidean distance", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none", "l2");
    await createStorage(pool, s);
    await upsert(pool, s, "d1", [1, 0, 0]);
    await upsert(pool, s, "d2", [0, 5, 0]);
    await upsert(pool, s, "d3", [0.9, 0.1, 0]);
    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { metric: "l2" }),
      ),
    );
    expect(rows.map((r) => r["node_id"] as string)).toEqual(["d1", "d3", "d2"]);
  });

  it("inner_product metric ranks by maximum inner product (pgvector-only)", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none", "inner_product");
    await createStorage(pool, s);
    // IP with query [1,0,0]: d2=2, d1=1, d3=0 → highest IP first.
    await upsert(pool, s, "d1", [1, 0, 0]);
    await upsert(pool, s, "d2", [2, 0, 0]);
    await upsert(pool, s, "d3", [0, 1, 0]);
    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { metric: "inner_product" }),
      ),
    );
    expect(rows.map((r) => r["node_id"] as string)).toEqual(["d2", "d1", "d3"]);
  });

  it("search is partition-correct: another graph's identical vector does not leak", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none");
    await createStorage(pool, s);
    await upsert(pool, s, "d1", [1, 0, 0], GRAPH);
    await upsert(pool, s, "other", [1, 0, 0], "g2");
    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0], { limit: 10 })),
    );
    expect(rows.map((r) => r["node_id"] as string)).toEqual(["d1"]);
  });

  it("buildCreateIndex (HNSW) produces DDL that executes and search still ranks", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("hnsw");
    await createStorage(pool, s);
    const indexDdl = pgvectorStrategy.buildCreateIndex?.(s);
    expect(indexDdl).toBeDefined();
    await execAll(pool, [requireDefined(indexDdl)]);
    await upsert(pool, s, "d1", [1, 0, 0]);
    await upsert(pool, s, "d2", [0, 1, 0]);
    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0], { limit: 1 })),
    );
    expect(rows.map((r) => r["node_id"] as string)).toEqual(["d1"]);
  });

  it("buildCreateIndex (IVFFlat) produces DDL that executes", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("ivfflat");
    await createStorage(pool, s);
    const indexDdl = pgvectorStrategy.buildCreateIndex?.(s);
    expect(indexDdl).toBeDefined();
    await execAll(pool, [requireDefined(indexDdl)]);
    await upsert(pool, s, "d1", [1, 0, 0]);
    const rows = await run(
      pool,
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0], { limit: 1 })),
    );
    expect(rows.map((r) => r["node_id"] as string)).toEqual(["d1"]);
  });

  it("buildDropStorage drops the per-field table", async (ctx) => {
    const pool = requirePool(ctx);
    const s = slot("none");
    await createStorage(pool, s);
    const table = pgvectorStrategy.tableName(GRAPH, "Document", "embedding");
    for (const ddl of pgvectorStrategy.buildDropStorage(s)) {
      await pool.query(ddl);
    }
    const info = await pool.query(
      "SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1",
      [table],
    );
    expect(info.rowCount).toBe(0);
  });

  it("advertises cosine, l2, and inner_product + hnsw/ivfflat/none", () => {
    expect(pgvectorStrategy.capabilities.metrics).toEqual([
      "cosine",
      "l2",
      "inner_product",
    ]);
    expect(pgvectorStrategy.capabilities.indexTypes).toEqual([
      "hnsw",
      "ivfflat",
      "none",
    ]);
    // pgvector >= 0.8 re-enters the index under `hnsw.iterative_scan` for more
    // candidates — better recall than post-filtering a fixed neighbor window
    // (libSQL), but NOT a full-page guarantee: the scan stops at
    // `hnsw.max_scan_tuples`, and pgvector < 0.8 has no iterative scan at all.
    // Only sqlite-vec's filter pushdown can promise a full page.
    expect(pgvectorStrategy.capabilities.filteredApproximateSearch).toEqual({
      mode: "iterative-scan",
      guaranteesFullPage: false,
    });
  });
});
