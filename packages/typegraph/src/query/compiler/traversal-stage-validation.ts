import { UnsupportedPredicateError } from "../../errors";
import type {
  FieldRef,
  PredicateExpression,
  QueryAst,
  Traversal,
} from "../ast";
import { visitExpressionFields } from "./standard-pass-pipeline";

/** Refuses predicates that an independently compiled traversal stage cannot evaluate. */
export function assertTraversalStagePredicatesSupported(
  ast: QueryAst,
  traversal: Traversal,
  index: number,
): void {
  const stageTargets = new Set([
    traversal.edgeAlias,
    traversal.nodeAlias,
    ...(index === 0 ? [ast.start.alias] : []),
  ]);

  for (const predicate of ast.predicates) {
    if (!stageTargets.has(predicate.targetAlias)) continue;
    visitPredicateFields(predicate.expression, (field) => {
      if (field.alias !== predicate.targetAlias) {
        throw new UnsupportedPredicateError(
          `Traversal stage predicate for alias "${predicate.targetAlias}" cannot evaluate cross-alias reference "${field.alias}"; use completed where() for comparisons between aliases.`,
        );
      }
    });
  }
}

function visitPredicateFields(
  expression: PredicateExpression,
  visit: (field: FieldRef) => void,
): void {
  switch (expression.__type) {
    case "comparison": {
      visit(expression.left);
      if (
        !Array.isArray(expression.right) &&
        expression.right.__type === "field_ref"
      )
        visit(expression.right);
      return;
    }
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op":
    case "in_subquery":
    case "vector_similarity":
    case "fulltext_match": {
      visit(expression.field);
      return;
    }
    case "aggregate_comparison": {
      visit(expression.aggregate.field);
      return;
    }
    case "and":
    case "or": {
      for (const operand of expression.predicates)
        visitPredicateFields(operand, visit);
      return;
    }
    case "not": {
      visitPredicateFields(expression.predicate, visit);
      return;
    }
    case "database_expression_predicate": {
      visitExpressionFields(expression.expression, visit);
      return;
    }
    case "exists": {
      return;
    }
  }
}
