/**
 * Cursor encoding/decoding for keyset pagination.
 *
 * Cursors are opaque URL-safe base64-encoded JSON containing:
 * - Column values at cursor position
 * - Direction indicator
 * - Version for forward compatibility
 */

import {
  ConfigurationError,
  UnsupportedPredicateError,
  ValidationError,
} from "../errors";
import { canonicalOffsetTimestampText } from "../utils/date";
import { sha256HexSync } from "../utils/hash";
import {
  type FieldRef,
  type NumericRelevanceSortSource,
  type OrderSpec,
  type QueryAst,
} from "./ast";
import {
  assertComparedOperand,
  isTimestampFieldReference,
  systemColumnSelectedPath,
} from "./builder/order-by-field";
import { getNodeKindsForAlias } from "./compiler/predicate-utils";
import {
  extractFulltextMatchPredicates,
  extractVectorSimilarityPredicates,
} from "./compiler/predicates";
import { type RelevanceSortKey } from "./compiler/relevance-order";
import { type SqlDialect } from "./dialect/types";
import { resolveJsonPointer } from "./json-pointer";

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
  /**
   * The search a full-text, vector or hybrid query's cursor positions
   * ({@link searchCursorFingerprint}); absent on any other query's cursor.
   */
  s?: string;
}>;

// ============================================================
// Encoding / Decoding
// ============================================================

/**
 * Encodes cursor data to a URL-safe base64 string.
 */
export function encodeCursor(data: CursorData): string {
  // `btoa` takes Latin-1 only. A character above U+00FF (an id or sort value
  // in another script) is written as its JSON `\u` escape, which decodes to
  // the same string; every cursor that encoded before keeps its bytes.
  // Matched one UTF-16 code unit at a time, so a surrogate pair becomes two
  // escapes, as JSON spells it.
  const json = JSON.stringify(data).replaceAll(
    /[\u0100-\uFFFF]/g,
    (unit) =>
      String.raw`\u${(unit.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
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

    if (typeof raw["v"] !== "number" || raw["v"] > CURSOR_VERSION) {
      throw new ValidationError(
        `Unsupported cursor version: ${String(raw["v"])}. Maximum supported: ${CURSOR_VERSION}`,
        {
          issues: [
            {
              path: "cursor",
              message: `Cursor version ${String(raw["v"])} is not supported`,
            },
          ],
        },
        {
          suggestion: `This cursor was created with a newer version. Re-fetch the data to get a compatible cursor.`,
        },
      );
    }

    if (raw["d"] !== "f" && raw["d"] !== "b") {
      throw new ValidationError(
        `Invalid cursor direction: ${String(raw["d"])}`,
        {
          issues: [
            {
              path: "cursor",
              message: `Direction must be "f" (forward) or "b" (backward)`,
            },
          ],
        },
      );
    }

    if (!Array.isArray(raw["vals"]) || !Array.isArray(raw["cols"])) {
      throw new ValidationError("Invalid cursor structure", {
        issues: [
          {
            path: "cursor",
            message: "Cursor must contain vals and cols arrays",
          },
        ],
      });
    }

    if (raw["vals"].length !== raw["cols"].length) {
      throw new ValidationError("Cursor column count mismatch", {
        issues: [
          {
            path: "cursor",
            message: `vals (${raw["vals"].length}) and cols (${raw["cols"].length}) must have same length`,
          },
        ],
      });
    }

    const search = raw["s"];
    if (search !== undefined && typeof search !== "string") {
      throw new ValidationError("Invalid cursor structure", {
        issues: [{ path: "cursor", message: "Cursor search must be a string" }],
      });
    }

    return {
      v: raw["v"],
      d: raw["d"],
      vals: raw["vals"] as readonly unknown[],
      cols: raw["cols"] as readonly string[],
      ...(search === undefined ? {} : { s: search }),
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
  const { alias, path, jsonPointer } = requireCursorField(spec.field);

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
 * For mapped results, we navigate through the path and then jsonPointer. An
 * ordered system column is read where a selectable node or edge holds it
 * ({@link systemColumnSelectedPath}): `created_at` is `meta.createdAt` there,
 * not a top-level key.
 */
export function extractCursorValue(
  row: Record<string, unknown>,
  spec: OrderSpec,
): unknown {
  const field = requireCursorField(spec.field);
  const { alias, path, jsonPointer } = field;

  // Try alias-keyed format first (mapped results)
  let current: unknown = row[alias];
  if (current !== undefined) {
    // Follow path first (e.g., ["props"])
    for (const segment of selectableFieldPath(field)) {
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
      return resolveJsonPointer(current, jsonPointer);
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

/** The path of `field` on a selectable node or edge. */
function selectableFieldPath(field: FieldRef): readonly string[] {
  const [column] = field.path;
  if (
    field.jsonPointer === undefined &&
    field.path.length === 1 &&
    column !== undefined
  ) {
    return systemColumnSelectedPath(column) ?? field.path;
  }
  return field.path;
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

/** Builds a cursor when the ordered values were projected independently. */
export function buildCursorFromValues(
  values: readonly unknown[],
  orderSpecs: readonly OrderSpec[],
  direction: "f" | "b",
): string {
  return encodeCursor({
    v: CURSOR_VERSION,
    d: direction,
    vals: values,
    cols: orderSpecs.map((spec) => buildColumnId(spec)),
  });
}

/**
 * Validates that cursor columns match the query's ORDER BY columns, and
 * returns the cursor with each value in its field's canonical form
 * ({@link canonicalCursorFieldValue}), the form its position compares.
 *
 * @throws ValidationError if columns don't match
 */
export function validateCursorColumns(
  cursorData: CursorData,
  orderSpecs: readonly OrderSpec[],
  text: CursorTextBinding,
): CursorData {
  validateCursorColumnIds(
    cursorData,
    orderSpecs.map((spec) => buildColumnId(spec)),
  );
  return {
    ...cursorData,
    vals: orderSpecs.map((spec, index) =>
      requireCursorFieldValue(
        cursorData.vals[index],
        spec,
        buildColumnId(spec),
        text,
      ),
    ),
  };
}

/**
 * What a dialect's text can hold (`DialectCapabilities.textAdmitsNul`): the
 * text a cursor carries is bound only when the database can hold it.
 */
export type CursorTextBinding = Readonly<{ textAdmitsNul: boolean }>;

/** A UTF-16 surrogate without its pair: text no database stores or returns. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Whether every string in `value` (itself, or one inside an array or object
 * a key of unknown type carries) is text the database binds unchanged: no
 * lone surrogate on any dialect (a driver re-encodes it, or sends bytes
 * PostgreSQL refuses as invalid UTF-8, and no database returns one, so no
 * terminal issued it), and no NUL where the dialect's text cannot hold one.
 * The one owner of a cursor's text bindability, for field and relevance keys.
 */
function isBindableCursorText(
  value: unknown,
  text: CursorTextBinding,
): boolean {
  if (typeof value === "string")
    return (
      !LONE_SURROGATE.test(value) &&
      (text.textAdmitsNul || !value.includes("\u0000"))
    );
  if (Array.isArray(value))
    return value.every((entry: unknown) => isBindableCursorText(entry, text));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).every(
      ([key, entry]) =>
        isBindableCursorText(key, text) && isBindableCursorText(entry, text),
    );
  return true;
}

/**
 * The value a cursor carries for a key over `spec`'s field, in the form its
 * position compares, or `undefined` when the cursor cannot have been issued
 * for this field: NULL, or a JSON scalar of the field's value type (any JSON
 * value for a field of unknown type, which may hold one) that the field's
 * operand contract accepts (`assertComparedOperand`, the check a predicate's
 * operand gets: a 32-bit integer for `version`, a canonical UTC instant for a
 * timestamp). Accepts every form a terminal has issued, read back as the
 * canonical value every dialect binds: SQLite's `batchOnce()` carries a
 * boolean as `0`/`1` (read as `false`/`true`), and PostgreSQL's carries a
 * timestamp with the session's offset (read as its canonical UTC text,
 * `canonicalOffsetTimestampText`). A cursor holding anything else was not
 * issued for this query, and comparing it would be a database error (a text
 * compared as a PostgreSQL number or timestamp) or a position among values
 * of another type.
 */
function canonicalCursorFieldValue(
  value: unknown,
  spec: OrderSpec,
): Readonly<{ value: unknown }> | undefined {
  if (value === null) return { value };
  if (spec.field.__type !== "field_ref") return { value };
  const reference = spec.field;
  const canonical = canonicalCursorFieldScalar(value, reference);
  if (canonical === undefined) return undefined;
  try {
    assertComparedOperand(reference, canonical.value);
  } catch (error) {
    // The contract's refusals: an operand of the wrong form
    // (ValidationError) or one backends compare differently
    // (UnsupportedPredicateError).
    if (
      error instanceof ValidationError ||
      error instanceof UnsupportedPredicateError
    )
      return undefined;
    throw error;
  }
  return canonical;
}

/**
 * The value of `reference`'s JSON type that `value` is, in its canonical
 * form, or `undefined` when it is a value of another type.
 */
function canonicalCursorFieldScalar(
  value: unknown,
  reference: FieldRef,
): Readonly<{ value: unknown }> | undefined {
  switch (reference.valueType) {
    case "string":
    case "date": {
      if (typeof value !== "string") return undefined;
      if (!isTimestampFieldReference(reference)) return { value };
      const offsetCanonical = canonicalOffsetTimestampText(value);
      return { value: offsetCanonical ?? value };
    }
    case "number": {
      return typeof value === "number" && Number.isFinite(value) ?
          { value }
        : undefined;
    }
    case "boolean": {
      if (typeof value === "boolean") return { value };
      if (value === 0 || value === 1) return { value: value === 1 };
      return undefined;
    }
    case "array":
    case "object":
    case "embedding":
    case "unknown":
    case undefined: {
      return { value };
    }
  }
}

function requireCursorFieldValue(
  value: unknown,
  spec: OrderSpec,
  columnId: string,
  text: CursorTextBinding,
): unknown {
  const canonical = canonicalCursorFieldValue(value, spec);
  if (canonical !== undefined && isBindableCursorText(canonical.value, text))
    return canonical.value;
  throw new ValidationError(
    `Cursor value for column ${columnId} is not a value of its field`,
    {
      issues: [
        {
          path: "cursor",
          message: `Cursor value for column ${columnId} is not a value of its field`,
        },
      ],
    },
    {
      suggestion:
        "This cursor was not issued for this query. Start again without a cursor.",
    },
  );
}

function validateCursorColumnIds(
  cursorData: CursorData,
  expectedCols: readonly string[],
): void {
  if (cursorData.vals.length !== cursorData.cols.length) {
    throw new ValidationError(
      `Cursor has ${cursorData.vals.length} values for ${cursorData.cols.length} columns`,
      {
        issues: [
          {
            path: "cursor",
            message: "Cursor values do not match its columns",
          },
        ],
      },
      {
        suggestion:
          "This cursor was not issued for this query. Start again without a cursor.",
      },
    );
  }
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

/** Cursor encoding currently requires identifiable fields, not computed values. */
export function requireCursorField(field: OrderSpec["field"]): FieldRef {
  if (field.__type !== "field_ref")
    throw new ConfigurationError(
      "Cursor pagination does not support database-expression ordering.",
    );
  return field;
}

// ============================================================
// Keyset cursors over relevance-ordered (search) queries
// ============================================================

/**
 * One key of a keyset cursor: a field the row's order reads, or one of the
 * relevance sort keys a full-text, vector or hybrid statement orders by.
 */
export type KeysetKey =
  | Readonly<{ kind: "field"; spec: OrderSpec }>
  | Readonly<{ kind: "relevance"; key: RelevanceSortKey }>;

/**
 * What a full-text, vector or hybrid query's cursor is bound to: the search it
 * positions ({@link searchCursorFingerprint}) and how its dialect binds the
 * text a numeric relevance key is carried as
 * (`DialectAdapter.relevanceCursorKey.bind`).
 */
export type SearchCursorBinding = CursorTextBinding &
  Readonly<{
    fingerprint: string;
    bindRelevanceKey: (
      text: string,
      source: NumericRelevanceSortSource,
    ) => string | number | undefined;
  }>;

/**
 * The length of a search cursor's fingerprint: a 128-bit SHA-256 prefix, so
 * two distinct searches never in practice accept each other's cursors (a
 * 32-bit hash did: two query texts collided).
 */
const SEARCH_CURSOR_FINGERPRINT_BYTES = 16;

/** The code of the refusal of a cursor that does not position this query. */
export const SEARCH_CURSOR_MISMATCH = "SEARCH_CURSOR_MISMATCH";

/**
 * Identifies the search a full-text, vector or hybrid query runs: everything
 * that decides its candidates and their relevance values (each predicate's
 * target alias and the kinds it searches, query text or embedding, mode, language, metric, k, minimum score
 * and approximate retrieval, and the hybrid fusion), on the dialect that scores
 * it. A cursor records it, and a cursor recorded for another search is
 * refused: its relevance values are positions in another ranking, and another
 * engine's native scores (BM25 against `ts_rank_cd`) rank differently. The
 * query's other filters are not part of it, as they are not part of a
 * non-search cursor.
 */
export function searchCursorFingerprint(
  ast: QueryAst,
  dialect: SqlDialect,
): string {
  const fulltext = extractFulltextMatchPredicates(ast.predicates).map(
    (predicate) => [
      "fulltext",
      predicate.field.alias,
      getNodeKindsForAlias(ast, predicate.field.alias),
      predicate.query,
      predicate.mode,
      predicate.language,
      predicate.limit,
      predicate.minScore,
    ],
  );
  const vector = extractVectorSimilarityPredicates(ast.predicates).map(
    (predicate) => [
      "vector",
      predicate.field.alias,
      getNodeKindsForAlias(ast, predicate.field.alias),
      predicate.field.path,
      predicate.field.jsonPointer,
      predicate.queryEmbedding,
      predicate.metric,
      predicate.limit,
      predicate.minScore,
      predicate.approximate ?? false,
    ],
  );
  // JSON writes an absent option as `null`, so it keeps its position.
  const fusion =
    fulltext.length > 0 && vector.length > 0 ?
      [
        ast.fusion?.method ?? "rrf",
        ast.fusion?.k,
        ast.fusion?.weights?.vector,
        ast.fusion?.weights?.fulltext,
      ]
    : [];
  return sha256HexSync(
    JSON.stringify([dialect, fulltext, vector, fusion]),
    SEARCH_CURSOR_FINGERPRINT_BYTES,
  );
}

/** The column identifier a cursor records for one keyset key. */
function keysetColumnId(key: KeysetKey): string {
  return key.kind === "field" ?
      buildColumnId(key.spec)
    : `@relevance.${key.key.source}`;
}

/**
 * Builds the cursor of a keyset that leads with, or interleaves, relevance
 * keys. `fieldValues` hold the field keys' values in keyset order and
 * `relevanceValues` the relevance keys' values in keyset order, as the
 * statement's cursor-key columns returned them.
 */
export function buildKeysetCursor(
  input: Readonly<{
    keys: readonly KeysetKey[];
    fieldValues: readonly unknown[];
    relevanceValues: readonly unknown[];
    direction: "f" | "b";
    search: SearchCursorBinding;
  }>,
): string {
  const fieldValues = input.fieldValues.values();
  const relevanceValues = input.relevanceValues.values();
  const vals = input.keys.map((key) => {
    if (key.kind === "field") return fieldValues.next().value;
    const value: unknown = relevanceValues.next().value;
    if (relevanceKeyBinding(key.key, value, input.search) === undefined) {
      throw new ConfigurationError(
        `Cursor pagination cannot position a row whose ${key.key.source} relevance key is ${String(value)}: ` +
          "the database returned no exact text for it (on PostgreSQL, extra_float_digits is below 1).",
        { code: "SEARCH_CURSOR_KEY_UNAVAILABLE", operation: "paginate" },
        {
          suggestion:
            "Keep PostgreSQL's extra_float_digits at its default of 1 or above for the sessions that page searches.",
        },
      );
    }
    return value;
  });
  return encodeCursor({
    v: CURSOR_VERSION,
    d: input.direction,
    vals,
    cols: input.keys.map((key) => keysetColumnId(key)),
    s: input.search.fingerprint,
  });
}

/**
 * The value a cursor's comparison binds for a relevance key the cursor carries
 * as `value`, `null` for a NULL key, or `undefined` when `value` is not a
 * key this dialect renders or a value its key type cannot hold.
 * The hybrid node-id tiebreak is text compared as text; a numeric key is the
 * text `DialectAdapter.relevanceCursorKey.select` rendered, bound by its
 * `bind`.
 */
function relevanceKeyBinding(
  key: RelevanceSortKey,
  value: unknown,
  search: SearchCursorBinding,
): string | number | null | undefined {
  // A NULL key (a cosine distance to a zero embedding) is carried as NULL and
  // positioned in the key's null placement.
  // eslint-disable-next-line unicorn/no-null -- a cursor's JSON carries a NULL key as null
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  if (key.source === "hybrid_node_id")
    return isBindableCursorText(value, search) ? value : undefined;
  return search.bindRelevanceKey(value, key.source);
}

/**
 * The values a validated search cursor's keyset position compares against,
 * in keyset order: a field key's value as the cursor carries it, a relevance
 * key's as its dialect binds it ({@link relevanceKeyBinding}).
 */
export function keysetPositionValues(
  cursorData: CursorData,
  keys: readonly KeysetKey[],
  search: SearchCursorBinding,
): readonly unknown[] {
  return keys.map((key, index) => {
    const value = cursorData.vals[index];
    if (key.kind === "field") return value;
    const bound = relevanceKeyBinding(key.key, value, search);
    if (bound === undefined)
      refuseSearchCursor(
        `This cursor's ${key.key.source} relevance key is not a value this backend issued.`,
      );
    return bound;
  });
}

function refuseSearchCursor(message: string): never {
  throw new ValidationError(
    message,
    {
      issues: [{ path: "cursor", code: SEARCH_CURSOR_MISMATCH, message }],
    },
    {
      suggestion:
        "Start again without a cursor: a search query's cursor positions only the search it was issued for, and cursors issued for search queries before relevance-ordered keysets are not accepted.",
    },
  );
}

/**
 * Validates that `cursorData` positions this query's keyset. For a full-text,
 * vector or hybrid query (`search` given), the cursor must have been issued
 * for the same search, carry every relevance key the keyset leads with, and
 * hold each relevance value in the type this dialect carries it in. A cursor
 * that does not is refused with a `ValidationError` whose issue code is
 * {@link SEARCH_CURSOR_MISMATCH}: a cursor issued before this check existed, by
 * another search, by a query that is not a search, or by another dialect. A
 * query that is not a search refuses a search's cursor the same way. Field
 * columns are then checked as for any cursor ({@link validateCursorColumns}),
 * and the cursor is returned with them in their canonical form.
 *
 * @throws ValidationError if the cursor does not position this keyset
 */
export function validateKeysetCursor(
  cursorData: CursorData,
  keys: readonly KeysetKey[],
  search: SearchCursorBinding | undefined,
  text: CursorTextBinding,
): CursorData {
  if (search === undefined) {
    if (cursorData.s !== undefined)
      refuseSearchCursor(
        "This cursor was issued for a full-text, vector or hybrid query and cannot position a query without one.",
      );
  } else if (cursorData.s === undefined) {
    refuseSearchCursor(
      "This cursor does not position a full-text, vector or hybrid query: it was issued for a query without a search, or before search cursors carried their relevance keys.",
    );
  } else if (cursorData.s !== search.fingerprint) {
    refuseSearchCursor(
      "This cursor was issued for a different search (query text, embedding, k, minimum score, metric or fusion).",
    );
  }
  validateCursorColumnIds(
    cursorData,
    keys.map((key) => keysetColumnId(key)),
  );
  const canonical: CursorData = {
    ...cursorData,
    vals: keys.map((key, index) =>
      key.kind === "field" ?
        requireCursorFieldValue(
          cursorData.vals[index],
          key.spec,
          keysetColumnId(key),
          text,
        )
      : cursorData.vals[index],
    ),
  };
  if (search !== undefined) keysetPositionValues(canonical, keys, search);
  return canonical;
}
