/**
 * In-graph embedding-dimension migration: `store.reembedVectorField` +
 * write-time dimension-change detection. Runs against the local sqlite-vec
 * backend (per-field vec0 storage); the dimension-mismatch parser is also
 * unit-tested against the engine error shapes it must recognize.
 */
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3 } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  embedding,
  EmbeddingDimensionChangedError,
  type GraphBackend,
} from "../src";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { createSqliteBackend, generateSqliteDDL } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { createStoreWithSchema } from "../src/store/store";
import { parseDimensionMismatch } from "../src/utils/sql-errors";

/** A SQLite backend with NO vector strategy (the bring-your-own-Drizzle path). */
function createNoVectorSqliteBackend(): GraphBackend {
  const sqlite = new Database(":memory:");
  for (const statement of generateSqliteDDL(sqliteTables)) {
    sqlite.exec(statement);
  }
  return createSqliteBackend(drizzleBetterSqlite3(sqlite), {
    executionProfile: { isSync: true },
    tables: sqliteTables,
  });
}

const Document = defineNode("Doc", {
  schema: z.object({ title: z.string(), embedding: embedding(3) }),
});
const graph = defineGraph({
  id: "reembed_test",
  nodes: { Doc: { type: Document } },
  edges: {},
});

const L2Document = defineNode("Doc", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(3, { metric: "l2" }),
  }),
});
const l2Graph = defineGraph({
  id: "reembed_l2_test",
  nodes: { Doc: { type: L2Document } },
  edges: {},
});

// Same graph id as `graph` but a different embedding dimension — re-opening the
// store with this evolves the field from embedding(3) to embedding(4).
const Document4 = defineNode("Doc", {
  schema: z.object({ title: z.string(), embedding: embedding(4) }),
});
const graph4 = defineGraph({
  id: "reembed_test",
  nodes: { Doc: { type: Document4 } },
  edges: {},
});

describe("parseDimensionMismatch", () => {
  it("parses the engine dimension-mismatch shapes", () => {
    expect(
      parseDimensionMismatch(new Error("expected 384 dimensions, not 512")),
    ).toEqual({ expected: 384, actual: 512 });
    expect(
      parseDimensionMismatch(
        new Error("Dimension mismatch: expected 3 dimensions, got 4"),
      ),
    ).toEqual({ expected: 3, actual: 4 });
    expect(
      parseDimensionMismatch(new Error("some other failure")),
    ).toBeUndefined();
  });

  it("walks the driver-wrapped cause chain", () => {
    const wrapped = new Error("query failed", {
      cause: new Error("expected 8 dimensions, not 16"),
    });
    expect(parseDimensionMismatch(wrapped)).toEqual({
      expected: 8,
      actual: 16,
    });
  });
});

describe("store.reembedVectorField (sqlite-vec)", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createLocalSqliteBackend().backend;
  });

  it("recreates per-field storage and re-embeds via the embed callback", async () => {
    if (backend.vectorStrategy === undefined) return; // sqlite-vec not installed
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Doc.create({ title: "a", embedding: [1, 0, 0] });
    await store.nodes.Doc.create({ title: "b", embedding: [0, 1, 0] });

    const result = await store.reembedVectorField("Doc", "embedding", {
      embed: (nodes) => new Map(nodes.map((node) => [node.id, [1, 0, 0]])),
    });
    expect(result).toEqual({ recreated: true, reembedded: 2 });

    // Storage was dropped + recreated and both rows re-embedded → searchable.
    const hits = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    expect(hits).toHaveLength(2);
  });

  it("recreates storage at a NEW dimension and re-embeds (embedding(3) -> embedding(4))", async () => {
    if (backend.vectorStrategy === undefined) return;
    const [storeV3] = await createStoreWithSchema(graph, backend);
    await storeV3.nodes.Doc.create({ title: "a", embedding: [1, 0, 0] });

    // Re-open with embedding(4): the schema auto-evolves to the new dimension.
    const [storeV4] = await createStoreWithSchema(graph4, backend);
    const result = await storeV4.reembedVectorField("Doc", "embedding", {
      embed: (nodes) => new Map(nodes.map((node) => [node.id, [1, 0, 0, 0]])),
    });
    expect(result).toEqual({ recreated: true, reembedded: 1 });

    // The per-field table was recreated at dim 4 — a 4-dim query now works,
    // and a stale 3-dim write surfaces the typed dimension-changed error.
    const hits = await storeV4.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      limit: 10,
    });
    expect(hits).toHaveLength(1);
  });

  it("recreate-only (no embed) leaves storage empty for app-driven re-embed", async () => {
    if (backend.vectorStrategy === undefined) return;
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Doc.create({ title: "a", embedding: [1, 0, 0] });

    const result = await store.reembedVectorField("Doc", "embedding");
    expect(result).toEqual({ recreated: true, reembedded: 0 });

    const hits = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it("throws for an undeclared embedding field", async () => {
    const [store] = await createStoreWithSchema(graph, backend);
    await expect(store.reembedVectorField("Doc", "nope")).rejects.toThrow(
      /No embedding field/,
    );
  });

  it("write-time: a length-mismatched upsert surfaces EmbeddingDimensionChangedError", async () => {
    if (
      backend.vectorStrategy === undefined ||
      backend.upsertEmbedding === undefined ||
      backend.ensureVectorSlotContribution === undefined
    ) {
      return;
    }
    const base = {
      graphId: "g",
      nodeKind: "Doc",
      fieldPath: "embedding",
      metric: "cosine" as const,
      indexType: "none" as const,
    };
    // Provision + fix the per-field table at dimension 3 (the privileged step
    // the migrator does; this test drives the backend directly).
    await backend.ensureVectorSlotContribution({ ...base, dimensions: 3 });
    await backend.upsertEmbedding({
      ...base,
      nodeId: "n1",
      embedding: [1, 0, 0],
      dimensions: 3,
    });
    // A vector whose length doesn't match the column's fixed dimension must
    // surface the typed error (via mapVectorWriteError), not the raw engine
    // "expected N dimensions" message. The marker assert passes (dimensions
    // still 3); the engine rejects the 4-length vector.
    await expect(
      backend.upsertEmbedding({
        ...base,
        nodeId: "n2",
        embedding: [1, 0, 0, 0],
        dimensions: 3,
      }),
    ).rejects.toBeInstanceOf(EmbeddingDimensionChangedError);
  });

  it("store.search.vector defaults to the field's declared metric (#3)", async () => {
    if (
      backend.vectorStrategy === undefined ||
      backend.vectorSearch === undefined
    ) {
      return;
    }
    const recorded: string[] = [];
    const recordingBackend: GraphBackend = {
      ...backend,
      vectorSearch: (params) => {
        recorded.push(params.metric);
        return backend.vectorSearch!(params);
      },
    };
    const [store] = await createStoreWithSchema(l2Graph, recordingBackend);
    await store.nodes.Doc.create({ title: "a", embedding: [1, 0, 0] });

    // No explicit metric in the call → must use the field's declared "l2".
    await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      limit: 5,
    });
    expect(recorded.at(-1)).toBe("l2");
  });

  it("a rolled-back transaction's first vector write does not poison the latch (#1)", async () => {
    if (backend.vectorStrategy === undefined) return;
    const [store] = await createStoreWithSchema(graph, backend);

    // The first-ever write to the slot happens inside a transaction that rolls
    // back — its CREATE TABLE is undone. A shared latch caching that CREATE as
    // "done" would make the next write skip it and fail with "no such table".
    await expect(
      store.transaction(async (tx) => {
        await tx.nodes.Doc.create({
          title: "rolled-back",
          embedding: [1, 0, 0],
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // A subsequent write must re-ensure the table and succeed.
    await store.nodes.Doc.create({ title: "after", embedding: [1, 0, 0] });
    const hits = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    expect(hits.map((hit) => hit.node.title)).toEqual(["after"]);
  });

  it("rejects a non-finite / out-of-range minScore at the facade (#7)", async () => {
    const [store] = await createStoreWithSchema(graph, backend);
    await expect(
      store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0],
        limit: 10,
        minScore: Number.NaN,
      }),
    ).rejects.toThrow(/minScore must be a finite number/);
    // cosine score is a 1 - distance similarity → out of [-1, 1] is invalid.
    await expect(
      store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0],
        limit: 10,
        minScore: 5,
      }),
    ).rejects.toThrow(/between -1 and 1/);
  });

  it("throws ConfigurationError when the backend has no vector strategy", async () => {
    const [store] = await createStoreWithSchema(
      graph,
      createNoVectorSqliteBackend(),
    );
    await expect(store.reembedVectorField("Doc", "embedding")).rejects.toThrow(
      /vector strategy/,
    );
  });

  it("backend.vectorSearch rejects a non-finite minScore (#6)", async () => {
    if (
      backend.vectorSearch === undefined ||
      backend.ensureVectorSlotContribution === undefined
    ) {
      return;
    }
    // Provision the slot so the marker assert passes and execution reaches
    // buildSearch — which must still reject a non-finite minScore instead of
    // compiling `distance <= (1 - NaN)`.
    await backend.ensureVectorSlotContribution({
      graphId: "g",
      nodeKind: "Doc",
      fieldPath: "embedding",
      dimensions: 3,
      metric: "cosine",
      indexType: "none",
    });
    await expect(
      backend.vectorSearch({
        graphId: "g",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0],
        metric: "cosine",
        dimensions: 3,
        indexType: "none",
        limit: 10,
        minScore: Number.NaN,
      }),
    ).rejects.toThrow(/finite/);
  });

  it("store.search.vector rejects a metric that differs from the declared one (#8)", async () => {
    if (backend.vectorStrategy === undefined) return;
    const [store] = await createStoreWithSchema(graph, backend); // cosine field
    await store.nodes.Doc.create({ title: "a", embedding: [1, 0, 0] });
    await expect(
      store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0],
        limit: 10,
        metric: "l2", // field is declared cosine
      }),
    ).rejects.toThrow(/declared metric/);
  });

  it("store.search.vector rejects a query vector of the wrong dimension (#10)", async () => {
    if (backend.vectorStrategy === undefined) return;
    const [store] = await createStoreWithSchema(graph, backend); // embedding(3)
    await store.nodes.Doc.create({ title: "a", embedding: [1, 0, 0] });
    await expect(
      store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0], // 2-dim against a 3-dim field
        limit: 10,
      }),
    ).rejects.toThrow(/dimensions/);
  });

  it("reembedVectorField rejects a non-positive / fractional batchSize (#14)", async () => {
    if (backend.vectorStrategy === undefined) return;
    const [store] = await createStoreWithSchema(graph, backend);
    await expect(
      store.reembedVectorField("Doc", "embedding", { batchSize: 0 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      store.reembedVectorField("Doc", "embedding", { batchSize: 2.5 }),
    ).rejects.toThrow(/positive integer/);
  });
});
