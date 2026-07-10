/**
 * libSQL vector strategy — executable verification.
 *
 * Runs the SQL `libsqlVectorStrategy` generates against a real
 * `@libsql/client` connection, proving the per-field DDL, upsert,
 * brute-force search, DiskANN (`vector_top_k`) search, minScore filtering,
 * and delete all execute and rank correctly on libSQL's native engine.
 */
import { type Client, createClient } from "@libsql/client";
import { type SQL, sql } from "drizzle-orm";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import { type VectorSearchParams } from "../../../src/backend/types";
import { libsqlVectorStrategy } from "../../../src/query/dialect/vector/libsql-strategy";
import { type VectorSlot } from "../../../src/query/dialect/vector-strategy";

const dialect = new SQLiteAsyncDialect();

function run(client: Client, query: SQL) {
  const compiled = dialect.sqlToQuery(query);
  return client.execute({
    sql: compiled.sql,
    args: compiled.params as never[],
  });
}

async function runAll(client: Client, queries: readonly SQL[]): Promise<void> {
  for (const query of queries) await run(client, query);
}

const GRAPH = "g1";
const TS = "2026-06-01T00:00:00.000Z";

/** `nodeIds` as a one-column SELECT, the shape `buildSearch` expects. */
function candidateIds(nodeIds: readonly string[]): SQL {
  return sql.join(
    nodeIds.map((nodeId) => sql`SELECT ${nodeId}`),
    sql` UNION ALL `,
  );
}

function slot(indexType: VectorSlot["indexType"]): VectorSlot {
  return {
    graphId: GRAPH,
    nodeKind: "Document",
    fieldPath: "embedding",
    dimensions: 3,
    metric: "cosine",
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

describe("libsqlVectorStrategy (executed against @libsql/client)", () => {
  let client: Client;

  beforeEach(() => {
    client = createClient({ url: "file::memory:" });
  });
  afterEach(() => {
    client.close();
  });

  // Helper that runs raw DDL strings (ownedTables emits strings, not SQL).
  async function createStorage(s: VectorSlot): Promise<void> {
    for (const contribution of libsqlVectorStrategy.ownedTables(s)) {
      for (const ddl of contribution.createDdl) {
        await client.execute(ddl);
      }
    }
  }

  async function upsert(
    s: VectorSlot,
    nodeId: string,
    embedding: readonly number[],
    graphId = GRAPH,
  ): Promise<void> {
    await runAll(
      client,
      libsqlVectorStrategy.buildUpsert(
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

  it("creates a per-field F32_BLOB(N) table named from (kind, field)", async () => {
    const s = slot("none");
    await createStorage(s);
    const table = libsqlVectorStrategy.tableName(
      GRAPH,
      "Document",
      "embedding",
    );
    // Readable prefix + an exact-tuple hash suffix (collision-safe).
    expect(table).toMatch(/^tg_vec_g1_document_embedding_[0-9a-f]{8}$/u);
    const info = await client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      args: [table],
    });
    expect(info.rows.length).toBe(1);
  });

  it("brute-force search ranks by cosine similarity (closest first)", async () => {
    const s = slot("none");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 1, 0]);
    await upsert(s, "d3", [0.9, 0.1, 0]);

    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    const ids = result.rows.map((r) => r.node_id as string);
    expect(ids[0]).toBe("d1");
    expect(ids[1]).toBe("d3");
    expect(ids[2]).toBe("d2");
    // cosine score = 1 - distance; exact match → ~1.0
    expect(Number(result.rows[0]?.score)).toBeCloseTo(1, 5);
  });

  it("upsert replaces an existing embedding for the same node", async () => {
    const s = slot("none");
    await createStorage(s);
    await upsert(s, "d1", [0, 1, 0]);
    await upsert(s, "d1", [1, 0, 0]);
    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0]?.score)).toBeCloseTo(1, 5);
  });

  it("minScore filters out dissimilar rows", async () => {
    const s = slot("none");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 1, 0]); // orthogonal → cosine similarity 0
    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { minScore: 0.5 }),
      ),
    );
    const ids = result.rows.map((r) => r.node_id as string);
    expect(ids).toEqual(["d1"]);
  });

  it("delete removes a node's embedding", async () => {
    const s = slot("none");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await runAll(
      client,
      libsqlVectorStrategy.buildDelete(s, {
        graphId: GRAPH,
        nodeKind: s.nodeKind,
        nodeId: "d1",
        fieldPath: s.fieldPath,
        dimensions: s.dimensions,
        metric: s.metric,
        indexType: s.indexType,
      }),
    );
    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(result.rows.length).toBe(0);
  });

  it("DiskANN (hnsw) slot: vector_top_k search returns nearest neighbors", async () => {
    const s = slot("hnsw");
    await createStorage(s); // includes libsql_vector_idx index DDL
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 1, 0]);
    await upsert(s, "d3", [0.9, 0.1, 0]);

    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { limit: 2 }),
      ),
    );
    const ids = result.rows.map((r) => r.node_id as string);
    expect(ids).toContain("d1");
    expect(ids).not.toContain("d2"); // orthogonal vector excluded from top-2
  });

  it("backend ensure reruns DiskANN DDL when indexType changes at the same dimension", async () => {
    const { backend } = await createLibsqlBackend(client);
    const base = {
      graphId: GRAPH,
      nodeKind: "Document",
      fieldPath: "embedding",
      dimensions: 3,
      metric: "cosine" as const,
    };

    // vectorSearch computes top-k over LIVE nodes only, so the embedding
    // needs a live node row backing it.
    await backend.insertNode({
      graphId: GRAPH,
      kind: "Document",
      id: "d1",
      props: {},
    });
    // First write ensures only brute-force storage. A later schema change can
    // keep the same dimension while switching the slot to ANN-backed `hnsw`;
    // the backend must run the hnsw ensure path so `vector_top_k` has an index.
    await backend.upsertEmbedding!({
      ...base,
      nodeId: "d1",
      embedding: [1, 0, 0],
      indexType: "none",
    });

    const result = await backend.vectorSearch!({
      ...base,
      queryEmbedding: [1, 0, 0],
      indexType: "hnsw",
      limit: 1,
    });

    expect(result).toEqual([{ nodeId: "d1", score: 1 }]);
  });

  it("l2 metric ranks by distance (brute force)", async () => {
    const s: VectorSlot = { ...slot("none"), metric: "l2" };
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 5, 0]);
    await upsert(s, "d3", [0.9, 0.1, 0]);
    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { metric: "l2" }),
      ),
    );
    const ids = result.rows.map((r) => r.node_id as string);
    expect(ids).toEqual(["d1", "d3", "d2"]);
  });

  it("DiskANN (hnsw) slot: minScore filters within vector_top_k", async () => {
    const s = slot("hnsw");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 1, 0]); // orthogonal → similarity 0, below 0.5
    await upsert(s, "d3", [0.9, 0.1, 0]);
    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { minScore: 0.5 }),
      ),
    );
    const ids = result.rows.map((r) => r.node_id as string);
    expect(ids).toContain("d1");
    expect(ids).not.toContain("d2");
  });

  it("delete removes a node's embedding on an ANN (hnsw) slot", async () => {
    const s = slot("hnsw");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await runAll(
      client,
      libsqlVectorStrategy.buildDelete(s, {
        graphId: GRAPH,
        nodeKind: s.nodeKind,
        nodeId: "d1",
        fieldPath: s.fieldPath,
        dimensions: s.dimensions,
        metric: s.metric,
        indexType: s.indexType,
      }),
    );
    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(result.rows.length).toBe(0);
  });

  it("DiskANN search is partition-correct: another graph's vector does not leak", async () => {
    const s = slot("hnsw");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0], GRAPH);
    await upsert(s, "other", [1, 0, 0], "g2"); // identical vector, different graph
    const result = await run(
      client,
      libsqlVectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { limit: 10 }),
      ),
    );
    const ids = result.rows.map((r) => r.node_id as string);
    expect(ids).toEqual(["d1"]);
    expect(ids).not.toContain("other");
  });

  it("buildDropStorage drops the per-field table and its DiskANN index", async () => {
    const s = slot("hnsw");
    await createStorage(s);
    for (const ddl of libsqlVectorStrategy.buildDropStorage(s)) {
      await client.execute(ddl);
    }
    const table = libsqlVectorStrategy.tableName(
      GRAPH,
      "Document",
      "embedding",
    );
    const info = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
    );
    expect(info.rows.length).toBe(0);
  });

  it("advertises cosine+l2, hnsw+none, and no inner_product", () => {
    expect(libsqlVectorStrategy.capabilities.metrics).toEqual(["cosine", "l2"]);
    expect(libsqlVectorStrategy.capabilities.indexTypes).toEqual([
      "hnsw",
      "none",
    ]);
    expect(libsqlVectorStrategy.capabilities.metrics).not.toContain(
      "inner_product",
    );
  });

  // ============================================================
  // Filtered DiskANN recall — the `"post-filter"` capability, executed.
  //
  // `vector_top_k` has no filter pushdown and no way to re-enter the index, so
  // a filtered search fetches `4 * (limit + offset)` neighbors and filters
  // afterwards. Inside that headroom the page fills; past it the page is short
  // even though more matching rows exist. sqlite-vec and pgvector >= 0.8 both
  // recover; libSQL cannot. The asymmetry is declared on `capabilities`, and
  // these tests are what that declaration means.
  // ============================================================
  describe("filtered approximate search (capabilities.filteredApproximateSearch)", () => {
    const FAN_SIZE = 200;

    /**
     * A fan of `FAN_SIZE` vectors around `[1, 0, 0]`. Cosine distance to the
     * query grows monotonically with the index, so `dN` has rank `N + 1`.
     */
    async function seedRankedFan(s: VectorSlot): Promise<void> {
      for (let index = 0; index < FAN_SIZE; index += 1) {
        await upsert(s, `d${index}`, [1, index * 0.001, 0]);
      }
    }

    it("declares that a filtered DiskANN page can under-fill", () => {
      expect(
        libsqlVectorStrategy.capabilities.filteredApproximateSearch,
      ).toEqual({ mode: "post-filter", guaranteesFullPage: false });
    });

    it("fills the page when the surviving candidates sit inside the over-fetch headroom", async () => {
      const s = slot("hnsw");
      await createStorage(s);
      await seedRankedFan(s);

      // limit 2 ⇒ DiskANN fetches 4 × 2 = 8 neighbors. Ranks 3 and 4 survive.
      const result = await run(
        client,
        libsqlVectorStrategy.buildSearch(
          s,
          searchParams([1, 0, 0], { limit: 2, indexType: "hnsw" }),
          candidateIds(["d2", "d3"]),
        ),
      );
      expect(result.rows.map((row) => row.node_id)).toEqual(["d2", "d3"]);
    });

    it("under-fills when tombstone drift pushes the survivors past the headroom", async () => {
      const s = slot("hnsw");
      await createStorage(s);
      await seedRankedFan(s);

      // The only two live rows rank 199th and 200th — far outside the 8
      // neighbors `vector_top_k` is asked for. Both match; neither can be seen.
      const survivors = ["d198", "d199"];
      const approximate = await run(
        client,
        libsqlVectorStrategy.buildSearch(
          s,
          searchParams([1, 0, 0], { limit: 2, indexType: "hnsw" }),
          candidateIds(survivors),
        ),
      );
      expect(approximate.rows.length).toBeLessThan(2);

      // Same filter, same limit, exact search: the matches are there. The short
      // page is the ANN path's post-filter, not a missing row.
      const exact = await run(
        client,
        libsqlVectorStrategy.buildSearch(
          { ...s, indexType: "none" },
          searchParams([1, 0, 0], { limit: 2, indexType: "none" }),
          candidateIds(survivors),
        ),
      );
      expect(exact.rows.map((row) => row.node_id)).toEqual(survivors);
    });
  });
});
