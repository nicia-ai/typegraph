/**
 * Filtered approximate recall — pgvector RECOVERS where libSQL under-fills.
 *
 * The store-level mirror of the libSQL DiskANN under-fill boundary test
 * (`tests/backends/sqlite/libsql-vector-strategy.test.ts`, describe
 * "filtered approximate search (capabilities.filteredApproximateSearch)").
 * Same ranked fan, same limit, same "only the two worst-ranked rows survive
 * the liveness filter" fixture:
 *
 * - libSQL's DiskANN `vector_top_k` post-filters a fixed `4 * limit` neighbor
 *   window and returns a SHORT page — `filteredApproximateSearch.mode ===
 *   "post-filter"`. Its test asserts `rows.length < 2`.
 * - pgvector >= 0.8 re-enters the HNSW index under
 *   `hnsw.iterative_scan = strict_order`, gathering more candidates until
 *   `limit` live rows survive the filter. This test asserts both survivors come
 *   back at this scale. That is recovery, NOT a guarantee: the iterative scan
 *   stops at `hnsw.max_scan_tuples` (default 20000), which is why
 *   `filteredApproximateSearch.guaranteesFullPage` is `false` for pgvector.
 *
 * Skipped automatically when POSTGRES_URL is unset or pgvector < 0.8 (the
 * recovery only exists there; older servers stay `ef_search`-bounded and behave
 * like libSQL's post-filter).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { embedding } from "../../../src/core/embedding";
import { defineGraph, defineNode } from "../../../src/index";
import { createStoreWithSchema } from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const GRAPH_ID = "filtered_ann_recall";
const FAN_SIZE = 200;
/** The two WORST-ranked nodes — ranks 199 and 200 of 200. */
const SURVIVORS = ["d198", "d199"] as const;
const QUERY_EMBEDDING = [1, 0, 0] as const;

// A pinned single-connection pool. The store applies `hnsw.iterative_scan`
// transaction-locally (`SET LOCAL`), and the planner-forcing session GUCs set
// below only reach the search when it lands on the SAME connection they were
// set on — max: 1 guarantees that.
let pool: Pool | undefined;
let isPostgresAvailable = false;
let hasIterativeScan = false;

function requirePostgres(ctx: { skip: () => void }): Pool {
  if (!isPostgresAvailable || pool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return pool;
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 1,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(generatePostgresMigrationSQL());
    // The recovery only exists on pgvector >= 0.8; probe via extversion (the
    // GUC itself registers only after the extension loads into a session).
    const version = await candidate.query<{ v: string | null }>(
      "SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'",
    );
    const [major = 0, minor = 0] = (version.rows[0]?.v ?? "0.0")
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    hasIterativeScan = major > 0 || (major === 0 && minor >= 8);
    pool = candidate;
    isPostgresAvailable = true;
  } catch {
    await candidate.end().catch(() => {
      // Unreachable Postgres degrades to "skip".
    });
  }
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

beforeEach(async () => {
  if (pool === undefined) return;
  await pool.query(
    `TRUNCATE typegraph_index_materializations,
              typegraph_node_uniques,
              typegraph_nodes,
              typegraph_edges,
              typegraph_schema_versions CASCADE`,
  );
  // The strategy's per-(kind, field) vector table is created lazily; drop any
  // leftover so each run re-materializes its table + HNSW index from scratch.
  // (The materialization ledger is truncated above so materializeIndexes
  // actually rebuilds the physical index rather than reporting a stale
  // `alreadyMaterialized` against a table this beforeEach just dropped.)
  const { rows } = await pool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const row of rows) {
    await pool.query(`DROP TABLE IF EXISTS "${row.tablename}" CASCADE`);
  }
});

const Document = defineNode("Doc", {
  // Default index type is hnsw (src/core/embedding.ts
  // DEFAULT_EMBEDDING_INDEX_TYPE), so a search over this field routes through
  // the ANN / iterative-scan path, not a brute-force scan.
  schema: z.object({ embedding: embedding(3) }),
});

describe("Postgres filtered ANN recall — iterative-scan recovers a full page", () => {
  it(
    "returns both survivors where libSQL DiskANN post-filters a short page",
    { timeout: 60_000 },
    async (ctx) => {
      const activePool = requirePostgres(ctx);
      if (!hasIterativeScan) {
        ctx.skip();
        return;
      }
      const backend = createPostgresBackend(drizzle(activePool));
      const graph = defineGraph({
        id: GRAPH_ID,
        nodes: { Doc: { type: Document } },
        edges: {},
      });
      const [store] = await createStoreWithSchema(graph, backend);

      // A ranked fan around the query [1, 0, 0]: cosine distance grows
      // monotonically with the index, so dN has rank N + 1 (d0 closest,
      // d199 farthest). Identical fixture to the libSQL mirror.
      await store.nodes.Doc.bulkCreate(
        Array.from({ length: FAN_SIZE }, (_, index) => ({
          id: `d${index}`,
          props: { embedding: [1, index * 0.001, 0] },
        })),
      );

      // Build the real HNSW index. A brute-force sequential scan would be
      // trivially exact and prove nothing about iterative-scan recovery.
      const materialized = await store.materializeIndexes();
      expect(
        materialized.results.find((entry) => entry.entity === "vector")?.status,
      ).toBe("created");

      // Assert the physical HNSW index exists — otherwise the search below
      // would silently be an exact seq scan and the test would be vacuous.
      const table = requireDefined(backend.vectorStrategy).tableName(
        GRAPH_ID,
        "Doc",
        "embedding",
      );
      const hnswIndexes = await activePool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = $1
         AND indexdef LIKE '%hnsw%'`,
        [table],
      );
      expect(hnswIndexes.rows.length).toBeGreaterThan(0);

      // Tombstone every node except the two WORST-ranked. Done at the row
      // level (NOT store.nodes.Doc.delete) on purpose: the store's soft delete
      // cascades an embedding removal (applyNodeSoftDelete -> deleteNodeEmbeddings),
      // which would shrink the ANN index to two rows and make the recovery
      // vacuous. Setting deleted_at directly leaves all 200 embeddings resident
      // — exactly the "ranking tombstones into top-k" drift the liveness
      // pushdown in pgvector `buildSearch` defends against — so the always-on
      // liveness filter (`liveNodeIdsSubquery`: deleted_at IS NULL + validity)
      // is the only thing narrowing the result to d198/d199.
      await activePool.query(
        `UPDATE typegraph_nodes SET deleted_at = NOW()
         WHERE graph_id = $1 AND kind = 'Doc' AND id NOT IN ($2, $3)`,
        [GRAPH_ID, SURVIVORS[0], SURVIVORS[1]],
      );

      // Force the planner onto the HNSW index for the searches below: at 200
      // rows it would otherwise seq-scan (exact), making iterative_scan a no-op
      // and every assertion vacuous. Session-level (not SET LOCAL) so it
      // persists into the store's internal search transaction on this pinned
      // connection. `enable_sort = off` blocks a pkey-scan + Sort exact plan,
      // leaving the ordered HNSW index scan as the only viable shape — the same
      // technique exact-vector-scan.test.ts uses to make its plan pin meaningful.
      await activePool.query("SET enable_seqscan = off");
      await activePool.query("SET enable_sort = off");

      // Non-vacuity guard — the pre-recovery (pgvector < 0.8 / libSQL) shape.
      // indexType "none" tells the backend NOT to apply the iterative_scan GUC;
      // the physical HNSW index is still the plan (seqscan/sort forced off), so
      // this is a single bounded HNSW pass. The two survivors rank 199th and
      // 200th — far outside the default ef_search (40) frontier — so nothing
      // live survives the filter and the page under-fills, mirroring libSQL's
      // `expect(approximate.rows.length).toBeLessThan(2)`.
      const bounded = await requireDefined(backend.vectorSearch)({
        graphId: GRAPH_ID,
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [...QUERY_EMBEDDING],
        metric: "cosine",
        dimensions: 3,
        indexType: "none",
        limit: 2,
      });
      expect(bounded.length).toBeLessThan(2);

      // The recovery. The store's approximate search declares indexType "hnsw"
      // (the field's default), so the Postgres backend wraps it in
      // `hnsw.iterative_scan = strict_order`. pgvector re-enters the index until
      // LIMIT live rows survive the liveness filter, returning the full page
      // libSQL cannot produce for this identical fixture.
      const hits = await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [...QUERY_EMBEDDING],
        limit: 2,
      });
      expect(hits.map((hit) => hit.node.id).toSorted()).toEqual([
        SURVIVORS[0],
        SURVIVORS[1],
      ]);
    },
  );
});
