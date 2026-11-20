import { canonicalDateOperandText, type PropsDateValue } from "../utils/date";
import { hasOwnKey } from "../utils/object";
import { type JsonPointer, parseJsonPointer } from "./json-pointer";
import { type FieldTypeInfo } from "./schema-introspector";

function isJsonPointerIndex(segment: string): boolean {
  return /^\d+$/.test(segment);
}

export function resolveFieldTypeInfoAtJsonPointer(
  typeInfo: FieldTypeInfo | undefined,
  pointer: JsonPointer,
): FieldTypeInfo | undefined {
  if (!typeInfo) {
    return undefined;
  }

  const segments = parseJsonPointer(pointer);

  let current: FieldTypeInfo | undefined = typeInfo;
  for (const segment of segments) {
    if (!current) {
      return undefined;
    }

    if (current.valueType === "array") {
      if (!isJsonPointerIndex(segment)) {
        throw new Error(
          `JSON Pointer segment "${segment}" is not a valid array index`,
        );
      }
      current = current.elementTypeInfo;
      continue;
    }

    if (current.valueType === "object") {
      if (isJsonPointerIndex(segment)) {
        throw new Error(
          "JSON Pointer numeric segments are only valid for arrays",
        );
      }
      if (current.shape && hasOwnKey(current.shape, segment)) {
        current = current.shape[segment];
        continue;
      }
      if (current.recordValueType) {
        current = current.recordValueType;
        continue;
      }
      throw new Error(
        `JSON Pointer segment "${segment}" is not defined on object schema`,
      );
    }

    throw new Error(
      `JSON Pointer segment "${segment}" cannot traverse ${current.valueType}`,
    );
  }

  return current;
}

/** The type of each element of an array field, when the schema declares one. */
function elementTypeInfo(info: FieldTypeInfo): FieldTypeInfo | undefined {
  if (info.elementTypeInfo !== undefined) return info.elementTypeInfo;
  return info.elementType === undefined ?
      undefined
    : { valueType: info.elementType };
}

/** Whether a value of this type holds a date anywhere. */
export function fieldTypeHoldsDate(info: FieldTypeInfo): boolean {
  if (info.valueType === "date") return true;
  const element = elementTypeInfo(info);
  if (element !== undefined && fieldTypeHoldsDate(element)) return true;
  if (
    info.recordValueType !== undefined &&
    fieldTypeHoldsDate(info.recordValueType)
  )
    return true;
  return Object.values(info.shape ?? {}).some((field) =>
    fieldTypeHoldsDate(field),
  );
}

/**
 * The first value at a date-typed position of `value` — read through the
 * schema type `info`, the typing the query compiler casts a date by — that no
 * backend stores and compares as a date: one `canonicalDateOperandText`
 * refuses. For a write that carries props as stated text rather than as the
 * `Date`s a schema parse yields (a trusted import stream), the same decision
 * the store's own writes make on `Date`s (`findUnstorableDate`). Absent and
 * null values state nothing.
 */
export function findUnstorableDateValue(
  value: unknown,
  info: FieldTypeInfo | undefined,
  path: string,
): PropsDateValue | undefined {
  if (info === undefined || value === undefined || value === null)
    return undefined;
  if (info.valueType === "date") {
    return canonicalDateOperandText(value) === undefined ?
        { path, value }
      : undefined;
  }
  if (info.valueType === "array") {
    const element = elementTypeInfo(info);
    if (!Array.isArray(value) || element === undefined) return undefined;
    for (const [index, item] of (value as readonly unknown[]).entries()) {
      const found = findUnstorableDateValue(item, element, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (
    info.valueType !== "object" ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return undefined;
  for (const [key, item] of Object.entries(value)) {
    const fieldInfo =
      info.shape !== undefined && hasOwnKey(info.shape, key) ?
        info.shape[key]
      : info.recordValueType;
    const found = findUnstorableDateValue(item, fieldInfo, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}
