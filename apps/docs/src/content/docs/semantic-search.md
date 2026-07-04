---
title: Semantic Search
description: Vector embeddings and similarity search for AI-powered retrieval
---

TypeGraph supports semantic search using vector embeddings, enabling you to find
semantically similar content using embedding models like OpenAI, Sentence Transformers,
CLIP, or any model that produces fixed-dimension vectors.

## Overview

Traditional search relies on exact keyword matching. Semantic search understands
meaning—"machine learning" matches documents about "neural networks" and "AI algorithms"
even without those exact words.

**Key capabilities:**

- Store embeddings as node properties alongside your graph data
- Find the k most similar nodes using cosine, L2, or inner product distance
- Combine semantic similarity with graph traversals and standard predicates
- Automatic vector indexing for fast approximate nearest neighbor search

## Use Cases

### Retrieval-Augmented Generation (RAG)

Build context-aware AI applications by retrieving relevant documents before
generating responses:

```typescript
async function ragQuery(question: string): Promise<string> {
  const questionEmbedding = await embed(question);

  const context = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) =>
      d.embedding.similarTo(questionEmbedding, 5, {
        metric: "cosine",
        minScore: 0.7,
      })
    )
    .select((ctx) => ({
      title: ctx.d.title,
      content: ctx.d.content,
    }))
    .execute();

  return await llm.chat({
    messages: [
      {
        role: "system",
        content: `Answer based on this context:\n${context.map((d) => d.content).join("\n\n")}`,
      },
      { role: "user", content: question },
    ],
  });
}
```

### Semantic Document Search

Find documents by meaning rather than keywords:

```typescript
const results = await store
  .query()
  .from("Article", "a")
  .whereNode("a", (a) =>
    a.embedding
      .similarTo(queryEmbedding, 20)
      .and(a.category.eq("technology"))
  )
  .select((ctx) => ctx.a)
  .execute();
```

### Image Similarity

Use CLIP or similar vision models for image search:

```typescript
const similarImages = await store
  .query()
  .from("Image", "i")
  .whereNode("i", (i) => i.clipEmbedding.similarTo(queryImageEmbedding, 10))
  .select((ctx) => ({
    url: ctx.i.url,
    caption: ctx.i.caption,
  }))
  .execute();
```

### Product Recommendations

Recommend products based on embedding similarity:

```typescript
const recommendations = await store
  .query()
  .from("Product", "p")
  .whereNode("p", (p) =>
    p.embedding
      .similarTo(referenceProductEmbedding, 10)
      .and(p.inStock.eq(true))
  )
  .select((ctx) => ctx.p)
  .execute();
```

## Database Setup

Vector search requires database-specific extensions for storing and querying
high-dimensional vectors efficiently.

### PostgreSQL with pgvector

[pgvector](https://github.com/pgvector/pgvector) is the recommended extension
for PostgreSQL. It provides:

- Native `vector` column type
- HNSW and IVFFlat indexes for fast approximate nearest neighbor search
- Support for cosine, L2, and inner product distance

**Installation:**

```sql
-- Install the extension (requires superuser or database owner)
CREATE EXTENSION vector;
```

**Docker setup:**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: myapp
    ports:
      - "5432:5432"
```

**TypeGraph migration enables vector support:**

```typescript
import { generatePostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

// Generates DDL including `CREATE EXTENSION IF NOT EXISTS vector;`.
// It does NOT create a single embeddings table — each embedding field gets
// its own typed `vector(N)` table, created lazily on first write (see
// Storage Layout below).
const migrationSQL = generatePostgresMigrationSQL();
```

### SQLite with sqlite-vec

[sqlite-vec](https://github.com/asg017/sqlite-vec) provides vector search
for SQLite. It offers:

- `vec_f32` type for 32-bit float vectors
- Cosine and L2 distance functions

:::caution[sqlite-vec requires a native (better-sqlite3) connection]
sqlite-vec is a loadable C extension. TypeGraph loads it through
better-sqlite3's `loadExtension` in `createLocalSqliteBackend`, so it only
applies to the **local, native** SQLite backend. It does **not** apply to the
**libSQL / Turso** backend (`createLibsqlBackend`): `@libsql/client` does not
expose `loadExtension`, and libSQL ships its **own** native vector engine
(`F32_BLOB`, `vector_distance_cos`, `vector_top_k`) which is a different API
than sqlite-vec. See [libSQL / Turso](#libsql--turso-native-vectors) below.
:::

**Installation:**

```bash
npm install sqlite-vec
```

**Loading the extension:**

```typescript
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const sqlite = new Database("myapp.db");
sqliteVec.load(sqlite);
```

**Limitations:**

- sqlite-vec does not support inner product distance
- Use `cosine` or `l2` metrics only

### libSQL / Turso (native vectors)

The **libSQL / Turso** backend (`createLibsqlBackend`) does **not** use
sqlite-vec. libSQL has a built-in vector engine — no extension to load — so
vector and hybrid search work out of the box on local files, embedded
replicas, and remote Turso databases:

```typescript
import { createClient } from "@libsql/client";
import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";

const client = createClient({ url: "libsql://my-db.turso.io", authToken: "..." });
const { backend } = await createLibsqlBackend(client);
// backend.capabilities.vector?.supported === true
```

Under the hood it stores embeddings as `F32_BLOB` and searches with
`vector_distance_cos` / `vector_distance_l2`, with optional approximate
nearest-neighbor (DiskANN) indexes via `libsql_vector_idx` + `vector_top_k`.
Supported metrics are `cosine` and `l2` (no `inner_product`), matching the
sqlite-vec feature set.

One caveat specific to DiskANN: `vector_top_k` is a table function with no
filter pushdown, so the liveness filter every search applies (only
non-deleted nodes may rank — see below) runs *after* ANN retrieval.
TypeGraph over-fetches 4× `limit` neighbors to leave headroom; if more than
3×`limit` of those neighbors are filtered out, fewer than `limit` results
return. pgvector and sqlite-vec apply the filter inside the index scan and
do not share this bound.

### Supported Distance Metrics

| Metric | PostgreSQL | SQLite (sqlite-vec) | libSQL / Turso | Description |
|--------|------------|---------------------|----------------|-------------|
| `cosine` | `<=>` | `vec_distance_cosine` | `vector_distance_cos` | Cosine distance (1 - similarity). Best for normalized embeddings. |
| `l2` | `<->` | `vec_distance_l2` | `vector_distance_l2` | Euclidean distance. Good for unnormalized vectors. |
| `inner_product` | `<#>` | Not supported | Not supported | Negative inner product. For maximum inner product search (MIPS). |

## Storage Layout & Maintenance

Each embedding field is stored in its own typed, graph-scoped table named
`tg_vec_<graphId>_<kind>_<field>`, carrying that field's fixed dimension
(pgvector `vector(N)`, libSQL `F32_BLOB(N)`, sqlite-vec `vec0`). Tables are
created lazily on the first write, so no migration step provisions them.
Graph-scoping means several graphs in one database can declare the same
`kind`+`field` at different dimensions without collision. This is transparent
to queries — `.similarTo()`, `store.search.vector`, and `store.search.hybrid`
read it for you.

### Deleted nodes never rank

Every facade search (`store.search.vector` / `fulltext` / `hybrid`) computes
its top-k over live nodes only: the search SQL constrains candidates to
non-deleted node ids, so a stale embedding or fulltext row — one whose node
was tombstoned by a writer that bypassed the store's cleanup — can neither
surface in results nor crowd live rows out of the top-k. You always get
`limit` results when at least `limit` live matches exist (on libSQL DiskANN,
subject to the over-fetch bound above).

### Changing an embedding dimension

Switching embedding models usually changes the vector dimension. Stored vectors
can't be reinterpreted at a new dimension, so a stray write at the old
dimension throws `EmbeddingDimensionChangedError`. Update the field's
`embedding(N)` declaration, then recompute the stored vectors with
`store.reembedVectorField()`, which recreates the field's storage at the new
dimension:

```typescript
// embedding(1536) → embedding(3072): recreate storage and re-embed in batches.
// `embed` receives a page of nodes and returns a Map from node id to vector.
await store.reembedVectorField("Document", "embedding", {
  embed: async (nodes) => {
    const vectors = await batchEmbed(nodes.map((node) => node.content));
    return new Map(nodes.map((node, index) => [node.id, vectors[index]]));
  },
});
// → { recreated: true, reembedded: <count> }
```

Without an `embed` callback the storage is recreated empty and you re-embed via
normal `update()` writes.

### Reclaiming removed embedding fields

Removing an embedding field from a kind that still exists orphans its
`tg_vec_*` table. `store.materializeRemovals()` reclaims it — it drops per-field
tables for embedding fields no longer in the active schema and reports them in
`reclaimedVectorFields`:

```typescript
const { reclaimedVectorFields } = await store.materializeRemovals();
// → [{ kind: "Document", fieldPath: "embedding", status: "reclaimed" }]
```

The active schema is the source of truth, so a removed-then-re-added field is
never dropped. The pass is idempotent.

### Migrating from the legacy shared table

Earlier versions stored every embedding in a single shared
`typegraph_node_embeddings` table. If you have existing data there, run the
one-time, idempotent `migrateLegacyEmbeddings()` utility to copy it into the new
per-field tables (new deployments need no action):

```typescript
import { migrateLegacyEmbeddings } from "@nicia-ai/typegraph";

const result = await migrateLegacyEmbeddings({ backend });
// → { migrated, perField, skippedDimensionMismatch, legacyTablePresent }
```

## Schema Design

### Defining Embedding Properties

Use the `embedding()` function to define vector properties with a specific dimension:

```typescript
import { defineNode, embedding } from "@nicia-ai/typegraph";
import { z } from "zod";

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    embedding: embedding(1536), // OpenAI ada-002 dimension
  }),
});

const Image = defineNode("Image", {
  schema: z.object({
    url: z.string(),
    caption: z.string().optional(),
    clipEmbedding: embedding(512), // CLIP ViT-B/32 dimension
  }),
});
```

### Common Embedding Dimensions

| Model | Dimensions | Use Case |
|-------|------------|----------|
| all-MiniLM-L6-v2 | 384 | Fast, lightweight text embeddings |
| CLIP ViT-B/32 | 512 | Image-text multimodal |
| BERT base | 768 | General text embeddings |
| OpenAI ada-002 | 1536 | High-quality text embeddings |
| OpenAI text-embedding-3-small | 1536 | Efficient, high-quality |
| OpenAI text-embedding-3-large | 3072 | Maximum quality |
| Cohere embed-v3 | 1024 | Multilingual support |

### Optional Embeddings

Embedding properties can be optional for gradual population:

```typescript
const Article = defineNode("Article", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    embedding: embedding(1536).optional(),
  }),
});

// Create without embedding
const article = await store.nodes.Article.create({
  title: "Draft Article",
  content: "...",
});

// Add embedding later via background job
await store.nodes.Article.update(article.id, {
  embedding: await generateEmbedding(article.content),
});
```

### Multiple Embeddings per Node

Nodes can have multiple embedding fields for different purposes:

```typescript
const Product = defineNode("Product", {
  schema: z.object({
    name: z.string(),
    description: z.string(),
    imageUrl: z.string(),
    // Text embedding for description search
    textEmbedding: embedding(1536).optional(),
    // Image embedding for visual similarity
    imageEmbedding: embedding(512).optional(),
  }),
});
```

## Storing Embeddings

Embeddings are stored when creating or updating nodes:

```typescript
// Using OpenAI
import OpenAI from "openai";
const openai = new OpenAI();

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: text,
  });
  return response.data[0].embedding;
}

// Store with embedding
const embedding = await generateEmbedding("Machine learning fundamentals");

await store.nodes.Document.create({
  title: "ML Guide",
  content: "Machine learning fundamentals...",
  embedding: embedding,
});
```

### Batch Embedding

For bulk operations, batch your embedding API calls:

```typescript
async function batchEmbed(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

// Process in batches
const documents = await fetchDocumentsWithoutEmbeddings();
const batchSize = 100;

for (let i = 0; i < documents.length; i += batchSize) {
  const batch = documents.slice(i, i + batchSize);
  const embeddings = await batchEmbed(batch.map((d) => d.content));

  await store.transaction(async (tx) => {
    for (const [index, doc] of batch.entries()) {
      await tx.nodes.Document.update(doc.id, {
        embedding: embeddings[index],
      });
    }
  });
}
```

## Querying

### Basic Similarity Search

Use `.similarTo()` to find the k most similar nodes:

```typescript
const queryEmbedding = await generateEmbedding("neural networks");

const similar = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.embedding.similarTo(queryEmbedding, 10) // Top 10 most similar
  )
  .select((ctx) => ({
    title: ctx.d.title,
    content: ctx.d.content,
  }))
  .execute();
```

### Approximate retrieval for `.similarTo()` (opt-in)

By default `.similarTo()` ranks with an exact distance scan — correct at any
scale, and index-served by the PostgreSQL planner where the plan shape
allows. When a kind declares an ANN index (`embedding(n)` defaults to
`hnsw`), you can opt the predicate into the engine's native approximate
retrieval:

```typescript
const similar = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.embedding
      .similarTo(queryEmbedding, 10, { approximate: true })
      .and(d.status.eq("published")),
  )
  .select((ctx) => ctx.d)
  .execute();
```

This is a semantic change, never applied silently: results are subject to
the index's recall. Composed predicates constrain the ANN candidate set —
exactly on pgvector and sqlite-vec, bounded by over-fetch on libSQL
DiskANN. A kind declared with `indexType: "none"` keeps the exact scan even
with the opt-in.

### Scoped facade search: filters, pagination, subclasses

`store.search.vector` (and `fulltext` / `hybrid`) accept a `where`
predicate, an `offset`, and `includeSubClasses` — all compiled into the
search statement itself, so the engine ranks only eligible rows. A filter
never costs you results: you get `limit` hits whenever `limit` matching
nodes exist (on libSQL DiskANN, subject to the over-fetch bound above).

```typescript
// Top 10 most similar *published* documents, second page.
const hits = await store.search.vector("Document", {
  fieldPath: "embedding",
  queryEmbedding,
  limit: 10,
  offset: 10,
  where: (d) => d.status.eq("published"),
});

// Search a kind and all of its subClassOf descendants; per-kind results
// merge into one globally ordered ranking. Kinds that don't declare the
// embedding field are skipped.
const acrossKinds = await store.search.vector("Content", {
  fieldPath: "embedding",
  queryEmbedding,
  limit: 10,
  includeSubClasses: true,
});
```

The `where` predicate is compiled by the same query compiler as
`store.query()` — property predicates behave identically, use the same
declared indexes, and apply the same current-read semantics (tombstoned
nodes and nodes outside their validity window never rank). Kinds expanded
via `includeSubClasses` must share one declared metric: scores from
different metrics cannot merge into one ranking (and a per-call `metric`
cannot bridge the gap — each kind's storage is validated against its
declared metric), so mixed-metric expansions throw; search those kinds
separately.

### Choosing a Distance Metric

```typescript
// Cosine similarity (default) - best for normalized embeddings
d.embedding.similarTo(queryEmbedding, 10, { metric: "cosine" })

// L2 (Euclidean) distance - for unnormalized embeddings
d.embedding.similarTo(queryEmbedding, 10, { metric: "l2" })

// Inner product - for maximum inner product search (PostgreSQL only)
d.embedding.similarTo(queryEmbedding, 10, { metric: "inner_product" })
```

**When to use each:**

- **Cosine**: Most common choice. Works well with normalized embeddings
  (OpenAI, Sentence Transformers). Focuses on direction, not magnitude.
- **L2**: Use when vector magnitude matters. Good for detecting exact
  duplicates.
- **Inner product**: For MIPS (maximum inner product search). Useful when
  embeddings encode both relevance and importance in magnitude.

### Minimum Score Filtering

Filter results below a similarity threshold:

```typescript
const highQualityMatches = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.embedding.similarTo(queryEmbedding, 100, {
      metric: "cosine",
      minScore: 0.8, // Only results with similarity >= 0.8
    })
  )
  .select((ctx) => ctx.d)
  .execute();
```

The `minScore` parameter filters results using **similarity** (not distance):

- **Cosine**: 1.0 = identical, 0.0 = orthogonal. Typical thresholds: 0.7-0.9
- **L2**: Maximum distance to include (lower = more similar)
- **Inner product**: Minimum inner product value

:::note[Similarity vs Distance]
While the underlying database operators use distance (where 0 = identical for cosine),
`minScore` uses similarity semantics for intuitive usage. TypeGraph converts internally:
`distance_threshold = 1 - minScore` for cosine.
:::

### Combining with Predicates

Semantic search integrates with all standard query predicates:

```typescript
const filteredSearch = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.embedding
      .similarTo(queryEmbedding, 20)
      .and(d.category.eq("technology"))
      .and(d.publishedAt.gte("2024-01-01"))
      .and(d.status.eq("published"))
  )
  .select((ctx) => ctx.d)
  .execute();
```

### Combining with Graph Traversals

Search within graph relationships:

```typescript
// Find similar documents by authors I follow
const personalizedSearch = await store
  .query()
  .from("Person", "me")
  .whereNode("me", (p) => p.id.eq(currentUserId))
  .traverse("follows", "f")
  .to("Person", "author")
  .traverse("authored", "a", { direction: "in" })
  .to("Document", "d")
  .whereNode("d", (d) =>
    d.embedding.similarTo(queryEmbedding, 10)
  )
  .select((ctx) => ({
    title: ctx.d.title,
    author: ctx.author.name,
  }))
  .execute();
```

## Best Practices

### Normalize Your Embeddings

Most embedding models produce normalized vectors (unit length). If yours doesn't,
normalize before storing:

```typescript
function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return vector.map((v) => v / magnitude);
}

await store.nodes.Document.create({
  title: "Example",
  content: "...",
  embedding: normalize(rawEmbedding),
});
```

### Use Consistent Embedding Models

Always use the same model for both storing and querying:

```typescript
// Bad: Mixing models
const docEmbedding = await embed("text-embedding-ada-002", content);
const queryEmbedding = await embed("text-embedding-3-small", query); // Different!

// Good: Same model throughout
const MODEL = "text-embedding-ada-002";
const docEmbedding = await embed(MODEL, content);
const queryEmbedding = await embed(MODEL, query);
```

### Handle Missing Embeddings

Not all nodes may have embeddings. Handle gracefully:

```typescript
// Only search nodes with embeddings
const results = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.embedding
      .isNotNull()
      .and(d.embedding.similarTo(queryEmbedding, 10))
  )
  .select((ctx) => ctx.d)
  .execute();
```

### Choose Appropriate k Values

The `k` parameter (number of results) affects performance:

```typescript
// For RAG: Small k (3-10) for focused context
d.embedding.similarTo(query, 5)

// For exploration: Larger k with pagination
d.embedding.similarTo(query, 100)
```

### Index Considerations

Vector indexes (HNSW, IVFFlat) trade accuracy for speed:

- **Small datasets (< 10K)**: Exact search is fast enough
- **Medium datasets (10K-1M)**: HNSW provides good recall with fast queries
- **Large datasets (> 1M)**: Consider IVFFlat with appropriate parameters

TypeGraph creates HNSW indexes by default for optimal balance.

### Tuning recall per query with `efSearch`

pgvector's HNSW index searches a dynamic candidate list whose size is
the `hnsw.ef_search` GUC — **default 40**. That frontier caps how many
neighbors a single scan can surface, so on corpora past a few million
vectors recall@k flattens well below 1.0 at the default. TypeGraph
exposes it as a per-search `efSearch` knob on `store.search.vector` and
the vector half of `store.search.hybrid`:

```typescript
const hits = await store.search.hybrid("Document", {
  limit: 20,
  vector: {
    fieldPath: "embedding",
    queryEmbedding,
    k: 80, // over-fetch 80 candidates from the vector side
    efSearch: 240, // ~3× k — high-recall frontier for this query
  },
  fulltext: { query: "renewable energy" },
});
```

Sizing guidance:

- **Floor — `efSearch >= k`.** Hybrid over-fetches `k` candidates from
  the vector side (default `4 * limit`). If `efSearch` is below `k` the
  scan can't fill the candidate set, so the over-fetch silently
  under-delivers — RRF papers over this on head queries (the fulltext
  half covers the miss) but drops tail queries only the vector side
  knows about.
- **Target — ~2–4× `k`.** On million-scale corpora this clears roughly
  0.95 recall@10, versus ~0.82–0.85 at the default 40. Verify the curve
  against your own corpus rather than hard-coding a multiplier.
- **Ceiling — 1000.** pgvector caps `hnsw.ef_search` at 1000; TypeGraph
  rejects a larger `efSearch` with a clear error.

Because it's per-search, one connection pool can serve both a
latency-sensitive interactive path (omit `efSearch`, inherit the session
default) and a recall-sensitive batch/ETL path (raise it) — a session
GUC can't, a per-call override can.

**Mechanics and limits.** The override is applied transaction-locally
(`SET LOCAL hnsw.ef_search`) around the vector `SELECT`, so it never
leaks to the next query on a pooled connection. Omitting it preserves
today's behavior exactly — no transaction is opened. It applies to the
**Postgres HNSW** path only:

- **sqlite-vec** has no equivalent frontier knob and ignores `efSearch`
  (no-op).
- **Transaction-less Postgres drivers** (`drizzle-orm/neon-http`) can't
  scope `SET LOCAL`, so `efSearch` is ignored with a one-time warning —
  use a transactional driver (`node-postgres` / `neon-serverless` /
  `postgres-js`) to apply it.
- It tunes HNSW only; IVFFlat's analogous knob (`ivfflat.probes`) is not
  yet exposed.

## Troubleshooting

### "Extension not found" errors

**PostgreSQL:**

```sql
-- Check if pgvector is installed
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Install it
CREATE EXTENSION vector;
```

**SQLite:**

```typescript
// Ensure sqlite-vec is loaded before queries
import * as sqliteVec from "sqlite-vec";
sqliteVec.load(sqlite);
```

### "Inner product not supported" (SQLite)

sqlite-vec only supports `cosine` and `l2` metrics. Use one of those instead:

```typescript
// Instead of:
d.embedding.similarTo(query, 10, { metric: "inner_product" })

// Use:
d.embedding.similarTo(query, 10, { metric: "cosine" })
```

### Dimension mismatch errors

Ensure query embedding has the same dimension as stored embeddings:

```typescript
const Document = defineNode("Document", {
  schema: z.object({
    embedding: embedding(1536), // 1536 dimensions
  }),
});

// Query embedding must also be 1536 dimensions
const queryEmbedding = await embed(text); // Verify this returns 1536-dim vector
```

### Slow queries

1. **Check index creation**: Vector indexes may not exist
2. **Reduce k**: Smaller k = faster queries
3. **Add filters**: Pre-filter with standard predicates before similarity search
4. **Consider approximate search**: HNSW indexes sacrifice some accuracy for speed

## Hybrid Search: Combining with Fulltext

Vector search excels at semantic similarity but misses exact matches —
proper nouns, SKUs, code identifiers, rare technical terms. **Hybrid
search** fuses vector and fulltext results with Reciprocal Rank Fusion
and typically beats either approach alone.

```typescript
// One query, both signals — fused with RRF at the SQL layer
const results = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.$fulltext
      .matches("renewable energy", 50)
      .and(d.embedding.similarTo(queryVec, 50))
  )
  .select((ctx) => ctx.d)
  .limit(10)
  .execute();
```

For tunable per-source weights and RRF parameters, use the store-level
`store.search.hybrid()` API. See the [Fulltext Search guide](/fulltext-search)
for the complete hybrid workflow.

## API Reference

See the [Predicates documentation](/queries/predicates#embedding) for
complete API reference of the `similarTo()` predicate and related options.

See [Fulltext Search](/fulltext-search) for the `n.$fulltext.matches()`
predicate and `searchable()` schema brand.
