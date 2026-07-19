import { type GraphBackend } from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import {
  assertValidRecordedInstant,
  type RecordedInstant,
  resolveReadCoordinate,
} from "../../core/temporal";
import { type TemporalMode } from "../../core/types";
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
} from "../../errors";
import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { MAX_EXPLICIT_RECURSIVE_DEPTH } from "../../query/compiler/recursive";
import {
  type RecordedReadBinding,
  recordedReadSchemaFor,
  type SqlSchema,
} from "../../query/compiler/schema";
import {
  compileTemporalFilter,
  currentReadInstant,
  type TemporalFilterOptions,
} from "../../query/compiler/temporal";
import { type DialectAdapter } from "../../query/dialect/types";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { type KindRegistry } from "../../registry/kind-registry";
import { compareCodePoints } from "../../utils/compare";
import type { AlgorithmCyclePolicy, TraversalDirection } from "./types";

export const DEFAULT_ALGORITHM_MAX_HOPS = 10;
export const DEFAULT_NEIGHBOR_DEPTH = 1;

export type AlgorithmContext = Readonly<{
  graphId: string;
  /** Graph definition — degree() enumerates declared edge endpoint kinds. */
  graph: GraphDef;
  /** Kind registry — expands declared endpoint kinds through subClassOf. */
  registry: KindRegistry;
  backend: GraphBackend;
  dialect: DialectAdapter;
  schema: SqlSchema;
  recordedReadBinding: RecordedReadBinding | undefined;
  defaultTemporalMode: TemporalMode;
}>;

export type InternalTemporalOptions = Readonly<{
  temporalMode?: TemporalMode;
  asOf?: string;
  recordedAsOf?: RecordedInstant;
}>;

export type InternalTraversalOptions = InternalTemporalOptions &
  Readonly<{
    edges: readonly string[];
    maxHops?: number;
    direction?: TraversalDirection;
    cyclePolicy?: AlgorithmCyclePolicy;
    workingMemory?: string;
    /**
     * Numeric edge property supplying per-edge traversal weights. When set,
     * the iterative operation compiles a shared weight expression and every
     * edge expansion carries a `weight` column.
     */
    weightProperty?: string;
    /** Weight substituted for edges missing `weightProperty`. */
    defaultWeight?: number;
  }>;

/** Copies only explicitly supplied temporal overrides for option forwarding. */
export function pickTemporalOptions(
  options: InternalTemporalOptions,
): InternalTemporalOptions {
  return {
    ...(options.temporalMode === undefined ?
      {}
    : { temporalMode: options.temporalMode }),
    ...(options.asOf === undefined ? {} : { asOf: options.asOf }),
    ...(options.recordedAsOf === undefined ?
      {}
    : { recordedAsOf: options.recordedAsOf }),
  };
}

/**
 * Resolves per-call temporal overrides against the graph's default mode into
 * a plain `{ temporalMode, asOf? }` object. Shared by callers that forward
 * the pair to `buildReachableCte`. An `asOf` is rejected unless the mode is
 * `"asOf"` (via {@link resolveReadCoordinate}), matching every other read path.
 */
export function resolveTemporalOptions(
  ctx: AlgorithmContext,
  options: InternalTemporalOptions,
): Readonly<{
  temporalMode: TemporalMode;
  asOf?: string;
  recordedAsOf?: RecordedInstant;
}> {
  const { valid } = resolveReadCoordinate(
    options.temporalMode ?? ctx.defaultTemporalMode,
    options.asOf,
  );
  // `recordedAsOf` normally arrives pre-validated through StoreView's
  // withRecordedCoordinate, but it is absent from the public algorithm option
  // types, so validate here too: a type-unsafe caller that smuggles a
  // non-canonical timestamp would otherwise be string-compared raw against
  // recorded_from/recorded_to and return wrong rows on SQLite.
  if (options.recordedAsOf !== undefined) {
    assertValidRecordedInstant(options.recordedAsOf, "recordedAsOf");
  }
  return {
    temporalMode: valid.mode,
    ...(valid.asOf !== undefined && { asOf: valid.asOf }),
    ...(options.recordedAsOf === undefined ?
      {}
    : { recordedAsOf: options.recordedAsOf }),
  };
}

export function resolveReadSchema(
  ctx: AlgorithmContext,
  options: InternalTemporalOptions,
): SqlSchema {
  return recordedReadSchemaFor(
    ctx.schema,
    options.recordedAsOf,
    ctx.recordedReadBinding,
    "recorded-graph-algorithm",
  );
}

/**
 * Compiles the resolved temporal filter to SQL. `resolveTemporalOptions`
 * has already rejected an `asOf` paired with any non-`"asOf"` mode, so a
 * stray pin can never reach the filter; `current` resolves against the
 * dialect's current-timestamp expression.
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
    recordedAsOf: resolved.recordedAsOf,
    tableAlias,
    currentTimestamp: currentReadInstant(),
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

/**
 * Validates an iterative algorithm's round budget. Unlike {@link
 * resolveMaxHops}, the budget is not a traversal depth bound — convergence
 * normally ends the run first — so it is not capped at the recursive-CTE
 * depth limit.
 */
export function resolveMaxIterations(
  value: number | undefined,
  fallback: number,
  algorithm: string,
): number {
  const maxIterations = value ?? fallback;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new ConfigurationError(
      `${algorithm} maxIterations must be a positive safe integer, got ${String(maxIterations)}.`,
      { maxIterations },
    );
  }
  return maxIterations;
}

export function assertEdgeKinds(edges: readonly string[]): void {
  if (edges.length === 0) {
    throw new ConfigurationError(
      `Graph algorithms require at least one edge kind in 'edges'.`,
      { edges },
    );
  }
}

/**
 * Compiles the induced-subgraph node filter for a working-table seeding
 * statement over the nodes-table alias `n`; `undefined` selects every kind.
 */
export function compileNodeKindSeedFilter(
  nodeKinds: readonly string[] | undefined,
): SqlFragment {
  if (nodeKinds === undefined) return sql`TRUE`;
  return compileKindFilter(sql.raw("n.kind"), nodeKinds);
}

/**
 * Deduplicates and code-point-sorts an induced-subgraph kind selection so
 * compiled kind filters are deterministic across call sites and backends.
 */
export function normalizeNodeKinds(
  nodeKinds: readonly string[] | undefined,
): readonly string[] | undefined {
  if (nodeKinds === undefined) return undefined;
  return [...new Set(nodeKinds)].toSorted((left, right) =>
    compareCodePoints(left, right),
  );
}

export function assertGraphAnalyticsSupported(
  ctx: AlgorithmContext,
  algorithm: string,
  options: Readonly<{ requiresWindowFunctions?: boolean }> = {},
): void {
  const graphAnalytics =
    ctx.backend.capabilities.graphAnalytics?.supported === true;
  const windowFunctions = ctx.backend.capabilities.windowFunctions;
  if (
    graphAnalytics &&
    (options.requiresWindowFunctions !== true || windowFunctions)
  ) {
    return;
  }

  throw new UnsupportedBackendCapabilityError(
    algorithm,
    "graphAnalytics",
    {
      dialect: ctx.backend.dialect,
      supported: graphAnalytics,
      ...(options.requiresWindowFunctions === true ? { windowFunctions } : {}),
    },
    "Use a built-in transactional SQLite/PostgreSQL backend, or declare graphAnalytics support on a compatible custom backend.",
  );
}
