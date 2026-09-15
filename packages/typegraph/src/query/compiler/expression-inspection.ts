import type { DatabaseExpression } from "../expressions";

export function isAggregateExpression(expression: DatabaseExpression): boolean {
  return (
    expression.node.kind === "aggregate" || expression.node.kind === "collect"
  );
}

export function expressionContainsAggregate(
  expression: DatabaseExpression,
): boolean {
  if (isAggregateExpression(expression)) return true;
  let found = false;
  visitExpressionChildren(expression, (operand) => {
    if (expressionContainsAggregate(operand)) found = true;
  });
  return found;
}

export function visitExpressionChildren(
  expression: DatabaseExpression,
  visit: (operand: DatabaseExpression) => void,
): void {
  const node = expression.node;
  switch (node.kind) {
    case "arithmetic":
    case "comparison": {
      visit(node.left);
      visit(node.right);
      return;
    }
    case "boolean":
    case "coalesce": {
      for (const operand of node.operands) visit(operand);
      return;
    }
    case "not":
    case "null_check":
    case "numeric_conversion": {
      visit(node.operand);
      return;
    }
    case "aggregate": {
      if (node.operand !== undefined) visit(node.operand);
      return;
    }
    case "collect": {
      visit(node.operand);
      for (const order of node.orderBy) visit(order.expression);
      return;
    }
    case "conditional": {
      visit(node.condition);
      visit(node.then);
      visit(node.otherwise);
      return;
    }
    case "outer_reference": {
      visit(node.expression);
      return;
    }
    case "exists_subquery":
    case "scalar_subquery":
    case "field":
    case "literal":
    case "parameter": {
      return;
    }
  }
}
