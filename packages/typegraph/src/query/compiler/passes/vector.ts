import { UnsupportedPredicateError } from "../../../errors";
import type { QueryAst, VectorSimilarityPredicate } from "../../ast";
import type { DialectAdapter } from "../../dialect";
import { extractVectorSimilarityPredicates } from "../predicates";

export type VectorPredicatePassResult = Readonly<{
  vectorPredicate: VectorSimilarityPredicate | undefined;
}>;

/**
 * Validates vector predicate placement and cardinality.
 *
 * Invariants:
 * - Vector predicates must not appear under OR/NOT branches.
 * - At most one vector predicate is allowed per query.
 */
export function runVectorPredicatePass(
  ast: QueryAst,
  dialect: DialectAdapter,
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

  const vectorStrategy = dialect.capabilities.vectorPredicateStrategy;
  if (vectorStrategy === "unsupported" || !dialect.supportsVectors) {
    throw new UnsupportedPredicateError(
      `Vector similarity predicates are not supported for dialect "${dialect.name}"`,
    );
  }

  if (!dialect.capabilities.vectorMetrics.includes(vectorPredicate.metric)) {
    throw new UnsupportedPredicateError(
      `Vector metric "${vectorPredicate.metric}" is not supported for dialect "${dialect.name}"`,
    );
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
    if (
      vectorPredicate.metric === "cosine" &&
      (minScore < -1 || minScore > 1)
    ) {
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
