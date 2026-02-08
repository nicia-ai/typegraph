/**
 * Index Recommendations - Generates index suggestions from usage patterns.
 *
 * Analyzes collected property access patterns and generates prioritized
 * recommendations for missing indexes.
 */

import { keyToPath, pathToKey } from "./collector";
import {
  DEFAULT_HIGH_FREQUENCY_THRESHOLD,
  DEFAULT_MEDIUM_FREQUENCY_THRESHOLD,
  DEFAULT_MIN_FREQUENCY_FOR_RECOMMENDATION,
} from "./constants";
import {
  type DeclaredIndex,
  type IndexRecommendation,
  type PropertyAccessStats,
  type PropertyPath,
  type RecommendationPriority,
} from "./types";

// ============================================================
// Main Functions
// ============================================================

type GenerateRecommendationsOptions = Readonly<{
  minFrequencyForRecommendation?: number;
  mediumFrequencyThreshold?: number;
  highFrequencyThreshold?: number;
}>;

/**
 * Generates index recommendations based on usage patterns.
 *
 * Analyzes property access patterns and returns prioritized recommendations
 * for properties that would benefit from indexing.
 *
 * @param patterns - Collected property access patterns
 * @param declaredIndexes - Indexes that already exist
 * @param options - Threshold configuration (or legacy `minFrequency` number)
 * @returns Sorted array of index recommendations
 */
export function generateRecommendations(
  patterns: ReadonlyMap<string, PropertyAccessStats>,
  declaredIndexes: readonly DeclaredIndex[],
  options: number | GenerateRecommendationsOptions = {},
): readonly IndexRecommendation[] {
  const recommendations: IndexRecommendation[] = [];
  const indexedPaths = buildIndexedPathsSet(declaredIndexes);

  const config = normalizeRecommendationsOptions(options);

  for (const [key, stats] of patterns) {
    // Only recommend indexes for filter and sort contexts.
    // Select and groupBy contexts are collected for completeness (useful for debugging
    // and future features like covering index suggestions) but don't drive recommendations
    // since they don't benefit from B-tree indexes in the same way.
    const hasFilterOrSort =
      stats.contexts.has("filter") || stats.contexts.has("sort");

    if (!hasFilterOrSort) {
      continue;
    }

    if (stats.count < config.minFrequencyForRecommendation) {
      continue;
    }

    const path = keyToPath(key);

    // Skip system fields - they're indexed by TypeGraph and/or not indexable as props.
    if (isSystemField(path)) {
      continue;
    }

    // Check if already indexed
    if (isIndexed(path, indexedPaths)) {
      continue;
    }

    recommendations.push({
      entityType: path.entityType,
      kind: path.kind,
      fields: path.target.__type === "prop" ? [path.target.pointer] : [],
      reason: buildReasonString(stats),
      frequency: stats.count,
      priority: getPriority(stats.count, config),
    });
  }

  // Sort by priority (high first), then by frequency (descending)
  return recommendations.toSorted((a, b) => {
    const priorityOrder: Record<RecommendationPriority, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return b.frequency - a.frequency;
  });
}

/**
 * Gets properties used in filters that lack indexes.
 *
 * Useful for test assertions to ensure all filtered properties are indexed.
 *
 * @param patterns - Collected property access patterns
 * @param declaredIndexes - Indexes that already exist
 * @returns Array of unindexed property paths
 */
export function getUnindexedFilters(
  patterns: ReadonlyMap<string, PropertyAccessStats>,
  declaredIndexes: readonly DeclaredIndex[],
): readonly PropertyPath[] {
  const indexedPaths = buildIndexedPathsSet(declaredIndexes);
  const unindexed: PropertyPath[] = [];

  for (const [key, stats] of patterns) {
    // Only check filter context
    if (!stats.contexts.has("filter")) {
      continue;
    }

    const path = keyToPath(key);

    // Skip system fields
    if (isSystemField(path)) {
      continue;
    }

    if (!isIndexed(path, indexedPaths)) {
      unindexed.push(path);
    }
  }

  return unindexed;
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Builds a set of indexed property paths for fast lookup.
 */
function buildIndexedPathsSet(indexes: readonly DeclaredIndex[]): Set<string> {
  const set = new Set<string>();

  for (const index of indexes) {
    const firstField = index.fields[0];
    if (!firstField) continue;

    // Prefix matching:
    // A composite index on (a, b, c) can be used for predicates on (a).
    set.add(
      pathToKey({
        entityType: index.entityType,
        kind: index.kind,
        target: { __type: "prop", pointer: firstField },
      }),
    );
  }

  return set;
}

/**
 * Checks if a property path is covered by an index.
 */
function isIndexed(path: PropertyPath, indexedPaths: Set<string>): boolean {
  return indexedPaths.has(pathToKey(path));
}

/**
 * Checks if a property path refers to a system field.
 */
function isSystemField(path: PropertyPath): boolean {
  return path.target.__type === "system";
}

/**
 * Builds a human-readable reason string for a recommendation.
 */
function buildReasonString(stats: PropertyAccessStats): string {
  const contexts = [...stats.contexts].join(", ");
  const predicates = [...stats.predicateTypes];

  let reason = `Used in ${contexts}`;
  if (predicates.length > 0) {
    reason += ` with ${predicates.join(", ")}`;
  }
  reason += ` (${stats.count} ${stats.count === 1 ? "time" : "times"})`;

  return reason;
}

/**
 * Determines recommendation priority based on access frequency.
 */
type NormalizedRecommendationsOptions = Readonly<{
  minFrequencyForRecommendation: number;
  mediumFrequencyThreshold: number;
  highFrequencyThreshold: number;
}>;

function normalizeRecommendationsOptions(
  options: number | GenerateRecommendationsOptions,
): NormalizedRecommendationsOptions {
  if (typeof options === "number") {
    return {
      minFrequencyForRecommendation: options,
      mediumFrequencyThreshold: DEFAULT_MEDIUM_FREQUENCY_THRESHOLD,
      highFrequencyThreshold: DEFAULT_HIGH_FREQUENCY_THRESHOLD,
    };
  }

  return {
    minFrequencyForRecommendation:
      options.minFrequencyForRecommendation ??
      DEFAULT_MIN_FREQUENCY_FOR_RECOMMENDATION,
    mediumFrequencyThreshold:
      options.mediumFrequencyThreshold ?? DEFAULT_MEDIUM_FREQUENCY_THRESHOLD,
    highFrequencyThreshold:
      options.highFrequencyThreshold ?? DEFAULT_HIGH_FREQUENCY_THRESHOLD,
  };
}

function getPriority(
  frequency: number,
  options: NormalizedRecommendationsOptions,
): RecommendationPriority {
  if (frequency >= options.highFrequencyThreshold) return "high";
  if (frequency >= options.mediumFrequencyThreshold) return "medium";
  return "low";
}
