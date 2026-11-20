/**
 * Which literal and parameter values a database expression compares, and
 * what it compares each one with. The one enumeration the build-time operand
 * check, prepared-query binding validation, the predicate builder's subquery
 * membership, and the compiler's date typing share, so no path can see a
 * different set of operands.
 *
 * Every function here switches over every expression node kind, so a new
 * kind is a compile error until it states whether it forwards or compares a
 * value.
 */
import type { FieldRef, QueryAst, ValueType } from "./ast";
import type { DatabaseExpression, DatabaseExpressionNode } from "./expressions";
import { getSingleSubqueryColumnValueType } from "./subquery-utils";

/**
 * Whether a comparison against a value of `valueType` is a date comparison:
 * one SQLite decides on the stored text and PostgreSQL on the parsed
 * `timestamptz`. The one place that decision is made. A date-typed property
 * (`FieldRef.valueType`), a `$meta` timestamp, and a composed expression
 * whose value is a date (`expr.coalesce(d.publishedAt, …)`,
 * `DatabaseExpression.valueType`) all reach it, so a literal and a binding
 * compared with any of them are held to the same operand contract, and the
 * compiler types the same values as dates.
 */
export function isDateComparison(valueType: ValueType | undefined): boolean {
  return valueType === "date";
}

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
 * The nodes whose value becomes `expression`'s value unchanged: the
 * expression itself when it is a literal, a parameter or a `$scalar()`
 * subquery; one a `coalesce` operand or a conditional branch forwards; or the
 * one a `min` or `max` of it returns. Any other node computes its value, so
 * nothing under it is compared as-is.
 */
function forwardedValueSources(
  expression: DatabaseExpression,
): readonly DatabaseExpression[] {
  const node: DatabaseExpressionNode = expression.node;
  switch (node.kind) {
    case "literal":
    case "parameter":
    case "scalar_subquery": {
      return [expression];
    }
    case "coalesce": {
      return node.operands.flatMap((operand) => forwardedValueSources(operand));
    }
    case "conditional": {
      return [
        ...forwardedValueSources(node.then),
        ...forwardedValueSources(node.otherwise),
      ];
    }
    case "aggregate": {
      return (
          (node.operator === "min" || node.operator === "max") &&
            node.operand !== undefined
        ) ?
          forwardedValueSources(node.operand)
        : [];
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
 * The literal and parameter leaves whose value becomes `expression`'s value:
 * each forwarded source ({@link forwardedValueSources}) that is one, and the
 * leaves a forwarded `$scalar()` subquery projects.
 */
function forwardedValueLeaves(
  expression: DatabaseExpression,
): readonly DatabaseExpression[] {
  return forwardedValueSources(expression).flatMap((source) =>
    source.node.kind === "scalar_subquery" ?
      subqueryProjectedValueLeaves(source.node.subquery)
    : [source],
  );
}

/**
 * The literal and parameter leaves a single-column subquery projects — the
 * values a `$scalar()` subquery returns, or an `in` / `notIn` subquery
 * compares its field with. Empty for any other projection.
 */
export function subqueryProjectedValueLeaves(
  subquery: QueryAst,
): readonly DatabaseExpression[] {
  // Selective fields replace the projection the subquery compiles, and are
  // field references, never a literal or parameter.
  if (
    subquery.selectiveFields !== undefined &&
    subquery.selectiveFields.length > 0
  )
    return [];
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

/**
 * The `$scalar()` subqueries `side` forwards that project a literal or
 * parameter, when `side` is compared with a date.
 */
function dateComparedSubqueries(
  side: DatabaseExpression,
  compared: DatabaseExpression,
): readonly DatabaseExpression[] {
  if (!isDateComparison(compared.valueType)) return [];
  return forwardedValueSources(side).filter(
    (source) =>
      source.node.kind === "scalar_subquery" &&
      subqueryProjectedValueLeaves(source.node.subquery).length > 0,
  );
}

/**
 * @internal The `$scalar()` subqueries the comparison `expression` compares
 * with a date that project a literal or parameter — the compared values
 * ({@link comparedExpressionOperands}) whose type the engine cannot infer.
 * PostgreSQL infers a literal or parameter compared directly with a
 * `timestamptz` as one, but types one a subquery projects as `text`, so the
 * comparison fails (`operator does not exist: timestamp with time zone >=
 * text`). The compiler types exactly these as dates
 * (`DialectAdapter.dateValue`); a date a query merely projects is left as
 * it was.
 */
export function dateTypedComparisonSubqueries(
  expression: DatabaseExpression,
): readonly DatabaseExpression[] {
  const node = expression.node;
  if (node.kind !== "comparison") return [];
  return [
    ...dateComparedSubqueries(node.left, node.right),
    ...dateComparedSubqueries(node.right, node.left),
  ];
}

/**
 * The value type an `in` / `notIn` subquery compares its field and each
 * value it projects as: the field's own type, or — when the field reference
 * states none — the type of the column the subquery projects. The one
 * decision the builder's operand check, prepared-query binding validation
 * and the compiler share, so a value the compiler compares as a date is
 * always checked as one.
 */
export function inSubqueryComparisonValueType(
  field: FieldRef,
  subquery: QueryAst,
): ValueType | undefined {
  const fieldValueType =
    field.valueType === "unknown" ? undefined : field.valueType;
  return fieldValueType ?? getSingleSubqueryColumnValueType(subquery);
}

/**
 * @internal Whether an `in` / `notIn` subquery's projected values must be
 * typed as dates when compiled: it compares them as dates
 * ({@link inSubqueryComparisonValueType}) and its projection forwards a
 * literal or parameter, which PostgreSQL would otherwise type as `text`.
 */
export function inSubqueryProjectsDateValue(
  field: FieldRef,
  subquery: QueryAst,
): boolean {
  return (
    isDateComparison(inSubqueryComparisonValueType(field, subquery)) &&
    subqueryProjectedValueLeaves(subquery).length > 0
  );
}
