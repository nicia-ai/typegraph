import { ConfigurationError } from "../../errors";
import type { FieldRef, PredicateExpression, Traversal } from "../ast";
import type { QueryBuilderState } from "./types";

function assertStopFieldAlias(field: FieldRef, alias: string): void {
  if (field.alias !== alias)
    throw new ConfigurationError(
      `stopExpansion() predicate must reference only recursive target alias "${alias}".`,
    );
}

function assertSupportedStopPredicate(
  expression: PredicateExpression,
  alias: string,
): void {
  switch (expression.__type) {
    case "comparison": {
      assertStopFieldAlias(expression.left, alias);
      if (
        !Array.isArray(expression.right) &&
        expression.right.__type === "field_ref"
      )
        assertStopFieldAlias(expression.right, alias);
      return;
    }
    case "tuple_comparison": {
      for (const field of expression.fields) assertStopFieldAlias(field, alias);
      return;
    }
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op": {
      assertStopFieldAlias(expression.field, alias);
      return;
    }
    case "and":
    case "or": {
      for (const predicate of expression.predicates)
        assertSupportedStopPredicate(predicate, alias);
      return;
    }
    case "not": {
      assertSupportedStopPredicate(expression.predicate, alias);
      return;
    }
    case "aggregate_comparison":
    case "exists":
    case "in_subquery":
    case "vector_similarity":
    case "fulltext_match":
    case "database_expression_predicate": {
      throw new ConfigurationError(
        "stopExpansion() supports ordinary target-node predicates only.",
      );
    }
  }
}

export function withRecursiveStopExpansion(
  state: QueryBuilderState,
  alias: string,
  expression: PredicateExpression,
  emitStopNode: boolean,
): QueryBuilderState {
  if (typeof emitStopNode !== "boolean")
    throw new ConfigurationError(
      "stopExpansion() emitStopNode must be a boolean.",
    );
  const traversal = state.traversals.find(
    (traversal) =>
      traversal.nodeAlias === alias && traversal.variableLength !== undefined,
  );
  const variableLength = traversal?.variableLength;
  if (traversal === undefined || variableLength === undefined)
    throw new ConfigurationError(
      `stopExpansion() alias "${alias}" must be the target of a recursive traversal.`,
    );
  if (variableLength.stopExpansion !== undefined)
    throw new ConfigurationError(
      `stopExpansion() is already defined for recursive target alias "${alias}".`,
    );
  assertSupportedStopPredicate(expression, alias);
  const updatedTraversal: Traversal = {
    ...traversal,
    variableLength: {
      ...variableLength,
      stopExpansion: { expression, emitStopNode },
    },
  };
  return {
    ...state,
    traversals: state.traversals.map((candidate) =>
      candidate === traversal ? updatedTraversal : candidate,
    ),
  };
}
