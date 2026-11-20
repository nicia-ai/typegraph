/**
 * Which literal and parameter values a database expression compares, and
 * what it compares each one with. The one enumeration the build-time operand
 * check, prepared-query binding validation, and the predicate builder's
 * subquery membership share, so no path can see a different set of operands.
 *
 * Every function here switches over every expression node kind, so a new
 * kind is a compile error until it states whether it forwards or compares a
 * value.
 */
import type { QueryAst } from "./ast";
import type { DatabaseExpression, DatabaseExpressionNode } from "./expressions";

/**
 * The side of a comparison a value is compared with: the value of
 * `expression` itself, or (for array membership) each element of it.
 */
export type ExpressionComparedSide = Readonly<{
  expression: DatabaseExpression;
  position: "value" | "element";
}>;

/**
 * @internal A literal or parameter whose value an expression compares, with
 * the side it is compared against.
 */
export type ComparedExpressionOperand = Readonly<{
  compared: ExpressionComparedSide;
  operand: DatabaseExpression;
}>;

function assertNever(value: never): never {
  throw new TypeError(`Unknown database expression node: ${String(value)}`);
}

/**
 * The literal and parameter leaves whose value becomes `expression`'s value:
 * the expression itself when it is one; a leaf a `coalesce` operand or a
 * conditional branch forwards; the leaf a `min` or `max` of it returns; or the
 * leaf a `$scalar()` subquery projects. Any other node computes its value, so
 * no leaf under it is compared as-is.
 */
function forwardedValueLeaves(
  expression: DatabaseExpression,
): readonly DatabaseExpression[] {
  const node: DatabaseExpressionNode = expression.node;
  switch (node.kind) {
    case "literal":
    case "parameter": {
      return [expression];
    }
    case "coalesce": {
      return node.operands.flatMap((operand) => forwardedValueLeaves(operand));
    }
    case "conditional": {
      return [
        ...forwardedValueLeaves(node.then),
        ...forwardedValueLeaves(node.otherwise),
      ];
    }
    case "aggregate": {
      return (
          (node.operator === "min" || node.operator === "max") &&
            node.operand !== undefined
        ) ?
          forwardedValueLeaves(node.operand)
        : [];
    }
    case "scalar_subquery": {
      return subqueryProjectedValueLeaves(node.subquery);
    }
    case "arithmetic":
    case "array_contains":
    case "boolean":
    case "collect":
    case "comparison":
    case "exists_subquery":
    case "field":
    case "not":
    case "null_check":
    case "numeric_conversion":
    case "outer_reference": {
      return [];
    }
    default: {
      return assertNever(node);
    }
  }
}

/**
 * The literal and parameter leaves a single-column subquery projects — the
 * values a `$scalar()` subquery returns, or an `in` / `notIn` subquery
 * compares its field with. Empty for any other projection.
 */
export function subqueryProjectedValueLeaves(
  subquery: QueryAst,
): readonly DatabaseExpression[] {
  const fields = subquery.projection.fields;
  const only = fields[0];
  if (fields.length !== 1 || only === undefined) return [];
  return only.source.__type === "database_expression" ?
      forwardedValueLeaves(only.source)
    : [];
}

/**
 * @internal Every literal and parameter the expression node `expression`
 * compares, each with the side it is compared against. A comparison compares
 * each side's forwarded leaves with the other side
 * (`expr.gte(expr.coalesce(d.publishedAt, expr.literal(fallback)),
 * expr.param("from", "date"))` compares both `fallback` and `from`); array
 * membership compares its element's forwarded leaves with each element of
 * the array. Other nodes compare nothing themselves — their operands are
 * enumerated where they are built or walked.
 */
export function comparedExpressionOperands(
  expression: DatabaseExpression,
): readonly ComparedExpressionOperand[] {
  const node: DatabaseExpressionNode = expression.node;
  switch (node.kind) {
    case "comparison": {
      return [
        ...forwardedValueLeaves(node.right).map((operand) => ({
          compared: { expression: node.left, position: "value" as const },
          operand,
        })),
        ...forwardedValueLeaves(node.left).map((operand) => ({
          compared: { expression: node.right, position: "value" as const },
          operand,
        })),
      ];
    }
    case "array_contains": {
      return forwardedValueLeaves(node.element).map((operand) => ({
        compared: { expression: node.array, position: "element" as const },
        operand,
      }));
    }
    case "aggregate":
    case "arithmetic":
    case "boolean":
    case "coalesce":
    case "collect":
    case "conditional":
    case "exists_subquery":
    case "field":
    case "literal":
    case "not":
    case "null_check":
    case "numeric_conversion":
    case "outer_reference":
    case "parameter":
    case "scalar_subquery": {
      return [];
    }
    default: {
      return assertNever(node);
    }
  }
}
