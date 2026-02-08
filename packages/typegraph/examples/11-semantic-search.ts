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
 * Prerequisites (for database backends):
 * - PostgreSQL with pgvector extension, OR
 * - SQLite with sqlite-vec extension
 *
 * Run with:
 *   npx tsx examples/11-semantic-search.ts
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  embedding,
  getEmbeddingDimensions,
  isEmbeddingSchema,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

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
// Mock Embedding Functions
// ============================================================

/**
 * Generates a deterministic mock embedding based on text content.
 * In production, you would call an actual embedding API.
 */
function mockTextEmbedding(text: string, dimensions: number): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < dimensions; i++) {
    // Generate deterministic values based on text hash
    const charSum = text.split("").reduce((sum, char, idx) => {
      return sum + char.charCodeAt(0) * (idx + 1) * (i + 1);
    }, 0);
    embedding.push(Math.sin(charSum + i) * 0.5 + 0.5);
  }
  // Normalize to unit vector
  const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map((v) => v / magnitude);
}

/**
 * Computes cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) ** 2;
    magB += (b[i] ?? 0) ** 2;
  }
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ============================================================
// Main Example
// ============================================================

export async function main() {
  console.log("=== Semantic Search Example ===\n");

  // ============================================================
  // Part 1: Understanding the Embedding Type
  // ============================================================

  console.log("=== Part 1: Embedding Type Basics ===\n");

  // The embedding() function creates a Zod schema for vector arrays
  const docEmbeddingSchema = embedding(1536);

  console.log("Embedding schema created:");
  console.log(`  Is embedding schema: ${isEmbeddingSchema(docEmbeddingSchema)}`);
  console.log(`  Dimensions: ${getEmbeddingDimensions(docEmbeddingSchema)}`);

  // Validation examples
  const validEmbedding = Array(1536).fill(0.1);
  const invalidLength = Array(100).fill(0.1);
  const invalidType = ["not", "numbers"];

  console.log("\nValidation:");
  console.log(`  Valid embedding (1536 floats): ${docEmbeddingSchema.safeParse(validEmbedding).success}`);
  console.log(`  Invalid length (100 floats): ${docEmbeddingSchema.safeParse(invalidLength).success}`);
  console.log(`  Invalid type (strings): ${docEmbeddingSchema.safeParse(invalidType).success}`);

  // ============================================================
  // Part 2: Storing Documents with Embeddings
  // ============================================================

  console.log("\n=== Part 2: Storing Documents with Embeddings ===\n");

  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  // Sample documents to index
  const documents = [
    {
      title: "Introduction to Machine Learning",
      content: "Machine learning is a subset of artificial intelligence...",
      category: "AI",
    },
    {
      title: "Deep Learning Fundamentals",
      content: "Neural networks with multiple layers can learn complex patterns...",
      category: "AI",
    },
    {
      title: "Natural Language Processing",
      content: "NLP enables computers to understand human language...",
      category: "AI",
    },
    {
      title: "Web Development with React",
      content: "React is a JavaScript library for building user interfaces...",
      category: "Web",
    },
    {
      title: "Database Design Patterns",
      content: "Relational databases organize data into tables with relationships...",
      category: "Database",
    },
  ];

  console.log("Creating documents with embeddings...\n");

  const createdDocs = [];
  for (const doc of documents) {
    // Generate embedding from title + content
    const textForEmbedding = `${doc.title} ${doc.content}`;
    const docEmbedding = mockTextEmbedding(textForEmbedding, 1536);

    const created = await store.nodes.Document.create({
      ...doc,
      embedding: docEmbedding,
    });

    createdDocs.push({ ...created, embedding: docEmbedding });
    console.log(`  Created: "${doc.title}" (${doc.category})`);
  }

  // ============================================================
  // Part 3: Semantic Similarity Search
  // ============================================================

  console.log("\n=== Part 3: Semantic Similarity Search ===\n");

  // Query: Find documents similar to "artificial intelligence and neural networks"
  const queryText = "artificial intelligence and neural networks";
  const queryEmbedding = mockTextEmbedding(queryText, 1536);

  console.log(`Query: "${queryText}"\n`);

  // --- Native Query Builder API ---
  //
  // TypeGraph provides the .similarTo() predicate for native vector similarity
  // search. This API is fully supported and compiles to optimized SQL using:
  // - pgvector for PostgreSQL
  // - sqlite-vec for SQLite
  //
  // Example usage (requires vector extension to be loaded):
  //
  //   const similar = await store
  //     .query()
  //     .from("Document", "d")
  //     .whereNode("d", (d) =>
  //       d.embedding.similarTo(queryEmbedding, 5, {
  //         metric: "cosine",   // or "l2", "inner_product"
  //         minScore: 0.7,      // optional: filter by similarity threshold
  //       })
  //     )
  //     .select((ctx) => ({
  //       title: ctx.d.title,
  //       content: ctx.d.content,
  //     }))
  //     .execute();
  //
  // The .similarTo() predicate:
  // - Returns results ordered by similarity (most similar first)
  // - First parameter: query embedding vector
  // - Second parameter: k (maximum results)
  // - Third parameter: options (metric, minScore)
  //
  // Supported metrics:
  // - "cosine" (default): Cosine similarity, range 0-1 where 1 is identical
  // - "l2": Euclidean distance, lower is more similar
  // - "inner_product": Inner product, higher is more similar
  //
  // --- Demo Mode (Manual Similarity) ---
  //
  // This example uses an in-memory SQLite backend without sqlite-vec loaded,
  // so we demonstrate the concept by computing similarity manually:

  console.log("Computing similarities (demo without vector extension)...\n");

  // Compute similarity scores
  const similarities = createdDocs.map((doc) => ({
    title: doc.title,
    category: doc.category,
    similarity: cosineSimilarity(queryEmbedding, doc.embedding),
  }));

  // Sort by similarity (highest first)
  similarities.sort((a, b) => b.similarity - a.similarity);

  console.log("Results (ranked by cosine similarity):");
  for (const result of similarities) {
    const stars = "★".repeat(Math.round(result.similarity * 5));
    console.log(`  ${stars.padEnd(5)} ${result.similarity.toFixed(4)} - "${result.title}"`);
  }

  // ============================================================
  // Part 4: Multi-Modal Search with CLIP Embeddings
  // ============================================================

  console.log("\n=== Part 4: Multi-Modal Search (CLIP) ===\n");

  // Create images with CLIP embeddings
  const images = [
    { url: "/images/cat.jpg", description: "A fluffy orange cat" },
    { url: "/images/dog.jpg", description: "A golden retriever" },
    { url: "/images/landscape.jpg", description: "Mountain sunset" },
  ];

  console.log("Creating images with CLIP embeddings...\n");

  for (const img of images) {
    const clipEmbedding = mockTextEmbedding(img.description ?? img.url, 512);
    await store.nodes.Image.create({
      ...img,
      clipEmbedding,
    });
    console.log(`  Created: ${img.url} - "${img.description}"`);
  }

  console.log("\nCLIP enables searching images with text queries!");
  console.log("Example: 'cute pet' would match both cat and dog images.");

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
  console.log(`Sentence 2 now has embedding: ${updated.embedding !== undefined}`);

  // ============================================================
  // Part 6: Different Embedding Dimensions
  // ============================================================

  console.log("\n=== Part 6: Embedding Dimension Summary ===\n");

  console.log("Common embedding dimensions:");
  console.log("  - 384:  all-MiniLM-L6-v2 (fast, lightweight)");
  console.log("  - 512:  CLIP ViT-B/32 (multi-modal)");
  console.log("  - 768:  BERT base, Sentence-BERT");
  console.log("  - 1024: CLIP ViT-L/14");
  console.log("  - 1536: OpenAI text-embedding-ada-002");
  console.log("  - 3072: OpenAI text-embedding-3-large");

  console.log("\nChoose dimensions based on your embedding model.");
  console.log("TypeGraph validates that stored embeddings match the schema dimension.");

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

  console.log("\nNative vector search (PostgreSQL with pgvector, SQLite with sqlite-vec):");
  console.log("  - Use .similarTo() predicate for hardware-accelerated search");
  console.log("  - Automatic ORDER BY similarity with configurable LIMIT");
  console.log("  - HNSW/IVFFlat indexes enable sub-millisecond search at scale");
  console.log("  - Supports cosine, L2 (Euclidean), and inner product metrics");
  console.log("  - minScore option filters results by similarity threshold");

  console.log("\n=== Example Complete ===");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
