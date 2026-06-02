/**
 * Per-search `efSearch` (HNSW `hnsw.ef_search` override) — backend-agnostic
 * behavior.
 *
 * Covers the parts that don't need a live Postgres:
 * - Validation at the store boundary (positive integer) for vector + hybrid.
 * - pgvector's 1..1000 ceiling, enforced where the SELECT is built.
 * - sqlite-vec accepts the option as a pure no-op (identical results).
 *
 * The Postgres `SET LOCAL` mechanism (transaction scoping, non-leak,
 * transaction-less warn) lives in
 * `tests/backends/postgres/postgres-vector-ef-search.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, searchable } from "../src";
import { embedding } from "../src/core/embedding";
import {
  assertPgvectorEfSearch,
  MAX_HNSW_EF_SEARCH,
} from "../src/query/dialect/vector/pgvector-strategy";
import { createStoreWithSchema } from "../src/store";
import { createTestBackend } from "./test-utils";

const Document = defineNode("Doc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    embedding: embedding(4),
  }),
});

const graph = defineGraph({
  id: "ef_search_unit",
  nodes: { Doc: { type: Document } },
  edges: {},
});

async function seededStore() {
  const backend = createTestBackend();
  const [store] = await createStoreWithSchema(graph, backend);
  await store.nodes.Doc.create({ title: "alpha", embedding: [1, 0, 0, 0] });
  await store.nodes.Doc.create({ title: "beta", embedding: [0, 1, 0, 0] });
  await store.nodes.Doc.create({ title: "gamma", embedding: [0, 0, 1, 0] });
  return store;
}

describe("efSearch validation (store boundary)", () => {
  it("rejects a non-positive-integer efSearch on vector search", async () => {
    const store = await seededStore();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(
        store.search.vector("Doc", {
          fieldPath: "embedding",
          queryEmbedding: [1, 0, 0, 0],
          limit: 5,
          efSearch: bad,
        }),
      ).rejects.toThrow(/efSearch must be a positive integer/);
    }
  });

  it("rejects a non-positive-integer efSearch on hybrid search", async () => {
    const store = await seededStore();
    await expect(
      store.search.hybrid("Doc", {
        limit: 5,
        vector: {
          fieldPath: "embedding",
          queryEmbedding: [1, 0, 0, 0],
          efSearch: 0,
        },
        fulltext: { query: "alpha" },
      }),
    ).rejects.toThrow(/efSearch must be a positive integer/);
  });
});

describe("efSearch pgvector ceiling (assertPgvectorEfSearch)", () => {
  it("rejects efSearch above pgvector's 1000 ceiling", () => {
    expect(() => {
      assertPgvectorEfSearch(MAX_HNSW_EF_SEARCH + 1);
    }).toThrow(/1\.\.1000/);
  });

  it("accepts efSearch exactly at the ceiling", () => {
    expect(() => {
      assertPgvectorEfSearch(MAX_HNSW_EF_SEARCH);
    }).not.toThrow();
  });

  it("accepts an undefined efSearch (no override)", () => {
    expect(() => {
      assertPgvectorEfSearch();
    }).not.toThrow();
  });

  it("rejects a non-positive-integer efSearch at the build boundary", () => {
    for (const bad of [0, -5, 2.5]) {
      expect(() => {
        assertPgvectorEfSearch(bad);
      }).toThrow(/efSearch must be a positive integer/);
    }
  });
});

describe("efSearch on sqlite-vec is a no-op", () => {
  it("returns identical results with and without efSearch", async () => {
    const store = await seededStore();
    const query = [1, 0, 0, 0];

    const without = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: query,
      limit: 5,
    });
    const withEf = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: query,
      limit: 5,
      efSearch: 256,
    });

    expect(withEf.length).toBe(without.length);
    expect(withEf.map((hit) => hit.node.id)).toEqual(
      without.map((hit) => hit.node.id),
    );
    // The nearest neighbor to the x-axis query is "alpha".
    expect((withEf[0]!.node as unknown as { title: string }).title).toBe(
      "alpha",
    );
  });
});
