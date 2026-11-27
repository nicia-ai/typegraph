/**
 * Shared Compiler Utilities
 *
 * Functions and constants shared between the standard and recursive compilers.
 */
import { type AggregateExpr, type FieldRef, type SelectiveField } from "../ast";
import { parseJsonPointer } from "../json-pointer";
import { sql, type SqlFragment } from "../sql-fragment";
import { getFieldPointer } from "./predicates";
import { selectiveExtractionIsFieldValue } from "./typed-json-extract";

// ============================================================
// Constants
// ============================================================

export const NODE_COLUMNS = [
  "id",
  "kind",
  "props",
  "version",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

export const EDGE_COLUMNS = [
  "id",
  "kind",
  "from_id",
  "to_id",
  "props",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

export type RequiredColumnsByAlias = ReadonlyMap<string, ReadonlySet<string>>;
export const EMPTY_REQUIRED_COLUMNS = new Set<string>();

// ============================================================
// SQL Helpers
// ============================================================

export function quoteIdentifier(identifier: string): SqlFragment {
  return sql.identifier(identifier);
}

// ============================================================
// Column Projection
// ============================================================

/**
 * Determines whether a column should be included in the projection.
 *
 * @param requiredColumns - Set of columns required by the query, or undefined to include all.
 * @param column - The column name to check.
 * @param alwaysRequiredColumns - Optional set of columns that are always projected
 *   (e.g. join keys in recursive CTEs). Pass only from recursive compiler callers.
 */
export function shouldProjectColumn(
  requiredColumns: ReadonlySet<string> | undefined,
  column: string,
  alwaysRequiredColumns?: ReadonlySet<string>,
): boolean {
  if (alwaysRequiredColumns?.has(column)) return true;
  if (requiredColumns === undefined) return true;
  return requiredColumns.has(column);
}

// ============================================================
// Required Column Tracking
// ============================================================

export function addRequiredColumn(
  requiredColumnsByAlias: Map<string, Set<string>>,
  alias: string,
  column: string,
): void {
  const existing = requiredColumnsByAlias.get(alias);
  if (existing) {
    existing.add(column);
    return;
  }
  requiredColumnsByAlias.set(alias, new Set([column]));
}

export function markFieldRefAsRequired(
  requiredColumnsByAlias: Map<string, Set<string>>,
  field: FieldRef,
): void {
  const column = field.path[0];
  if (column === undefined) return;
  addRequiredColumn(requiredColumnsByAlias, field.alias, column);
}

export function mapSelectiveSystemFieldToColumn(field: string): string {
  if (field === "fromId") return "from_id";
  if (field === "toId") return "to_id";
  if (field.startsWith("meta.")) {
    return field
      .slice(5)
      .replaceAll(/([A-Z])/g, "_$1")
      .toLowerCase();
  }
  return field;
}

export function markSelectiveFieldAsRequired(
  requiredColumnsByAlias: Map<string, Set<string>>,
  field: SelectiveField,
): void {
  if (field.isSystemField) {
    addRequiredColumn(
      requiredColumnsByAlias,
      field.alias,
      mapSelectiveSystemFieldToColumn(field.field),
    );
    return;
  }
  addRequiredColumn(requiredColumnsByAlias, field.alias, "props");
}

function getTopLevelPropsFieldName(field: FieldRef): string | undefined {
  const pointer = getFieldPointer(field);
  if (pointer === undefined) return undefined;

  const segments = parseJsonPointer(pointer);
  return segments.length === 1 ? segments[0] : undefined;
}

/**
 * The selectively projected field whose extracted column holds the value an
 * ORDER BY term over `field` sorts by, or `undefined` when no column does
 * and the term must read the field itself. A selective column holds that
 * value only when it reads the same top-level property with the same typed
 * extraction (`selectiveExtractionIsFieldValue`): a property of unknown type
 * is selected as its JSON value, while it is ordered and compared as the
 * value `compileFieldValue` reads, which on PostgreSQL is its text.
 *
 * The one decision every consumer of an ordering term makes: the ORDER BY,
 * the column-pruning pass and late materialization's sort keys.
 */
export function findSelectiveFieldHoldingOrderValue(
  selectiveFields: readonly SelectiveField[] | undefined,
  field: FieldRef,
): SelectiveField | undefined {
  if (selectiveFields === undefined || selectiveFields.length === 0) {
    return undefined;
  }

  const propsFieldName = getTopLevelPropsFieldName(field);
  if (propsFieldName === undefined) return undefined;

  return selectiveFields.find(
    (selectiveField) =>
      !selectiveField.isSystemField &&
      selectiveField.alias === field.alias &&
      selectiveField.field === propsFieldName &&
      selectiveField.valueType === field.valueType &&
      selectiveExtractionIsFieldValue(selectiveField.valueType),
  );
}

// ============================================================
// AST Type Guards
// ============================================================

export function isIdFieldRef(field: FieldRef): boolean {
  return (
    field.path.length === 1 &&
    field.path[0] === "id" &&
    field.jsonPointer === undefined
  );
}

export function isAggregateExpr(
  source: FieldRef | AggregateExpr,
): source is AggregateExpr {
  return "__type" in source && source.__type === "aggregate";
}
