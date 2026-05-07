/**
 * Tests for vector index unification — `embedding()` brands flow into
 * `GraphDef.indexes` as auto-derived `VectorIndexDeclaration` entries
 * and are dispatched through `materializeIndexes()` like relational
 * indexes.
 *
 * SQLite does not have native vector index support in the bundled
 * configuration, so the test backend reports `status: "skipped"` for
 * vector entries. Postgres with pgvector is covered separately in
 * `tests/backends/postgres/`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { embedding } from "../src/core/embedding";
import { type VectorIndexDeclaration } from "../src/indexes/types";
import { createStoreWithSchema } from "../src/store";
import { createTestBackend } from "./test-utils";

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(384),
  }),
});

const DocumentL2 = defineNode("DocumentL2", {
  schema: z.object({
    title: z.string(),
    // Override metric: l2 instead of cosine.
    embedding: embedding(512, { metric: "l2", m: 32, efConstruction: 100 }),
  }),
});

const Plain = defineNode("Plain", {
  schema: z.object({ name: z.string() }),
});

describe("auto-derive vector indexes from embedding() brands", () => {
  it("auto-derives one VectorIndexDeclaration per embedding field, with default config", () => {
    const graph = defineGraph({
      id: "vector_auto",
      nodes: { Document: { type: Document } },
      edges: {},
    });

    const vectorIndexes = (graph.indexes ?? []).filter(
      (entry): entry is VectorIndexDeclaration => entry.entity === "vector",
    );
    expect(vectorIndexes).toHaveLength(1);
    const declaration = vectorIndexes[0]!;
    expect(declaration.kind).toBe("Document");
    expect(declaration.fieldPath).toBe("embedding");
    expect(declaration.dimensions).toBe(384);
    expect(declaration.metric).toBe("cosine");
    expect(declaration.indexType).toBe("hnsw");
    expect(declaration.indexParams.m).toBe(16);
    expect(declaration.indexParams.efConstruction).toBe(64);
  });

  it("auto-derives with overridden metric and HNSW params from the brand", () => {
    const graph = defineGraph({
      id: "vector_auto_overrides",
      nodes: { DocumentL2: { type: DocumentL2 } },
      edges: {},
    });

    const declaration = (graph.indexes ?? []).find(
      (entry): entry is VectorIndexDeclaration => entry.entity === "vector",
    )!;
    expect(declaration.dimensions).toBe(512);
    expect(declaration.metric).toBe("l2");
    expect(declaration.indexParams.m).toBe(32);
    expect(declaration.indexParams.efConstruction).toBe(100);
  });

  it("emits no vector indexes when no embedding brand exists", () => {
    const graph = defineGraph({
      id: "vector_none",
      nodes: { Plain: { type: Plain } },
      edges: {},
    });
    expect(graph.indexes).toBeUndefined();
  });

  it("auto-derives only for top-level embedding fields (nested embeddings ignored in v1)", () => {
    const Container = defineNode("Container", {
      schema: z.object({
        nested: z.object({ embedding: embedding(64) }),
      }),
    });
    const graph = defineGraph({
      id: "vector_nested",
      nodes: { Container: { type: Container } },
      edges: {},
    });
    const vectorIndexes = (graph.indexes ?? []).filter(
      (entry) => entry.entity === "vector",
    );
    expect(vectorIndexes).toHaveLength(0);
  });

  it("includes the metric in the deterministic index name", () => {
    const graph = defineGraph({
      id: "vector_naming",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const declaration = (graph.indexes ?? []).find(
      (entry): entry is VectorIndexDeclaration => entry.entity === "vector",
    )!;
    expect(declaration.name).toContain("document");
    expect(declaration.name).toContain("embedding");
    expect(declaration.name).toContain("cosine");
  });

  it("auto-derived names are clean (no graph id baked in) — disambiguation lives at the materialization boundary", () => {
    // Auto-derived names stay scannable in `pg_indexes` and result-
    // entry inspection. Cross-graph disambiguation is enforced by
    // the materializer's compound status key, NOT by the declaration
    // name itself — see the cross-graph status test below.
    const graphA = defineGraph({
      id: "vec_graph_a",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const graphB = defineGraph({
      id: "vec_graph_b",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const declarationA = (graphA.indexes ?? []).find(
      (entry): entry is VectorIndexDeclaration => entry.entity === "vector",
    )!;
    const declarationB = (graphB.indexes ?? []).find(
      (entry): entry is VectorIndexDeclaration => entry.entity === "vector",
    )!;
    // Same declaration name across graphs — the disambiguation is
    // applied at materialize time, not at the declaration boundary.
    expect(declarationA.name).toBe(declarationB.name);
    expect(declarationA.name).not.toContain("vec_graph_a");
  });

  it("auto-derives through chained Zod wrappers (.optional().nullable())", () => {
    // Regression: readEmbeddingIndex used to unwrap only one level,
    // which dropped chained-wrapper embeddings on the floor.
    const ChainedWrap = defineNode("ChainedWrap", {
      schema: z.object({
        title: z.string(),
        embedding: embedding(384).optional().nullable(),
      }),
    });
    const graph = defineGraph({
      id: "vector_chained_wrap",
      nodes: { ChainedWrap: { type: ChainedWrap } },
      edges: {},
    });
    const vectorIndexes = (graph.indexes ?? []).filter(
      (entry): entry is VectorIndexDeclaration => entry.entity === "vector",
    );
    expect(vectorIndexes).toHaveLength(1);
    expect(vectorIndexes[0]!.dimensions).toBe(384);
    expect(vectorIndexes[0]!.metric).toBe("cosine");
  });
});

describe("Store.materializeIndexes — vector dispatch on SQLite", () => {
  it("reports vector indexes as skipped when the backend lacks vector support", async () => {
    // The test backend does not enable sqlite-vec, so vector indexes
    // can't be materialized. The dispatch returns status: "skipped"
    // with a reason rather than failing.
    const backend = createTestBackend();
    const graph = defineGraph({
      id: "vector_sqlite_skip",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();
    const vectorEntry = result.results.find(
      (entry) => entry.entity === "vector",
    );
    expect(vectorEntry).toBeDefined();
    expect(vectorEntry!.status).toBe("skipped");
    expect(vectorEntry!.reason).toMatch(/vector/i);
  });

  it("indexType: 'none' on the embedding brand surfaces as skipped with a clear reason", async () => {
    const NoIndex = defineNode("NoIndex", {
      schema: z.object({
        title: z.string(),
        embedding: embedding(384, { indexType: "none" }),
      }),
    });
    const backend = createTestBackend();
    const graph = defineGraph({
      id: "vector_none_optout",
      nodes: { NoIndex: { type: NoIndex } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();
    const vectorEntry = result.results.find(
      (entry) => entry.entity === "vector",
    );
    expect(vectorEntry?.status).toBe("skipped");
    expect(vectorEntry?.reason).toContain("'none'");
  });
});

describe("explicit vector indexes win over auto-derived on (kind, fieldPath) collisions", () => {
  it("preserves the explicit declaration when both auto-derived and explicit target the same field", () => {
    // Build a graph where the consumer provides their own
    // VectorIndexDeclaration overriding the auto-derived defaults.
    const explicitVector: VectorIndexDeclaration = {
      entity: "vector",
      name: "custom_doc_embedding_idx",
      kind: "Document",
      fieldPath: "embedding",
      dimensions: 384,
      metric: "inner_product",
      indexType: "ivfflat",
      indexParams: { m: 16, efConstruction: 64, lists: 100 },
    };

    const graph = defineGraph({
      id: "vector_explicit_override",
      nodes: { Document: { type: Document } },
      edges: {},
      indexes: [explicitVector],
    });

    const vectorIndexes = (graph.indexes ?? []).filter(
      (entry) => entry.entity === "vector",
    );
    expect(vectorIndexes).toHaveLength(1);
    expect(vectorIndexes[0]).toBe(explicitVector);
  });
});

describe("cross-graph vector status disambiguation (compound key)", () => {
  it("explicit vector declarations sharing a name across two graphs do not collide in the status table", async () => {
    // Regression for the explicit-declaration false-skip bug. Two
    // graphs with identical explicit VectorIndexDeclaration entries
    // (same name) used to hit `alreadyMaterialized` from each
    // other's status row because the status table keyed on
    // declaration.name only. The fix composes a compound
    // `${graphId}::${declaration.name}` key at the materialization
    // boundary so each graph gets its own row.
    const sharedExplicit: VectorIndexDeclaration = {
      entity: "vector",
      name: "shared_explicit_vec",
      kind: "Document",
      fieldPath: "embedding",
      dimensions: 384,
      metric: "cosine",
      indexType: "hnsw",
      indexParams: { m: 16, efConstruction: 64, lists: undefined },
    };
    const graphA = defineGraph({
      id: "vec_xgraph_a",
      nodes: { Document: { type: Document } },
      edges: {},
      indexes: [sharedExplicit],
    });
    const graphB = defineGraph({
      id: "vec_xgraph_b",
      nodes: { Document: { type: Document } },
      edges: {},
      indexes: [sharedExplicit],
    });

    // SQLite test backend can't materialize HNSW vector indexes, so
    // both sides report `skipped` — but the assertion that matters
    // is "neither sees the OTHER's row as alreadyMaterialized".
    // Status entries are written via the same compound key, and a
    // skipped entry doesn't write to the status table at all, so
    // we can't observe the disambiguation through the SQLite path
    // alone. The Postgres-side test in
    // `tests/backends/postgres/materialize-vector-indexes.test.ts`
    // exercises the actually-materialized path with two real graphs.
    //
    // What we CAN observe here: the two graphs construct distinct
    // declarations (same name, different graph context), and
    // materialize doesn't crash on the shared explicit declaration.
    const backend = createTestBackend();
    const [storeA] = await createStoreWithSchema(graphA, backend);
    const [storeB] = await createStoreWithSchema(graphB, backend);

    const resultA = await storeA.materializeIndexes();
    const resultB = await storeB.materializeIndexes();

    const entryA = resultA.results.find((entry) => entry.entity === "vector")!;
    const entryB = resultB.results.find((entry) => entry.entity === "vector")!;

    // Both surface the shared declaration name to the consumer
    // (clean for inspection); neither falsely reports
    // alreadyMaterialized from the other.
    expect(entryA.indexName).toBe("shared_explicit_vec");
    expect(entryB.indexName).toBe("shared_explicit_vec");
    expect(entryA.status).not.toBe("alreadyMaterialized");
    expect(entryB.status).not.toBe("alreadyMaterialized");
  });
});
