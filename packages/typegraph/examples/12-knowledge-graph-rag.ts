/**
 * Example 12: Knowledge Graph for RAG
 *
 * Demonstrates what graph structure adds to RAG beyond vector similarity:
 * - Entity disambiguation and linking
 * - Multi-hop relationship traversal
 * - Context window expansion via chunk chains
 * - Hybrid retrieval: vector search combined with graph traversals
 *
 * Run with:
 *   npx tsx examples/12-knowledge-graph-rag.ts
 */
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  inverseOf,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema
// ============================================================

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    source: z.string(),
  }),
});

const Chunk = defineNode("Chunk", {
  schema: z.object({
    text: z.string(),
    embedding: embedding(384),
    position: z.number().int(),
  }),
});

const Entity = defineNode("Entity", {
  schema: z.object({
    name: z.string(),
    type: z.enum(["person", "organization", "location", "concept"]),
    embedding: embedding(384).optional(),
  }),
});

const containsChunk = defineEdge("containsChunk");
const nextChunk = defineEdge("nextChunk");
const prevChunk = defineEdge("prevChunk");
const mentions = defineEdge("mentions");
const relatesTo = defineEdge("relatesTo", {
  schema: z.object({ relationship: z.string() }),
});

const graph = defineGraph({
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

// ============================================================
// Helpers
// ============================================================

/** Generate deterministic mock embedding based on text */
function mockEmbedding(text: string): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 384; i++) {
    const charSum = text.split("").reduce((sum, char, idx) => {
      return sum + char.charCodeAt(0) * (idx + 1) * (i + 1);
    }, 0);
    embedding.push(Math.sin(charSum + i) * 0.5 + 0.5);
  }
  const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map((v) => v / magnitude);
}

// ============================================================
// Main
// ============================================================

export async function main() {
  console.log("=== Knowledge Graph for RAG ===\n");

  const store = createStore(graph, createExampleBackend());

  // ----------------------------------------------------------
  // Seed data: Two documents about AI companies
  // ----------------------------------------------------------

  console.log("--- Seeding Data ---\n");

  // Document 1: About OpenAI
  const doc1 = await store.nodes.Document.create({
    title: "OpenAI History",
    source: "wikipedia.org/openai",
  });

  const chunks1 = [
    "OpenAI was founded in 2015 by Sam Altman and others.",
    "Sam Altman became CEO of OpenAI in 2019.",
    "OpenAI released GPT-4 in March 2023.",
  ];

  let prevChunkNode: Awaited<ReturnType<typeof store.nodes.Chunk.create>> | undefined;
  const doc1Chunks = [];

  for (const [i, text] of chunks1.entries()) {
    const chunk = await store.nodes.Chunk.create({
      text,
      embedding: mockEmbedding(text),
      position: i,
    });
    doc1Chunks.push(chunk);
    await store.edges.containsChunk.create(doc1, chunk, {});
    if (prevChunkNode) {
      // Create both directions - inverseOf declares them equivalent but doesn't auto-create
      await store.edges.nextChunk.create(prevChunkNode, chunk, {});
      await store.edges.prevChunk.create(chunk, prevChunkNode, {});
    }
    prevChunkNode = chunk;
  }

  // Document 2: About Tesla
  const doc2 = await store.nodes.Document.create({
    title: "Tesla Overview",
    source: "wikipedia.org/tesla",
  });

  const chunks2 = [
    "Tesla was founded in 2003 by Martin Eberhard and Marc Tarpenning.",
    "Elon Musk joined Tesla in 2004 as chairman.",
    "Tesla produces electric vehicles and energy storage systems.",
  ];

  prevChunkNode = undefined;
  const doc2Chunks = [];

  for (const [i, text] of chunks2.entries()) {
    const chunk = await store.nodes.Chunk.create({
      text,
      embedding: mockEmbedding(text),
      position: i,
    });
    doc2Chunks.push(chunk);
    await store.edges.containsChunk.create(doc2, chunk, {});
    if (prevChunkNode) {
      await store.edges.nextChunk.create(prevChunkNode, chunk, {});
      await store.edges.prevChunk.create(chunk, prevChunkNode, {});
    }
    prevChunkNode = chunk;
  }

  // Create entities
  const samAltman = await store.nodes.Entity.create({
    name: "Sam Altman",
    type: "person",
    embedding: mockEmbedding("Sam Altman"),
  });
  const elonMusk = await store.nodes.Entity.create({
    name: "Elon Musk",
    type: "person",
    embedding: mockEmbedding("Elon Musk"),
  });
  const openai = await store.nodes.Entity.create({
    name: "OpenAI",
    type: "organization",
    embedding: mockEmbedding("OpenAI"),
  });
  const tesla = await store.nodes.Entity.create({
    name: "Tesla",
    type: "organization",
    embedding: mockEmbedding("Tesla"),
  });
  const gpt4 = await store.nodes.Entity.create({
    name: "GPT-4",
    type: "concept",
    embedding: mockEmbedding("GPT-4"),
  });

  // Link chunks to entities (mentions)
  await store.edges.mentions.create(doc1Chunks[0]!, samAltman, {});
  await store.edges.mentions.create(doc1Chunks[0]!, openai, {});
  await store.edges.mentions.create(doc1Chunks[1]!, samAltman, {});
  await store.edges.mentions.create(doc1Chunks[1]!, openai, {});
  await store.edges.mentions.create(doc1Chunks[2]!, openai, {});
  await store.edges.mentions.create(doc1Chunks[2]!, gpt4, {});

  await store.edges.mentions.create(doc2Chunks[0]!, tesla, {});
  await store.edges.mentions.create(doc2Chunks[1]!, elonMusk, {});
  await store.edges.mentions.create(doc2Chunks[1]!, tesla, {});
  await store.edges.mentions.create(doc2Chunks[2]!, tesla, {});

  // Entity relationships
  await store.edges.relatesTo.create(samAltman, openai, { relationship: "leads" });
  await store.edges.relatesTo.create(elonMusk, tesla, { relationship: "leads" });
  await store.edges.relatesTo.create(openai, gpt4, { relationship: "created" });

  console.log("Created 2 documents, 6 chunks, 5 entities\n");

  // ----------------------------------------------------------
  // Pattern 1: Entity-Based Retrieval
  // ----------------------------------------------------------

  console.log("--- Pattern 1: Entity-Based Retrieval ---");
  console.log('Find all chunks mentioning "Sam Altman"\n');

  const samAltmanChunks = await store
    .query()
    .from("Entity", "e")
    .whereNode("e", (e) => e.name.eq("Sam Altman"))
    .traverse("mentions", "m", { direction: "in" })
    .to("Chunk", "c")
    .select((ctx) => ctx.c.text)
    .execute();

  for (const text of samAltmanChunks) {
    console.log(`  • ${text}`);
  }

  // ----------------------------------------------------------
  // Pattern 2: Multi-Hop Entity Traversal
  // ----------------------------------------------------------

  console.log("\n--- Pattern 2: Multi-Hop Entity Traversal ---");
  console.log("Find entities related to people (1 hop)\n");

  const relatedToPersons = await store
    .query()
    .from("Entity", "e")
    .whereNode("e", (e) => e.type.eq("person"))
    .traverse("relatesTo", "r")
    .to("Entity", "target")
    .select((ctx) => ({
      person: ctx.e.name,
      target: ctx.target.name,
    }))
    .execute();

  for (const rel of relatedToPersons) {
    console.log(`  ${rel.person} --> ${rel.target}`);
  }

  // ----------------------------------------------------------
  // Pattern 3: Context Window Expansion
  // ----------------------------------------------------------

  console.log("\n--- Pattern 3: Context Window Expansion ---");
  console.log("Get chunk with surrounding context\n");

  const middleChunk = doc1Chunks[1]!;

  // Get previous chunk
  const before = await store
    .query()
    .from("Chunk", "c")
    .whereNode("c", (c) => c.id.eq(middleChunk.id))
    .traverse("prevChunk", "e")
    .to("Chunk", "prev")
    .select((ctx) => ctx.prev.text)
    .execute();

  // Get next chunk
  const after = await store
    .query()
    .from("Chunk", "c")
    .whereNode("c", (c) => c.id.eq(middleChunk.id))
    .traverse("nextChunk", "e")
    .to("Chunk", "next")
    .select((ctx) => ctx.next.text)
    .execute();

  console.log(`  [before] ${before[0] ?? "(none)"}`);
  console.log(`  [target] ${middleChunk.text}`);
  console.log(`  [after]  ${after[0] ?? "(none)"}`);

  // ----------------------------------------------------------
  // Pattern 4: Hybrid Retrieval (Single Query with Fan-out)
  // ----------------------------------------------------------

  console.log("\n--- Pattern 4: Hybrid Retrieval (Single Query) ---");
  console.log("Vector search + fan-out to entities AND document\n");

  // Single query using `from` option for fan-out pattern
  // Simulating vector match with text filter (in production, use .similarTo())
  const hybridResults = await store
    .query()
    .from("Chunk", "c")
    .whereNode("c", (c) => c.text.contains("CEO"))
    .traverse("mentions", "m")
    .to("Entity", "e")
    .traverse("containsChunk", "d_edge", { direction: "in", from: "c" }) // Fan-out from chunk
    .to("Document", "d")
    .select((ctx) => ({
      chunkId: ctx.c.id,
      text: ctx.c.text,
      source: ctx.d.title,
      entityName: ctx.e.name,
      entityType: ctx.e.type,
    }))
    .execute();

  // Group by chunk (one row per chunk-entity pair)
  const byChunk = new Map<
    string,
    { text: string; source: string; entities: Array<{ name: string; type: string }> }
  >();
  for (const row of hybridResults) {
    const existing = byChunk.get(row.chunkId);
    if (existing) {
      existing.entities.push({ name: row.entityName, type: row.entityType });
    } else {
      byChunk.set(row.chunkId, {
        text: row.text,
        source: row.source,
        entities: [{ name: row.entityName, type: row.entityType }],
      });
    }
  }

  console.log("Results (single query, grouped by chunk):");
  for (const [, chunk] of byChunk) {
    console.log(`  • [${chunk.source}] "${chunk.text.slice(0, 40)}..."`);
    console.log(`    Entities: [${chunk.entities.map((e) => e.name).join(", ")}]`);
  }

  // ----------------------------------------------------------
  // Pattern 5: Building Structured Context
  // ----------------------------------------------------------

  console.log("\n--- Pattern 5: Building Structured Context ---");
  console.log("Retrieve chunks + entity facts for LLM prompt\n");

  // Get chunks from a document
  const contextChunks = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.title.eq("OpenAI History"))
    .traverse("containsChunk", "e")
    .to("Chunk", "c")
    .select((ctx) => ({ text: ctx.c.text, source: ctx.d.title }))
    .execute();

  // Get entity relationships (note: edge properties not yet accessible in select)
  const entityRelations = await store
    .query()
    .from("Entity", "e")
    .whereNode("e", (e) => e.name.eq("Sam Altman"))
    .traverse("relatesTo", "r")
    .to("Entity", "target")
    .select((ctx) => ({
      from: ctx.e.name,
      to: ctx.target.name,
    }))
    .execute();

  console.log("## Relevant Passages\n");
  for (const chunk of contextChunks) {
    console.log(`**${chunk.source}**: ${chunk.text}\n`);
  }

  console.log("## Entity Relationships\n");
  for (const rel of entityRelations) {
    console.log(`- ${rel.from} → ${rel.to}`);
  }

  // ----------------------------------------------------------
  // Pattern 6: Bidirectional Chunk Navigation
  // ----------------------------------------------------------

  console.log("\n--- Pattern 6: Bidirectional Chunk Navigation ---");
  console.log("Navigate chunk chains in both directions\n");

  const lastChunk = doc1Chunks[2]!;
  const backwards = await store
    .query()
    .from("Chunk", "c")
    .whereNode("c", (c) => c.id.eq(lastChunk.id))
    .traverse("prevChunk", "e")
    .to("Chunk", "prev")
    .select((ctx) => ctx.prev.text)
    .execute();

  console.log(`  Last chunk: "${lastChunk.text.slice(0, 40)}..."`);
  console.log(`  Previous:   "${backwards[0]?.slice(0, 40)}..."`);

  console.log("\n=== Done ===");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
