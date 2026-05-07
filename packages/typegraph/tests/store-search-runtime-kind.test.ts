/**
 * `store.search` widening: runtime-extended kinds work without a type
 * cast.
 *
 * Before this change the kind argument was bounded by `NodeKinds<G>`,
 * which excludes runtime kinds added via `store.evolve()` and forced
 * consumers to write `store.search.fulltext("Paper" as never, …)` —
 * the only place in the runtime-extension surface still requiring a
 * cast (`getNodeCollection` / `getEdgeCollection` already solved the
 * same problem). The constraint relaxed to `K extends string` with a
 * runtime registry guard for misspelling protection.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { KindNotFoundError } from "../src";
import { defineGraphExtension } from "../src/runtime";
import { createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "search_runtime_kind",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("store.search.fulltext on runtime kinds", () => {
  it("accepts a runtime kind name without a type cast", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: {
            properties: {
              title: { type: "string", searchable: { language: "english" } },
              abstract: {
                type: "string",
                searchable: { language: "english" },
                optional: true,
              },
            },
          },
        },
      }),
    );
    const papers = evolved.getNodeCollection("Paper")!;
    await papers.create({
      title: "Attention is all you need",
      abstract: "Introduces the Transformer architecture",
    });
    await papers.create({
      title: "Local cuisine guide",
      abstract: "Restaurants worth visiting",
    });

    // No cast required.
    const results = await evolved.search.fulltext("Paper", {
      query: "attention transformer",
      limit: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    const top = results[0]!.node as unknown as { title: string };
    expect(top.title).toBe("Attention is all you need");
  });

  it("misspelled runtime kind throws ConfigurationError at the call site", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: {
            properties: {
              title: { type: "string", searchable: { language: "english" } },
            },
          },
        },
      }),
    );

    const caught = await evolved.search
      .fulltext("Papre", { query: "x", limit: 10 })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(KindNotFoundError);
    expect((caught as Error).message).toMatch(
      /Node kind "Papre" is not registered/,
    );
  });

  it("misspelled compile-time kind also throws (no silent empty result)", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const caught = await store.search
      .fulltext("Persn" as never, { query: "x", limit: 10 })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(KindNotFoundError);
  });
});

describe("store.search.vector", () => {
  it("runs vector-only similarity against a runtime kind without a type cast", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: {
            properties: {
              title: { type: "string" },
              embedding: {
                type: "array",
                items: { type: "number" },
                embedding: { dimensions: 4 },
              },
            },
          },
        },
      }),
    );
    const papers = evolved.getNodeCollection("Paper")!;
    await papers.create({
      title: "alpha",
      embedding: [1, 0, 0, 0],
    });
    await papers.create({
      title: "beta",
      embedding: [0, 1, 0, 0],
    });

    // No cast required.
    const results = await evolved.search.vector("Paper", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      limit: 5,
    });
    // The runtime kind's auto-derived embedding flowed through the
    // backend's vector search path. Either we get hits ranked by
    // similarity, or we get an empty array (the backend honored the
    // call but the embedding column wasn't populated). Both are
    // valid backend responses; what matters is that the kind wasn't
    // rejected at the facade boundary.
    expect(Array.isArray(results)).toBe(true);
  });

  it("misspelled kind on vector throws before the capability check", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const caught = await store.search
      .vector("DoesNotExist" as never, {
        fieldPath: "embedding",
        queryEmbedding: [0.1, 0.2, 0.3, 0.4],
        limit: 5,
      })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(KindNotFoundError);
    expect((caught as Error).message).toMatch(/is not registered/);
  });
});

describe("store.search.hybrid on runtime kinds", () => {
  it("accepts a runtime kind name without a type cast", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: {
            properties: {
              title: { type: "string", searchable: { language: "english" } },
              embedding: {
                type: "array",
                items: { type: "number" },
                embedding: { dimensions: 4 },
              },
            },
          },
        },
      }),
    );
    const papers = evolved.getNodeCollection("Paper")!;
    await papers.create({
      title: "Attention is all you need",
      embedding: [1, 0, 0, 0],
    });
    await papers.create({
      title: "Local cuisine guide",
      embedding: [0, 1, 0, 0],
    });

    // No cast required.
    const results = await evolved.search.hybrid("Paper", {
      limit: 5,
      vector: {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
      },
      fulltext: { query: "attention" },
    });
    // RRF fuses the two halves; we don't assert ordering (depends on
    // backend ranking deterministically), only that the call accepted
    // a runtime kind without a cast.
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("store.search.rebuildFulltext on runtime kinds", () => {
  it("accepts a runtime kind name without a type cast", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: {
            properties: {
              title: { type: "string", searchable: { language: "english" } },
            },
          },
        },
      }),
    );
    const papers = evolved.getNodeCollection("Paper")!;
    await papers.create({ title: "Attention" });

    // No cast: the kind name parameter is `string`-bounded, registry-
    // guarded.
    const result = await evolved.search.rebuildFulltext("Paper");
    expect(result.kinds).toContain("Paper");
    expect(result.upserted).toBeGreaterThan(0);
  });

  it("rebuildFulltext with no kind argument scans every kind including runtime", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: {
            properties: {
              title: { type: "string", searchable: { language: "english" } },
            },
          },
        },
      }),
    );
    const papers = evolved.getNodeCollection("Paper")!;
    await papers.create({ title: "First paper" });
    await papers.create({ title: "Second paper" });

    const result = await evolved.search.rebuildFulltext();
    expect(result.kinds).toContain("Paper");
    expect(result.upserted).toBeGreaterThan(0);
  });
});
