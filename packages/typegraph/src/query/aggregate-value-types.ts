import { UnsupportedPredicateError } from "../errors";
import type { ValueType } from "./ast";

export type PortableCountDistinctValueType =
  "boolean" | "date" | "number" | "string";

const PORTABLE_COUNT_DISTINCT_VALUE_TYPES: ReadonlySet<ValueType> = new Set([
  "boolean",
  "date",
  "number",
  "string",
]);

export function isPortableCountDistinctValueType(
  valueType: ValueType,
): valueType is PortableCountDistinctValueType {
  return PORTABLE_COUNT_DISTINCT_VALUE_TYPES.has(valueType);
}

export function assertPortableCountDistinctValueType(
  valueType: ValueType,
): asserts valueType is PortableCountDistinctValueType {
  if (!isPortableCountDistinctValueType(valueType)) {
    throw new UnsupportedPredicateError(
      `COUNT DISTINCT supports only string, number, boolean, and date values; received ${valueType}.`,
    );
  }
}
