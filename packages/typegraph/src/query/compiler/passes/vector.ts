import { UnsupportedPredicateError } from "../../../errors";
import type { QueryAst, VectorSimilarityPredicate } from "../../ast";
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
): VectorPredicatePassResult {
  const vectorPredicates = extractVectorSimilarityPredicates(ast.predicates);
  if (vectorPredicates.length > 1) {
    throw new UnsupportedPredicateError(
      "Multiple vector similarity predicates in a single query are not supported",
    );
  }

  return {
    vectorPredicate: vectorPredicates[0],
  };
}

/**
 * Resolves the query LIMIT in the presence of vector similarity.
 *
 * If a vector predicate is present and AST limit is omitted, use the
 * predicate's built-in limit to bound nearest-neighbor search.
 */
export function resolveVectorAwareLimit(
  astLimit: number | undefined,
  vectorPredicate: VectorSimilarityPredicate | undefined,
): number | undefined {
  if (vectorPredicate !== undefined && astLimit === undefined) {
    return vectorPredicate.limit;
  }
  return astLimit;
}
