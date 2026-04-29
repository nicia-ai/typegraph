/**
 * Tests for fulltext search: searchable() brand, schema introspection,
 * sync-on-write, end-to-end search, and hybrid (RRF) search.
 *
 * The FTS5 extension is statically linked into better-sqlite3 in the standard
 * prebuilt binaries, so the end-to-end tests can run against the in-memory
 * backend without additional setup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { embedding } from "../src/core/embedding";
import {
  getSearchableMetadata,
  isSearchableSchema,
  searchable,
} from "../src/core/searchable";
import { createSchemaIntrospector } from "../src/query/schema-introspector";
import { createStore } from "../src/store";
import { getSearchableFields } from "../src/store/fulltext-sync";
import { type FulltextSearchHit } from "../src/store/search";
import { createTestBackend } from "./test-utils";

type DocumentProps = Readonly<{ title: string; body: string; plain?: string }>;
function documentProps(hit: FulltextSearchHit): DocumentProps {
  return hit.node as unknown as DocumentProps;
}

// ============================================================
// searchable() brand
// ============================================================

describe("searchable() brand", () => {
  it("attaches default metadata when no options provided", () => {
    const schema = searchable();
    expect(isSearchableSchema(schema)).toBe(true);
    expect(getSearchableMetadata(schema)).toEqual({ language: "english" });
  });

  it("respects the language option", () => {
    const schema = searchable({ language: "spanish" });
    expect(getSearchableMetadata(schema)).toEqual({ language: "spanish" });
  });

  it("rejects empty language", () => {
    expect(() => searchable({ language: "" })).toThrow(
      /language must be a non-empty string/,
    );
  });

  it("validates as a normal Zod string", () => {
    const schema = searchable();
    expect(schema.parse("hello")).toBe("hello");
    expect(() => schema.parse(42)).toThrow();
  });
});

// ============================================================
// Schema introspection
// ============================================================

describe("getSearchableFields", () => {
  it("extracts top-level searchable fields with metadata", () => {
    const schema = z.object({
      title: searchable({ language: "english" }),
      body: searchable({ language: "english" }),
      authorId: z.string(),
    });

    const fields = getSearchableFields(schema);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toEqual({
      fieldPath: "title",
      metadata: { language: "english" },
    });
    expect(fields[1]).toEqual({
      fieldPath: "body",
      metadata: { language: "english" },
    });
  });

  it("unwraps optional and nullable wrappers", () => {
    const schema = z.object({
      title: searchable().optional(),
      body: searchable().nullable(),
    });

    const fields = getSearchableFields(schema);
    expect(fields).toHaveLength(2);
    expect(fields[0]?.fieldPath).toBe("title");
    expect(fields[1]?.fieldPath).toBe("body");
  });

  it("preserves searchable metadata across chaining and string transforms", () => {
    const schema = z.object({
      title: searchable().min(1),
      body: searchable().trim(),
      summary: searchable().transform((value) => value.trim()),
    });

    const fields = getSearchableFields(schema);
    expect(fields).toHaveLength(3);
    expect(fields.map((field) => field.fieldPath).toSorted()).toEqual([
      "body",
      "summary",
      "title",
    ]);
  });

  it("returns no fields when none are searchable", () => {
    const schema = z.object({
      title: z.string(),
      body: z.string(),
    });
    expect(getSearchableFields(schema)).toEqual([]);
  });

  it("ignores non-string searchable wrappers gracefully", () => {
    // Non-object schema returns empty array.
    expect(getSearchableFields(z.string())).toEqual([]);
  });
});

describe("schema introspector recognises searchable strings", () => {
  it("returns ValueType=string with searchable metadata attached", () => {
    const Document_ = defineNode("Doc", {
      schema: z.object({
        title: searchable({ language: "english" }),
        plain: z.string(),
      }),
    });
    const introspector = createSchemaIntrospector(
      new Map([["Doc", { schema: Document_.schema }]]),
    );

    const titleInfo = introspector.getFieldTypeInfo("Doc", "title");
    expect(titleInfo?.valueType).toBe("string");
    expect(titleInfo?.searchable).toEqual({ language: "english" });

    const plainInfo = introspector.getFieldTypeInfo("Doc", "plain");
    expect(plainInfo?.valueType).toBe("string");
    expect(plainInfo?.searchable).toBeUndefined();
  });

  it("recognises searchable strings after chaining and transforms", () => {
    const Document_ = defineNode("Doc", {
      schema: z.object({
        title: searchable({ language: "english" }).min(1),
        body: searchable({ language: "english" }).trim(),
        summary: searchable({ language: "english" }).transform((value) =>
          value.trim(),
        ),
      }),
    });
    const introspector = createSchemaIntrospector(
      new Map([["Doc", { schema: Document_.schema }]]),
    );

    for (const fieldName of ["title", "body", "summary"] as const) {
      const fieldInfo = introspector.getFieldTypeInfo("Doc", fieldName);
      expect(fieldInfo?.valueType).toBe("string");
      expect(fieldInfo?.searchable).toEqual({ language: "english" });
    }
  });
});

// ============================================================
// End-to-end: store sync + fulltext search
// ============================================================

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    plain: z.string().optional(),
  }),
});

const SearchableGraph = defineGraph({
  id: "search-test",
  nodes: { Document: { type: Document } },
  edges: {},
});

describe("end-to-end fulltext search (SQLite FTS5)", () => {
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof SearchableGraph>>;

  beforeEach(async () => {
    backend = createTestBackend();
    await backend.bootstrapTables?.();
    store = createStore(SearchableGraph, backend);
  });

  it("declares fulltext capability", () => {
    expect(backend.capabilities.fulltext?.supported).toBe(true);
    expect(backend.capabilities.fulltext?.phraseQueries).toBe(true);
    expect(backend.capabilities.fulltext?.prefixQueries).toBe(true);
  });

  it("indexes searchable fields on create and surfaces them in search", async () => {
    await store.nodes.Document.create({
      title: "Climate change drivers",
      body: "Rising global temperatures linked to greenhouse emissions",
    });
    await store.nodes.Document.create({
      title: "Local cuisine guide",
      body: "Ten restaurants worth visiting in town this weekend",
    });
    await store.nodes.Document.create({
      title: "Renewable energy outlook",
      body: "Solar and wind capacity projected to surpass coal by 2030",
    });

    const results = await store.search.fulltext("Document", {
      query: "climate temperatures",
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(documentProps(results[0]!).title).toBe("Climate change drivers");
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(results[0]?.rank).toBe(1);
  });

  it("supports phrase queries", async () => {
    await store.nodes.Document.create({
      title: "Quick brown fox",
      body: "The quick brown fox jumps over the lazy dog",
    });
    await store.nodes.Document.create({
      title: "Slow brown bear",
      body: "A slow brown bear naps in the afternoon sun",
    });

    const phrase = await store.search.fulltext("Document", {
      query: "quick brown fox",
      mode: "phrase",
      limit: 10,
    });
    expect(phrase).toHaveLength(1);
    expect(documentProps(phrase[0]!).title).toBe("Quick brown fox");
  });

  it("supports websearch syntax with negation", async () => {
    await store.nodes.Document.create({
      title: "Apple harvest",
      body: "Apples and oranges in autumn",
    });
    await store.nodes.Document.create({
      title: "Apple recipe",
      body: "Apples and cinnamon make a fine pie",
    });

    const negated = await store.search.fulltext("Document", {
      query: "apples -oranges",
      mode: "websearch",
      limit: 10,
    });
    expect(negated).toHaveLength(1);
    expect(documentProps(negated[0]!).title).toBe("Apple recipe");
  });

  it("re-indexes content on update", async () => {
    const node = await store.nodes.Document.create({
      title: "Initial title",
      body: "Initial body",
    });

    let results = await store.search.fulltext("Document", {
      query: "initial",
      limit: 10,
    });
    expect(results).toHaveLength(1);

    await store.nodes.Document.update(node.id, {
      title: "Replaced title",
      body: "Replaced body",
    });

    results = await store.search.fulltext("Document", {
      query: "initial",
      limit: 10,
    });
    expect(results).toHaveLength(0);

    results = await store.search.fulltext("Document", {
      query: "replaced",
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(documentProps(results[0]!).title).toBe("Replaced title");
  });

  it("deletes the fulltext row when all searchable fields are emptied", async () => {
    const node = await store.nodes.Document.create({
      title: "Title to clear",
      body: "Body to clear",
    });

    await store.nodes.Document.update(node.id, { title: "", body: "" });

    const results = await store.search.fulltext("Document", {
      query: "title clear",
      limit: 10,
    });
    expect(results).toHaveLength(0);
  });

  it("removes fulltext rows on soft delete", async () => {
    const node = await store.nodes.Document.create({
      title: "Doomed document",
      body: "Will be deleted shortly",
    });

    let results = await store.search.fulltext("Document", {
      query: "doomed",
      limit: 10,
    });
    expect(results).toHaveLength(1);

    await store.nodes.Document.delete(node.id);

    results = await store.search.fulltext("Document", {
      query: "doomed",
      limit: 10,
    });
    expect(results).toHaveLength(0);
  });

  it("filters tombstones even when the fulltext index is stale", async () => {
    const node = await store.nodes.Document.create({
      title: "Stale drift document",
      body: "Body content",
    });

    // Bypass the sync path: soft-delete the node without clearing the
    // fulltext row. Simulates drift (a rebuild is pending, or a prior
    // delete raced with an index-maintenance failure). The store-level
    // search path must still filter tombstones before returning hits.
    await backend.transaction(async (tx) => {
      await tx.deleteNode({
        graphId: store.graphId,
        kind: "Document",
        id: node.id,
      });
    });

    const results = await store.search.fulltext("Document", {
      query: "stale drift",
      limit: 10,
    });
    expect(results).toHaveLength(0);
  });

  it("returns highlighted snippets when requested", async () => {
    await store.nodes.Document.create({
      title: "Snippet test",
      body: "A long body with the word climate buried in the middle",
    });

    const results = await store.search.fulltext("Document", {
      query: "climate",
      limit: 1,
      includeSnippets: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toBeDefined();
    expect(results[0]?.snippet).toMatch(/<mark>climate<\/mark>/i);
  });

  it("matches terms spread across multiple searchable fields", async () => {
    await store.nodes.Document.create({
      title: "Climate report",
      body: "Rising global temperatures driven by emissions",
    });

    // "climate" is in title; "temperatures" is in body. With per-node
    // indexing both terms find the same document.
    const results = await store.search.fulltext("Document", {
      query: "climate temperatures",
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(documentProps(results[0]!).title).toBe("Climate report");
  });

  it("rejects non-positive limit", async () => {
    await expect(
      store.search.fulltext("Document", { query: "anything", limit: 0 }),
    ).rejects.toThrow(/limit must be a positive integer/);
  });

  it("rejects per-query language override on fts5 strategy", async () => {
    // FTS5's tokenizer is fixed at table-create time; the strategy sets
    // `supportsLanguageOverride: false`. Store-level validation must reject
    // the option rather than silently ignoring it.
    await expect(
      store.search.fulltext("Document", {
        query: "climate",
        limit: 5,
        language: "spanish",
      }),
    ).rejects.toThrow(/does not honor a per-query `language` override/);
  });

  it("rejects per-query language override on hybrid fts5 strategy", async () => {
    const mutableBackend = backend as unknown as {
      vectorSearch?: GraphBackend["vectorSearch"];
    };
    mutableBackend.vectorSearch = () => Promise.resolve([]);

    await expect(
      store.search.hybrid("Document", {
        limit: 5,
        vector: { fieldPath: "embedding", queryEmbedding: [1, 0, 0, 0] },
        fulltext: { query: "climate", language: "spanish" },
      }),
    ).rejects.toThrow(/does not honor a per-query `language` override/);
  });

  it("rejects unsupported mode advertised by strategy", async () => {
    // Swap in a stub strategy whose supportedModes excludes "phrase" to
    // exercise the strategy-driven mode check. The built-in fts5Strategy
    // allows all modes, so we can't exercise the rejection path with it.
    const mutableBackend = backend as unknown as {
      fulltextStrategy?: GraphBackend["fulltextStrategy"];
    };
    const original = mutableBackend.fulltextStrategy;
    if (original === undefined) {
      throw new Error(
        "test precondition: backend must have a fulltextStrategy",
      );
    }
    mutableBackend.fulltextStrategy = {
      ...original,
      supportedModes: ["websearch", "plain"],
    };

    try {
      await expect(
        store.search.fulltext("Document", {
          query: "climate",
          limit: 5,
          mode: "phrase",
        }),
      ).rejects.toThrow(/does not support mode "phrase"/);
    } finally {
      mutableBackend.fulltextStrategy = original;
    }
  });

  it("indexes chained searchable schemas and allows .matches() on them", async () => {
    const ChainedDocument = defineNode("ChainedDocument", {
      schema: z.object({
        title: searchable({ language: "english" }).min(1),
        body: searchable({ language: "english" }).transform((value) =>
          value.trim(),
        ),
      }),
    });
    const ChainedGraph = defineGraph({
      id: "search-chained-test",
      nodes: { ChainedDocument: { type: ChainedDocument } },
      edges: {},
    });
    const chainedBackend = createTestBackend();
    await chainedBackend.bootstrapTables?.();
    const chainedStore = createStore(ChainedGraph, chainedBackend);

    await chainedStore.nodes.ChainedDocument.create({
      title: "Climate report",
      body: "  climate body with trimmed whitespace  ",
    });

    const results = await chainedStore
      .query()
      .from("ChainedDocument", "d")
      .whereNode("d", (d) => d.$fulltext.matches("climate", 10))
      .select((ctx) => ctx.d)
      .execute();

    expect(results).toHaveLength(1);
  });
});

// ============================================================
// End-to-end: hybrid search (vector + fulltext + RRF)
// ============================================================

const HybridDocument = defineNode("HybridDoc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    embedding: embedding(4),
  }),
});

const HybridGraph = defineGraph({
  id: "hybrid-test",
  nodes: { HybridDoc: { type: HybridDocument } },
  edges: {},
});

describe("hybrid search (vector + FTS, RRF fusion)", () => {
  it("throws clearly when vector search not supported (sqlite without sqlite-vec)", async () => {
    // Construct the backend by hand without `hasVectorEmbeddings` so the
    // no-extension case is exercised regardless of whether the test runner
    // has sqlite-vec installed locally.
    const drizzleModule = await import("drizzle-orm/better-sqlite3");
    const betterSqlite3 = await import("better-sqlite3");
    const Database = betterSqlite3.default;
    const sqliteModule = await import("../src/backend/drizzle/sqlite");
    const ddlModule = await import("../src/backend/drizzle/ddl");

    const sqlite = new Database(":memory:");
    for (const statement of ddlModule.generateSqliteDDL(sqliteModule.tables)) {
      sqlite.exec(statement);
    }
    const db = drizzleModule.drizzle(sqlite);
    const backend = sqliteModule.createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: sqliteModule.tables,
    });
    expect(backend.vectorSearch).toBeUndefined();

    const store = createStore(HybridGraph, backend);
    await store.nodes.HybridDoc.create({
      title: "doc",
      body: "body",
      embedding: [0.1, 0.2, 0.3, 0.4],
    });

    await expect(
      store.search.hybrid("HybridDoc", {
        limit: 5,
        vector: {
          fieldPath: "embedding",
          queryEmbedding: [0.1, 0.2, 0.3, 0.4],
        },
        fulltext: { query: "doc" },
      }),
    ).rejects.toThrow(/vector search/);

    sqlite.close();
  });

  it("fuses sqlite-vec and FTS5 results via RRF end-to-end", async () => {
    const backend = createTestBackend();
    if (backend.vectorSearch === undefined) return;
    await backend.bootstrapTables?.();
    const store = createStore(HybridGraph, backend);

    const solar = await store.nodes.HybridDoc.create({
      title: "Solar power",
      body: "renewable energy from photovoltaics",
      embedding: [1, 0, 0, 0],
    });
    const wind = await store.nodes.HybridDoc.create({
      title: "Wind turbines",
      body: "kinetic energy converted by rotors",
      embedding: [0, 1, 0, 0],
    });
    const hydro = await store.nodes.HybridDoc.create({
      title: "Hydroelectric dams",
      body: "energy from controlled water flow",
      embedding: [0, 0, 1, 0],
    });

    // Vector query targets `wind`; fulltext query targets `solar`. RRF
    // should put one of those at the top, with `hydro` filling the
    // long tail via the vector signal.
    const results = await store.search.hybrid("HybridDoc", {
      limit: 3,
      vector: {
        fieldPath: "embedding",
        queryEmbedding: [0, 1, 0, 0],
      },
      fulltext: { query: "solar" },
    });

    expect(results.length).toBeGreaterThan(0);
    const topId = results[0]!.node.id;
    expect([solar.id, wind.id]).toContain(topId);

    const fused = results.find(
      (row) => row.vector !== undefined && row.fulltext !== undefined,
    );
    expect(fused).toBeDefined();

    expect([solar.id, wind.id, hydro.id]).toContain(topId);
  });

  it("respects the limit on real SQLite hybrid fusion", async () => {
    const backend = createTestBackend();
    if (backend.vectorSearch === undefined) return;
    await backend.bootstrapTables?.();
    const store = createStore(HybridGraph, backend);

    for (let index = 0; index < 5; index++) {
      await store.nodes.HybridDoc.create({
        title: `Doc ${index}`,
        body: "shared keyword payload",
        embedding: [Math.cos(index * 0.5), Math.sin(index * 0.5), 0, 0],
      });
    }

    const results = await store.search.hybrid("HybridDoc", {
      limit: 2,
      vector: {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
      },
      fulltext: { query: "shared keyword" },
    });

    expect(results).toHaveLength(2);
  });

  it("RRF helper produces correct fused ordering for synthetic results", async () => {
    // Direct test of the fusion math via store.search.hybrid is gated on
    // having both vector and fulltext backends — validated in postgres
    // tests. Here we exercise the RRF math by stubbing backend methods.
    const backend = createTestBackend();
    await backend.bootstrapTables?.();
    const store = createStore(HybridGraph, backend);

    // Insert three nodes so getNodes can resolve them by id.
    const a = await store.nodes.HybridDoc.create({
      title: "alpha",
      body: "alpha body",
      embedding: [1, 0, 0, 0],
    });
    const b = await store.nodes.HybridDoc.create({
      title: "beta",
      body: "beta body",
      embedding: [0, 1, 0, 0],
    });
    const c = await store.nodes.HybridDoc.create({
      title: "gamma",
      body: "gamma body",
      embedding: [0, 0, 1, 0],
    });

    // Stub the missing vectorSearch with deterministic ordering.
    const mutableBackend = backend as unknown as {
      vectorSearch?: GraphBackend["vectorSearch"];
    };
    mutableBackend.vectorSearch = () =>
      Promise.resolve([
        { nodeId: a.id, score: 0.9 },
        { nodeId: b.id, score: 0.8 },
        { nodeId: c.id, score: 0.7 },
      ]);

    const results = await store.search.hybrid("HybridDoc", {
      limit: 3,
      vector: {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
      },
      // Fulltext favors c (gamma) — opposite of vector to make fusion visible.
      fulltext: { query: "gamma" },
      fusion: { method: "rrf", k: 60 },
    });

    expect(results).toHaveLength(3);
    // RRF should put a (vector rank 1, no fulltext) and c (fulltext rank 1,
    // vector rank 3) near the top. Tie depends on rrf math but order is
    // deterministic.
    const top = results[0];
    expect(top).toBeDefined();
    expect([a.id, c.id]).toContain(top!.node.id);
    // Both sub-scores are reported when the node was retrieved from both.
    const fullyFused = results.find(
      (r) => r.vector !== undefined && r.fulltext !== undefined,
    );
    expect(fullyFused).toBeDefined();
  });
});

// ================================================================
// Custom FulltextStrategy — end-to-end plumbing
// ================================================================

describe("custom FulltextStrategy plumbing", () => {
  it("routes DDL, writes, deletes, and search through the configured strategy", async () => {
    // Spy-wraps every method on the default fts5Strategy so we can
    // verify the operation layer delegates to it instead of using
    // dialect-hardcoded SQL.
    const fulltextStrategyModule =
      await import("../src/query/dialect/fulltext-strategy");
    const fts5Strategy = fulltextStrategyModule.fts5Strategy;
    const sqliteModule = await import("../src/backend/drizzle/sqlite");
    const createSqliteBackend = sqliteModule.createSqliteBackend;
    const drizzleModule = await import("drizzle-orm/better-sqlite3");
    const drizzle = drizzleModule.drizzle;
    const betterSqlite3 = await import("better-sqlite3");
    const Database = betterSqlite3.default;

    const calls = {
      generateDdl: 0,
      buildUpsert: 0,
      buildBatchUpsert: 0,
      buildDelete: 0,
      buildBatchDelete: 0,
      matchCondition: 0,
      rankExpression: 0,
      snippetExpression: 0,
    };
    const spyStrategy = {
      ...fts5Strategy,
      generateDdl: (tableName: string) => {
        calls.generateDdl += 1;
        return fts5Strategy.generateDdl(tableName);
      },
      buildUpsert: (...args: Parameters<typeof fts5Strategy.buildUpsert>) => {
        calls.buildUpsert += 1;
        return fts5Strategy.buildUpsert(...args);
      },
      buildBatchUpsert: (
        ...args: Parameters<typeof fts5Strategy.buildBatchUpsert>
      ) => {
        calls.buildBatchUpsert += 1;
        return fts5Strategy.buildBatchUpsert(...args);
      },
      buildDelete: (...args: Parameters<typeof fts5Strategy.buildDelete>) => {
        calls.buildDelete += 1;
        return fts5Strategy.buildDelete(...args);
      },
      buildBatchDelete: (
        ...args: Parameters<typeof fts5Strategy.buildBatchDelete>
      ) => {
        calls.buildBatchDelete += 1;
        return fts5Strategy.buildBatchDelete(...args);
      },
      matchCondition: (
        ...args: Parameters<typeof fts5Strategy.matchCondition>
      ) => {
        calls.matchCondition += 1;
        return fts5Strategy.matchCondition(...args);
      },
      rankExpression: (
        ...args: Parameters<typeof fts5Strategy.rankExpression>
      ) => {
        calls.rankExpression += 1;
        return fts5Strategy.rankExpression(...args);
      },
      snippetExpression: (
        ...args: Parameters<typeof fts5Strategy.snippetExpression>
      ) => {
        calls.snippetExpression += 1;
        return fts5Strategy.snippetExpression(...args);
      },
    };

    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    const backend = createSqliteBackend(db, { fulltext: spyStrategy });
    await backend.bootstrapTables?.();
    const store = createStore(HybridGraph, backend);

    // generateDdl called during bootstrap.
    expect(calls.generateDdl).toBeGreaterThanOrEqual(1);

    const node = await store.nodes.HybridDoc.create({
      title: "strategy plumbing",
      body: "custom strategy owns every SQL statement",
      embedding: [1, 0, 0, 0],
    });
    expect(calls.buildUpsert).toBe(1);

    const searchHits = await store.search.fulltext("HybridDoc", {
      query: "plumbing",
      limit: 5,
      includeSnippets: true,
    });
    expect(searchHits).toHaveLength(1);
    expect(calls.matchCondition).toBeGreaterThanOrEqual(1);
    expect(calls.rankExpression).toBeGreaterThanOrEqual(1);
    expect(calls.snippetExpression).toBeGreaterThanOrEqual(1);

    await store.nodes.HybridDoc.hardDelete(node.id);
    expect(calls.buildDelete).toBeGreaterThanOrEqual(1);

    await backend.close();
  });
});

// ============================================================
// Conflicting-language warning
// ============================================================

describe("warnIfConflictingLanguages", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // Swallow warnings in tests — we assert on them via the spy.
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns once per schema when searchable fields declare different languages", () => {
    const Mixed = defineNode("MixedLangDoc", {
      schema: z.object({
        title: searchable({ language: "english" }),
        titulo: searchable({ language: "spanish" }),
      }),
    });

    // First call triggers the warning.
    getSearchableFields(Mixed.schema);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = warnSpy.mock.calls[0]?.[0];
    expect(payload).toContain("conflicting languages");
    expect(payload).toContain("title=english");
    expect(payload).toContain("titulo=spanish");

    // Memoized via WeakMap — repeat lookups do not re-emit.
    getSearchableFields(Mixed.schema);
    getSearchableFields(Mixed.schema);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not warn for uniform-language searchable fields", () => {
    const Uniform = defineNode("UniformLangDoc", {
      schema: z.object({
        title: searchable({ language: "english" }),
        body: searchable({ language: "english" }),
      }),
    });

    getSearchableFields(Uniform.schema);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not warn for a single searchable field", () => {
    const Single = defineNode("SingleLangDoc", {
      schema: z.object({
        title: searchable({ language: "french" }),
        body: z.string(),
      }),
    });

    getSearchableFields(Single.schema);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// Reserved `$` prefix in schema keys
// ============================================================

describe("reserved $-prefix", () => {
  it("defineNode rejects schema keys starting with $", () => {
    expect(() =>
      defineNode("NodeWithDollarKey", {
        schema: z.object({
          $fulltext: z.string(),
        }),
      }),
    ).toThrow(ConfigurationError);

    expect(() =>
      defineNode("NodeWithArbitraryDollarKey", {
        schema: z.object({
          $custom: z.number(),
        }),
      }),
    ).toThrow(/reserved "\$" prefix/);
  });

  it("defineEdge rejects schema keys starting with $", () => {
    expect(() =>
      defineEdge("edgeWithDollarKey", {
        schema: z.object({
          $meta: z.string(),
        }),
      }),
    ).toThrow(ConfigurationError);
  });

  it("permits schema keys that merely contain $ after the first character", () => {
    // The reservation is on the prefix only. A key like `cost$` is fine.
    expect(() =>
      defineNode("NodeWithInternalDollar", {
        schema: z.object({
          cost$: z.number(),
        }),
      }),
    ).not.toThrow();
  });
});
