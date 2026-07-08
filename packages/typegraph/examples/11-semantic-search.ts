/**
 * Example 11: Semantic Search with Vector Embeddings
 *
 * This example demonstrates TypeGraph's vector search capabilities:
 * - Defining nodes with embedding properties
 * - Storing and retrieving embeddings
 * - Semantic similarity search with different metrics
 *
 * Vector search enables finding semantically similar content
 * using embedding vectors from models like OpenAI, CLIP, or sentence transformers.
 *
 * Vector search works across every backend via a pluggable VectorStrategy:
 * - PostgreSQL with pgvector, OR
 * - SQLite with sqlite-vec (loaded by createLocalSqliteBackend), OR
 * - libSQL / Turso's built-in vector engine
 *
 * Run with:
 *   npx tsx examples/11-semantic-search.ts
 */
import {
  createStore,
  defineGraph,
  defineNode,
  embedding,
  getEmbeddingDimensions,
  isEmbeddingSchema,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import {
  cosineSimilarity,
  createExampleBackend,
  mockTextEmbedding,
} from "./_helpers";

// ============================================================
// Schema Definition with Embeddings
// ============================================================

/**
 * Document node with a 1536-dimensional embedding.
 * This dimension matches OpenAI's text-embedding-ada-002 model.
 */
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    category: z.string(),
    embedding: embedding(1536),
  }),
});

/**
 * Image node with a 512-dimensional CLIP embedding.
 * CLIP embeddings enable cross-modal search (text-to-image).
 */
const Image = defineNode("Image", {
  schema: z.object({
    url: z.string(),
    description: z.string().optional(),
    clipEmbedding: embedding(512),
  }),
});

/**
 * Sentence node with a smaller embedding for efficient search.
 * 384 dimensions matches all-MiniLM-L6-v2 sentence transformer.
 */
const Sentence = defineNode("Sentence", {
  schema: z.object({
    text: z.string(),
    embedding: embedding(384).optional(), // Optional embedding
  }),
});

const graph = defineGraph({
  id: "semantic_search_example",
  nodes: {
    Document: { type: Document },
    Image: { type: Image },
    Sentence: { type: Sentence },
  },
  edges: {},
  ontology: [],
});

// ============================================================
// Main Example
// ============================================================

export async function main() {
  console.log("=== Semantic Search Example ===\n");

  // ============================================================
  // Part 1: Understanding the Embedding Type
  // ============================================================

  console.log("=== Part 1: Embedding Type Basics ===\n");

  // embedding(dim) creates a Zod schema for fixed-length float arrays: it
  // rejects wrong lengths and non-numeric elements at write time, and
  // isEmbeddingSchema/getEmbeddingDimensions introspect it (this is how
  // TypeGraph discovers which fields are vector-indexable).
  const documentEmbeddingSchema = embedding(1536);
  console.log(
    `  Is embedding schema: ${isEmbeddingSchema(documentEmbeddingSchema)}`,
  );
  console.log(`  Dimensions: ${getEmbeddingDimensions(documentEmbeddingSchema)}`);

  // ============================================================
  // Part 2: Storing Documents with Embeddings
  // ============================================================

  console.log("\n=== Part 2: Storing Documents with Embeddings ===\n");

  const backend = createExampleBackend();
  // Sync createStore is fine here: no searchable() fields means no fulltext
  // storage to materialize (contrast with createStoreWithSchema in example 15).
  const store = createStore(graph, backend);

  try {
    // Sample documents to index
    const documents = [
      {
        title: "Introduction to Machine Learning",
        content: "Machine learning is a subset of artificial intelligence...",
        category: "AI",
      },
      {
        title: "Deep Learning Fundamentals",
        content:
          "Neural networks with multiple layers can learn complex patterns...",
        category: "AI",
      },
      {
        title: "Natural Language Processing",
        content:
          "NLP uses neural networks to help computers understand human language...",
        category: "AI",
      },
      {
        title: "Web Development with React",
        content:
          "React is a JavaScript library for building user interfaces...",
        category: "Web",
      },
      {
        title: "Database Design Patterns",
        content:
          "Relational databases organize data into tables with relationships...",
        category: "Database",
      },
    ];

    console.log("Creating documents with embeddings...\n");

    // Kept solely for the no-vector-engine fallback in Part 3, which ranks
    // in JS from these created nodes instead of querying the backend.
    const createdDocuments = [];
    for (const document of documents) {
      // Generate embedding from title + content
      const textForEmbedding = `${document.title} ${document.content}`;
      const created = await store.nodes.Document.create({
        ...document,
        embedding: mockTextEmbedding(textForEmbedding, 1536),
      });

      createdDocuments.push(created);
      console.log(`  Created: "${document.title}" (${document.category})`);
    }

    // ============================================================
    // Part 3: Semantic Similarity Search
    // ============================================================

    console.log("\n=== Part 3: Semantic Similarity Search ===\n");

    // Query: Find documents similar to "artificial intelligence and neural networks"
    const queryText = "artificial intelligence and neural networks";
    const queryEmbedding = mockTextEmbedding(queryText, 1536);

    console.log(`Query: "${queryText}"\n`);

    // TypeGraph runs native vector search on whichever backend is configured —
    // sqlite-vec here, pgvector on PostgreSQL, or libSQL's built-in engine. The
    // example backend loads sqlite-vec, so the queries below execute for real. We
    // gate on the backend's advertised capability and fall back to an in-JS
    // ranking only when no vector engine is present, so the example always runs.
    const stars = (score: number): string =>
      "★".repeat(Math.max(0, Math.min(5, Math.round(score * 5))));

    if (backend.capabilities.vector?.supported) {
      // Store facade: ranked hits with similarity scores.
      const hits = await store.search.vector("Document", {
        fieldPath: "embedding",
        queryEmbedding,
        limit: 5,
        metric: "cosine",
      });

      console.log("Results via store.search.vector (ranked by similarity):");
      for (const hit of hits) {
        console.log(
          `  ${stars(hit.score).padEnd(5)} ${hit.score.toFixed(4)} - "${hit.node.title}"`,
        );
      }

      // A bare LIMIT pads the tail with whatever is nearest, however unrelated —
      // note the ~0.0000-score hits above. minScore turns "top k" into
      // "top k that actually match" by applying a similarity floor.
      const confidentHits = await store.search.vector("Document", {
        fieldPath: "embedding",
        queryEmbedding,
        limit: 5,
        metric: "cosine",
        minScore: 0.1,
      });

      console.log("\nSame query with minScore: 0.1 (padding hits drop out):");
      for (const hit of confidentHits) {
        console.log(
          `  ${stars(hit.score).padEnd(5)} ${hit.score.toFixed(4)} - "${hit.node.title}"`,
        );
      }

      // Query builder: compose .similarTo() with a metadata predicate in one SQL
      // statement (here, restrict the nearest neighbors to the "AI" category).
      const aiOnly = await store
        .query()
        .from("Document", "d")
        .whereNode("d", (d) =>
          d.embedding
            .similarTo(queryEmbedding, 5, { metric: "cosine" })
            .and(d.category.eq("AI")),
        )
        .select((ctx) => ({ title: ctx.d.title, category: ctx.d.category }))
        .execute();

      console.log(
        '\nFiltered to category = "AI" via .similarTo() + predicate:',
      );
      for (const row of aiOnly) {
        console.log(`  - "${row.title}" (${row.category})`);
      }
    } else {
      // No vector engine loaded — rank in JS so the example still runs.
      console.log("No vector engine loaded; ranking in JS (cosine):\n");
      const similarities = createdDocuments
        .map((document) => ({
          title: document.title,
          similarity: cosineSimilarity(queryEmbedding, document.embedding),
        }))
        .toSorted((a, b) => b.similarity - a.similarity);
      for (const result of similarities) {
        console.log(
          `  ${stars(result.similarity).padEnd(5)} ${result.similarity.toFixed(4)} - "${result.title}"`,
        );
      }
    }

    // ============================================================
    // Part 4: Multi-Modal Search with CLIP Embeddings
    // ============================================================

    console.log("\n=== Part 4: Multi-Modal Search (CLIP) ===\n");

    // Create images with CLIP embeddings
    const images = [
      {
        url: "/images/cat.jpg",
        description: "A fluffy orange cat, a beloved house pet",
      },
      {
        url: "/images/dog.jpg",
        description: "A loyal golden retriever, a friendly pet dog",
      },
      {
        url: "/images/landscape.jpg",
        description: "A mountain landscape at sunset",
      },
    ];

    console.log("Creating images with CLIP embeddings...\n");

    for (const img of images) {
      const clipEmbedding = mockTextEmbedding(img.description, 512);
      await store.nodes.Image.create({
        ...img,
        clipEmbedding,
      });
      console.log(`  Created: ${img.url} - "${img.description}"`);
    }

    // CLIP maps text and images into the same vector space, so a text query
    // embedding searches the image embeddings directly (cross-modal retrieval).
    const imageQueryText = "a fluffy pet";
    const imageQuery = mockTextEmbedding(imageQueryText, 512);

    if (backend.capabilities.vector?.supported) {
      const imageHits = await store.search.vector("Image", {
        fieldPath: "clipEmbedding",
        queryEmbedding: imageQuery,
        limit: 3,
        metric: "cosine",
      });
      console.log(`\nText-to-image search for "${imageQueryText}":`);
      for (const hit of imageHits) {
        console.log(
          `  ${hit.score.toFixed(4)} - ${hit.node.url} ("${hit.node.description ?? ""}")`,
        );
      }
    } else {
      console.log(
        "\nCLIP enables searching images with text queries (no vector engine loaded here).",
      );
    }

    // ============================================================
    // Part 5: Optional Embeddings
    // ============================================================

    console.log("\n=== Part 5: Optional Embeddings ===\n");

    // Sentences can optionally have embeddings
    const sentence1 = await store.nodes.Sentence.create({
      text: "This sentence has an embedding.",
      embedding: mockTextEmbedding("This sentence has an embedding.", 384),
    });

    const sentence2 = await store.nodes.Sentence.create({
      text: "This sentence has no embedding yet.",
      // embedding is optional, so we can omit it
    });

    console.log(`Sentence 1: "${sentence1.text}"`);
    console.log(`  Has embedding: ${sentence1.embedding !== undefined}`);
    console.log(`Sentence 2: "${sentence2.text}"`);
    console.log(`  Has embedding: ${sentence2.embedding !== undefined}`);

    // Later, we can update to add an embedding
    const updated = await store.nodes.Sentence.update(sentence2.id, {
      embedding: mockTextEmbedding(sentence2.text, 384),
    });

    console.log(`\nAfter update:`);
    console.log(
      `Sentence 2 now has embedding: ${updated.embedding !== undefined}`,
    );

    // Note on dimensions: pick the dimension of your embedding model (e.g. 384
    // for all-MiniLM-L6-v2, 512 for CLIP ViT-B/32, 1536 for OpenAI ada-002,
    // 3072 for text-embedding-3-large). TypeGraph validates that every stored
    // embedding matches its schema dimension, as the three node kinds above show.

    // ============================================================
    // Summary
    // ============================================================

    console.log("\n=== Summary ===\n");

    console.log("Key features demonstrated:");
    console.log("  1. embedding(dim) creates a typed schema for vector arrays");
    console.log("  2. Embeddings are validated for correct dimension");
    console.log("  3. Different nodes can use different embedding dimensions");
    console.log("  4. Embeddings can be optional with .optional()");
    console.log("  5. Similarity search ranks results by vector distance");

    console.log(
      "\nNative vector search (pgvector, sqlite-vec, or libSQL built-in):",
    );
    console.log(
      "  - Use .similarTo() (query builder) or store.search.vector() (facade)",
    );
    console.log("  - Automatic ORDER BY similarity with configurable LIMIT");
    console.log(
      "  - HNSW/IVFFlat indexes enable sub-millisecond search at scale",
    );
    console.log(
      "  - Supports cosine, L2 (Euclidean), and inner product metrics",
    );
    console.log("  - minScore option filters results by similarity threshold");

    console.log("\n=== Example Complete ===");
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
