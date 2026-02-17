/**
 * Shared utilities for subquery projection shape and type handling.
 */
import { type AggregateExpr, type QueryAst, type ValueType } from "./ast";

/**
 * Normalizes a value type by treating "unknown" as undefined.
 */
function normalizeValueType(valueType?: ValueType): ValueType | undefined {
  if (valueType === undefined || valueType === "unknown") {
    return undefined;
  }
  return valueType;
}

/**
 * Returns true when the type cannot be compared with IN/NOT IN.
 */
export function isUnsupportedInSubqueryValueType(
  valueType?: ValueType,
): boolean {
  const normalized = normalizeValueType(valueType);
  return (
    normalized === "array" ||
    normalized === "object" ||
    normalized === "embedding"
  );
}

/**
 * Returns true when two value types are compatible for IN/NOT IN.
 *
 * Unknown types are treated as compatible (deferred to runtime) to preserve
 * flexibility for untyped fields.
 */
export function isInSubqueryTypeCompatible(
  left?: ValueType,
  right?: ValueType,
): boolean {
  const normalizedLeft = normalizeValueType(left);
  const normalizedRight = normalizeValueType(right);

  if (normalizedLeft === undefined || normalizedRight === undefined) {
    return true;
  }

  return normalizedLeft === normalizedRight;
}

/**
 * Resolves the value type produced by an aggregate projection.
 */
function getAggregateValueType(
  aggregate: AggregateExpr,
): ValueType | undefined {
  switch (aggregate.function) {
    case "count":
    case "countDistinct":
    case "sum":
    case "avg": {
      return "number";
    }
    case "min":
    case "max": {
      return normalizeValueType(aggregate.field.valueType);
    }
  }
}

/**
 * Returns effective projected column value types for a subquery.
 *
 * If selective fields are present, they represent the effective projection.
 * Otherwise, falls back to the explicit projection fields.
 */
function getProjectedValueTypes(
  subquery: QueryAst,
): readonly (ValueType | undefined)[] {
  if (subquery.selectiveFields && subquery.selectiveFields.length > 0) {
    return subquery.selectiveFields.map((field) =>
      normalizeValueType(field.valueType),
    );
  }

  return subquery.projection.fields.map((field) => {
    if (field.source.__type === "aggregate") {
      return getAggregateValueType(field.source);
    }
    return normalizeValueType(field.source.valueType);
  });
}

/**
 * Returns the effective number of columns projected by a subquery.
 */
export function getSubqueryColumnCount(subquery: QueryAst): number {
  return getProjectedValueTypes(subquery).length;
}

/**
 * Returns the value type when a subquery projects exactly one column.
 */
export function getSingleSubqueryColumnValueType(
  subquery: QueryAst,
): ValueType | undefined {
  const valueTypes = getProjectedValueTypes(subquery);
  if (valueTypes.length !== 1) {
    return undefined;
  }
  return valueTypes[0];
}
