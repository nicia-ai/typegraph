import { ConfigurationError } from "../../errors";
import { isPortableCountDistinctValueType } from "../aggregate-value-types";
import type { DatabaseExpression } from "../expressions";
import {
  expressionContainsAggregate,
  isAggregateExpression,
  visitExpressionChildren,
} from "./expression-inspection";

/** SQL grouping needs every value outside an aggregate to be group-determined. */
export function validateRelationAggregation(
  projection: readonly DatabaseExpression[],
  groupBy: readonly DatabaseExpression[] = [],
): void {
  if (
    groupBy.some(
      (expression) => !isPortableCountDistinctValueType(expression.valueType),
    )
  )
    throw new ConfigurationError(
      "Relation GROUP BY requires portable scalar expressions.",
    );
  if (groupBy.some((expression) => expressionContainsAggregate(expression)))
    throw new ConfigurationError(
      "Relation GROUP BY cannot contain aggregate expressions.",
    );
  if (
    groupBy.length === 0 &&
    !projection.some((expression) => expressionContainsAggregate(expression))
  )
    return;

  // Scope was validated at construction; the serializable node is the SQL expression's identity.
  const grouped = new Set(
    groupBy.map((expression) => JSON.stringify(expression.node)),
  );
  function validate(expression: DatabaseExpression): void {
    if (
      isAggregateExpression(expression) ||
      grouped.has(JSON.stringify(expression.node))
    )
      return;
    if (
      expression.node.kind === "field" ||
      expression.node.kind === "outer_reference"
    )
      throw new ConfigurationError(
        "Every projected field outside an aggregate must be determined by GROUP BY.",
      );
    visitExpressionChildren(expression, (operand) => {
      validate(operand);
    });
  }
  for (const expression of projection) validate(expression);
}
