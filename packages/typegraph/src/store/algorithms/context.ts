import { type GraphBackend } from "../../backend/types";
import { type TemporalMode } from "../../core/types";
import { ConfigurationError } from "../../errors";
import { MAX_EXPLICIT_RECURSIVE_DEPTH } from "../../query/compiler/recursive";
import { type SqlSchema } from "../../query/compiler/schema";
import {
  compileTemporalFilter,
  type TemporalFilterOptions,
} from "../../query/compiler/temporal";
import { type DialectAdapter } from "../../query/dialect/types";
import type { AlgorithmCyclePolicy, TraversalDirection } from "./types";

export const DEFAULT_ALGORITHM_MAX_HOPS = 10;
export const DEFAULT_NEIGHBOR_DEPTH = 1;

export type AlgorithmContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
  dialect: DialectAdapter;
  schema: SqlSchema;
  defaultTemporalMode: TemporalMode;
}>;

export type InternalTemporalOptions = Readonly<{
  temporalMode?: TemporalMode;
  asOf?: string;
}>;

export type InternalTraversalOptions = InternalTemporalOptions &
  Readonly<{
    edges: readonly string[];
    maxHops?: number;
    direction?: TraversalDirection;
    cyclePolicy?: AlgorithmCyclePolicy;
  }>;

/**
 * Resolves per-call temporal overrides against the graph's default mode into
 * a plain `{ temporalMode, asOf? }` object. Shared by callers that forward
 * the pair to `buildReachableCte`.
 */
export function resolveTemporalOptions(
  ctx: AlgorithmContext,
  options: InternalTemporalOptions,
): Readonly<{ temporalMode: TemporalMode; asOf?: string }> {
  return {
    temporalMode: options.temporalMode ?? ctx.defaultTemporalMode,
    ...(options.asOf !== undefined && { asOf: options.asOf }),
  };
}

/**
 * Compiles the resolved temporal filter to SQL. `asOf` is only meaningful
 * when the resolved mode is `"asOf"`; `compileTemporalFilter` ignores it in
 * every other mode.
 */
export function resolveTemporalFilter(
  ctx: AlgorithmContext,
  options: InternalTemporalOptions,
  tableAlias?: string,
): ReturnType<typeof compileTemporalFilter> {
  const resolved = resolveTemporalOptions(ctx, options);
  const filterOptions: TemporalFilterOptions = {
    mode: resolved.temporalMode,
    asOf: resolved.asOf,
    tableAlias,
  };
  return compileTemporalFilter(filterOptions);
}

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

export function assertEdgeKinds(edges: readonly string[]): void {
  if (edges.length === 0) {
    throw new ConfigurationError(
      `Graph algorithms require at least one edge kind in 'edges'.`,
      { edges },
    );
  }
}
