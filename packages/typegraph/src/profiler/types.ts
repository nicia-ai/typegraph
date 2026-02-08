/**
 * QueryProfiler types.
 *
 * Type definitions for the query profiling system that captures
 * property access patterns and generates index recommendations.
 */

import { type JsonPointer } from "../query/json-pointer";

// ============================================================
// Property Access Types
// ============================================================

export type ProfileEntityType = "node" | "edge";

export type PropertyTarget =
  | Readonly<{
      __type: "prop";
      pointer: JsonPointer;
    }>
  | Readonly<{
      __type: "system";
      field: string;
    }>;

/**
 * Represents a property access path.
 *
 * @example
 * ```typescript
 * // Simple property access
 * { entityType: "node", kind: "Person", target: { __type: "prop", pointer: "/email" } }
 *
 * // Nested property access
 * { entityType: "node", kind: "Order", target: { __type: "prop", pointer: "/metadata/priority" } }
 * ```
 */
export type PropertyPath = Readonly<{
  entityType: ProfileEntityType;
  kind: string;
  target: PropertyTarget;
}>;

/**
 * Usage context for a property access.
 */
export type UsageContext = "filter" | "sort" | "select" | "groupBy";

/**
 * Statistics for a property access pattern.
 */
export type PropertyAccessStats = Readonly<{
  /** Number of times this property was accessed */
  count: number;
  /** Contexts in which this property was used */
  contexts: ReadonlySet<UsageContext>;
  /** Predicate types used with this property (eq, contains, gt, etc.) */
  predicateTypes: ReadonlySet<string>;
  /** When this pattern was first observed */
  firstSeen: Date;
  /** When this pattern was last observed */
  lastSeen: Date;
}>;

// ============================================================
// Index Types
// ============================================================

/**
 * A declared index for comparison against usage patterns.
 *
 * Pass these to QueryProfiler to exclude already-indexed
 * properties from recommendations.
 */
export type DeclaredIndex = Readonly<{
  /** Whether this index applies to nodes or edges */
  entityType: ProfileEntityType;
  /** The kind name this index applies to */
  kind: string;
  /** Props JSON pointers covered by this index (in key order for composite indexes) */
  fields: readonly JsonPointer[];
  /** Whether this is a unique index */
  unique: boolean;
  /** Index name (for reference in reports) */
  name: string;
}>;

/**
 * Priority level for index recommendations.
 */
export type RecommendationPriority = "high" | "medium" | "low";

/**
 * An index recommendation based on observed query patterns.
 */
export type IndexRecommendation = Readonly<{
  /** Whether this recommendation is for nodes or edges */
  entityType: ProfileEntityType;
  /** The kind name that would benefit from this index */
  kind: string;
  /** Props JSON pointers to index (in key order for composite indexes) */
  fields: readonly JsonPointer[];
  /** Human-readable reason for the recommendation */
  reason: string;
  /** How often this property was accessed */
  frequency: number;
  /** Priority based on frequency and usage context */
  priority: RecommendationPriority;
}>;

// ============================================================
// Report Types
// ============================================================

/**
 * Summary statistics for a profiling session.
 */
export type ProfileSummary = Readonly<{
  /** Total number of queries executed */
  totalQueries: number;
  /** Number of unique property access patterns */
  uniquePatterns: number;
  /** When profiling started */
  startedAt: Date;
  /** Duration of profiling session in milliseconds */
  durationMs: number;
}>;

/**
 * Complete profiler report with patterns, recommendations, and summary.
 *
 * @example
 * ```typescript
 * const report = profiler.getReport();
 *
 * console.log(`Total queries: ${report.summary.totalQueries}`);
 * console.log(`Unique patterns: ${report.summary.uniquePatterns}`);
 *
 * for (const rec of report.recommendations) {
 *   console.log(`[${rec.priority}] ${rec.entityType}:${rec.kind} ${rec.fields.join(", ")}: ${rec.reason}`);
 * }
 * ```
 */
export type ProfileReport = Readonly<{
  /** All property access patterns aggregated by path */
  patterns: ReadonlyMap<string, PropertyAccessStats>;
  /** Index recommendations sorted by priority */
  recommendations: readonly IndexRecommendation[];
  /** Summary statistics */
  summary: ProfileSummary;
  /** Properties used in filters that lack indexes */
  unindexedFilters: readonly PropertyPath[];
}>;

// ============================================================
// Configuration Types
// ============================================================

/**
 * Options for configuring the QueryProfiler.
 */
export type ProfilerOptions = Readonly<{
  /**
   * Declared indexes to compare against usage patterns.
   * Properties covered by these indexes will be excluded from recommendations.
   */
  declaredIndexes?: readonly DeclaredIndex[];

  /**
   * Minimum frequency for a property to be included in recommendations.
   * Properties accessed fewer times than this will not generate recommendations.
   * @default 3
   */
  minFrequencyForRecommendation?: number;

  /**
   * Minimum frequency for a `medium` priority recommendation.
   * @default 5
   */
  mediumFrequencyThreshold?: number;

  /**
   * Minimum frequency for a `high` priority recommendation.
   * @default 10
   */
  highFrequencyThreshold?: number;
}>;
