/**
 * Example 15: Fulltext and Hybrid Search
 *
 * Demonstrates TypeGraph's fulltext search capabilities and how hybrid
 * retrieval (fulltext + vector) beats either approach alone:
 *
 *   - `searchable()` fields on the schema enable BM25 fulltext indexing
 *     without any external search service (Postgres tsvector + GIN, or
 *     SQLite FTS5).
 *   - `store.search.fulltext()` runs a ranked BM25 query with optional
 *     highlighted snippets.
 *   - `n.$fulltext.matches()` in the query builder composes fulltext
 *     with metadata filters and graph traversal in one SQL statement.
 *   - `store.search.hybrid()` fuses vector and fulltext results with
 *     Reciprocal Rank Fusion (RRF) — the production-grade RAG pattern.
 *   - `store.search.rebuildFulltext()` backfills the fulltext index
 *     after schema changes or drift.
 *
 * The example uses an in-memory SQLite backend. FTS5 is built into the
 * standard SQLite distribution so fulltext works out of the box — no
 * extension required. Real vector similarity (both `store.search.hybrid`
 * and the `.similarTo()` builder predicate) needs sqlite-vec (or
 * pgvector on Postgres); since this example's in-memory SQLite does not
 * load that extension, Part 6 attaches a small JS cosine-similarity
 * `vectorSearch` shim so the hybrid call actually executes end-to-end
 * against the same code path a native deployment would take. The
 * `.similarTo()` builder path is shown as code only.
 *
 * Run with:
 *   npx tsx examples/15-fulltext-hybrid-search.ts
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  embedding,
  type GraphBackend,
  searchable,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema
// ============================================================

/**
 * A Product with fulltext-searchable fields and a vector embedding.
 *
 * - `name` and `description` are declared with `searchable()`. Their
 *   combined content is BM25-indexed; a single query can match terms
 *   that span both fields.
 * - `sku` carries rare tokens (codes like "PROD-1005-E") that
 *   embeddings consistently fail to rank correctly. Indexing it for
 *   fulltext is what makes hybrid retrieval better than either side.
 * - `embedding` powers semantic retrieval — paraphrased queries,
 *   conceptual similarity, synonyms.
 */
const Product = defineNode("Product", {
  schema: z.object({
    name: searchable({ language: "english" }),
    description: searchable({ language: "english" }),
    sku: searchable({ language: "english" }),
    category: z.enum(["outerwear", "footwear", "accessories", "climbing"]),
    basePrice: z.number().positive(),
    status: z.enum(["draft", "active", "discontinued"]).default("active"),
    embedding: embedding(16).optional(),
  }),
});

const graph = defineGraph({
  id: "fulltext_hybrid_search_example",
  nodes: { Product: { type: Product } },
  edges: {},
});

// ============================================================
// Mock embedding — deterministic, for demo purposes
// ============================================================

/**
 * Produces a deterministic 16-dim unit vector from a text string. In
 * production this would be a call to an embedding API (OpenAI,
 * Sentence Transformers, etc.). The tiny dimension keeps the example
 * fast; use 384+ in real applications.
 */
function mockEmbedding(text: string, dimensions = 16): number[] {
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index++) {
    const charSum = text.split("").reduce((sum, char, position) => {
      return sum + char.charCodeAt(0) * (position + 1) * (index + 1);
    }, 0);
    vector.push(Math.sin(charSum + index) * 0.5 + 0.5);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / magnitude);
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += (a[index] ?? 0) * (b[index] ?? 0);
  }
  // mockEmbedding() already unit-normalizes, so dot product == cosine.
  return dot;
}

/**
 * Attaches a JS-side cosine-similarity `vectorSearch` implementation to
 * the backend. The in-memory SQLite used by examples does not load
 * sqlite-vec, so the real native path is unavailable here; a production
 * deployment swaps pgvector or sqlite-vec in and keeps the same API.
 */
function attachJsVectorSearchStub(
  backend: GraphBackend,
  productsWithEmbeddings: ReadonlyArray<
    Readonly<{ id: string; embedding: readonly number[] }>
  >,
): void {
  (backend as { vectorSearch?: GraphBackend["vectorSearch"] }).vectorSearch =
    (params) => {
      const scored = productsWithEmbeddings
        .map((node) => ({
          nodeId: node.id,
          score: cosineSimilarity(params.queryEmbedding, node.embedding),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, params.limit);
      return Promise.resolve(scored);
    };
}

// ============================================================
// Demo catalog
// ============================================================

const seedProducts = [
  {
    name: "Expedition Parka",
    description:
      "Heavily insulated jacket for alpine expeditions and extreme cold. Waterproof outer shell with down fill.",
    sku: "PROD-1001-A",
    category: "outerwear",
    basePrice: 549,
  },
  {
    name: "Arctic Shell",
    description:
      "Lightweight waterproof outer shell for layering. Breathable membrane, fully seam-sealed.",
    sku: "PROD-1002-B",
    category: "outerwear",
    basePrice: 319,
  },
  {
    name: "Base Layer Thermal",
    description:
      "Moisture-wicking merino wool underlayer for cold weather. Soft, warm, odor-resistant.",
    sku: "PROD-1003-C",
    category: "outerwear",
    basePrice: 89,
  },
  {
    name: "Trail Runner 720",
    description:
      "Lightweight trail running shoes with aggressive tread. Breathable mesh upper.",
    sku: "PROD-1004-D",
    category: "footwear",
    basePrice: 145,
  },
  {
    name: "Climbing Harness Pro",
    description:
      "Lightweight sport-climbing harness with four gear loops. Adjustable leg loops for warm-weather climbing.",
    sku: "PROD-1005-E",
    category: "climbing",
    basePrice: 89,
  },
  {
    name: "Ski Goggles UV400",
    description:
      "Anti-fog ski goggles with UV400 protection and interchangeable lenses for different light conditions.",
    sku: "PROD-1006-F",
    category: "accessories",
    basePrice: 175,
  },
  {
    name: "Compression Socks",
    description:
      "Athletic compression socks for recovery and long hikes. Graduated compression, moisture-wicking.",
    sku: "PROD-1007-G",
    category: "accessories",
    basePrice: 35,
  },
  {
    name: "Hiking Daypack 25L",
    description:
      "25-liter lightweight daypack for day hikes. Hydration bladder compatible, internal frame.",
    sku: "PROD-1008-H",
    category: "accessories",
    basePrice: 119,
  },
  // A discontinued item we'll use to show status filtering.
  {
    name: "Legacy Rain Shell",
    description:
      "Older waterproof rain shell — discontinued product kept for parts and warranty service.",
    sku: "PROD-9901-Z",
    category: "outerwear",
    basePrice: 1,
    status: "discontinued" as const,
  },
] as const;

function divider(title: string): void {
  console.log(`\n=== ${title} ===\n`);
}

/**
 * `store.search.fulltext("Product", ...)` narrows `hit.node` to the
 * Product node type, so `hit.node.name` / `.sku` are directly typed —
 * no cast needed.
 */
type ProductHit = Readonly<{
  name: string;
  sku: string;
}>;

function renderHit(
  rank: number,
  node: ProductHit,
  score: number,
  extras?: string,
): void {
  const scoreStr = score.toFixed(4);
  const extrasStr = extras === undefined ? "" : ` ${extras}`;
  console.log(
    `  ${String(rank).padStart(2)}. [${node.sku}] ${node.name.padEnd(24)} score=${scoreStr}${extrasStr}`,
  );
}

// ============================================================
// Main
// ============================================================

export async function main(): Promise<void> {
  console.log("=== Fulltext & Hybrid Search Example ===");

  // Fulltext is backed by SQLite FTS5 — no extra extension required.
  // `createExampleBackend()` runs the DDL on startup, so the fulltext
  // virtual table is already in place.
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  // ============================================================
  // Part 1: Seed the catalog
  // ============================================================

  divider("Part 1: Seed the catalog");

  const seededEmbeddings: Array<{
    id: string;
    embedding: readonly number[];
  }> = [];
  for (const product of seedProducts) {
    const indexedText = `${product.name} ${product.description} ${product.sku}`;
    const productEmbedding = mockEmbedding(indexedText);
    const created = await store.nodes.Product.create({
      ...product,
      embedding: productEmbedding,
    });
    seededEmbeddings.push({ id: created.id, embedding: productEmbedding });
  }

  console.log(`Seeded ${seedProducts.length} products.`);
  console.log(
    "Each product has `searchable()` fields (name, description, sku) " +
      "plus a 16-dim embedding. The fulltext index is kept in sync on " +
      "every create/update/delete; no manual indexing step needed.",
  );

  // ============================================================
  // Part 2: Fulltext-only search (store.search.fulltext)
  // ============================================================

  divider("Part 2: Fulltext-only search");

  console.log(
    "Run a BM25-ranked query against every searchable field, with " +
      "highlighted snippets so users can see where the match is:\n",
  );

  const fulltextHits = await store.search.fulltext("Product", {
    query: "waterproof jacket",
    limit: 3,
    includeSnippets: true,
  });

  console.log(`Query: "waterproof jacket"`);
  for (const [index, hit] of fulltextHits.entries()) {
    renderHit(index + 1, hit.node, hit.score, `snippet=${hit.snippet ?? ""}`);
  }

  // ============================================================
  // Part 3: Why hybrid exists — exact-token queries break embeddings
  // ============================================================

  divider("Part 3: Why hybrid matters — exact-token queries");

  console.log(
    "Users routinely type SKUs, proper nouns, and model numbers. " +
      "Embeddings smooth these out; BM25 nails them.\n",
  );

  const skuHits = await store.search.fulltext("Product", {
    query: "PROD-1005-E",
    limit: 3,
  });

  console.log(`Query: "PROD-1005-E" (looking up an exact SKU)`);
  for (const [index, hit] of skuHits.entries()) {
    renderHit(index + 1, hit.node, hit.score);
  }
  console.log(
    "  ↑ Fulltext finds the exact SKU immediately. A pure-vector search " +
      "on the same query would rank unrelated products higher because " +
      "the SKU token doesn't participate meaningfully in the embedding.",
  );

  // ============================================================
  // Part 4: Query modes — websearch, phrase, plain, raw
  // ============================================================

  divider("Part 4: Query modes");

  console.log("websearch (default): Google-style syntax.\n");

  const websearchHits = await store.search.fulltext("Product", {
    query: `"ski goggles" -compression`,
    limit: 5,
    mode: "websearch",
  });
  console.log(`Query: "\\"ski goggles\\" -compression"`);
  for (const [index, hit] of websearchHits.entries()) {
    renderHit(index + 1, hit.node, hit.score);
  }

  console.log("\nphrase mode: exact adjacency.\n");
  const phraseHits = await store.search.fulltext("Product", {
    query: "climbing harness",
    limit: 3,
    mode: "phrase",
  });
  console.log(`Query (phrase): "climbing harness"`);
  for (const [index, hit] of phraseHits.entries()) {
    renderHit(index + 1, hit.node, hit.score);
  }

  console.log("\nplain mode: all terms must appear, no special syntax.\n");
  const plainHits = await store.search.fulltext("Product", {
    query: "lightweight shell",
    limit: 3,
    mode: "plain",
  });
  console.log(`Query (plain): "lightweight shell"`);
  for (const [index, hit] of plainHits.entries()) {
    renderHit(index + 1, hit.node, hit.score);
  }

  // ============================================================
  // Part 5: $fulltext.matches() in the query builder
  // ============================================================

  divider("Part 5: $fulltext.matches() in the query builder");

  console.log(
    "The query-builder predicate composes with any other filter or " +
      "traversal. Here we search for 'lightweight' but only among " +
      "`active` products in the `outerwear` category:\n",
  );

  const activeOuterwear = await store
    .query()
    .from("Product", "p")
    .whereNode("p", (p) =>
      p.$fulltext
        .matches("lightweight", 10)
        .and(p.status.eq("active"))
        .and(p.category.eq("outerwear")),
    )
    .select((ctx) => ({ sku: ctx.p.sku, name: ctx.p.name }))
    .execute();

  console.log(`Query: "lightweight" + status=active + category=outerwear`);
  for (const [index, row] of activeOuterwear.entries()) {
    console.log(`  ${String(index + 1).padStart(2)}. [${row.sku}] ${row.name}`);
  }
  console.log(
    "  ↑ Metadata filters apply inside the fulltext CTE, so the " +
      "discontinued 'Legacy Rain Shell' is filtered out before ranking.",
  );

  // ============================================================
  // Part 6: Hybrid search — vector + fulltext fused with RRF
  // ============================================================

  divider("Part 6: Hybrid search — RRF fusion");

  console.log(
    "Production RAG typically needs both: embeddings for conceptual\n" +
      "matching, fulltext for rare-token exactness. RRF is rank-based,\n" +
      "so it fuses them without caring about score-scale differences.\n",
  );

  // In-memory SQLite does not load the sqlite-vec extension, so
  // `backend.vectorSearch` is absent and `store.search.hybrid()` would
  // fail its capability check. A real deployment uses pgvector (Postgres)
  // or sqlite-vec (SQLite); here we attach a small JS cosine-similarity
  // stub that ranks the stored embeddings so the example exercises the
  // same hybrid code path end-to-end.
  attachJsVectorSearchStub(backend, seededEmbeddings);

  const hybridQuery = "waterproof shell";
  const queryEmbedding = mockEmbedding(hybridQuery);

  const hybridHits = await store.search.hybrid("Product", {
    limit: 5,
    vector: {
      fieldPath: "embedding",
      queryEmbedding,
      metric: "cosine",
      k: 20,
    },
    fulltext: {
      query: hybridQuery,
      k: 20,
      includeSnippets: true,
    },
    fusion: {
      method: "rrf",
      k: 60,
      weights: { vector: 1, fulltext: 1.25 },
    },
  });

  console.log(`Query: "${hybridQuery}"`);
  console.log(
    `  (limit=5, vector k=20, fulltext k=20, RRF k=60, fulltext weight=1.25)\n`,
  );
  for (const [index, hit] of hybridHits.entries()) {
    const vectorRank = hit.vector ? `v#${hit.vector.rank}` : "v—";
    const fulltextRank = hit.fulltext ? `f#${hit.fulltext.rank}` : "f—";
    renderHit(
      index + 1,
      hit.node as ProductHit,
      hit.score,
      `(${vectorRank}, ${fulltextRank})`,
    );
  }
  console.log(
    "  ↑ The (v#, f#) tags show each sub-result's rank. A hit ranked by\n" +
      "    only one side still lands well when it is highly ranked there;\n" +
      "    hits ranked by both sides get a compounding RRF boost.",
  );

  console.log(
    "\nFor composition with graph traversal / metadata predicates, use the\n" +
      "query-builder path — both predicates in one whereNode(), fusion\n" +
      "configured via .fuseWith():\n",
  );
  console.log(
    [
      `  await store.query()`,
      `    .from("Product", "p")`,
      `    .whereNode("p", p =>`,
      `      p.$fulltext.matches(query, 20)`,
      `        .and(p.embedding.similarTo(queryEmbedding, 20))`,
      `        .and(p.status.eq("active"))`,
      `    )`,
      `    .fuseWith({ k: 60, weights: { vector: 1, fulltext: 1.25 } })`,
      `    .select(ctx => ctx.p)`,
      `    .limit(5)`,
      `    .execute();`,
    ].join("\n"),
  );
  console.log(
    "\nThe builder path compiles both predicates into a single SQL\n" +
      "statement; it requires a vector-capable backend at runtime\n" +
      "(pgvector or sqlite-vec) and is therefore not executed here.",
  );

  // ============================================================
  // Part 7: Rebuild the fulltext index
  // ============================================================

  divider("Part 7: Rebuild the fulltext index");

  console.log(
    "After schema changes (a new `searchable()` field, a `language`\n" +
      "change) or direct DB writes that bypass the store, call\n" +
      "`store.search.rebuildFulltext()` to backfill. It iterates nodes\n" +
      "with keyset pagination, transacts per page, and returns counts.\n",
  );

  // Simulate drift: delete every fulltext row directly through the
  // backend. Normal writes never need this — it's just to show the
  // rebuild pathway.
  const allProducts = await store.nodes.Product.find();
  for (const product of allProducts) {
    await backend.deleteFulltext?.({
      graphId: store.graphId,
      nodeKind: "Product",
      nodeId: product.id,
    });
  }

  const emptyAfterDrift = await store.search.fulltext("Product", {
    query: "waterproof",
    limit: 3,
  });
  console.log(
    `Before rebuild: "waterproof" → ${emptyAfterDrift.length} hits (fulltext rows cleared).`,
  );

  const stats = await store.search.rebuildFulltext();
  console.log(
    `Rebuilt: kinds=${stats.kinds.join(",")} processed=${stats.processed} ` +
      `upserted=${stats.upserted} cleared=${stats.cleared} skipped=${stats.skipped}`,
  );
  if (stats.skippedIds.length > 0) {
    console.log(`Skipped IDs (repair targets): ${stats.skippedIds.join(", ")}`);
  }

  const recovered = await store.search.fulltext("Product", {
    query: "waterproof",
    limit: 3,
  });
  console.log(
    `After rebuild: "waterproof" → ${recovered.length} hits restored.\n`,
  );

  // ============================================================
  // Summary
  // ============================================================

  divider("Summary");

  console.log("What this example demonstrated:");
  console.log(
    "  1. `searchable()` marks a string field for native BM25 indexing.",
  );
  console.log(
    "  2. `store.search.fulltext()` runs BM25 with optional snippets.",
  );
  console.log(
    "  3. Four query modes (websearch, phrase, plain, raw) cover the\n" +
      "     common input shapes.",
  );
  console.log(
    "  4. `n.$fulltext.matches()` composes with metadata predicates and\n" +
      "     graph traversal in the query builder.",
  );
  console.log(
    "  5. `store.search.hybrid()` (and `.fuseWith()` on the builder)\n" +
      "     fuse vector + fulltext with RRF — the production-grade RAG\n" +
      "     pattern.",
  );
  console.log(
    "  6. `store.search.rebuildFulltext()` backfills the index after\n" +
      "     schema changes or drift, returning per-kind counts.",
  );

  console.log(
    "\nSee /fulltext-search in the docs for the full guide: tuning RRF,\n" +
      "adding fulltext to existing data, swapping in alternate PostgreSQL\n" +
      "strategies (pg_trgm, ParadeDB, pgroonga), and troubleshooting.",
  );

  await backend.close();

  console.log("\n=== Example Complete ===");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
