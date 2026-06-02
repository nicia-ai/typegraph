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
 * Deterministic mock embedding via the bag-of-words "hashing trick": each
 * content word is hashed to one dimension and accumulated, then the vector is
 * unit-normalized. Texts that share vocabulary land on overlapping dimensions
 * and score high; texts with disjoint vocabulary are near-orthogonal and score
 * near zero — so cosine similarity tracks shared content the way a real model
 * does, only far more crudely (no synonyms or paraphrase). In production you
 * would call an actual embedding API.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "into", "from", "are", "was",
  "can", "its", "but", "not", "all", "any", "has", "have", "will",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/** Deterministic FNV-1a hash, so a given word always maps to the same dimension. */
function hashWord(word: string): number {
  let hash = 2166136261;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mockTextEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const dimension = hashWord(token) % dimensions;
    vector[dimension] = (vector[dimension] ?? 0) + 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  // Stopword-only / empty text has no signal — return a fixed unit vector so the
  // result is still a valid (non-zero) embedding.
  if (magnitude === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / magnitude);
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
      content: "NLP uses neural networks to help computers understand human language...",
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
      console.log(`  ${stars(hit.score).padEnd(5)} ${hit.score.toFixed(4)} - "${hit.node.title}"`);
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

    console.log('\nFiltered to category = "AI" via .similarTo() + predicate:');
    for (const row of aiOnly) {
      console.log(`  - "${row.title}" (${row.category})`);
    }
  } else {
    // No vector engine loaded — rank in JS so the example still runs.
    console.log("No vector engine loaded; ranking in JS (cosine):\n");
    const similarities = createdDocs
      .map((doc) => ({
        title: doc.title,
        similarity: cosineSimilarity(queryEmbedding, doc.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity);
    for (const result of similarities) {
      console.log(`  ${stars(result.similarity).padEnd(5)} ${result.similarity.toFixed(4)} - "${result.title}"`);
    }
  }

  // ============================================================
  // Part 4: Multi-Modal Search with CLIP Embeddings
  // ============================================================

  console.log("\n=== Part 4: Multi-Modal Search (CLIP) ===\n");

  // Create images with CLIP embeddings
  const images = [
    { url: "/images/cat.jpg", description: "A fluffy orange cat, a beloved house pet" },
    { url: "/images/dog.jpg", description: "A loyal golden retriever, a friendly pet dog" },
    { url: "/images/landscape.jpg", description: "A mountain landscape at sunset" },
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
      console.log(`  ${hit.score.toFixed(4)} - ${hit.node.url} ("${hit.node.description ?? ""}")`);
    }
  } else {
    console.log("\nCLIP enables searching images with text queries (no vector engine loaded here).");
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

  console.log("\nNative vector search (pgvector, sqlite-vec, or libSQL built-in):");
  console.log("  - Use .similarTo() (query builder) or store.search.vector() (facade)");
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
