/**
 * Cursor encoding/decoding for keyset pagination.
 *
 * Cursors are opaque URL-safe base64-encoded JSON containing:
 * - Column values at cursor position
 * - Direction indicator
 * - Version for forward compatibility
 */

import { ValidationError } from "../errors";
import { type OrderSpec } from "./ast";
import { parseJsonPointer } from "./json-pointer";

// ============================================================
// Types
// ============================================================

const CURSOR_VERSION = 1;

/**
 * Internal cursor data structure.
 */
export type CursorData = Readonly<{
  /** Version for forward compatibility */
  v: number;
  /** Direction: 'f' = forward, 'b' = backward */
  d: "f" | "b";
  /** ORDER BY column values at cursor position */
  vals: readonly unknown[];
  /** Column identifiers for validation */
  cols: readonly string[];
}>;

// ============================================================
// Encoding / Decoding
// ============================================================

/**
 * Encodes cursor data to a URL-safe base64 string.
 */
export function encodeCursor(data: CursorData): string {
  const json = JSON.stringify(data);
  // Use URL-safe base64: replace + with -, / with _, remove padding
  return btoa(json)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Decodes a cursor string to cursor data.
 *
 * @throws ValidationError if cursor is invalid or incompatible
 */
export function decodeCursor(cursor: string): CursorData {
  try {
    // Restore standard base64
    let base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    // Add padding if needed
    while (base64.length % 4) {
      base64 += "=";
    }
    const json = atob(base64);
    const raw = JSON.parse(json) as Record<string, unknown>;

    if (typeof raw.v !== "number" || raw.v > CURSOR_VERSION) {
      throw new ValidationError(
        `Unsupported cursor version: ${String(raw.v)}. Maximum supported: ${CURSOR_VERSION}`,
        {
          issues: [
            {
              path: "cursor",
              message: `Cursor version ${String(raw.v)} is not supported`,
            },
          ],
        },
        {
          suggestion: `This cursor was created with a newer version. Re-fetch the data to get a compatible cursor.`,
        },
      );
    }

    if (raw.d !== "f" && raw.d !== "b") {
      throw new ValidationError(`Invalid cursor direction: ${String(raw.d)}`, {
        issues: [
          {
            path: "cursor",
            message: `Direction must be "f" (forward) or "b" (backward)`,
          },
        ],
      });
    }

    if (!Array.isArray(raw.vals) || !Array.isArray(raw.cols)) {
      throw new ValidationError("Invalid cursor structure", {
        issues: [
          {
            path: "cursor",
            message: "Cursor must contain vals and cols arrays",
          },
        ],
      });
    }

    if (raw.vals.length !== raw.cols.length) {
      throw new ValidationError("Cursor column count mismatch", {
        issues: [
          {
            path: "cursor",
            message: `vals (${raw.vals.length}) and cols (${raw.cols.length}) must have same length`,
          },
        ],
      });
    }

    return {
      v: raw.v,
      d: raw.d,
      vals: raw.vals as readonly unknown[],
      cols: raw.cols as readonly string[],
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(
      "Invalid cursor format",
      {
        issues: [{ path: "cursor", message: "Failed to decode cursor" }],
      },
      { cause: error },
    );
  }
}

// ============================================================
// Cursor Building
// ============================================================

/**
 * Builds a column identifier from an order spec.
 *
 * Format: "alias.fieldName" for property fields, "alias.path[0]..." for system fields.
 * Handles two field ref formats:
 * 1. New format: path=["props"], jsonPointer="/name"
 * 2. Legacy format: path=["props", "name"]
 *
 * In both cases, outputs flattened format "p.name" to match the flattened API.
 */
export function buildColumnId(spec: OrderSpec): string {
  const { alias, path, jsonPointer } = spec.field;

  // New format: path=["props"] with jsonPointer="/fieldName"
  // jsonPointer is a branded string like "/name" or "/nested/field"
  if (path.length === 1 && path[0] === "props" && jsonPointer) {
    const parts = (jsonPointer as string).split("/").filter(Boolean);
    return `${alias}.${parts.join(".")}`;
  }

  // Legacy format: path=["props", "fieldName", ...] without jsonPointer
  if (path.length >= 2 && path[0] === "props") {
    return `${alias}.${path.slice(1).join(".")}`;
  }

  // System fields (id, kind) or other paths
  return `${alias}.${path.join(".")}`;
}

/**
 * Extracts the value for a cursor column from a result row.
 *
 * The row can be in two formats:
 * 1. Raw database row with flat column names
 * 2. Mapped result with alias-keyed nested data
 *
 * For mapped results, we navigate through the path and then jsonPointer.
 */
export function extractCursorValue(
  row: Record<string, unknown>,
  spec: OrderSpec,
): unknown {
  const { alias, path, jsonPointer } = spec.field;

  // Try alias-keyed format first (mapped results)
  let current: unknown = row[alias];
  if (current !== undefined) {
    // Follow path first (e.g., ["props"])
    for (const segment of path) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== "object") return undefined;

      const record = current as Record<string, unknown>;
      if (segment === "props" && !Object.hasOwn(record, segment)) {
        continue;
      }

      current = record[segment];
    }

    // Then follow jsonPointer if present (e.g., "/name")
    if (jsonPointer) {
      const segments = parseJsonPointer(jsonPointer);
      for (const segment of segments) {
        if (current === null || current === undefined) return undefined;
        if (typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[segment];
      }
    }

    return current;
  }

  // Fallback: try direct path lookup for raw rows
  current = row;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Builds a cursor from a result row and order specifications.
 *
 * @param row - The result row (mapped with alias-keyed data)
 * @param orderSpecs - The ORDER BY specifications
 * @param direction - Pagination direction
 * @returns Encoded cursor string
 */
export function buildCursorFromRow(
  row: Record<string, unknown>,
  orderSpecs: readonly OrderSpec[],
  direction: "f" | "b",
): string {
  const vals = orderSpecs.map((spec) => extractCursorValue(row, spec));
  const cols = orderSpecs.map((spec) => buildColumnId(spec));

  return encodeCursor({
    v: CURSOR_VERSION,
    d: direction,
    vals,
    cols,
  });
}

/**
 * Validates that cursor columns match the query's ORDER BY columns.
 *
 * @throws ValidationError if columns don't match
 */
export function validateCursorColumns(
  cursorData: CursorData,
  orderSpecs: readonly OrderSpec[],
): void {
  const expectedCols = orderSpecs.map((spec) => buildColumnId(spec));

  if (cursorData.cols.length !== expectedCols.length) {
    throw new ValidationError(
      `Cursor has ${cursorData.cols.length} columns but query has ${expectedCols.length} ORDER BY columns`,
      {
        issues: [
          {
            path: "cursor",
            message: `Column count mismatch: cursor has ${cursorData.cols.length}, query has ${expectedCols.length}`,
          },
        ],
      },
      {
        suggestion: `The cursor was created with a different ORDER BY. Re-fetch with consistent ordering.`,
      },
    );
  }

  for (const [index, expectedCol] of expectedCols.entries()) {
    if (cursorData.cols[index] !== expectedCol) {
      throw new ValidationError(
        `Cursor column mismatch at position ${index}: expected "${expectedCol}", got "${cursorData.cols[index]}"`,
        {
          issues: [
            {
              path: "cursor",
              message: `Column ${index}: expected "${expectedCol}", got "${cursorData.cols[index]}"`,
            },
          ],
        },
        {
          suggestion: `The cursor was created with a different ORDER BY. Re-fetch with consistent ordering.`,
        },
      );
    }
  }
}
