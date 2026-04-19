/**
 * Resolved execution context shared by algorithm implementations.
 *
 * Algorithms are exposed as `store.algorithms.*` and share the same
 * graph-id, backend, dialect, and schema as the hosting store. Bundling
 * these into one value keeps the per-algorithm files focused on SQL
 * generation and result decoding.
 */
import { type GraphBackend } from "../../backend/types";
import { ConfigurationError } from "../../errors";
import { MAX_EXPLICIT_RECURSIVE_DEPTH } from "../../query/compiler/recursive";
import { type SqlSchema } from "../../query/compiler/schema";
import { type DialectAdapter } from "../../query/dialect/types";
import type { AlgorithmCyclePolicy, TraversalDirection } from "./types";

export const DEFAULT_ALGORITHM_MAX_HOPS = 10;
export const DEFAULT_NEIGHBOR_DEPTH = 1;

export type AlgorithmContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
  dialect: DialectAdapter;
  schema: SqlSchema;
}>;

/**
 * Graph-agnostic shape of traversal options used by every recursive-CTE
 * algorithm. Public wrappers in `./index.ts` narrow `edges` to
 * `EdgeKinds<G>[]` for type safety; the runtime only sees raw kind strings.
 */
export type InternalTraversalOptions = Readonly<{
  edges: readonly string[];
  maxHops?: number;
  direction?: TraversalDirection;
  cyclePolicy?: AlgorithmCyclePolicy;
}>;

/**
 * Normalizes and validates a `maxHops` option.
 *
 * Rejects zero, negative, non-finite, and over-limit values up-front so the
 * compiled SQL always carries a sensible `r.depth < N` bound.
 */
export function resolveMaxHops(
  rawMaxHops: number | undefined,
  fallback: number,
  optionName: "maxHops" | "depth",
): number {
  const value = rawMaxHops ?? fallback;

  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigurationError(
      `Graph algorithm ${optionName} must be a finite integer, got ${String(value)}.`,
      { option: optionName, value },
    );
  }

  if (value < 1) {
    throw new ConfigurationError(
      `Graph algorithm ${optionName} must be at least 1, got ${value}.`,
      { option: optionName, value },
    );
  }

  if (value > MAX_EXPLICIT_RECURSIVE_DEPTH) {
    throw new ConfigurationError(
      `Graph algorithm ${optionName} (${value}) exceeds the maximum of ${MAX_EXPLICIT_RECURSIVE_DEPTH}.`,
      { option: optionName, value, limit: MAX_EXPLICIT_RECURSIVE_DEPTH },
    );
  }

  return value;
}

/**
 * Validates that the caller supplied at least one edge kind. Zero-kind
 * traversals always produce empty results, which almost always indicates a
 * programming mistake (forgotten kind list, typo in a variable).
 */
export function assertEdgeKinds(edges: readonly string[]): void {
  if (edges.length === 0) {
    throw new ConfigurationError(
      `Graph algorithms require at least one edge kind in 'edges'.`,
      { edges },
    );
  }
}
