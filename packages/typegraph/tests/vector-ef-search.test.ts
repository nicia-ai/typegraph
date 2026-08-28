/**
 * Per-search `efSearch` (HNSW `hnsw.ef_search` override) — backend-agnostic
 * behavior.
 *
 * Covers the parts that don't need a live Postgres:
 * - Validation at the store boundary (positive integer) for vector + hybrid.
 * - pgvector's 1..1000 ceiling, enforced where the SELECT is built.
 * - sqlite-vec REFUSES the option (#433): the engine has no frontier knob, so
 *   the capability declares the gap and both search paths throw the typed
 *   error instead of silently searching without it.
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
  pgvectorStrategy,
} from "../src/query/dialect/vector/pgvector-strategy";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
import { resolveEfSearchOverride } from "../src/query/dialect/vector-strategy";
import { createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";
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

/**
 * sqlite-vec's own statement of why it has no frontier knob. Spelled out
 * (not read back off the capability) so a change to the declaration has to be
 * made deliberately in both places rather than silently agreeing with itself.
 */
const SQLITE_VEC_NO_FRONTIER_REASON =
  "a vec0 KNN takes only `k` (the page size); sqlite-vec exposes no ANN frontier parameter";

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

/**
 * The one predicate both backends read. Its arms are exercised end-to-end
 * against sqlite-vec below and against a live pgvector in
 * `tests/backends/postgres/postgres-vector-ef-search.test.ts`; here they are
 * pinned directly so the PostgreSQL arms stay covered without a server, and so
 * the SQLite and PostgreSQL refusals are visibly the same decision.
 */
/**
 * Returns what `run` threw, so a synchronous refusal can be matched on its
 * code and details the same way an async one is.
 */
function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw, but it returned normally");
}

describe("efSearch applicability (resolveEfSearchOverride)", () => {
  const pgvectorTuning = pgvectorStrategy.capabilities.searchFrontierTuning;
  const sqliteVecTuning = sqliteVecStrategy.capabilities.searchFrontierTuning;

  it("returns the engine parameter for a tunable HNSW slot", () => {
    expect(
      resolveEfSearchOverride({
        efSearch: 256,
        indexType: "hnsw",
        tuning: pgvectorTuning,
        interactiveTransactions: true,
        dialect: "PostgreSQL",
        engine: "pgvector",
      }),
    ).toBe("hnsw.ef_search");
  });

  it("accepts an absent override on every engine", () => {
    for (const tuning of [pgvectorTuning, sqliteVecTuning]) {
      expect(
        resolveEfSearchOverride({
          efSearch: undefined,
          indexType: "none",
          tuning,
          interactiveTransactions: false,
          dialect: "SQLite",
          engine: "engine",
        }),
      ).toBeUndefined();
    }
  });

  it("refuses a slot whose index type cannot honor the parameter", () => {
    expect(
      captureThrown(() =>
        resolveEfSearchOverride({
          efSearch: 256,
          indexType: "ivfflat",
          tuning: pgvectorTuning,
          interactiveTransactions: true,
          dialect: "PostgreSQL",
          engine: "pgvector",
        }),
      ),
    ).toMatchObject({
      code: "CONFIGURATION_ERROR",
      details: { efSearch: 256, indexType: "ivfflat" },
    });
  });

  it("refuses a scoped override on a transaction-less backend", () => {
    expect(
      captureThrown(() =>
        resolveEfSearchOverride({
          efSearch: 256,
          indexType: "hnsw",
          tuning: pgvectorTuning,
          interactiveTransactions: false,
          dialect: "PostgreSQL",
          engine: "pgvector",
        }),
      ),
    ).toMatchObject({
      code: "UNSUPPORTED_BACKEND_CAPABILITY",
      details: { capability: "execution.interactiveTransactions", efSearch: 256 },
    });
  });

  it("refuses an engine with no frontier knob, naming its reason", () => {
    // Transactions are ON here: an engine that has no knob is refused for the
    // engine, not for the frame — the two arms cannot be conflated.
    expect(
      captureThrown(() =>
        resolveEfSearchOverride({
          efSearch: 256,
          indexType: "hnsw",
          tuning: sqliteVecTuning,
          interactiveTransactions: true,
          dialect: "SQLite",
          engine: "sqlite-vec",
        }),
      ),
    ).toMatchObject({
      code: "UNSUPPORTED_BACKEND_CAPABILITY",
      details: {
        capability: "vector.searchFrontierTuning",
        efSearch: 256,
        engine: "sqlite-vec",
        reason: SQLITE_VEC_NO_FRONTIER_REASON,
      },
    });
  });
});

/**
 * sqlite-vec has no per-search ANN frontier knob of any kind — a vec0 KNN
 * takes `k` (the page size) and nothing else. Until #433 the backend accepted
 * `efSearch` and searched as though it had never been passed, which is the one
 * outcome AGENTS.md's contract discipline forbids: an accepted option is
 * applied or refused, never ignored. The engine gap is now declared as a
 * capability and refused with the typed error the PostgreSQL arms use.
 */
describe("efSearch on sqlite-vec is refused, not ignored", () => {
  it("declares the engine gap as a capability", () => {
    const backend = createTestBackend();

    expect(backend.capabilities.vector?.searchFrontierTuning).toEqual({
      tunable: false,
      reason: SQLITE_VEC_NO_FRONTIER_REASON,
    });
  });

  it("refuses efSearch on a vector search", async () => {
    const store = await seededStore();

    await expect(
      store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        limit: 5,
        efSearch: 256,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_BACKEND_CAPABILITY",
      details: {
        capability: "vector.searchFrontierTuning",
        efSearch: 256,
        engine: "sqlite-vec",
      },
    });
  });

  it("refuses efSearch on a hybrid search", async () => {
    // The single-statement hybrid path builds its own VectorSearchParams and
    // used to drop `vector.efSearch` while doing so — the same silent ignore
    // in a second place, so it gets the same refusal.
    const store = await seededStore();

    await expect(
      store.search.hybrid("Doc", {
        limit: 5,
        vector: {
          fieldPath: "embedding",
          queryEmbedding: [1, 0, 0, 0],
          efSearch: 256,
        },
        fulltext: { query: "alpha" },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_BACKEND_CAPABILITY",
      details: {
        capability: "vector.searchFrontierTuning",
        efSearch: 256,
        engine: "sqlite-vec",
      },
    });
  });

  it("still searches normally when no override is passed", async () => {
    // The refusal is scoped to the stated option: omitting it must not
    // disturb the search that worked before.
    const store = await seededStore();

    const hits = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      limit: 5,
    });

    expect(hits.length).toBe(3);
    // The nearest neighbor to the x-axis query is "alpha".
    expect(
      (requireDefined(hits[0]).node as unknown as { title: string }).title,
    ).toBe("alpha");
  });
});
