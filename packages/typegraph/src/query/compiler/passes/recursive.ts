import {
  CompilerInvariantError,
  UnsupportedPredicateError,
} from "../../../errors";
import type { QueryAst, Traversal, VariableLengthSpec } from "../../ast";

/**
 * Traversal with required variable-length spec.
 */
export type VariableLengthTraversal = Traversal & {
  variableLength: VariableLengthSpec;
};

/**
 * Selects and validates the variable-length traversal target for recursive compilation.
 *
 * Invariants:
 * - Query must contain exactly one variable-length traversal.
 * - Recursive mode currently supports only a single traversal in the query.
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
