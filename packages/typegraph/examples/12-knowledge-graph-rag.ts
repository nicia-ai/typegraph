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
import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  inverseOf,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend, mockTextEmbedding } from "./_helpers";

// ============================================================
// Schema
// ============================================================

const EMBEDDING_DIMENSIONS = 384;

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    source: z.string(),
  }),
});

const Chunk = defineNode("Chunk", {
  schema: z.object({
    text: z.string(),
    embedding: embedding(EMBEDDING_DIMENSIONS),
    position: z.number().int(),
  }),
});

const Entity = defineNode("Entity", {
  schema: z.object({
    name: z.string(),
    type: z.enum(["person", "organization", "location", "concept"]),
    embedding: embedding(EMBEDDING_DIMENSIONS).optional(),
  }),
});

const containsChunk = defineEdge("containsChunk");
const nextChunk = defineEdge("nextChunk");
const previousChunk = defineEdge("prevChunk");
const mentions = defineEdge("mentions");
const relatesTo = defineEdge("relatesTo", {
  schema: z.object({ relationship: z.string() }),
});

const graph = defineGraph({
  id: "rag_graph",
  nodes: {
    Document: { type: Document },
    Chunk: { type: Chunk },
    Entity: {
      type: Entity,
      unique: [
        {
          name: "entity_name_type",
          fields: ["name", "type"],
          scope: "kind",
          collation: "caseInsensitive",
        },
      ],
    },
  },
  edges: {
    containsChunk: { type: containsChunk, from: [Document], to: [Chunk] },
    nextChunk: { type: nextChunk, from: [Chunk], to: [Chunk] },
    prevChunk: { type: previousChunk, from: [Chunk], to: [Chunk] },
    mentions: { type: mentions, from: [Chunk], to: [Entity] },
    relatesTo: { type: relatesTo, from: [Entity], to: [Entity] },
  },
  ontology: [inverseOf(nextChunk, previousChunk)],
});

// ============================================================
// Main
// ============================================================

export async function main() {
  console.log("=== Knowledge Graph for RAG ===\n");

  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  try {
    // ----------------------------------------------------------
    // Seed data: Two documents about AI companies
    // ----------------------------------------------------------

    console.log("--- Seeding Data ---\n");

    // Document 1: About OpenAI
    const document1 = await store.nodes.Document.create({
      title: "OpenAI History",
      source: "wikipedia.org/openai",
    });

    const chunks1 = [
      "OpenAI was founded in 2015 by Sam Altman and others.",
      "Sam Altman became CEO of OpenAI in 2019.",
      "OpenAI released GPT-4 in March 2023.",
    ];

    let previousChunkNode:
      Awaited<ReturnType<typeof store.nodes.Chunk.create>> | undefined;
    const document1Chunks = [];

    for (const [index, text] of chunks1.entries()) {
      const chunk = await store.nodes.Chunk.create({
        text,
        embedding: mockTextEmbedding(text, EMBEDDING_DIMENSIONS),
        position: index,
      });
      document1Chunks.push(chunk);
      await store.edges.containsChunk.create(document1, chunk, {});
      if (previousChunkNode) {
        // Store only nextChunk — the inverseOf ontology lets .traverse("prevChunk")
        // follow stored nextChunk edges automatically.
        await store.edges.nextChunk.create(previousChunkNode, chunk, {});
      }
      previousChunkNode = chunk;
    }

    // Document 2: About Tesla
    const document2 = await store.nodes.Document.create({
      title: "Tesla Overview",
      source: "wikipedia.org/tesla",
    });

    const chunks2 = [
      "Tesla was founded in 2003 by Martin Eberhard and Marc Tarpenning.",
      "Elon Musk joined Tesla in 2004 as chairman.",
      "Tesla produces electric vehicles and energy storage systems.",
    ];

    previousChunkNode = undefined;
    const document2Chunks = [];

    for (const [index, text] of chunks2.entries()) {
      const chunk = await store.nodes.Chunk.create({
        text,
        embedding: mockTextEmbedding(text, EMBEDDING_DIMENSIONS),
        position: index,
      });
      document2Chunks.push(chunk);
      await store.edges.containsChunk.create(document2, chunk, {});
      if (previousChunkNode) {
        await store.edges.nextChunk.create(previousChunkNode, chunk, {});
      }
      previousChunkNode = chunk;
    }

    // Use getOrCreateByConstraint so re-running ingestion on overlapping
    // corpora dedupes entities via the `entity_name_type` unique constraint.
    // Each entity also gets a name embedding, used for mention disambiguation
    // in Pattern 6.
    async function ensureEntity(
      name: string,
      type: "person" | "organization" | "location" | "concept",
    ) {
      const result = await store.nodes.Entity.getOrCreateByConstraint(
        "entity_name_type",
        {
          name,
          type,
          embedding: mockTextEmbedding(name, EMBEDDING_DIMENSIONS),
        },
      );
      return result.node;
    }

    const samAltman = await ensureEntity("Sam Altman", "person");
    const elonMusk = await ensureEntity("Elon Musk", "person");
    const openai = await ensureEntity("OpenAI", "organization");
    const tesla = await ensureEntity("Tesla", "organization");
    const gpt4 = await ensureEntity("GPT-4", "concept");

    // Link chunks to entities (mentions)
    await store.edges.mentions.create(document1Chunks[0]!, samAltman, {});
    await store.edges.mentions.create(document1Chunks[0]!, openai, {});
    await store.edges.mentions.create(document1Chunks[1]!, samAltman, {});
    await store.edges.mentions.create(document1Chunks[1]!, openai, {});
    await store.edges.mentions.create(document1Chunks[2]!, openai, {});
    await store.edges.mentions.create(document1Chunks[2]!, gpt4, {});

    await store.edges.mentions.create(document2Chunks[0]!, tesla, {});
    await store.edges.mentions.create(document2Chunks[1]!, elonMusk, {});
    await store.edges.mentions.create(document2Chunks[1]!, tesla, {});
    await store.edges.mentions.create(document2Chunks[2]!, tesla, {});

    // Entity relationships
    await store.edges.relatesTo.create(samAltman, openai, {
      relationship: "leads",
    });
    await store.edges.relatesTo.create(elonMusk, tesla, {
      relationship: "leads",
    });
    await store.edges.relatesTo.create(openai, gpt4, {
      relationship: "created",
    });

    console.log("Created 2 documents, 6 chunks, 5 entities\n");

    // ----------------------------------------------------------
    // Pattern 1: Entity-Based Retrieval
    // ----------------------------------------------------------

    console.log("--- Pattern 1: Entity-Based Retrieval ---");
    console.log('Find all chunks mentioning "Sam Altman"\n');

    const samAltmanChunks = await store
      .query()
      .from("Entity", "e")
      .whereNode("e", (entity) => entity.name.eq("Sam Altman"))
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
      .whereNode("e", (entity) => entity.type.eq("person"))
      .traverse("relatesTo", "r")
      .to("Entity", "target")
      .select((ctx) => ({
        person: ctx.e.name,
        target: ctx.target.name,
      }))
      .execute();

    for (const relation of relatedToPersons) {
      console.log(`  ${relation.person} --> ${relation.target}`);
    }

    // ----------------------------------------------------------
    // Pattern 3: Context Window Expansion
    // ----------------------------------------------------------

    console.log("\n--- Pattern 3: Context Window Expansion ---");
    console.log("Get chunk with surrounding context\n");

    const middleChunk = document1Chunks[1]!;

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

    // Real vector similarity on the chunk embedding, fanning out in one query to
    // the entities each matched chunk mentions AND back to its source document.
    // (Falls back to a keyword filter if the backend has no vector engine.)
    const vectorReady = backend.capabilities.vector?.supported === true;
    const chunkQuery = mockTextEmbedding(
      "company leadership and CEO",
      EMBEDDING_DIMENSIONS,
    );
    const hybridResults = await store
      .query()
      .from("Chunk", "c")
      .whereNode("c", (c) =>
        vectorReady ?
          c.embedding.similarTo(chunkQuery, 3)
        : c.text.contains("CEO"),
      )
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
      {
        text: string;
        source: string;
        entities: { name: string; type: string }[];
      }
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
      console.log(
        `    Entities: [${chunk.entities.map((entity) => entity.name).join(", ")}]`,
      );
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

    // Get entity relationships, including the edge property.
    const entityRelations = await store
      .query()
      .from("Entity", "e")
      .whereNode("e", (entity) => entity.name.eq("Sam Altman"))
      .traverse("relatesTo", "r")
      .to("Entity", "target")
      .select((ctx) => ({
        from: ctx.e.name,
        to: ctx.target.name,
        relationship: ctx.r.relationship,
      }))
      .execute();

    console.log("## Relevant Passages\n");
    for (const chunk of contextChunks) {
      console.log(`**${chunk.source}**: ${chunk.text}\n`);
    }

    console.log("## Entity Relationships\n");
    for (const relation of entityRelations) {
      console.log(`- ${relation.from} → ${relation.to}`);
    }

    // ----------------------------------------------------------
    // Pattern 6: Entity Disambiguation via Vector Search
    // ----------------------------------------------------------

    console.log("\n--- Pattern 6: Entity Disambiguation via Vector Search ---");
    console.log("Link free-text mentions to canonical entities\n");

    // An extraction pipeline surfaces raw mention strings that rarely match an
    // entity name exactly ("Altman", "the GPT-4 model"). Embedding the mention
    // and vector-searching the Entity name embeddings links each mention to its
    // canonical node — the entity-linking half of the header's promise.
    if (vectorReady) {
      const rawMentions = ["Altman", "the GPT-4 model"];
      for (const mention of rawMentions) {
        const [best] = await store.search.vector("Entity", {
          fieldPath: "embedding",
          queryEmbedding: mockTextEmbedding(mention, EMBEDDING_DIMENSIONS),
          limit: 1,
          metric: "cosine",
        });
        console.log(
          best ?
            `  "${mention}" → ${best.node.name} (${best.node.type}, score=${best.score.toFixed(4)})`
          : `  "${mention}" → (no candidate)`,
        );
      }
    } else {
      console.log("  (skipped — no vector engine loaded on this backend)");
    }

    // ----------------------------------------------------------
    // Pattern 7: Walking the Chunk Chain
    // ----------------------------------------------------------

    console.log("\n--- Pattern 7: Walking the Chunk Chain ---");
    console.log(
      "Reconstruct a document backwards via repeated prevChunk hops\n",
    );

    // Only nextChunk edges are stored; every prevChunk hop below is resolved
    // through the inverseOf ontology. Repeating the single-hop traversal walks
    // the whole chain back to the first chunk.
    const lastChunk = document1Chunks[2]!;
    console.log(`  start: "${lastChunk.text}"`);

    let cursorId = lastChunk.id;
    for (;;) {
      const previous = await store
        .query()
        .from("Chunk", "c")
        .whereNode("c", (c) => c.id.eq(cursorId))
        .traverse("prevChunk", "e")
        .to("Chunk", "prev")
        .select((ctx) => ({ id: ctx.prev.id, text: ctx.prev.text }))
        .execute();
      const step = previous[0];
      if (step === undefined) break;
      console.log(`  ← prev: "${step.text}"`);
      cursorId = step.id;
    }

    console.log("\n=== Done ===");
  } finally {
    await backend.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
