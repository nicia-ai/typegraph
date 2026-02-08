---
title: Knowledge Graph for RAG
description: Enhance retrieval with entity linking, relationship traversal, and multi-hop context
---

This example demonstrates how **graph structure enhances RAG** beyond vector similarity.
While [Semantic Search](/semantic-search) covers embedding basics, this guide focuses
on what graphs uniquely provide: entity disambiguation, relationship traversal,
and structured context that flat retrieval cannot offer.

## What Graphs Add to RAG

| Flat RAG | Graph RAG |
|----------|-----------|
| Returns similar chunks | Traverses to related entities and facts |
| Treats "Apple" the same everywhere | Disambiguates Apple Inc. vs. apple fruit |
| Context is unstructured text | Context includes structured relationships |
| Single-hop retrieval | Multi-hop reasoning across connections |

**Example**: For "What companies has Elon Musk founded?", flat RAG returns chunks
mentioning him. Graph RAG traverses from the "Elon Musk" entity through "founded"
edges to return structured company data—regardless of whether those facts appear
in the same chunk.

## Schema

```typescript
import { z } from "zod";
import { defineNode, defineEdge, defineGraph, embedding, inverseOf } from "@nicia-ai/typegraph";

// Source documents
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    source: z.string(),
  }),
});

// Text chunks with embeddings
const Chunk = defineNode("Chunk", {
  schema: z.object({
    text: z.string(),
    embedding: embedding(1536),
    position: z.number().int(),
  }),
});

// Extracted entities
const Entity = defineNode("Entity", {
  schema: z.object({
    name: z.string(),
    type: z.enum(["person", "organization", "location", "concept", "product", "event"]),
    description: z.string().optional(),
    embedding: embedding(1536).optional(),
  }),
});

// Edges
const containsChunk = defineEdge("containsChunk");
const nextChunk = defineEdge("nextChunk");
const prevChunk = defineEdge("prevChunk");
const mentions = defineEdge("mentions", {
  schema: z.object({
    confidence: z.number().min(0).max(1).optional(),
  }),
});
const relatesTo = defineEdge("relatesTo", {
  schema: z.object({
    relationship: z.string(), // "founded", "works_at", "located_in"
  }),
});

export const graph = defineGraph({
  id: "rag_graph",
  nodes: {
    Document: { type: Document },
    Chunk: { type: Chunk },
    Entity: { type: Entity },
  },
  edges: {
    containsChunk: { type: containsChunk, from: [Document], to: [Chunk] },
    nextChunk: { type: nextChunk, from: [Chunk], to: [Chunk] },
    prevChunk: { type: prevChunk, from: [Chunk], to: [Chunk] },
    mentions: { type: mentions, from: [Chunk], to: [Entity] },
    relatesTo: { type: relatesTo, from: [Entity], to: [Entity] },
  },
  ontology: [inverseOf(nextChunk, prevChunk)],
});
```

## Embedding Setup

Using [Vercel AI SDK](https://ai-sdk.dev/docs/ai-sdk-core/embeddings):

```typescript
import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";

const embeddingModel = openai.embeddingModel("text-embedding-3-small");

async function generateEmbedding(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: embeddingModel, value: text });
  return embedding;
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({ model: embeddingModel, values: texts });
  return embeddings;
}
```

## Ingestion with Entity Linking

The key graph RAG capability: linking chunks to disambiguated entities.

```typescript
interface ChunkData {
  text: string;
  entities: Array<{
    name: string;
    type: "person" | "organization" | "location" | "concept" | "product" | "event";
  }>;
}

async function ingestDocument(
  title: string,
  source: string,
  chunks: ChunkData[]
): Promise<void> {
  await store.transaction(async (tx) => {
    const doc = await tx.nodes.Document.create({ title, source });

    // Batch embed all chunks
    const chunkEmbeddings = await generateEmbeddings(chunks.map((c) => c.text));

    let prevChunk: typeof Chunk.$node | undefined;

    for (const [i, chunkData] of chunks.entries()) {
      const chunk = await tx.nodes.Chunk.create({
        text: chunkData.text,
        embedding: chunkEmbeddings[i],
        position: i,
      });

      await tx.edges.containsChunk.create(doc, chunk, {});

      if (prevChunk) {
        await tx.edges.nextChunk.create(prevChunk, chunk, {});
      }

      // Link to entities (find-or-create for deduplication)
      for (const entityData of chunkData.entities) {
        let entity = await tx
          .query()
          .from("Entity", "e")
          .whereNode("e", (e) =>
            e.name.eq(entityData.name).and(e.type.eq(entityData.type))
          )
          .select((ctx) => ctx.e)
          .first();

        if (!entity) {
          entity = await tx.nodes.Entity.create({
            name: entityData.name,
            type: entityData.type,
            embedding: await generateEmbedding(entityData.name),
          });
        }

        await tx.edges.mentions.create(chunk, entity, {});
      }

      prevChunk = chunk;
    }
  });
}
```

## Graph-Specific Query Patterns

These patterns demonstrate capabilities that require graph structure—they cannot
be replicated with flat vector search.

### Entity-Based Retrieval

Find all chunks mentioning a specific entity, regardless of how it's phrased:

```typescript
async function findChunksByEntity(entityName: string) {
  return store
    .query()
    .from("Entity", "e")
    .whereNode("e", (e) => e.name.eq(entityName))
    .traverse("mentions", "m", { direction: "in" })
    .to("Chunk", "c")
    .select((ctx) => ctx.c.text)
    .execute();
}
```

### Multi-Hop Entity Traversal

Find entities connected through relationships:

```typescript
async function findRelatedEntities(entityName: string, maxHops = 2) {
  return store
    .query()
    .from("Entity", "e")
    .whereNode("e", (e) => e.name.eq(entityName))
    .traverse("relatesTo", "r")
    .recursive()
    .maxHops(maxHops)
    .withDepth("depth")
    .to("Entity", "related")
    .select((ctx) => ({
      from: ctx.e.name,
      to: ctx.related.name,
      depth: ctx.depth,
    }))
    .execute();
}
```

### Context Window Expansion

Get surrounding chunks for a match:

```typescript
async function getChunkWithContext(chunkId: string, windowSize = 1) {
  const [before, after] = await Promise.all([
    store
      .query()
      .from("Chunk", "c")
      .whereNode("c", (c) => c.id.eq(chunkId))
      .traverse("prevChunk", "e")
      .recursive()
      .maxHops(windowSize)
      .to("Chunk", "prev")
      .orderBy("prev", "position", "desc")
      .select((ctx) => ctx.prev.text)
      .execute(),
    store
      .query()
      .from("Chunk", "c")
      .whereNode("c", (c) => c.id.eq(chunkId))
      .traverse("nextChunk", "e")
      .recursive()
      .maxHops(windowSize)
      .to("Chunk", "next")
      .orderBy("next", "position", "asc")
      .select((ctx) => ctx.next.text)
      .execute(),
  ]);

  const chunk = await store.nodes.Chunk.getById(chunkId);

  return {
    before: before.toReversed(),
    chunk: chunk?.text ?? "",
    after,
  };
}
```

## Hybrid Retrieval: Vector + Graph

Combine vector similarity with graph traversal in a single query using the `from` option:

```typescript
async function hybridRetrieval(query: string, limit = 10) {
  const queryEmbedding = await generateEmbedding(query);

  // Single query: vector search + fan-out to entities AND document
  const results = await store
    .query()
    .from("Chunk", "c")
    .whereNode("c", (c) =>
      c.embedding.similarTo(queryEmbedding, limit, { metric: "cosine", minScore: 0.7 })
    )
    .traverse("mentions", "m")
    .to("Entity", "e")
    .traverse("containsChunk", "d_edge", { direction: "in", from: "c" }) // Fan-out from chunk
    .to("Document", "d")
    .select((ctx) => ({
      chunkId: ctx.c.id,
      text: ctx.c.text,
      score: ctx.c.embedding.similarity(queryEmbedding),
      source: ctx.d.title,
      entityName: ctx.e.name,
      entityType: ctx.e.type,
    }))
    .execute();

  // Group by chunk (one row per chunk-entity pair)
  const byChunk = new Map<string, typeof results[number] & { entities: Array<{ name: string; type: string }> }>();
  for (const row of results) {
    const existing = byChunk.get(row.chunkId);
    if (existing) {
      existing.entities.push({ name: row.entityName, type: row.entityType });
    } else {
      byChunk.set(row.chunkId, {
        ...row,
        entities: [{ name: row.entityName, type: row.entityType }],
      });
    }
  }

  return [...byChunk.values()];
}
```

The `from` option enables **fan-out patterns** where you traverse multiple relationships
from the same node. Without `from`, traversals chain sequentially (A→B→C). With `from`,
you can branch: traverse from chunk to entities, AND from chunk to document.

## Building Structured Context

Format graph-enriched context for an LLM:

```typescript
async function buildGraphContext(query: string, extractedEntities: string[]) {
  const queryEmbedding = await generateEmbedding(query);

  // Get relevant chunks with sources
  const chunks = await store
    .query()
    .from("Chunk", "c")
    .whereNode("c", (c) =>
      c.embedding.similarTo(queryEmbedding, 5, { metric: "cosine", minScore: 0.7 })
    )
    .traverse("containsChunk", "e", { direction: "in" })
    .to("Document", "d")
    .select((ctx) => ({ text: ctx.c.text, source: ctx.d.title }))
    .execute();

  // Get entity relationships from graph
  const entityFacts = await Promise.all(
    extractedEntities.map(async (name) => {
      const relations = await store
        .query()
        .from("Entity", "e")
        .whereNode("e", (e) => e.name.eq(name))
        .traverse("relatesTo", "r")
        .to("Entity", "target")
        .select((ctx) => ctx.target.name)
        .execute();

      return relations.length > 0 ? { name, relatedTo: relations } : undefined;
    })
  );

  return { chunks, entityFacts: entityFacts.filter(Boolean) };
}

function formatForPrompt(context: Awaited<ReturnType<typeof buildGraphContext>>): string {
  let prompt = "## Relevant Passages\n\n";

  for (const chunk of context.chunks) {
    prompt += `**${chunk.source}**: ${chunk.text}\n\n`;
  }

  if (context.entityFacts.length > 0) {
    prompt += "## Entity Relationships\n\n";
    for (const entity of context.entityFacts) {
      if (entity) {
        prompt += `**${entity.name}** → ${entity.relatedTo.join(", ")}\n`;
      }
    }
  }

  return prompt;
}
```

## When to Use Graph RAG

**Use graph RAG when:**

- Queries require connecting facts across documents ("Who founded X and what else did they start?")
- Entity disambiguation matters (distinguishing "Apple" the company from "apple" the fruit)
- Relationship traversal provides value ("Find all companies in the same industry as X")
- You need structured facts alongside unstructured text

**Flat vector RAG may suffice when:**

- Simple "find similar content" queries
- No entity relationships to exploit
- Single-document question answering

## Next Steps

- [Semantic Search](/semantic-search) — Vector embedding fundamentals
- [Traversals](/queries/traverse) — Graph traversal patterns
- [Document Management](/examples/document-management) — Versioning and access control
