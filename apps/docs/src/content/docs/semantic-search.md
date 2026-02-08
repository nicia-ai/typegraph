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

**TypeGraph migration includes vector support:**

```typescript
import { getPostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

// Generates DDL including:
// - CREATE EXTENSION IF NOT EXISTS vector;
// - typegraph_embeddings table with vector column
const migrationSQL = getPostgresMigrationSQL();
```

### SQLite with sqlite-vec

[sqlite-vec](https://github.com/asg017/sqlite-vec) provides vector search
for SQLite. It offers:

- `vec_f32` type for 32-bit float vectors
- Cosine and L2 distance functions
- Works with any SQLite database

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

### Supported Distance Metrics

| Metric | PostgreSQL | SQLite | Description |
|--------|------------|--------|-------------|
| `cosine` | `<=>` | `vec_distance_cosine` | Cosine distance (1 - similarity). Best for normalized embeddings. |
| `l2` | `<->` | `vec_distance_l2` | Euclidean distance. Good for unnormalized vectors. |
| `inner_product` | `<#>` | Not supported | Negative inner product. For maximum inner product search (MIPS). |

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

## API Reference

See the [Predicates documentation](/queries/predicates#embedding) for
complete API reference of the `similarTo()` predicate and related options.
