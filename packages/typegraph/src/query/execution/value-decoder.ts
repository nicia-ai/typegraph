/**
 * Value decoding utilities for query execution.
 *
 * Selective projection queries return values extracted directly from JSON
 * columns. Some dialects return booleans/numbers as different JS types, and
 * arrays/objects may be returned as JSON text. This module normalizes those
 * values based on schema type information.
 */

import {
  decodeStatedDate,
  decodeStoredDate,
  decodeStoredValue,
  storedReadPlan,
} from "../../store/stored-date-revival";
import { type ValueType } from "../ast";
import { type DateOrigin } from "../expressions";
import { type FieldTypeInfo } from "../schema-introspector";

/**
 * A date a query expression yields, decoded by the leaf its origin names: a
 * date the caller stated (`dateOrigin: "stated"` — a literal, a parameter, or
 * a composition of only those) by {@link decodeStatedDate}, which returns the
 * `Date` stated; every other date, which is stored property text, by the
 * strict {@link decodeStoredDate}. The one choice every query terminal makes.
 */
export function decodeExpressionDate(
  value: unknown,
  origin: DateOrigin | undefined,
): unknown {
  return origin === "stated" ?
      decodeStatedDate(value)
    : decodeStoredDate(value);
}

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

  // Every position the field's typing says reads as a `Date` — the field
  // itself, or one nested in an object, array or record — is decoded by the
  // one read owner, exactly as a whole row's props are.
  return decodeStoredValue(
    storedReadPlan(typeInfo),
    decodeByValueType(normalized, typeInfo.valueType),
  );
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
    default: {
      const _exhaustive: never = valueType;
      void _exhaustive;
      return value;
    }
  }
}
