import { UnsupportedPredicateError } from "../../errors";
import { assertPortableCountDistinctValueType } from "../aggregate-value-types";
import { type AggregateExpr, type ValueType } from "../ast";

const MIN_MAX_VALUE_TYPES = new Set<ValueType>(["date", "number", "string"]);

/** Validates the portable scalar contract of an aggregate operand. */
export function validateAggregateOperand(
  expression: AggregateExpr,
  resolvedValueType: ValueType | undefined = expression.field.valueType,
): void {
  if (resolvedValueType === undefined || resolvedValueType === "unknown")
    return;

  if (expression.function === "countDistinct") {
    assertPortableCountDistinctValueType(resolvedValueType);
  }

  if (
    (expression.function === "sum" || expression.function === "avg") &&
    resolvedValueType !== "number"
  ) {
    throw new UnsupportedPredicateError(
      `${expression.function.toUpperCase()} requires a numeric field; ` +
        `received ${resolvedValueType} for alias "${expression.field.alias}".`,
    );
  }

  if (
    (expression.function === "min" || expression.function === "max") &&
    !MIN_MAX_VALUE_TYPES.has(resolvedValueType)
  ) {
    throw new UnsupportedPredicateError(
      `${expression.function.toUpperCase()} supports string, number, and date fields; ` +
        `received ${resolvedValueType} for alias "${expression.field.alias}".`,
    );
  }
}
