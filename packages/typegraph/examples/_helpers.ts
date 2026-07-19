/**
 * Shared helpers for examples
 *
 * - `createExampleBackend()` — an in-memory SQLite backend with full query
 *   support (FTS5 fulltext plus sqlite-vec vector search).
 * - `mockTextEmbedding()` / `cosineSimilarity()` — a deterministic,
 *   dependency-free stand-in for a real embedding model, used by the
 *   vector-search examples.
 * - `requireRecordedNow()` — asserts a store has recorded history and returns
 *   its current recorded timestamp, for the time-travel examples.
 */
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";

/**
 * Creates an in-memory SQLite backend for examples.
 * This supports the full query API, unlike the memory adapter.
 */
export function createExampleBackend(): LocalSqliteBackendResult["backend"] {
  const { backend } = createLocalSqliteBackend();
  return backend;
}

// ============================================================
// Mock embeddings
// ============================================================

/**
 * Deterministic mock embedding via the bag-of-words "hashing trick": each
 * content word is hashed to one dimension and accumulated, then the vector is
 * unit-normalized. Texts that share vocabulary land on overlapping dimensions
 * and score high; texts with disjoint vocabulary are near-orthogonal and score
 * near zero — so cosine similarity tracks vocabulary overlap the way a real
 * model does, only far more crudely (no synonyms or paraphrase). In production
 * you would call an actual embedding model (OpenAI, Sentence Transformers, ...).
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "into",
  "from",
  "are",
  "was",
  "can",
  "its",
  "but",
  "not",
  "all",
  "any",
  "has",
  "have",
  "will",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/** Deterministic FNV-1a hash, so a given word always maps to the same dimension. */
function hashWord(word: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < word.length; index += 1) {
    hash ^= word.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function mockTextEmbedding(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of tokenize(text)) {
    const dimension = hashWord(token) % dimensions;
    vector[dimension] = (vector[dimension] ?? 0) + 1;
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  // Stopword-only / empty text has no signal — return a fixed unit vector so the
  // result is still a valid (non-zero) embedding.
  if (magnitude === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / magnitude);
}

/** Computes cosine similarity between two vectors. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (const [index, element] of a.entries()) {
    dotProduct += element * (b[index] ?? 0);
    magnitudeA += element ** 2;
    magnitudeB += (b[index] ?? 0) ** 2;
  }
  return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

// ============================================================
// Recorded history
// ============================================================

type RecordedClock<Instant extends string> = Readonly<{
  recordedNow: () => Promise<Instant | undefined>;
}>;

export async function requireRecordedNow<Instant extends string>(
  store: RecordedClock<Instant>,
  message = "expected recorded history — create the store with { history: true } and commit at least one write first",
): Promise<Instant> {
  const recordedNow = await store.recordedNow();
  if (recordedNow === undefined) throw new Error(message);
  return recordedNow;
}
