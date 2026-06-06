/**
 * Candidate generation over a kind's pre-blocked nodes (design §9 phase 3, T6).
 *
 * Since the §4 three-layer split this is a thin COMPOSITION of the two layers it
 * used to fuse: the bucket SOURCES (`sources.ts`) that turn the blocked buckets
 * into proposals, and the shared SCORING stage (`scoring.ts`) that turns those
 * proposals into the {@link CandidateEdge} set. `block()` / `unblocked` buckets
 * become fuzzy pairs (scored against the threshold); unique-constraint buckets
 * become FORCED edges (definitional, max score, never bounded by the comparison
 * ceiling). The two layers — not this function — own the behaviour; `merge()` drives
 * the same sources + scoring directly off the staged nodes (`merge.ts`).
 *
 * The edge / warning / result types live in `scoring.ts` (the layer that produces
 * them) and are re-exported here so existing importers keep their import path.
 */

import type { MergeError } from "./errors";
import type { Result } from "./result";
import type { CandidateGenResult } from "./scoring";
import { scoreCandidates } from "./scoring";
import type { SimilarityContext } from "./similarity";
import {
  forcedEdgesFromBlocks,
  keylessConfigFor,
  pairsFromBlocks,
} from "./sources";
import type { Node, NodeType } from "./typegraph-internal";
import type { ComparisonCeilingPolicy, ResolveConfig } from "./types";

export type {
  CandidateEdge,
  CandidateGenResult,
  CandidateWarning,
} from "./scoring";

/**
 * Generates candidate-merge edges for a single kind's blocked nodes by running the
 * bucket sources over the shared scoring stage.
 *
 * @param blocks The kind's nodes bucketed by `blockNodes` (T5) — the UNION of the
 *   `block()` key and the unique-constraint signatures. A node may appear in
 *   SEVERAL buckets; the scoring stage dedups pairs so each is scored once.
 * @param resolveConfig The kind's resolution config (similarity strategy + threshold).
 * @param ctx Ambient context (the backend, for vector-capability gating).
 * @param ceilingPolicy Behavior when `maxComparisonsPerKind` is exceeded.
 * @param maxComparisonsPerKind Optional per-kind FUZZY-comparison ceiling.
 *   `undefined` means unbounded.
 * @returns `ok({ edges, warnings })`, or `err(...)` when the `"error"` ceiling
 *   fires or a `vector`/`hybrid` guard trips.
 */
export function generateCandidates<K extends NodeType>(
  blocks: ReadonlyMap<string, readonly Node<K>[]>,
  resolveConfig: ResolveConfig,
  ctx: SimilarityContext,
  ceilingPolicy: ComparisonCeilingPolicy,
  maxComparisonsPerKind?: number,
): Result<CandidateGenResult, MergeError> {
  const widened = blocks as ReadonlyMap<string, readonly Node<NodeType>[]>;
  return scoreCandidates(
    {
      pairs: pairsFromBlocks(widened, keylessConfigFor(resolveConfig)),
      forcedEdges: forcedEdgesFromBlocks(widened),
    },
    resolveConfig,
    ctx,
    ceilingPolicy,
    maxComparisonsPerKind,
  );
}
