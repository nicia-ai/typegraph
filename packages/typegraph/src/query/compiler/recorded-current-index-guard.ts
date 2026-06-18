import { UnsupportedPredicateError } from "../../errors";
import type {
  FulltextMatchPredicate,
  QueryAst,
  VectorSimilarityPredicate,
} from "../ast";
import {
  extractFulltextMatchPredicates,
  extractVectorSimilarityPredicates,
} from "./predicates";

type CurrentIndexUsage = Readonly<{
  usesVectorPredicate: boolean;
  usesFulltextPredicate: boolean;
}>;

export function assertRecordedQueryDoesNotUseCurrentIndexes(
  ast: QueryAst,
  vectorPredicate: VectorSimilarityPredicate | undefined,
  fulltextPredicate: FulltextMatchPredicate | undefined,
): void {
  assertRecordedQueryHasNoCurrentIndexUsage(ast, {
    usesVectorPredicate: vectorPredicate !== undefined,
    usesFulltextPredicate: fulltextPredicate !== undefined,
  });
}

export function assertRecordedQueryAstDoesNotUseCurrentIndexes(
  ast: QueryAst,
): void {
  if (ast.recordedAsOf === undefined) return;
  const vectorPredicates = extractVectorSimilarityPredicates(ast.predicates);
  const fulltextPredicates = extractFulltextMatchPredicates(ast.predicates);
  assertRecordedQueryHasNoCurrentIndexUsage(ast, {
    usesVectorPredicate: vectorPredicates.length > 0,
    usesFulltextPredicate: fulltextPredicates.length > 0,
  });
}

function assertRecordedQueryHasNoCurrentIndexUsage(
  ast: QueryAst,
  usage: CurrentIndexUsage,
): void {
  if (ast.recordedAsOf === undefined) return;
  if (!usage.usesVectorPredicate && !usage.usesFulltextPredicate) return;

  throwRecordedCurrentIndexError(ast.recordedAsOf, usage);
}

function throwRecordedCurrentIndexError(
  recordedAsOf: string,
  usage: CurrentIndexUsage,
): never {
  throw new UnsupportedPredicateError(
    "Recorded-time queries cannot use vector or fulltext predicates because those indexes reflect current state.",
    {
      recordedAsOf,
      ...usage,
    },
    {
      suggestion:
        "Use ordinary property predicates on the recorded view, or run vector/fulltext predicates against the live Store.",
    },
  );
}
