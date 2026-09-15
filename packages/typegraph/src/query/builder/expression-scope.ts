import { ConfigurationError } from "../../errors";
import type { DatabaseExpression } from "../expressions";
import type { QueryBuilderConfig } from "./types";

const scopes = new WeakMap<QueryBuilderConfig, symbol>();

/** A builder chain shares a scope; a new query, including a subquery, gets its own. */
export function getExpressionScope(config: QueryBuilderConfig): symbol {
  const existing = scopes.get(config);
  if (existing !== undefined) return existing;
  const scope = Symbol("query expression scope");
  scopes.set(config, scope);
  return scope;
}

/** Refuses captured expressions from other query chains before SQL compilation. */
export function assertExpressionScope(
  expression: DatabaseExpression,
  scope: symbol,
): void {
  const node = expression.node;
  switch (node.kind) {
    case "field":
    case "outer_reference":
    case "exists_subquery":
    case "scalar_subquery": {
      if (expression.scopeIdentity !== scope)
        throw new ConfigurationError(
          "Expression belongs to another query scope; use the subquery outer context for correlations.",
        );
      return;
    }
    case "literal":
    case "parameter": {
      return;
    }
    case "arithmetic":
    case "comparison": {
      assertExpressionScope(node.left, scope);
      assertExpressionScope(node.right, scope);
      return;
    }
    case "boolean":
    case "coalesce": {
      for (const operand of node.operands)
        assertExpressionScope(operand, scope);
      return;
    }
    case "not":
    case "null_check":
    case "numeric_conversion": {
      assertExpressionScope(node.operand, scope);
      return;
    }
    case "aggregate": {
      if (node.operand !== undefined)
        assertExpressionScope(node.operand, scope);
      return;
    }
    case "collect": {
      assertExpressionScope(node.operand, scope);
      for (const order of node.orderBy)
        assertExpressionScope(order.expression, scope);
      if (node.filter !== undefined) assertExpressionScope(node.filter, scope);
      return;
    }
    case "conditional": {
      assertExpressionScope(node.condition, scope);
      assertExpressionScope(node.then, scope);
      assertExpressionScope(node.otherwise, scope);
    }
  }
}

/** Recognizes expression values at dynamic builder boundaries. */
export function isDatabaseExpression(
  value: unknown,
): value is DatabaseExpression {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    value.__type === "database_expression"
  );
}
