/**
 * Value decoding utilities for query execution.
 *
 * Selective projection queries return values extracted directly from JSON
 * columns. Some dialects return booleans/numbers as different JS types, and
 * arrays/objects may be returned as JSON text. This module normalizes those
 * values based on schema type information.
 */

import { type ValueType } from "../ast";
import { type FieldTypeInfo } from "../schema-introspector";

export function nullToUndefined(value: unknown): unknown {
  return value === null ? undefined : value;
}

export function decodeSelectedValue(
  value: unknown,
  typeInfo: FieldTypeInfo | undefined,
): unknown {
  const normalized = nullToUndefined(value);
  if (normalized === undefined) return undefined;

  if (typeInfo === undefined) {
    return normalized;
  }

  return decodeByValueType(normalized, typeInfo.valueType);
}

function decodeByValueType(value: unknown, valueType: ValueType): unknown {
  switch (valueType) {
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") {
        if (value === "0") return false;
        if (value === "1") return true;
        if (value.toLowerCase() === "true") return true;
        if (value.toLowerCase() === "false") return false;
      }
      return Boolean(value);
    }
    case "number": {
      if (typeof value === "number") return value;
      if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isNaN(parsed) ? value : parsed;
      }
      return value;
    }
    case "array":
    case "object":
    case "embedding": {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      const looksJson = trimmed.startsWith("[") || trimmed.startsWith("{");
      if (!looksJson) return value;
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return value;
      }
    }
    case "string":
    case "date":
    case "unknown": {
      return value;
    }
  }
}
