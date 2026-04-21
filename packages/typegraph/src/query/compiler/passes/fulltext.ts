import { UnsupportedPredicateError } from "../../../errors";
import type { FulltextMatchPredicate, QueryAst } from "../../ast";
import type { DialectAdapter } from "../../dialect";
import { extractFulltextMatchPredicates } from "../predicates";

export type FulltextPredicatePassResult = Readonly<{
  fulltextPredicate: FulltextMatchPredicate | undefined;
}>;

/**
 * Validates fulltext predicate placement and cardinality.
 *
 * Invariants mirror the vector predicate pass:
 * - Fulltext predicates must not appear under OR/NOT branches.
 * - At most one fulltext predicate is allowed per query.
 * - The dialect must declare fulltext support.
 */
export function runFulltextPredicatePass(
  ast: QueryAst,
  dialect: DialectAdapter,
): FulltextPredicatePassResult {
  const fulltextPredicates = extractFulltextMatchPredicates(ast.predicates);
  if (fulltextPredicates.length > 1) {
    throw new UnsupportedPredicateError(
      "Multiple fulltext match predicates in a single query are not supported",
    );
  }

  const fulltextPredicate = fulltextPredicates[0];
  if (fulltextPredicate === undefined) {
    return { fulltextPredicate: undefined };
  }

  if (!dialect.capabilities.supportsFulltext) {
    throw new UnsupportedPredicateError(
      `Fulltext match predicates are not supported for dialect "${dialect.name}"`,
    );
  }

  const strategy = dialect.fulltext;
  if (strategy === undefined) {
    throw new UnsupportedPredicateError(
      `Dialect "${dialect.name}" advertises fulltext support but has no strategy configured`,
    );
  }

  if (!strategy.supportedModes.includes(fulltextPredicate.mode)) {
    throw new UnsupportedPredicateError(
      `Fulltext query mode "${fulltextPredicate.mode}" is not supported by the "${strategy.name}" strategy. Supported modes: ${strategy.supportedModes.join(", ")}.`,
    );
  }

  if (
    !Number.isFinite(fulltextPredicate.limit) ||
    fulltextPredicate.limit <= 0
  ) {
    throw new UnsupportedPredicateError(
      `Fulltext match limit must be a positive finite number, got ${String(fulltextPredicate.limit)}`,
    );
  }

  const { minScore } = fulltextPredicate;
  if (minScore !== undefined && !Number.isFinite(minScore)) {
    throw new UnsupportedPredicateError(
      `Fulltext minScore must be a finite number, got ${String(minScore)}`,
    );
  }

  return { fulltextPredicate };
}

/**
 * Resolves query LIMIT in the presence of a fulltext predicate.
 *
 * Mirrors resolveVectorAwareLimit. When a fulltext predicate is present
 * without an explicit AST limit, the predicate's own limit bounds the
 * result set; when both are present the tighter wins.
 */
export function resolveFulltextAwareLimit(
  astLimit?: number,
  fulltextPredicate?: FulltextMatchPredicate,
): number | undefined {
  if (fulltextPredicate === undefined) {
    return astLimit;
  }
  if (astLimit === undefined) {
    return fulltextPredicate.limit;
  }
  return Math.min(astLimit, fulltextPredicate.limit);
}
