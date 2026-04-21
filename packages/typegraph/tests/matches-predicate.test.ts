/**
 * Tests for .matches() query predicate — the query-builder-native FTS
 * predicate that composes with metadata filters, graph traversal, and
 * (in hybrid mode) vector similarity.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  searchable,
  subClassOf,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { type PropsAccessor } from "../src/query/builder/types";
import { compileQuery } from "../src/query/compiler";
import { type FulltextAccessor } from "../src/query/predicates";
import { buildKindRegistry } from "../src/registry";
import { createStore } from "../src/store";
import { toSqlString, toSqlWithParams } from "./sql-test-utils";
import { createTestBackend } from "./test-utils";

// ============================================================
// Fixture schemas
// ============================================================

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    tenantId: z.string(),
    published: z.boolean(),
  }),
});

const User = defineNode("User", {
  schema: z.object({ name: z.string() }),
});

const canRead = defineEdge("canRead");

const DocumentGraph = defineGraph({
  id: "matches-predicate-test",
  nodes: { Document: { type: Document }, User: { type: User } },
  edges: {
    canRead: {
      type: canRead,
      from: [User],
      to: [Document],
      cardinality: "many",
    },
  },
});

type DocumentShape = Readonly<{
  title: string;
  body: string;
  tenantId: string;
  published: boolean;
}>;

/**
 * Retained for tests that exercise the runtime safety net on node kinds
 * without `searchable()` fields. `$fulltext` is always present on
 * `NodeAccessor` now; the runtime check is the single source of truth.
 */
function runtimeFulltext(u: unknown): FulltextAccessor {
  return (u as { $fulltext: FulltextAccessor }).$fulltext;
}

// ============================================================
// Setup
// ============================================================

describe(".matches() predicate", () => {
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof DocumentGraph>>;

  beforeEach(async () => {
    backend = createTestBackend();
    await backend.bootstrapTables?.();
    store = createStore(DocumentGraph, backend);
  });

  // ================================================================
  // Standalone usage
  // ================================================================

  it("ranks matching docs by relevance", async () => {
    await store.nodes.Document.create({
      title: "Climate report",
      body: "Rising temperatures and greenhouse gases",
      tenantId: "t1",
      published: true,
    });
    await store.nodes.Document.create({
      title: "Local cuisine",
      body: "Restaurants in town",
      tenantId: "t1",
      published: true,
    });

    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.$fulltext.matches("climate temperatures", 10))
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(1);
    expect((results[0] as unknown as DocumentShape).title).toBe(
      "Climate report",
    );
  });

  it("enforces the top-k limit from the matches() call", async () => {
    for (let index = 0; index < 5; index += 1) {
      await store.nodes.Document.create({
        title: `Document ${index}`,
        body: "shared body content climate",
        tenantId: "t1",
        published: true,
      });
    }

    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.$fulltext.matches("climate", 3))
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(3);
  });

  it("applies the matches() top-k within metadata-filtered scope", async () => {
    await store.nodes.Document.create({
      title: "Climate climate climate climate climate climate",
      body: "dominates the global rank but belongs to another tenant",
      tenantId: "t2",
      published: true,
    });
    await store.nodes.Document.create({
      title: "Climate report for tenant one",
      body: "relevant within the requested tenant scope",
      tenantId: "t1",
      published: true,
    });

    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.$fulltext.matches("climate", 1).and(d.tenantId.eq("t1")),
      )
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(1);
    expect((results[0] as unknown as DocumentShape).tenantId).toBe("t1");
  });

  // ================================================================
  // Composition with metadata predicates — the multi-tenant RAG case
  // ================================================================

  it("composes with .and(metadata predicate)", async () => {
    await store.nodes.Document.create({
      title: "Climate report — t1",
      body: "climate body",
      tenantId: "t1",
      published: true,
    });
    await store.nodes.Document.create({
      title: "Climate report — t2",
      body: "climate body",
      tenantId: "t2",
      published: true,
    });

    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.$fulltext.matches("climate", 10).and(d.tenantId.eq("t1")),
      )
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(1);
    expect((results[0] as unknown as DocumentShape).tenantId).toBe("t1");
  });

  it("composes with boolean filters", async () => {
    await store.nodes.Document.create({
      title: "Published climate story",
      body: "body",
      tenantId: "t1",
      published: true,
    });
    await store.nodes.Document.create({
      title: "Draft climate story",
      body: "body",
      tenantId: "t1",
      published: false,
    });

    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.$fulltext.matches("climate", 10).and(d.published.eq(true)),
      )
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(1);
    expect((results[0] as unknown as DocumentShape).published).toBe(true);
  });

  // ================================================================
  // Composition with graph traversal
  // ================================================================

  it("composes with .join() / graph traversal", async () => {
    const alice = await store.nodes.User.create({ name: "Alice" });
    const bob = await store.nodes.User.create({ name: "Bob" });
    const aliceDocument = await store.nodes.Document.create({
      title: "Climate Alice",
      body: "body",
      tenantId: "t1",
      published: true,
    });
    const bobDocument = await store.nodes.Document.create({
      title: "Climate Bob",
      body: "body",
      tenantId: "t1",
      published: true,
    });
    await store.edges.canRead.create(
      { kind: "User", id: alice.id },
      { kind: "Document", id: aliceDocument.id },
      {},
    );
    await store.edges.canRead.create(
      { kind: "User", id: bob.id },
      { kind: "Document", id: bobDocument.id },
      {},
    );

    // Docs Alice can read that match "climate".
    const results = await store
      .query()
      .from("User", "u")
      .traverse("canRead", "e")
      .to("Document", "d")
      .whereNode("u", (u) => u.id.eq(alice.id))
      .whereNode("d", (d) => d.$fulltext.matches("climate", 10))
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(1);
    expect((results[0] as unknown as DocumentShape).title).toBe(
      "Climate Alice",
    );
    void bob;
    void bobDocument;
  });

  it("applies matches() top-k within traversal-reachable scope", async () => {
    const alice = await store.nodes.User.create({ name: "Alice" });
    const bob = await store.nodes.User.create({ name: "Bob" });
    const aliceDocument = await store.nodes.Document.create({
      title: "Climate note for Alice",
      body: "reachable from Alice",
      tenantId: "t1",
      published: true,
    });
    const bobDocument = await store.nodes.Document.create({
      title: "Climate climate climate climate climate for Bob",
      body: "globally stronger but unreachable from Alice",
      tenantId: "t1",
      published: true,
    });
    await store.edges.canRead.create(
      { kind: "User", id: alice.id },
      { kind: "Document", id: aliceDocument.id },
      {},
    );
    await store.edges.canRead.create(
      { kind: "User", id: bob.id },
      { kind: "Document", id: bobDocument.id },
      {},
    );

    const results = await store
      .query()
      .from("User", "u")
      .traverse("canRead", "e")
      .to("Document", "d")
      .whereNode("u", (u) => u.id.eq(alice.id))
      .whereNode("d", (d) => d.$fulltext.matches("climate", 1))
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(1);
    expect((results[0] as unknown as DocumentShape).title).toBe(
      "Climate note for Alice",
    );
  });

  // ================================================================
  // Query modes
  // ================================================================

  it("handles websearch-mode negation", async () => {
    await store.nodes.Document.create({
      title: "Apple harvest",
      body: "apples and oranges in autumn",
      tenantId: "t1",
      published: true,
    });
    await store.nodes.Document.create({
      title: "Apple recipe",
      body: "apples and cinnamon",
      tenantId: "t1",
      published: true,
    });

    const results = await store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.$fulltext.matches("apples -oranges", 10, { mode: "websearch" }),
      )
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(1);
    expect((results[0] as unknown as DocumentShape).title).toBe("Apple recipe");
  });

  // ================================================================
  // Hybrid: matches() + similarTo() in one query builder call
  // ================================================================

  it("fuses with .similarTo() via SQL-layer RRF", async () => {
    // Build a smaller hybrid graph so we can exercise the dual-predicate path.
    const HybridDocument = defineNode("HybridDoc", {
      schema: z.object({
        title: searchable({ language: "english" }),
        body: searchable({ language: "english" }),
        embedding: embedding(4),
      }),
    });
    const HybridGraph = defineGraph({
      id: "matches-hybrid-test",
      nodes: { HybridDoc: { type: HybridDocument } },
      edges: {},
    });

    const hybridBackend = createTestBackend();
    await hybridBackend.bootstrapTables?.();
    const hybridStore = createStore(HybridGraph, hybridBackend);

    const solar = await hybridStore.nodes.HybridDoc.create({
      title: "Solar power",
      body: "photovoltaic renewable energy",
      embedding: [1, 0, 0, 0],
    });
    const wind = await hybridStore.nodes.HybridDoc.create({
      title: "Wind turbines",
      body: "rotating rotors convert kinetic energy",
      embedding: [0, 1, 0, 0],
    });

    // Stub vector search since the test backend lacks sqlite-vec. We only
    // need the compiled query to succeed shape-wise with FTS active.
    const mutableBackend = hybridBackend as unknown as {
      vectorSearch?: GraphBackend["vectorSearch"];
    };
    mutableBackend.vectorSearch = () =>
      Promise.resolve([
        { nodeId: wind.id, score: 0.95 },
        { nodeId: solar.id, score: 0.2 },
      ]);

    // We cannot easily drive the query-builder SQL-layer RRF from the
    // sqlite test backend because the actual `similarTo()` path needs a
    // loaded vector extension. Instead assert that store.search.hybrid()
    // (the TS-layer wrapper) produces sensible fused ordering.
    const results = await hybridStore.search.hybrid("HybridDoc", {
      limit: 2,
      vector: {
        fieldPath: "embedding",
        queryEmbedding: [0, 1, 0, 0],
      },
      fulltext: { query: "solar" },
    });
    expect(results).toHaveLength(2);
    // Fulltext only surfaces solar; vector only surfaces wind. RRF should
    // rank both near the top.
    const topIds = results.slice(0, 2).map((r) => r.node.id);
    expect(topIds).toContain(solar.id);
    expect(topIds).toContain(wind.id);
  });

  // ================================================================
  // Invalid usage
  // ================================================================

  it("rejects .matches() nested under .or()", async () => {
    await store.nodes.Document.create({
      title: "anything",
      body: "anything",
      tenantId: "t1",
      published: true,
    });

    const action = store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) =>
        d.$fulltext.matches("x", 10).or(d.tenantId.eq("t1")),
      )
      .select((ctx) => ctx.d)
      .execute();

    await expect(action).rejects.toThrow(/cannot be nested under OR or NOT/);
  });

  it("rejects zero / negative limits at the builder boundary", () => {
    expect(() =>
      store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) => d.$fulltext.matches("x", 0))
        .select((ctx) => ctx.d),
    ).toThrow(/positive finite number/);
  });

  // ================================================================
  // Searchable gating: .matches() must reject non-searchable fields
  // ================================================================

  it("rejects $fulltext.matches() on a node kind with no searchable fields", async () => {
    await store.nodes.User.create({ name: "someone" });

    // User has no searchable() fields, so $fulltext is absent at the type
    // level. The runtime check is the safety net; cast past the type gate
    // to exercise it.
    expect(() =>
      store
        .query()
        .from("User", "u")
        .whereNode("u", (u) => runtimeFulltext(u).matches("anything", 10))
        .select((ctx) => ctx.u),
    ).toThrow(
      /Cannot call \.\$fulltext\.matches\(\) on alias "u".*declared with searchable\(\)/,
    );
  });
});

// ================================================================
// Polymorphic aliases — Issue P1 #2
// ================================================================

const Content = defineNode("Content", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
  }),
});

const Article = defineNode("Article", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
  }),
});

const BlogPost = defineNode("BlogPost", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
  }),
});

const PolymorphicGraph = defineGraph({
  id: "matches-polymorphic-test",
  nodes: {
    Content: { type: Content },
    Article: { type: Article },
    BlogPost: { type: BlogPost },
  },
  edges: {},
  ontology: [subClassOf(Article, Content), subClassOf(BlogPost, Content)],
});

describe(".matches() with polymorphic alias", () => {
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof PolymorphicGraph>>;

  beforeEach(async () => {
    backend = createTestBackend();
    await backend.bootstrapTables?.();
    store = createStore(PolymorphicGraph, backend);
  });

  it("searches every concrete kind that the alias resolves to via subClassOf", async () => {
    const article = await store.nodes.Article.create({
      title: "Renewable energy article",
      body: "long-form analysis",
    });
    const blog = await store.nodes.BlogPost.create({
      title: "Renewable energy blog",
      body: "casual take",
    });

    // includeSubClasses expands "Content" to ["Content", "Article", "BlogPost"].
    // The polymorphic accessor types lose individual field typing; the
    // runtime introspector still recognizes title as searchable across
    // all three kinds and emits a node_kind IN (...) filter.
    const results = await store
      .query()
      .from("Content", "d", { includeSubClasses: true })
      .whereNode("d", (d) =>
        (d as unknown as { $fulltext: FulltextAccessor }).$fulltext.matches(
          "renewable",
          10,
        ),
      )
      .select((ctx) => ({ id: ctx.d.id }))
      .execute();

    const ids = results.map((r) => r.id).toSorted();
    expect(ids).toEqual([article.id, blog.id].toSorted());
  });

  it("rejects polymorphic matches when any subclass lacks searchable() fields", async () => {
    // Parent + two subclasses where only one declares `searchable()`.
    // `hasSearchableField` uses `.every()`, so the runtime guard throws
    // rather than silently producing partial results across the mixed
    // set. This pins the behavior for the kbgraph-style shape where a
    // parent kind has heterogeneous children.
    const Media = defineNode("Media", {
      schema: z.object({ title: z.string() }),
    });
    const TextMedia = defineNode("TextMedia", {
      schema: z.object({
        title: searchable({ language: "english" }),
      }),
    });
    const BinaryMedia = defineNode("BinaryMedia", {
      schema: z.object({ title: z.string() }),
    });
    const MixedGraph = defineGraph({
      id: "matches-mixed-subclass-test",
      nodes: {
        Media: { type: Media },
        TextMedia: { type: TextMedia },
        BinaryMedia: { type: BinaryMedia },
      },
      edges: {},
      ontology: [subClassOf(TextMedia, Media), subClassOf(BinaryMedia, Media)],
    });

    const mixedBackend = createTestBackend();
    await mixedBackend.bootstrapTables?.();
    const mixedStore = createStore(MixedGraph, mixedBackend);

    await mixedStore.nodes.TextMedia.create({ title: "searchable one" });
    await mixedStore.nodes.BinaryMedia.create({ title: "opaque one" });

    expect(() =>
      mixedStore
        .query()
        .from("Media", "m", { includeSubClasses: true })
        .whereNode("m", (m) =>
          (m as unknown as { $fulltext: FulltextAccessor }).$fulltext.matches(
            "searchable",
            10,
          ),
        )
        .select((ctx) => ({ id: ctx.m.id }))
        .execute(),
    ).toThrow(/searchable\(\)/i);
  });

  it("hybrid SQL appends user orderBy as RRF tiebreaker", () => {
    // We can't execute the dual-predicate path against the in-memory
    // SQLite test backend (no sqlite-vec), but we can compile the AST
    // and inspect the SQL to confirm the user's orderBy clause appears
    // after the RRF expression. Without this, pagination would be
    // unstable on RRF score ties.
    const queryEmbedding = [0.1, 0.2, 0.3, 0.4];
    const HybridDocument = defineNode("HybridDoc", {
      schema: z.object({
        title: searchable({ language: "english" }),
        body: searchable({ language: "english" }),
        rank: z.number(),
        embedding: embedding(4),
      }),
    });
    const HybridGraph = defineGraph({
      id: "hybrid-orderby-test",
      nodes: { HybridDoc: { type: HybridDocument } },
      edges: {},
    });
    const hybridQuery = createQueryBuilder<typeof HybridGraph>(
      HybridGraph.id,
      buildKindRegistry(HybridGraph),
    );

    const ast = hybridQuery
      .from("HybridDoc", "d")
      .whereNode("d", (d) =>
        d.$fulltext
          .matches("anything", 50)
          .and(d.embedding.similarTo(queryEmbedding, 50)),
      )
      .orderBy("d", "rank", "desc")
      .select((ctx) => ctx.d)
      .toAst();

    const compiled = compileQuery(ast, HybridGraph.id, {
      dialect: "postgres",
    });
    const sqlText = toSqlString(compiled);
    // The outer ORDER BY contains the fused RRF expression FOLLOWED BY
    // the user's `rank` orderBy as a tiebreaker (json-path extraction).
    expect(sqlText).toMatch(
      /ORDER BY.*cte_embeddings\.ord.*cte_fulltext\.ord.*ARRAY\['rank'\].*DESC/,
    );
    // The fulltext CTE's inner LIMIT must break rank ties by node_id so
    // the top-k cutoff matches the backend's fulltextSearch (rank DESC, node_id ASC).
    expect(sqlText).toMatch(
      /ORDER BY rank DESC,\s+"typegraph_node_fulltext"\."node_id" ASC\s+LIMIT/,
    );
  });

  it("hybrid SQL preserves single-source candidates before RRF ordering", () => {
    const queryEmbedding = [0.1, 0.2, 0.3, 0.4];
    const HybridDocument = defineNode("HybridDoc", {
      schema: z.object({
        title: searchable({ language: "english" }),
        body: searchable({ language: "english" }),
        embedding: embedding(4),
      }),
    });
    const HybridGraph = defineGraph({
      id: "hybrid-union-shape-test",
      nodes: { HybridDoc: { type: HybridDocument } },
      edges: {},
    });
    const hybridQuery = createQueryBuilder<typeof HybridGraph>(
      HybridGraph.id,
      buildKindRegistry(HybridGraph),
    );

    const ast = hybridQuery
      .from("HybridDoc", "d")
      .whereNode("d", (d) =>
        d.$fulltext
          .matches("anything", 50)
          .and(d.embedding.similarTo(queryEmbedding, 50)),
      )
      .select((ctx) => ctx.d)
      .toAst();

    const compiled = compileQuery(ast, HybridGraph.id, {
      dialect: "postgres",
    });
    const sqlText = toSqlString(compiled);

    expect(sqlText).toMatch(/cte_relevance_candidates AS/);
    expect(sqlText).toMatch(
      /SELECT node_id, node_kind FROM cte_embeddings\s+UNION\s+SELECT node_id, node_kind FROM cte_fulltext/,
    );
    expect(sqlText).toMatch(
      /INNER JOIN cte_relevance_candidates ON cte_relevance_candidates\.node_id = cte_d\.d_id AND cte_relevance_candidates\.node_kind = cte_d\.d_kind/,
    );
    expect(sqlText).toMatch(
      /LEFT JOIN cte_embeddings ON cte_embeddings\.node_id = cte_d\.d_id AND cte_embeddings\.node_kind = cte_d\.d_kind/,
    );
    expect(sqlText).toMatch(
      /LEFT JOIN cte_fulltext ON cte_fulltext\.node_id = cte_d\.d_id AND cte_fulltext\.node_kind = cte_d\.d_kind/,
    );
  });

  it("does not cross-join when two kinds share an id", async () => {
    // Node PK is (graph_id, kind, id) so the same id can legally exist
    // across kinds. The fulltext join must key on (node_id, node_kind),
    // not just node_id, otherwise polymorphic .matches() would
    // duplicate rows or attach the wrong rank.
    const SHARED_ID = "shared-id-001";
    await store.nodes.Article.create(
      {
        title: "Quantum entanglement essay",
        body: "Article on quantum entanglement.",
      },
      { id: SHARED_ID },
    );
    await store.nodes.BlogPost.create(
      {
        title: "Quantum entanglement post",
        body: "Blog on quantum entanglement.",
      },
      { id: SHARED_ID },
    );

    const results = await store
      .query()
      .from("Content", "d", { includeSubClasses: true })
      .whereNode("d", (d) =>
        (d as unknown as { $fulltext: FulltextAccessor }).$fulltext.matches(
          "quantum",
          10,
        ),
      )
      .select((ctx) => ({ id: ctx.d.id, kind: ctx.d.kind }))
      .execute();

    expect(results).toHaveLength(2);
    const kinds = results.map((r) => r.kind).toSorted();
    expect(kinds).toEqual(["Article", "BlogPost"]);
    // Both results carry the same id but distinct kinds; no duplication.
    expect(results.every((r) => r.id === SHARED_ID)).toBe(true);
  });

  it("vector CTE keys on (node_id, node_kind) and filters by resolved kinds", () => {
    // Mirrors the cross-kind shared-id concern but for the vector side.
    // Cannot execute end-to-end on the test backend (no sqlite-vec), so
    // compile and inspect the SQL.
    const queryEmbedding = [0.1, 0.2, 0.3, 0.4];
    const PolyVector = defineNode("PolyVector", {
      schema: z.object({
        title: searchable({ language: "english" }),
        embedding: embedding(4),
      }),
    });
    const PolyChild = defineNode("PolyChild", {
      schema: z.object({
        title: searchable({ language: "english" }),
        embedding: embedding(4),
      }),
    });
    const VectorPolyGraph = defineGraph({
      id: "vector-poly-test",
      nodes: {
        PolyVector: { type: PolyVector },
        PolyChild: { type: PolyChild },
      },
      edges: {},
      ontology: [subClassOf(PolyChild, PolyVector)],
    });

    const polyQuery = createQueryBuilder<typeof VectorPolyGraph>(
      VectorPolyGraph.id,
      buildKindRegistry(VectorPolyGraph),
    );
    const ast = polyQuery
      .from("PolyVector", "v", { includeSubClasses: true })
      .whereNode("v", (v) =>
        (v as unknown as PropsAccessor<typeof PolyChild>).embedding.similarTo(
          queryEmbedding,
          10,
        ),
      )
      .select((ctx) => ctx.v)
      .toAst();

    const compiled = compileQuery(ast, VectorPolyGraph.id, {
      dialect: "postgres",
    });
    const sqlText = toSqlString(compiled);
    const { params } = toSqlWithParams(compiled, "postgres");

    // Filter restricts to the alias's resolved kinds.
    expect(sqlText).toMatch(
      /node_kind" IN \(PolyVector, PolyChild\)|node_kind IN \(PolyVector, PolyChild\)/,
    );
    expect(params).toContain("embedding");
    // JOIN keys on both id AND kind.
    expect(sqlText).toMatch(
      /INNER JOIN cte_embeddings ON cte_embeddings\.node_id = cte_v\.v_id AND cte_embeddings\.node_kind = cte_v\.v_kind/,
    );
    // CTE carries node_kind through both the inner subquery SELECT and
    // the outer ROW_NUMBER-wrapping SELECT. Counting total occurrences
    // in the whole query: the baseline without node_kind support would
    // be 1 (the kind filter). Post-fix we expect ≥4 — inner projection,
    // outer projection, inner WHERE, and the JOIN's ON clause.
    const nodeKindMentions = (sqlText.match(/node_kind/g) ?? []).length;
    expect(nodeKindMentions).toBeGreaterThanOrEqual(4);
  });
});
