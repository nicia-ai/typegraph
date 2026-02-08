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
      if (current.shape && segment in current.shape) {
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
