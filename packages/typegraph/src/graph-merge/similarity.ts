import { requireDefined } from "../utils/presence";
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
import { canonicalValueKey } from "./canonical-props";
import { SimilarityUnavailableError } from "./errors";
import type { MergeKey } from "./node-key";
import type { Result } from "./result";
import { err, ok } from "./result";
import type {
  GraphBackend,
  JsonValue,
  Node,
  NodeType,
} from "./typegraph-internal";
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

/**
 * Sub-threshold sentinel returned by {@link scorePrepared} for a pair with NO
 * comparable text (one side has no value in the scoring field). It is BELOW
 * {@link MIN_SCORE}, and the kind's `threshold` is validated to `[0, 1]`, so a
 * textless pair can never clear ANY threshold — including `threshold: 0`, where
 * a `MIN_SCORE` (0) return would otherwise pass `score >= threshold` and merge two
 * distinct entities that share no evidence. The standalone {@link scorePair}
 * surfaces this as `MIN_SCORE` to keep its `[0, 1]` contract; only candidate-gen
 * (via {@link createPairScorer} + the threshold gate) treats it as "never a match".
 */
const NO_EVIDENCE_SCORE = -1;

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
  // Objects/arrays: canonical (recursively key-sorted) JSON so two
  // logically-equal values written with different key order yield the same
  // comparison text — matching canonicalValueKey used everywhere else.
  return canonicalValueKey(value as JsonValue);
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
/**
 * Sørensen–Dice coefficient over two PRECOMPUTED trigram multisets — the metric
 * core, with the same empty-input rules as {@link diceTrigramSimilarity}. The
 * candidate scorer prepares each node's multiset ONCE and calls this directly, so
 * a node's trigrams are built once rather than rebuilt for every pair it joins.
 */
function diceFromMultisets(
  left: Map<string, number>,
  right: Map<string, number>,
): number {
  const leftSize = multisetSize(left);
  const rightSize = multisetSize(right);
  if (leftSize === 0 && rightSize === 0) {
    return MAX_SCORE;
  }
  if (leftSize === 0 || rightSize === 0) {
    return MIN_SCORE;
  }
  const shared = multisetIntersectionSize(left, right);
  return (2 * shared) / (leftSize + rightSize);
}

export function diceTrigramSimilarity(left: string, right: string): number {
  return diceFromMultisets(
    trigramMultiset(left.toLowerCase()),
    trigramMultiset(right.toLowerCase()),
  );
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
 */
function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) {
    return MIN_SCORE;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftComponent = requireDefined(left[index]);
    const rightComponent = requireDefined(right[index]);
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
 * Coerces a raw weight into the non-negative finite domain. A non-finite value
 * (`NaN`/`±Infinity`) contributes `0` rather than poisoning the whole blend —
 * `Math.max(0, NaN)` is `NaN`, which would survive the `total === 0` guard and
 * collapse every hybrid score to 0. Valid weights are rejected earlier at the
 * options boundary (`normalizeMergeOptions`); this is the defensive backstop.
 */
function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Normalizes a hybrid strategy's `weights` so the vector and fulltext components
 * sum to 1, defaulting either omitted side to {@link DEFAULT_HYBRID_WEIGHT}. A
 * degenerate `{0, 0}` (or negative / non-finite) total falls back to an even
 * 0.5/0.5 split so the blend can never divide by zero, invert, or produce `NaN`.
 */
function normalizeHybridWeights(
  weights: Readonly<{ vector?: number; fulltext?: number }> | undefined,
): Readonly<{ vector: number; fulltext: number }> {
  const vector = nonNegativeFinite(weights?.vector ?? DEFAULT_HYBRID_WEIGHT);
  const fulltext = nonNegativeFinite(
    weights?.fulltext ?? DEFAULT_HYBRID_WEIGHT,
  );
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
 * The field(s) a strategy reads off a node to form its comparison text: the
 * embedded field(s) for `vector`/`hybrid`, the configured `fields` for `fulltext`,
 * and none for `custom` (which scores the node objects directly).
 */
function scoringFields(strategy: SimilarityStrategy): readonly string[] {
  switch (strategy.kind) {
    case "fulltext":
    case "hybrid": {
      return strategy.fields;
    }
    case "vector": {
      return [strategy.field];
    }
    case "custom": {
      return [];
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
 * A node's per-strategy comparison inputs, computed ONCE and reused across every
 * pair the node joins: its lowercase {@link fieldText} (looked up in the embedding
 * map for `vector`/`hybrid`) and, for the trigram strategies, its trigram multiset.
 * The original `node` is retained for the `custom` strategy, which scores nodes
 * directly. {@link createPairScorer} memoizes one of these per node.
 */
type PreparedNode<K extends NodeType = NodeType> = Readonly<{
  node: Node<K>;
  text: string;
  grams: Map<string, number>;
}>;

/** Empty trigram multiset shared by strategies that never consult grams. */
const NO_GRAMS: Map<string, number> = new Map<string, number>();

/** Computes a node's {@link PreparedNode} for a strategy (trigrams only when used). */
function prepareNode<K extends NodeType>(
  node: Node<K>,
  strategy: SimilarityStrategy,
): PreparedNode<K> {
  const text = fieldText(node, scoringFields(strategy));
  const grams =
    strategy.kind === "fulltext" || strategy.kind === "hybrid" ?
      trigramMultiset(text)
    : NO_GRAMS;
  return { node, text, grams };
}

/**
 * Scores a candidate pair from its two {@link PreparedNode}s under a
 * {@link SimilarityStrategy}, returning a value in `[0, 1]` (guaranteed symmetric
 * for the built-in strategies). This is the single match-decision switch;
 * {@link scorePair} and {@link createPairScorer} both feed it prepared nodes.
 *
 * @returns `ok(score)` on success, or `err(SimilarityUnavailableError)` when a
 *   `vector`/`hybrid` strategy is requested with no configured embedder.
 */
function scorePrepared<K extends NodeType>(
  left: PreparedNode<K>,
  right: PreparedNode<K>,
  strategy: SimilarityStrategy,
  ctx: SimilarityContext,
): Result<number, SimilarityUnavailableError> {
  switch (strategy.kind) {
    case "custom": {
      // The caller owns symmetry here; we only clamp into the codomain so a
      // stray out-of-range or NaN score cannot corrupt clustering.
      const raw = strategy.score(left.node, right.node);
      return ok(clampScore(raw));
    }
    case "fulltext": {
      // A node with NO text in the configured fields offers no evidence of a
      // match. Comparing two such nodes must NOT collapse two distinct entities,
      // NOT even at threshold 0 — so it returns the sub-threshold
      // {@link NO_EVIDENCE_SCORE}, never the vacuous diceTrigramSimilarity("","")
      // === 1. The metric itself keeps empty==empty==1 for direct callers / the
      // acceptance tests; this guard is candidate-gen's policy.
      if (left.text.length === 0 || right.text.length === 0) {
        return ok(NO_EVIDENCE_SCORE);
      }
      return ok(clampScore(diceFromMultisets(left.grams, right.grams)));
    }
    case "vector": {
      // Presence of `ctx.embeddings` == an embedder was configured. Absent → the
      // caller asked for vector similarity without supplying MergeOptions.embedder.
      if (ctx.embeddings === undefined) {
        return err(embedderUnavailable("vector", ctx));
      }
      // A node with no text in the field offers no evidence of a match —
      // NO_EVIDENCE_SCORE, not the cosine of two zero/absent vectors (mirrors the
      // fulltext guard, and excludes the pair even at threshold 0).
      if (left.text.length === 0 || right.text.length === 0) {
        return ok(NO_EVIDENCE_SCORE);
      }
      const cosine = cosineFromLookup(ctx.embeddings, left.text, right.text);
      return ok(clampScore(cosine));
    }
    case "hybrid": {
      if (ctx.embeddings === undefined) {
        return err(embedderUnavailable("hybrid", ctx));
      }
      if (left.text.length === 0 || right.text.length === 0) {
        return ok(NO_EVIDENCE_SCORE);
      }
      // Blend exact in-memory cosine (semantic/spelling proximity) with the Dice
      // trigram (literal character overlap) by the normalized weights. Both
      // components are symmetric, so the blend is too.
      const vectorScore = clampScore(
        cosineFromLookup(ctx.embeddings, left.text, right.text),
      );
      const fulltextScore = diceFromMultisets(left.grams, right.grams);
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

/**
 * Scores a candidate pair under a {@link SimilarityStrategy}, returning a value
 * in `[0, 1]` (guaranteed symmetric for the built-in strategies). A single-pair
 * convenience over {@link scorePrepared}; the candidate loop uses
 * {@link createPairScorer} instead so per-node work is not repeated across pairs.
 *
 * @param a   First staged node.
 * @param b   Second staged node.
 * @param strategy The per-kind similarity strategy from the kind's `ResolveConfig`.
 * @param ctx Ambient context (the backend, for vector-capability gating).
 * @returns `ok(score)` on success, or `err(SimilarityUnavailableError)` when a
 *   `vector`/`hybrid` strategy is requested with no configured embedder.
 */
export function scorePair<K extends NodeType>(
  a: Node<K>,
  b: Node<K>,
  strategy: SimilarityStrategy,
  ctx: SimilarityContext,
): Result<number, SimilarityUnavailableError> {
  const result = scorePrepared(
    prepareNode(a, strategy),
    prepareNode(b, strategy),
    strategy,
    ctx,
  );
  // The standalone scorer's contract is a [0, 1] score; the internal
  // NO_EVIDENCE_SCORE sentinel (a textless pair) surfaces here as MIN_SCORE. Only
  // candidate-gen needs the sub-threshold value to exclude the pair at threshold 0.
  if (result.success && result.data === NO_EVIDENCE_SCORE) {
    return ok(MIN_SCORE);
  }
  return result;
}

/**
 * Builds a memoized pair scorer for one kind. Each node's {@link PreparedNode} is
 * computed once, keyed by its `(kind, id)` {@link MergeKey}, so a node appearing in
 * m candidate pairs has its text + trigram multiset built once, not m times — the
 * per-bucket cost drops from O(pairs · text) trigram builds to O(nodes · text).
 * Pair-for-pair equivalent to {@link scorePair}.
 */
export function createPairScorer<K extends NodeType>(
  strategy: SimilarityStrategy,
  ctx: SimilarityContext,
): (
  a: MergeKey,
  left: Node<K>,
  b: MergeKey,
  right: Node<K>,
) => Result<number, SimilarityUnavailableError> {
  const prepared = new Map<MergeKey, PreparedNode<K>>();
  const prepare = (key: MergeKey, node: Node<K>): PreparedNode<K> => {
    const cached = prepared.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const fresh = prepareNode(node, strategy);
    prepared.set(key, fresh);
    return fresh;
  };
  return (a, left, b, right) =>
    scorePrepared(prepare(a, left), prepare(b, right), strategy, ctx);
}
