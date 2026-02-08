/**
 * ProfileCollector - Aggregates property access patterns.
 *
 * Mutable collector that tracks property access patterns across queries
 * and provides immutable snapshots for reporting.
 */

import {
  type JsonPointerInput,
  normalizeJsonPointer,
} from "../query/json-pointer";
import {
  type ProfileEntityType,
  type ProfileSummary,
  type PropertyAccessStats,
  type PropertyPath,
  type UsageContext,
} from "./types";

// ============================================================
// Serialization Helpers
// ============================================================

/**
 * Converts a PropertyPath to a string key for Map storage.
 *
 * @example
 * ```typescript
 * pathToKey({
 *   entityType: "node",
 *   kind: "Person",
 *   target: { __type: "prop", pointer: "/email" },
 * })
 * // => "node:Person:/email"
 * ```
 */
export function pathToKey(path: PropertyPath): string {
  const targetKey =
    path.target.__type === "prop" ?
      path.target.pointer
    : `$${path.target.field}`;
  return `${path.entityType}:${path.kind}:${targetKey}`;
}

/**
 * Parses a key back to a PropertyPath.
 *
 * @example
 * ```typescript
 * keyToPath("node:Person:/email")
 * // => { entityType: "node", kind: "Person", target: { __type: "prop", pointer: "/email" } }
 * ```
 */
export function keyToPath(key: string): PropertyPath {
  const firstColonIndex = key.indexOf(":");
  const secondColonIndex =
    firstColonIndex === -1 ? -1 : key.indexOf(":", firstColonIndex + 1);
  if (firstColonIndex === -1 || secondColonIndex === -1) {
    throw new Error(
      `Invalid profile key: "${key}". Expected format "{entityType}:{kind}:{target}".`,
    );
  }

  const entityTypePart = key.slice(0, firstColonIndex);
  const kind = key.slice(firstColonIndex + 1, secondColonIndex);
  if (kind === "") {
    throw new Error(`Invalid profile key: "${key}". Kind must not be empty.`);
  }
  const targetPart = key.slice(secondColonIndex + 1);

  const entityType = parseEntityType(entityTypePart);

  if (targetPart.startsWith("$")) {
    const systemField = targetPart.slice(1);
    if (systemField === "") {
      throw new Error(
        `Invalid profile key: "${key}". System field must not be empty.`,
      );
    }
    return {
      entityType,
      kind,
      target: { __type: "system", field: systemField },
    };
  }

  const pointer = normalizeJsonPointer(
    targetPart as JsonPointerInput<Record<string, unknown>>,
  );

  return {
    entityType,
    kind,
    target: { __type: "prop", pointer },
  };
}

// ============================================================
// Mutable Stats Type
// ============================================================

interface MutableStats {
  count: number;
  contexts: Set<UsageContext>;
  predicateTypes: Set<string>;
  firstSeenMs: number;
  lastSeenMs: number;
}

function parseEntityType(value: string): ProfileEntityType {
  if (value === "node" || value === "edge") {
    return value;
  }
  // This indicates a bug in pathToKey() or data corruption.
  // Throw rather than silently defaulting to avoid incorrect recommendations.
  throw new Error(
    `Invalid entity type in profile key: "${value}". Expected "node" or "edge".`,
  );
}

// ============================================================
// ProfileCollector Class
// ============================================================

/**
 * Collects and aggregates property access patterns.
 *
 * This class is mutable internally but provides immutable snapshots
 * via `getPatterns()` and `getSummary()`.
 *
 * @example
 * ```typescript
 * const collector = new ProfileCollector();
 *
 * collector.record(
 *   { nodeKind: "Person", fieldPath: ["email"] },
 *   "filter",
 *   "eq"
 * );
 * collector.recordQuery();
 *
 * const patterns = collector.getPatterns();
 * const summary = collector.getSummary();
 * ```
 */
export class ProfileCollector {
  readonly #patterns = new Map<string, MutableStats>();
  readonly #startedAt = new Date();
  #queryCount = 0;

  /**
   * Records a property access.
   *
   * @param path - The property path that was accessed
   * @param context - How the property was used (filter, sort, select, groupBy)
   * @param predicateType - Optional predicate type (eq, contains, gt, etc.)
   */
  record(
    path: PropertyPath,
    context: UsageContext,
    predicateType?: string,
  ): void {
    const key = pathToKey(path);
    const existing = this.#patterns.get(key);
    const nowMs = Date.now();

    if (existing) {
      existing.count++;
      existing.contexts.add(context);
      if (predicateType) {
        existing.predicateTypes.add(predicateType);
      }
      existing.lastSeenMs = nowMs;
    } else {
      this.#patterns.set(key, {
        count: 1,
        contexts: new Set([context]),
        predicateTypes: predicateType ? new Set([predicateType]) : new Set(),
        firstSeenMs: nowMs,
        lastSeenMs: nowMs,
      });
    }
  }

  /**
   * Increments the query count.
   * Call this once per query execution.
   */
  recordQuery(): void {
    this.#queryCount++;
  }

  /**
   * Gets all patterns as an immutable map.
   *
   * Returns a new Map with immutable stats objects.
   */
  getPatterns(): ReadonlyMap<string, PropertyAccessStats> {
    const result = new Map<string, PropertyAccessStats>();

    for (const [key, stats] of this.#patterns) {
      result.set(key, {
        count: stats.count,
        contexts: new Set(stats.contexts),
        predicateTypes: new Set(stats.predicateTypes),
        firstSeen: new Date(stats.firstSeenMs),
        lastSeen: new Date(stats.lastSeenMs),
      });
    }

    return result;
  }

  /**
   * Gets summary statistics.
   */
  getSummary(): ProfileSummary {
    return {
      totalQueries: this.#queryCount,
      uniquePatterns: this.#patterns.size,
      startedAt: this.#startedAt,
      durationMs: Date.now() - this.#startedAt.getTime(),
    };
  }

  /**
   * Resets all collected data.
   *
   * Note: This does not reset the startedAt timestamp.
   * Create a new ProfileCollector for a fresh session.
   */
  reset(): void {
    this.#patterns.clear();
    this.#queryCount = 0;
  }
}
