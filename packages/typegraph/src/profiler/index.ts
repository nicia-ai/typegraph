/**
 * QueryProfiler Module
 *
 * Tree-shakeable profiling for TypeGraph queries.
 * Captures query patterns from the AST and generates index recommendations.
 *
 * @example Basic Usage
 * ```typescript
 * import { QueryProfiler } from "@nicia-ai/typegraph/profiler";
 *
 * const profiler = new QueryProfiler();
 * const profiledStore = profiler.attachToStore(store);
 *
 * // Run queries...
 * await profiledStore.query()
 *   .from("Person", "p")
 *   .whereNode("p", (p) => p.email.eq("alice@example.com"))
 *   .select((ctx) => ctx.p)
 *   .execute();
 *
 * // Get report
 * const report = profiler.getReport();
 * console.log(report.recommendations);
 * ```
 *
 * @example With Declared Indexes
 * ```typescript
 * const profiler = new QueryProfiler({
 *   declaredIndexes: [
 *     { nodeKind: "Person", fields: ["email"], unique: true, name: "idx_email" },
 *   ],
 * });
 * ```
 *
 * @example Testing Integration
 * ```typescript
 * // In test setup
 * const profiler = new QueryProfiler({
 *   declaredIndexes: [
 *     { nodeKind: "Person", fields: ["email"], unique: true, name: "idx_email" },
 *   ],
 * });
 * const profiledStore = profiler.attachToStore(store);
 *
 * // Run all tests...
 *
 * // Then assert coverage
 * it("all filtered properties should be indexed", () => {
 *   profiler.assertIndexCoverage(); // throws if unindexed filters found
 * });
 * ```
 *
 * @packageDocumentation
 */

// ============================================================
// Main Class
// ============================================================

export { type ProfiledStore, QueryProfiler } from "./query-profiler";

// ============================================================
// Types
// ============================================================

export type {
  DeclaredIndex,
  IndexRecommendation,
  ProfileReport,
  ProfilerOptions,
  ProfileSummary,
  PropertyAccessStats,
  PropertyPath,
  RecommendationPriority,
  UsageContext,
} from "./types";

// ============================================================
// Utilities (for advanced usage)
// ============================================================

export { type ExtractedAccess, extractPropertyAccesses } from "./ast-extractor";
export { keyToPath, pathToKey, ProfileCollector } from "./collector";
export {
  generateRecommendations,
  getUnindexedFilters,
} from "./recommendations";
