/**
 * The shared SCORING stage (design §4, the single match-decision point).
 *
 * Candidate generation is three layers — sources → scoring → reconciler (§4).
 * This module is the MIDDLE layer: it turns the candidate PROPOSALS every source
 * emits into the {@link CandidateEdge} set the reconciler consumes, applying the
 * EXACT same scorer + threshold regardless of which source proposed a pair. A
 * source proposes (recall); scoring disposes (the match decision).
 *
 * Two proposal kinds enter:
 *
 *   - {@link CandidatePair}s — unscored `(a, b)` node pairs from any source. They
 *     are deduped by canonical `(a, b)` and each scored EXACTLY ONCE by
 *     {@link scorePair}; only pairs clearing the kind's threshold become edges.
 *   - FORCED {@link CandidateEdge}s — DEFINITIONAL matches (a shared unique value)
 *     that BYPASS scoring entirely, emitted at {@link FORCED_MATCH_SCORE}. A forced
 *     pair is never also fuzzy-scored: forced `(a, b)` keys are reserved first, so
 *     a fuzzy pair proposing the same endpoints is dropped before scoring.
 *
 * This was previously fused into `candidate-gen.ts`'s `generateCandidates` (which
 * scored AND thresholded inline); naming scoring as its own stage is what makes
 * "the scorer — not a source — decides matches" concrete (§4). `generateCandidates`
 * now composes the bucket sources over this stage.
 *
 * Determinism: the emitted edge set is a pure function of the proposal SETS — pairs
 * are deduped by canonical `(a, b)`, scored by the symmetric {@link scorePair}, and
 * the final list is sorted by `(a, b)`, so neither the order proposals arrive in
 * nor the directionality of a pair affects the result.
 *
 * The {@link ComparisonCeilingPolicy} bounds only the FUZZY scoring work (the
 * embedder step for vector/hybrid); FORCED edges are definitional, not
 * similarity-based, so they are emitted regardless of the ceiling:
 *
 *   - `"error"`         — exceeding the ceiling fails with a typed {@link MergeError}.
 *   - `"mergeByIdOnly"` — fuzzy similarity is SKIPPED for the kind (no
 *                         threshold-scored edges), FORCED edges are still emitted,
 *                         and a {@link CandidateWarning} is recorded.
 */

import { MergeError } from "./errors";
import { compareMergeKeys, type MergeKey } from "./node-key";
import type { Result } from "./result";
import { err, isErr, ok } from "./result";
import type { SimilarityContext } from "./similarity";
import { createPairScorer } from "./similarity";
import type { Node, NodeType } from "./typegraph-internal";
import type { ComparisonCeilingPolicy, ResolveConfig } from "./types";

/**
 * An undirected candidate-merge edge between two nodes that should merge.
 * Endpoints are stored in ascending id order (`a < b`) so the edge has a single
 * canonical representation. Fuzzy edges carry their similarity score; FORCED
 * (definitional) edges carry {@link FORCED_MATCH_SCORE}.
 */
export type CandidateEdge = Readonly<{
  a: MergeKey;
  b: MergeKey;
  score: number;
}>;

/**
 * A non-fatal advisory raised during scoring — currently only the
 * `"mergeByIdOnly"` comparison-ceiling skip. Surfaced in the merge report.
 */
type CandidateWarning = Readonly<{
  kind: "comparisonCeiling";
  comparisons: number;
  limit: number;
  message: string;
}>;

/**
 * The scoring result for one kind: the emitted edges plus any advisories.
 * Returned inside a {@link Result} so the `vector`/`hybrid` guard and the
 * `"error"` ceiling path can fail without throwing.
 */
export type CandidateGenResult = Readonly<{
  edges: readonly CandidateEdge[];
  warnings: readonly CandidateWarning[];
}>;

/**
 * An unscored candidate pair a source proposes for scoring: the canonical
 * endpoint ids `(a, b)` (`a < b`) plus the two node objects the scorer reads
 * fields off of. `left`/`right` carry the nodes whose ids are `a`/`b`
 * respectively, but {@link scorePair} is symmetric so their roles are
 * interchangeable for scoring.
 */
export type CandidatePair<K extends NodeType = NodeType> = Readonly<{
  a: MergeKey;
  b: MergeKey;
  left: Node<K>;
  right: Node<K>;
}>;

/**
 * The proposals the scoring stage consumes for one kind: the fuzzy pairs to score
 * and the forced (definitional) edges to pass through unscored.
 */
export type ScoringInput<K extends NodeType = NodeType> = Readonly<{
  pairs: readonly CandidatePair<K>[];
  forcedEdges: readonly CandidateEdge[];
}>;

/**
 * Score for a FORCED (definitional, unique-match) edge — the maximum, so the pair
 * always clears any threshold and is never the weakest edge a diameter guard would
 * drop. Sources that emit forced edges stamp this score; scoring passes it through.
 */
export const FORCED_MATCH_SCORE = 1;

/**
 * Stable `(a, b)` ascending comparator over {@link CandidateEdge}. Endpoints are
 * `(kind, id)` MergeKeys, so ordering uses the SAME id-first {@link compareMergeKeys}
 * the clustering stage uses — never raw kind-first string order. The SINGLE shared
 * definition: clustering and `merge()`'s candidate generation import this instead of
 * re-deriving it, so every stage orders the edge set identically by construction.
 */
export function compareCandidateEdges(
  left: CandidateEdge,
  right: CandidateEdge,
): number {
  const byA = compareMergeKeys(left.a, right.a);
  return byA === 0 ? compareMergeKeys(left.b, right.b) : byA;
}

/** The canonical dedup key for a pair / edge's ordered endpoints. */
function endpointKey(a: MergeKey, b: MergeKey): string {
  return JSON.stringify([a, b]);
}

/**
 * Scores the proposed candidates for a single kind into a {@link CandidateEdge}
 * set, applying the kind's threshold and the comparison-ceiling policy.
 *
 * FORCED endpoint keys are reserved FIRST, so a fuzzy pair proposing the same
 * `(a, b)` is dropped before scoring — a forced (definitional) match is never also
 * fuzzy-scored. The remaining fuzzy pairs are deduped by canonical `(a, b)` and
 * scored exactly once; only those clearing `threshold` become edges. The combined
 * forced + passing-fuzzy edge list is sorted by `(a, b)`.
 *
 * @param input The fuzzy pairs + forced edges every source proposed for the kind.
 * @param resolveConfig The kind's resolution config (similarity strategy + threshold).
 * @param ctx Ambient context (the backend, for vector-capability gating).
 * @param ceilingPolicy Behavior when `maxComparisonsPerKind` is exceeded.
 * @param maxComparisonsPerKind Optional per-kind FUZZY-comparison ceiling.
 *   `undefined` means unbounded. Forced edges are never bounded by it.
 * @returns `ok({ edges, warnings })`, or `err(...)` when the `"error"` ceiling
 *   fires or a `vector`/`hybrid` guard trips.
 */
export function scoreCandidates<K extends NodeType>(
  input: ScoringInput<K>,
  resolveConfig: ResolveConfig,
  ctx: SimilarityContext,
  ceilingPolicy: ComparisonCeilingPolicy,
  maxComparisonsPerKind?: number,
): Result<CandidateGenResult, MergeError> {
  const { similarity, threshold } = resolveConfig;

  // Reserve forced endpoint keys FIRST so a fuzzy pair proposing the same pair is
  // dropped — a definitional match is never also fuzzy-scored (the old Phase-1
  // before Phase-2 dedup, now source-agnostic).
  const seen = new Set<string>();
  const forced: CandidateEdge[] = [];
  for (const edge of input.forcedEdges) {
    const key = endpointKey(edge.a, edge.b);
    if (!seen.has(key)) {
      seen.add(key);
      forced.push(edge);
    }
  }

  const fuzzy: CandidatePair<K>[] = [];
  for (const pair of input.pairs) {
    const key = endpointKey(pair.a, pair.b);
    if (!seen.has(key)) {
      seen.add(key);
      fuzzy.push(pair);
    }
  }

  if (
    maxComparisonsPerKind !== undefined &&
    fuzzy.length > maxComparisonsPerKind
  ) {
    if (ceilingPolicy === "error") {
      return err(
        new MergeError(
          `Comparison ceiling exceeded: ${fuzzy.length} candidate pairs > maxComparisonsPerKind ${maxComparisonsPerKind}.`,
          {
            details: {
              comparisons: fuzzy.length,
              limit: maxComparisonsPerKind,
            },
            suggestion:
              'Tighten the kind\'s block() to shrink buckets, or set onComparisonCeiling: "mergeByIdOnly".',
          },
        ),
      );
    }
    // "mergeByIdOnly": skip FUZZY similarity for this kind, but KEEP the forced
    // edges — those are definitional, not similarity-based.
    return ok({
      edges: [...forced].sort((left, right) =>
        compareCandidateEdges(left, right),
      ),
      warnings: [
        {
          kind: "comparisonCeiling",
          comparisons: fuzzy.length,
          limit: maxComparisonsPerKind,
          message: `Skipped similarity for this kind: ${fuzzy.length} candidate pairs exceeded maxComparisonsPerKind ${maxComparisonsPerKind}; nodes will merge by id and exact unique match only.`,
        },
      ],
    });
  }

  // One memoized scorer per kind so each node's text + trigram multiset is built
  // once, not once per pair it joins (the within-bucket pair count is ~O(n²)).
  const scorer = createPairScorer<K>(similarity, ctx);
  const edges: CandidateEdge[] = [...forced];
  for (const { left, right, a, b } of fuzzy) {
    const scored = scorer(a, left, b, right);
    if (isErr(scored)) {
      return err(scored.error);
    }
    if (scored.data >= threshold) {
      edges.push({ a, b, score: scored.data });
    }
  }

  return ok({
    edges: edges.sort((left, right) => compareCandidateEdges(left, right)),
    warnings: [],
  });
}
