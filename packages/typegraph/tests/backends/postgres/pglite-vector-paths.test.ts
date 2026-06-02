/**
 * pgvector paths against in-process PGlite (Postgres-in-WASM).
 *
 * Part of the PGlite correctness lane (runs in plain `pnpm test`, zero Docker).
 * This file is intentionally a **representative** slice of the pgvector surface,
 * not a re-run of the Docker pgvector suite: enough to prove pgvector works
 * end-to-end under PGlite's bundled extension (pgvector 0.8.1), while deeper
 * behavior (full metric matrices, statistical recall, idempotency edge cases)
 * stays in the Docker files.
 *
 * Two layers:
 *  - strategy-level SQL driven directly through PGlite's `client.query` (the
 *    same shape `pgvector-strategy.test.ts` drives through `pool.query`);
 *  - store/backend-level paths: `SET LOCAL hnsw.ef_search` and removed-field
 *    storage reclamation. (Legacy shared-table migration is deliberately out of
 *    scope: PGlite is new this release and never had the legacy embeddings
 *    table, which is being dropped in the same release.)
 *
 * One shared engine per file; `beforeEach` drops vector tables (dimension- and
 * reclaim-sensitive) and truncates base tables.
 */
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, embedding } from "../../../src";
import { type VectorSearchParams } from "../../../src/backend/types";
import { defineGraphExtension } from "../../../src/graph-extension";
import { pgvectorStrategy } from "../../../src/query/dialect/vector/pgvector-strategy";
import { type VectorSlot } from "../../../src/query/dialect/vector-strategy";
import { createStoreWithSchema } from "../../../src/store";
import {
  setupSharedPgliteEngine,
  type SharedPgliteEngine,
} from "./pglite-correctness-harness";

// ============================================================
// Strategy-level SQL helpers (driven through PGlite's client.query, which
// matches pg's `query(sql, params) -> { rows }` shape).
// ============================================================

const dialect = new PgDialect();
const GRAPH = "g1";
const TS = "2026-06-01T00:00:00.000Z";

let engine: SharedPgliteEngine;

async function run(query: SQL): Promise<readonly Record<string, unknown>[]> {
  const compiled = dialect.sqlToQuery(query);
  const result = await engine.client.query<Record<string, unknown>>(
    compiled.sql,
    compiled.params,
  );
  return result.rows;
}

async function execAll(queries: readonly SQL[]): Promise<void> {
  for (const query of queries) {
    const compiled = dialect.sqlToQuery(query);
    await engine.client.query(compiled.sql, compiled.params);
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

async function createStorage(s: VectorSlot): Promise<void> {
  for (const contribution of pgvectorStrategy.ownedTables(s)) {
    for (const ddl of contribution.createDdl) {
      await engine.client.exec(ddl);
    }
  }
}

async function upsert(
  s: VectorSlot,
  nodeId: string,
  vec: readonly number[],
  graphId = GRAPH,
): Promise<void> {
  await execAll(
    pgvectorStrategy.buildUpsert(
      s,
      {
        graphId,
        nodeKind: s.nodeKind,
        nodeId,
        fieldPath: s.fieldPath,
        embedding: vec,
        dimensions: s.dimensions,
        metric: s.metric,
        indexType: s.indexType,
      },
      TS,
    ),
  );
}

beforeAll(async () => {
  engine = await setupSharedPgliteEngine();
});

afterAll(async () => {
  await engine.dispose();
});

beforeEach(async () => {
  // Drop (not truncate) per-field vector tables: these tests intentionally vary
  // dimensions and reclaim storage, so a leftover `vector(3)` table must not
  // outlive the test that created it.
  await engine.dropVectorTables();
  await engine.resetData();
});

// ============================================================
// Strategy-level pgvector SQL
// ============================================================

describe("pgvectorStrategy under PGlite (executed against bundled pgvector)", () => {
  it("ranks by cosine similarity (closest first)", async () => {
    const s = slot("none");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 1, 0]);
    await upsert(s, "d3", [0.9, 0.1, 0]);

    const rows = await run(
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(rows.map((row) => row.node_id)).toEqual(["d1", "d3", "d2"]);
    expect(Number(rows[0]?.score)).toBeCloseTo(1, 5);
  });

  it("ranks by l2 (euclidean) distance", async () => {
    const s = slot("none", "l2");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 5, 0]);
    await upsert(s, "d3", [0.9, 0.1, 0]);

    const rows = await run(
      pgvectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { metric: "l2" }),
      ),
    );
    expect(rows.map((row) => row.node_id)).toEqual(["d1", "d3", "d2"]);
  });

  it("ranks by inner_product (pgvector-only metric)", async () => {
    const s = slot("none", "inner_product");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [2, 0, 0]);
    await upsert(s, "d3", [0, 1, 0]);

    const rows = await run(
      pgvectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { metric: "inner_product" }),
      ),
    );
    expect(rows.map((row) => row.node_id)).toEqual(["d2", "d1", "d3"]);
  });

  it("filters dissimilar rows with minScore and replaces on re-upsert", async () => {
    const s = slot("none");
    await createStorage(s);
    await upsert(s, "d1", [0, 1, 0]); // will be replaced
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 1, 0]); // orthogonal → cosine 0

    const rows = await run(
      pgvectorStrategy.buildSearch(
        s,
        searchParams([1, 0, 0], { minScore: 0.5 }),
      ),
    );
    expect(rows.map((row) => row.node_id)).toEqual(["d1"]);
  });

  it("deletes a node's embedding", async () => {
    const s = slot("none");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0]);
    await execAll(
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
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(rows).toHaveLength(0);
  });

  it("partitions by graph: another graph's identical vector does not leak", async () => {
    const s = slot("none");
    await createStorage(s);
    await upsert(s, "d1", [1, 0, 0], GRAPH);
    await upsert(s, "other", [1, 0, 0], "g2");

    const rows = await run(
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0])),
    );
    expect(rows.map((row) => row.node_id)).toEqual(["d1"]);
  });

  it("builds an HNSW index that executes and still ranks", async () => {
    const s = slot("hnsw");
    await createStorage(s);
    const indexDdl = pgvectorStrategy.buildCreateIndex?.(s);
    expect(indexDdl).toBeDefined();
    await execAll([indexDdl!]);
    await upsert(s, "d1", [1, 0, 0]);
    await upsert(s, "d2", [0, 1, 0]);

    const rows = await run(
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0], { limit: 1 })),
    );
    expect(rows.map((row) => row.node_id)).toEqual(["d1"]);
  });

  it("builds an IVFFlat index that executes", async () => {
    const s = slot("ivfflat");
    await createStorage(s);
    const indexDdl = pgvectorStrategy.buildCreateIndex?.(s);
    expect(indexDdl).toBeDefined();
    await execAll([indexDdl!]);
    await upsert(s, "d1", [1, 0, 0]);

    const rows = await run(
      pgvectorStrategy.buildSearch(s, searchParams([1, 0, 0], { limit: 1 })),
    );
    expect(rows.map((row) => row.node_id)).toEqual(["d1"]);
  });
});

// ============================================================
// Store / backend-level vector paths
// ============================================================

const Document = defineNode("Doc", {
  schema: z.object({ title: z.string(), embedding: embedding(4) }),
});

function documentGraph(id: string) {
  return defineGraph({ id, nodes: { Doc: { type: Document } }, edges: {} });
}

describe("Store-level vector paths under PGlite", () => {
  it("applies hnsw.ef_search transaction-locally without leaking it", async () => {
    const backend = engine.makeBackend();
    const [store] = await createStoreWithSchema(
      documentGraph("ef_pglite"),
      backend,
    );
    await store.nodes.Doc.create({ title: "alpha", embedding: [1, 0, 0, 0] });
    await store.nodes.Doc.create({ title: "beta", embedding: [0, 1, 0, 0] });

    const readEfSearch = async () => {
      // missing_ok=true: returns NULL rather than erroring if the GUC is unset.
      const rows = await backend.execute<{ ef: string }>(
        sql`SELECT current_setting('hnsw.ef_search', true) AS ef`,
      );
      return rows[0]?.ef;
    };

    const baseline = await readEfSearch();
    const hits = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      limit: 2,
      efSearch: 256,
    });

    // Correct nearest neighbor returned via the efSearch path...
    expect(hits[0]!.node.title).toBe("alpha");
    // ...and the SET LOCAL rolled off — single-connection PGlite makes any leak
    // immediately visible on the next read.
    expect(await readEfSearch()).toBe(baseline);
    expect(await readEfSearch()).not.toBe("256");
  });

  it("reclaims the orphaned vector table when an embedding field is removed", async () => {
    const backend = engine.makeBackend();
    const table = backend.vectorStrategy!.tableName(
      "reclaim_pglite",
      "Document",
      "embedding",
    );

    const [store] = await createStoreWithSchema(
      defineGraph({ id: "reclaim_pglite", nodes: {}, edges: {} }),
      backend,
    );
    const withField = await store.evolve(addDocumentWithEmbedding);
    await withField
      .getNodeCollectionOrThrow("Document")
      .create({ title: "a", embedding: [1, 0, 0] });
    expect(await vectorTableExists(table)).toBe(true);

    const dropped = await withField.evolve(dropEmbeddingModifier);
    const result = await dropped.materializeRemovals();

    expect(result.reclaimedVectorFields).toEqual([
      { kind: "Document", fieldPath: "embedding", status: "reclaimed" },
    ]);
    expect(await vectorTableExists(table)).toBe(false);
  });
});

// ============================================================
// Store-level helpers
// ============================================================

async function vectorTableExists(name: string): Promise<boolean> {
  const result = await engine.client.query(
    "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1",
    [name],
  );
  return result.rows.length > 0;
}

const addDocumentWithEmbedding = defineGraphExtension({
  nodes: {
    Document: {
      properties: {
        title: { type: "string" },
        embedding: {
          type: "array",
          items: { type: "number" },
          embedding: { dimensions: 3 },
        },
      },
    },
  },
});

const dropEmbeddingModifier = defineGraphExtension({
  nodes: {
    Document: {
      properties: {
        title: { type: "string" },
        embedding: { type: "array", items: { type: "number" } },
      },
    },
  },
});
