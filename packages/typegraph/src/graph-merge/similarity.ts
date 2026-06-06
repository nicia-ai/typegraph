/**
 * Pluggable, symmetric candidate-pair similarity scoring (design §8, T6).
 *
 * Four strategy kinds, two of which are the ZERO-EMBEDDING P0 default:
 *
 *   - `custom`   — the caller's own `score(a, b)` function, clamped to `[0, 1]`.
 *   - `fulltext` — an IN-MEMORY Sørensen–Dice trigram coefficient over the
 *                  configured `fields` of the two staged nodes. No embeddings,
 *                  no DB round-trips, identical across every backend. This is
 *                  the portable scorer the FHIR demo runs on.
 *   - `vector` / `hybrid` — REAL embeddings scored IN MEMORY. An injected
 *                  {@link import("./types").Embedder} (precomputed by `merge()`
 *                  into `ctx.embeddings`, a text→vector lookup) turns each node's
 *                  configured field text into a vector; the pair is scored by
 *                  cosine. `vector` is pure cosine over one field; `hybrid` blends
 *                  cosine with the Dice trigram by `weights` (default 0.5 / 0.5).
 *                  Staged candidate rows are unindexed, so a backend ANN index
 *                  cannot score them pairwise — exact in-memory cosine is the right
 *                  tool at candidate-dedup scale AND is deterministic (the merge
 *                  contract). With NO embedder configured (`ctx.embeddings`
 *                  absent), scoring fails with a typed
 *                  {@link SimilarityUnavailableError}.
 *
 * IMPORTANT: this module never touches `store.search.fulltext`. Staged candidate
 * nodes are unindexed in the working copy, so the DB fulltext index cannot score
 * them; the in-memory Dice scorer is the only correct option for staged
 * candidate generation. `store.search.fulltext` is reserved for the T11 parity
 * probe.
 *
 * Symmetry is a load-bearing invariant: clustering treats candidate edges as
 * undirected, so `scorePair(a, b)` MUST equal `scorePair(b, a)`. The Dice
 * coefficient is symmetric by construction; the `custom` branch documents the
 * requirement and the caller is responsible for honoring it.
 */

import { SimilarityUnavailableError } from "./errors";
import type { Result } from "./result";
import { err, ok } from "./result";
import type { GraphBackend, Node, NodeType } from "./typegraph-internal";
import type { SimilarityStrategy } from "./types";

/**
 * Ambient context a scorer needs beyond the two nodes.
 *
 * - `backend` is carried for diagnostics (the dialect in error details).
 * - `embeddings` is the precomputed text→vector lookup `merge()` builds by running
 *   the injected {@link import("./types").Embedder} over every staged field text of
 *   the `vector`/`hybrid` kinds. Its PRESENCE means an embedder was configured;
 *   its ABSENCE makes a `vector`/`hybrid` strategy fail with
 *   {@link SimilarityUnavailableError}. `fulltext`/`custom` never read it.
 */
export type SimilarityContext = Readonly<{
  backend: GraphBackend;
  embeddings?: ReadonlyMap<string, Float32Array>;
}>;

/** Lower bound of the similarity codomain. */
const MIN_SCORE = 0;

/** Upper bound of the similarity codomain. */
const MAX_SCORE = 1;

/** Trigram window length for the Sørensen–Dice coefficient. */
const TRIGRAM_LENGTH = 3;

/**
 * Padding character framing a normalized string before trigram extraction, so
 * leading/trailing characters are weighted like interior ones and very short
 * strings still produce trigrams. A space is conventional and cannot appear in a
 * trigram alongside itself for non-trivial inputs.
 */
const TRIGRAM_PAD = " ";

/**
 * Clamps an arbitrary number into the `[0, 1]` similarity codomain. `NaN`
 * collapses to {@link MIN_SCORE} so a misbehaving custom scorer can never inject
 * a non-comparable score into clustering.
 */
function clampScore(value: number): number {
  if (Number.isNaN(value)) {
    return MIN_SCORE;
  }
  if (value < MIN_SCORE) {
    return MIN_SCORE;
  }
  if (value > MAX_SCORE) {
    return MAX_SCORE;
  }
  return value;
}

/**
 * Reads a single schema field off a node. `Node<N>` spreads its schema
 * properties at the top level (e.g. `node.name`, not `node.props.name`), so a
 * field is indexed directly on the node.
 */
function readField(node: Node<NodeType>, field: string): unknown {
  return (node as unknown as Record<string, unknown>)[field];
}

/**
 * Concatenates a node's configured `fields` into a single lowercase comparison
 * string. Non-string field values are coerced via `String(...)`; absent /
 * `undefined` fields contribute nothing. Fields are joined with a space so two
 * adjacent fields cannot fuse into a spurious cross-field trigram.
 *
 * Exported so `merge()`'s embedding precompute keys the text→vector lookup by the
 * EXACT same text `scorePair` looks up — there is a single source of truth for "the
 * text of a node under a strategy's fields", so the precompute and the scorer can
 * never disagree on what to embed.
 */
export function fieldText(
  node: Node<NodeType>,
  fields: readonly string[],
): string {
  const parts: string[] = [];
  for (const field of fields) {
    const value = readField(node, field);
    if (value === undefined || value === null) {
      continue;
    }
    parts.push(stringifyFieldValue(value));
  }
  return parts.join(TRIGRAM_PAD).toLowerCase();
}

function stringifyFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

/**
 * Extracts the trigram MULTISET of a normalized string as a count map. A
 * multiset (not a set) is required so repeated trigrams contribute their full
 * multiplicity to the Dice intersection, matching the standard Sørensen–Dice
 * formulation `2·|A∩B| / (|A|+|B|)` over bags.
 */
function trigramMultiset(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (text.length === 0) {
    return counts;
  }
  const padded = `${TRIGRAM_PAD}${text}${TRIGRAM_PAD}`;
  for (let index = 0; index + TRIGRAM_LENGTH <= padded.length; index += 1) {
    const gram = padded.slice(index, index + TRIGRAM_LENGTH);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Total cardinality (with multiplicity) of a trigram multiset. */
function multisetSize(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
}

/**
 * Multiset intersection cardinality: for every shared trigram, the lesser of
 * the two multiplicities.
 */
function multisetIntersectionSize(
  left: Map<string, number>,
  right: Map<string, number>,
): number {
  let shared = 0;
  for (const [gram, leftCount] of left) {
    const rightCount = right.get(gram);
    if (rightCount !== undefined) {
      shared += Math.min(leftCount, rightCount);
    }
  }
  return shared;
}

/**
 * Computes the symmetric Sørensen–Dice trigram coefficient of two raw strings:
 * lowercase, pad, extract trigram multisets, then `2·|A∩B| / (|A|+|B|)`.
 *
 * Edge cases:
 *   - Two empty strings score {@link MAX_SCORE} (vacuously identical).
 *   - One empty and one non-empty score {@link MIN_SCORE}.
 *
 * Exported so the determinism / acceptance tests can assert the metric directly.
 */
export function diceTrigramSimilarity(left: string, right: string): number {
  const leftGrams = trigramMultiset(left.toLowerCase());
  const rightGrams = trigramMultiset(right.toLowerCase());
  const leftSize = multisetSize(leftGrams);
  const rightSize = multisetSize(rightGrams);
  if (leftSize === 0 && rightSize === 0) {
    return MAX_SCORE;
  }
  if (leftSize === 0 || rightSize === 0) {
    return MIN_SCORE;
  }
  const shared = multisetIntersectionSize(leftGrams, rightGrams);
  return (2 * shared) / (leftSize + rightSize);
}

/**
 * The field(s) whose text a `vector`/`hybrid` strategy embeds, or `undefined` for
 * the zero-embedding strategies (`fulltext`/`custom`). `merge()`'s precompute uses
 * this to decide which staged texts to embed; `scorePair` uses the SAME selection
 * implicitly via {@link fieldText}, so the embedded text and the looked-up text
 * match exactly.
 */
export function embeddingFields(
  strategy: SimilarityStrategy,
): readonly string[] | undefined {
  switch (strategy.kind) {
    case "vector": {
      return [strategy.field];
    }
    case "hybrid": {
      return strategy.fields;
    }
    case "fulltext":
    case "custom": {
      return undefined;
    }
    default: {
      const exhaustive: never = strategy;
      throw new Error(
        `Unhandled similarity strategy: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Cosine similarity of two equal-length vectors, in `[-1, 1]`. Computed in a fixed
 * index order so it is deterministic. Returns {@link MIN_SCORE} for a dimension
 * mismatch or a zero-magnitude vector (no comparable direction → no evidence),
 * never `NaN`. `scorePair` clamps the result into the `[0, 1]` similarity codomain.
 *
 * Exported so the acceptance/determinism tests can assert the metric directly.
 */
export function cosineSimilarity(
  left: Float32Array,
  right: Float32Array,
): number {
  if (left.length !== right.length || left.length === 0) {
    return MIN_SCORE;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = left[index]!;
    const rightComponent = right[index]!;
    dot += leftComponent * rightComponent;
    leftMagnitude += leftComponent * leftComponent;
    rightMagnitude += rightComponent * rightComponent;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return MIN_SCORE;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * Cosine of the two field texts' precomputed vectors. A text whose vector is
 * absent from the lookup (only possible if the precompute and scorer disagreed —
 * they cannot, since both go through {@link fieldText}) scores {@link MIN_SCORE}
 * defensively rather than throwing.
 */
function cosineFromLookup(
  embeddings: ReadonlyMap<string, Float32Array>,
  leftText: string,
  rightText: string,
): number {
  const leftVector = embeddings.get(leftText);
  const rightVector = embeddings.get(rightText);
  if (leftVector === undefined || rightVector === undefined) {
    return MIN_SCORE;
  }
  return cosineSimilarity(leftVector, rightVector);
}

/** Default hybrid blend: equal weight to the vector and fulltext components. */
const DEFAULT_HYBRID_WEIGHT = 0.5;

/**
 * Normalizes a hybrid strategy's `weights` so the vector and fulltext components
 * sum to 1, defaulting either omitted side to {@link DEFAULT_HYBRID_WEIGHT}. A
 * degenerate `{0, 0}` (or negative) total falls back to an even 0.5/0.5 split so
 * the blend can never divide by zero or invert.
 */
function normalizeHybridWeights(
  weights: Readonly<{ vector?: number; fulltext?: number }> | undefined,
): Readonly<{ vector: number; fulltext: number }> {
  const vector = Math.max(0, weights?.vector ?? DEFAULT_HYBRID_WEIGHT);
  const fulltext = Math.max(0, weights?.fulltext ?? DEFAULT_HYBRID_WEIGHT);
  const total = vector + fulltext;
  if (total === 0) {
    return { vector: DEFAULT_HYBRID_WEIGHT, fulltext: DEFAULT_HYBRID_WEIGHT };
  }
  return { vector: vector / total, fulltext: fulltext / total };
}

/**
 * Builds the {@link SimilarityUnavailableError} for a `vector`/`hybrid` strategy
 * requested with no configured embedder.
 */
function embedderUnavailable(
  kind: "vector" | "hybrid",
  ctx: SimilarityContext,
): SimilarityUnavailableError {
  return new SimilarityUnavailableError(
    `Similarity strategy "${kind}" requires a configured embedder (MergeOptions.embedder); none was provided.`,
    { details: { strategy: kind, dialect: ctx.backend.dialect } },
  );
}

/**
 * Scores a candidate pair under a {@link SimilarityStrategy}, returning a value
 * in `[0, 1]` (guaranteed symmetric for the built-in strategies).
 *
 * @param a   First staged node.
 * @param b   Second staged node.
 * @param strategy The per-kind similarity strategy from the kind's
 *   `ResolveConfig`.
 * @param ctx Ambient context (the backend, for vector-capability gating).
 * @returns `ok(score)` on success, or `err(SimilarityUnavailableError)` when a
 *   `vector`/`hybrid` strategy is requested on a backend with no configured
 *   vector strategy.
 */
export function scorePair<K extends NodeType>(
  a: Node<K>,
  b: Node<K>,
  strategy: SimilarityStrategy,
  ctx: SimilarityContext,
): Result<number, SimilarityUnavailableError> {
  switch (strategy.kind) {
    case "custom": {
      // The caller owns symmetry here; we only clamp into the codomain so a
      // stray out-of-range or NaN score cannot corrupt clustering.
      const raw = strategy.score(a, b);
      return ok(clampScore(raw));
    }
    case "fulltext": {
      const leftText = fieldText(a, strategy.fields);
      const rightText = fieldText(b, strategy.fields);
      // A node with NO text in the configured fields offers no evidence of a
      // match. Comparing two such nodes must score MIN_SCORE (no candidate edge),
      // NOT the vacuous diceTrigramSimilarity("","") === 1 that would collapse two
      // distinct entities. The metric itself keeps empty==empty==1 for direct
      // callers / the acceptance tests; this guard is candidate-gen's policy.
      if (leftText.length === 0 || rightText.length === 0) {
        return ok(MIN_SCORE);
      }
      const score = diceTrigramSimilarity(leftText, rightText);
      return ok(clampScore(score));
    }
    case "vector": {
      // Presence of `ctx.embeddings` == an embedder was configured. Absent → the
      // caller asked for vector similarity without supplying MergeOptions.embedder.
      if (ctx.embeddings === undefined) {
        return err(embedderUnavailable("vector", ctx));
      }
      const leftText = fieldText(a, [strategy.field]);
      const rightText = fieldText(b, [strategy.field]);
      // A node with no text in the field offers no evidence of a match — MIN_SCORE,
      // not the cosine of two zero/absent vectors (mirrors the fulltext guard).
      if (leftText.length === 0 || rightText.length === 0) {
        return ok(MIN_SCORE);
      }
      const cosine = cosineFromLookup(ctx.embeddings, leftText, rightText);
      return ok(clampScore(cosine));
    }
    case "hybrid": {
      if (ctx.embeddings === undefined) {
        return err(embedderUnavailable("hybrid", ctx));
      }
      const leftText = fieldText(a, strategy.fields);
      const rightText = fieldText(b, strategy.fields);
      if (leftText.length === 0 || rightText.length === 0) {
        return ok(MIN_SCORE);
      }
      // Blend exact in-memory cosine (semantic/spelling proximity) with the Dice
      // trigram (literal character overlap) by the normalized weights. Both
      // components are symmetric, so the blend is too.
      const vectorScore = clampScore(
        cosineFromLookup(ctx.embeddings, leftText, rightText),
      );
      const fulltextScore = diceTrigramSimilarity(leftText, rightText);
      const weights = normalizeHybridWeights(strategy.weights);
      return ok(
        clampScore(
          weights.vector * vectorScore + weights.fulltext * fulltextScore,
        ),
      );
    }
    default: {
      // Exhaustiveness guard: a new strategy kind must add a branch above, or
      // this assignment fails to compile.
      const exhaustive: never = strategy;
      throw new Error(
        `Unhandled similarity strategy: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
