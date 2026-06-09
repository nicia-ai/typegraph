import { type VectorMetric } from "../../../backend/types";
import { UnsupportedPredicateError } from "../../../errors";
import type { QueryAst, VectorSimilarityPredicate } from "../../ast";
import type { DialectAdapter } from "../../dialect";
import { type VectorStrategy } from "../../dialect/vector-strategy";
import { extractVectorSimilarityPredicates } from "../predicates";

export type VectorPredicatePassResult = Readonly<{
  vectorPredicate: VectorSimilarityPredicate | undefined;
}>;

/**
 * Validates vector predicate placement, cardinality, and metric support.
 *
 * Invariants:
 * - Vector predicates must not appear under OR/NOT branches.
 * - At most one vector predicate is allowed per query.
 * - The requested metric must be supported by the active vector strategy.
 *
 * `vectorStrategy` is the backend-declared strategy that will generate the
 * relevance SQL (passed by the standard compile path). When present it is the
 * authoritative source for supported metrics — a custom strategy override may
 * advertise a different metric set than the dialect's built-in default. It is
 * omitted only by the plan-lowering path (recursive / set-operation queries),
 * which has no strategy plumbed and falls back to the dialect's metric list.
 */
export function runVectorPredicatePass(
  ast: QueryAst,
  dialect: DialectAdapter,
  vectorStrategy?: VectorStrategy,
): VectorPredicatePassResult {
  const vectorPredicates = extractVectorSimilarityPredicates(ast.predicates);
  if (vectorPredicates.length > 1) {
    throw new UnsupportedPredicateError(
      "Multiple vector similarity predicates in a single query are not supported",
    );
  }

  const vectorPredicate = vectorPredicates[0];
  if (vectorPredicate === undefined) {
    return { vectorPredicate: undefined };
  }

  const predicateStrategy = dialect.capabilities.vectorPredicateStrategy;
  if (predicateStrategy === "unsupported" || !dialect.supportsVectors) {
    throw new UnsupportedPredicateError(
      `Vector similarity predicates are not supported for dialect "${dialect.name}"`,
    );
  }

  // Only an EXPLICIT metric is validated here. When omitted, the compiler
  // resolves the field's declared `embedding()` metric per kind (validated
  // when the field's index was materialized), so there is nothing to check yet.
  if (vectorPredicate.metric !== undefined) {
    const supportedMetrics: readonly VectorMetric[] =
      vectorStrategy?.capabilities.metrics ??
      dialect.capabilities.vectorMetrics;
    if (!supportedMetrics.includes(vectorPredicate.metric)) {
      throw new UnsupportedPredicateError(
        vectorStrategy === undefined ?
          `Vector metric "${vectorPredicate.metric}" is not supported for dialect "${dialect.name}"`
        : `Vector metric "${vectorPredicate.metric}" is not supported by vector strategy "${vectorStrategy.name}" (supported: ${supportedMetrics.join(", ")})`,
      );
    }
  }

  if (!Number.isFinite(vectorPredicate.limit) || vectorPredicate.limit <= 0) {
    throw new UnsupportedPredicateError(
      `Vector predicate limit must be a positive finite number, got ${String(vectorPredicate.limit)}`,
    );
  }

  const { minScore } = vectorPredicate;
  if (minScore !== undefined) {
    if (!Number.isFinite(minScore)) {
      throw new UnsupportedPredicateError(
        `Vector minScore must be a finite number, got ${String(minScore)}`,
      );
    }
    if (vectorPredicate.metric === "cosine" && Math.abs(minScore) > 1) {
      throw new UnsupportedPredicateError(
        `Cosine minScore must be between -1 and 1, got ${String(minScore)}`,
      );
    }
  }

  return { vectorPredicate };
}

/**
 * Resolves the query LIMIT in the presence of vector similarity.
 *
 * If a vector predicate is present and AST limit is omitted, use the
 * predicate's built-in limit to bound nearest-neighbor search.
 */
export function resolveVectorAwareLimit(
  astLimit?: number,
  vectorPredicate?: VectorSimilarityPredicate,
): number | undefined {
  if (vectorPredicate === undefined) {
    return astLimit;
  }
  if (astLimit === undefined) {
    return vectorPredicate.limit;
  }
  return Math.min(astLimit, vectorPredicate.limit);
}
