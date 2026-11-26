import {
  CompilerInvariantError,
  UnsupportedPredicateError,
} from "../../../errors";
import type { QueryAst, Traversal, VariableLengthSpec } from "../../ast";
import {
  extractFulltextMatchPredicates,
  extractVectorSimilarityPredicates,
} from "../predicates";

/**
 * Traversal with required variable-length spec.
 */
export type VariableLengthTraversal = Traversal & {
  variableLength: VariableLengthSpec;
};

/**
 * Selects and validates the variable-length traversal target for recursive compilation.
 *
 * Invariant: the AST compiled here holds exactly one traversal, and it is the
 * variable-length one. A query with several traversals, recursive or fixed,
 * compiles through `compileMultiStageRecursiveQuery` (`recursive-chain.ts`),
 * which isolates each traversal into a single-traversal stage AST before it
 * reaches this pass; the refusal below guards that contract.
 */
export function runRecursiveTraversalSelectionPass(
  ast: QueryAst,
): VariableLengthTraversal {
  const variableLengthTraversal = ast.traversals.find(
    (traversal): traversal is VariableLengthTraversal =>
      traversal.variableLength !== undefined,
  );

  if (variableLengthTraversal === undefined) {
    throw new CompilerInvariantError("No variable-length traversal found");
  }

  if (ast.traversals.length > 1) {
    throw new UnsupportedPredicateError(
      "Variable-length traversals with multiple traversals are not yet supported. " +
        "Please use a single variable-length traversal.",
    );
  }

  return variableLengthTraversal;
}

/**
 * Refuses a vector or fulltext predicate on an alias a recursive statement
 * compiles: the start, edge or target alias of a recursive traversal, or of a
 * recursive stage of a multi-stage chain (the stage AST carries only its own
 * aliases' predicates). A fixed stage of a chain compiles through the standard
 * statement, which applies them, so its aliases never reach here.
 *
 * Those predicates are not row filters: they are top-k candidate sets with a
 * relevance order, applied by the relevance CTE joins only the standard
 * statement builds. A recursive statement has no such join and no relevance
 * order, so it cannot apply either with the semantics it has on a single hop;
 * the query is refused instead of being compiled without the predicate.
 *
 * `callerAlias` maps a renamed alias of a correlated subquery back to the
 * name the caller wrote.
 */
export function refuseRelevancePredicatesInRecursiveStatement(
  ast: QueryAst,
  callerAlias: ((alias: string) => string) | undefined,
): void {
  const [relevancePredicate] = [
    ...extractFulltextMatchPredicates(ast.predicates),
    ...extractVectorSimilarityPredicates(ast.predicates),
  ];
  if (relevancePredicate === undefined) return;
  const operation =
    relevancePredicate.__type === "fulltext_match" ?
      "$fulltext.matches()"
    : "similarTo()";
  const alias =
    callerAlias?.(relevancePredicate.field.alias) ??
    relevancePredicate.field.alias;
  throw new UnsupportedPredicateError(
    `${operation} on alias "${alias}" is not supported on a recursive traversal: ` +
      "the recursive statement has no relevance ranking to apply its top-k match set and order through, " +
      "so the predicate would be dropped.",
    {
      predicate: relevancePredicate.__type,
      alias,
      reason: "recursive_traversal",
    },
    {
      suggestion:
        "Run the search in a separate query and constrain the recursive walk with its ids " +
        "(for example `id.in(ids)` on the alias), or limit the traversal to a single hop " +
        "(`recursive({ maxHops: 1 })` without path, depth or stopExpansion, and no other traversal).",
    },
  );
}
