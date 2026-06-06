import type { GraphBackend, Node } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { SimilarityUnavailableError } from "../../src/graph-merge/errors";
import { isErr } from "../../src/graph-merge/result";
import type { SimilarityContext } from "../../src/graph-merge/similarity";
import { scorePair } from "../../src/graph-merge/similarity";
import type { SimilarityStrategy } from "../../src/graph-merge/types";
import {
  createPgliteMergeBackend,
  createSqliteMergeBackend,
} from "./test-utils";

/**
 * Search-parity probe (design §13 Open-Q#1, mostly resolved by TypeGraph 0.29.0).
 *
 * Three properties, asserted across the dual backend matrix:
 *
 *   1. `store.search.fulltext` returns hits on BOTH SQLite (FTS5) and PGlite
 *      (tsvector + GIN) — full parity, no extension beyond the batteries-included
 *      local backends, no embeddings.
 *   2. A `vector` / `hybrid` similarity strategy with NO configured embedder
 *      yields a typed {@link SimilarityUnavailableError}, INDEPENDENT of the
 *      backend's own vector capability: merge scoring uses an injected in-memory
 *      embedder (exact cosine over staged candidate pairs), never the backend ANN
 *      index (the staged candidate rows are unindexed).
 *   3. `backend.capabilities.vector?.supported` is `true` on the default PGlite
 *      backend (pgvector loaded). That index is available for RETRIEVAL at scale;
 *      it is deliberately NOT on the merge candidate-scoring path, so the
 *      capability and the merge embedder are orthogonal.
 */

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable(),
    body: z.string(),
  }),
});

const searchGraph = defineGraph({
  id: "search-parity",
  nodes: { Document: { type: Document } },
  edges: {},
});

/** Seeds three documents whose titles share a discriminating term. */
async function seedDocuments(backend: GraphBackend) {
  const [store] = await createStoreWithSchema(searchGraph, backend);
  await store.nodes.Document.create({
    title: "Climate warming trends",
    body: "rising global temperatures",
  });
  await store.nodes.Document.create({
    title: "Climate policy review",
    body: "carbon pricing mechanisms",
  });
  await store.nodes.Document.create({
    title: "Local bakery openings",
    body: "fresh bread daily",
  });
  return store;
}

describe("search-parity probe (Open-Q#1)", () => {
  let cleanups: (() => Promise<void>)[];

  afterEach(async () => {
    for (const cleanup of cleanups ?? []) {
      await cleanup();
    }
    cleanups = [];
  });

  it("fulltext returns hits on SQLite (FTS5)", async () => {
    const fixture = createSqliteMergeBackend();
    cleanups = [fixture.cleanup];
    const store = await seedDocuments(fixture.backend);

    const hits = await store.search.fulltext("Document", {
      query: "climate",
      limit: 10,
    });

    // Both "Climate" titles match; the bakery doc does not.
    expect(hits.length).toBe(2);
    const titles = hits.map((hit) => hit.node.title).sort();
    expect(titles).toEqual(["Climate policy review", "Climate warming trends"]);
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  it("fulltext returns hits on PGlite (tsvector + GIN)", async () => {
    const fixture = await createPgliteMergeBackend();
    cleanups = [fixture.cleanup];
    const store = await seedDocuments(fixture.backend);

    const hits = await store.search.fulltext("Document", {
      query: "climate",
      limit: 10,
    });

    expect(hits.length).toBe(2);
    const titles = hits.map((hit) => hit.node.title).sort();
    expect(titles).toEqual(["Climate policy review", "Climate warming trends"]);
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });

  it("yields SimilarityUnavailableError for vector/hybrid with no configured embedder", async () => {
    const fixture = createSqliteMergeBackend();
    cleanups = [fixture.cleanup];

    const a = { kind: "Document", id: "a", title: "x" } as unknown as Node;
    const b = { kind: "Document", id: "b", title: "y" } as unknown as Node;
    // No `embeddings` on the context == MergeOptions.embedder was not configured.
    // The error fires regardless of the backend's own vector capability.
    const ctx: SimilarityContext = { backend: fixture.backend };

    for (const kind of ["vector", "hybrid"] as const) {
      const strategy: SimilarityStrategy =
        kind === "vector" ?
          { kind: "vector", field: "title" }
        : { kind: "hybrid", fields: ["title"] };
      const result = scorePair(a, b, strategy, ctx);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(SimilarityUnavailableError);
        expect(result.error.code).toBe("GRAPH_MERGE_SIMILARITY_UNAVAILABLE");
      }
    }
  });

  it("advertises vector capability on the default PGlite backend (pgvector) — orthogonal to merge scoring", async () => {
    const fixture = await createPgliteMergeBackend();
    cleanups = [fixture.cleanup];

    // The default PGlite backend loads pgvector, so it advertises vector support
    // for RETRIEVAL. Merge candidate scoring does NOT use this index (staged rows
    // are unindexed) — it uses the injected in-memory embedder — so this is
    // asserted as an independent backend fact, not a merge gate.
    expect(fixture.backend.capabilities.vector?.supported).toBe(true);
    expect(
      fixture.backend.capabilities.vector?.metrics.length ?? 0,
    ).toBeGreaterThan(0);
  });
});
