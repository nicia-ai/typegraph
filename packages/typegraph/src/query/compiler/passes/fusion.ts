import { UnsupportedPredicateError } from "../../../errors";
import type {
  FulltextMatchPredicate,
  HybridFusionOptions,
  QueryAst,
  VectorSimilarityPredicate,
} from "../../ast";

export type FusionConfigPassResult = Readonly<{
  fusion: HybridFusionOptions | undefined;
}>;

/**
 * Validates that `.fuseWith()` configuration is coherent with the query
 * shape. Runs after the vector and fulltext predicate passes.
 *
 * - When no `fusion` is configured, returns `{ fusion: undefined }`.
 * - When `fusion` is configured but either predicate is missing, throws.
 * - When the predicates target different aliases, throws.
 */
export function runFusionConfigPass(
  ast: QueryAst,
  vectorPredicate: VectorSimilarityPredicate | undefined,
  fulltextPredicate: FulltextMatchPredicate | undefined,
): FusionConfigPassResult {
  const fusion = ast.fusion;
  if (fusion === undefined) return { fusion: undefined };

  if (vectorPredicate === undefined || fulltextPredicate === undefined) {
    throw new UnsupportedPredicateError(
      `.fuseWith() requires both a .similarTo() and a .$fulltext.matches() ` +
        `predicate in the same query. Remove .fuseWith(), or add the missing ` +
        `predicate.`,
    );
  }
  if (vectorPredicate.field.alias !== fulltextPredicate.field.alias) {
    throw new UnsupportedPredicateError(
      `.fuseWith() requires .similarTo() and .$fulltext.matches() to target ` +
        `the same node alias. Got vector=${vectorPredicate.field.alias}, ` +
        `fulltext=${fulltextPredicate.field.alias}.`,
    );
  }
  return { fusion };
}
