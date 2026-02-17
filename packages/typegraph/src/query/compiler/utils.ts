/**
 * Shared Compiler Utilities
 *
 * Functions and constants shared between the standard and recursive compilers.
 */
import { type SQL, sql } from "drizzle-orm";

import { type AggregateExpr, type FieldRef, type SelectiveField } from "../ast";

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

export function quoteIdentifier(identifier: string): SQL {
  return sql.raw(`"${identifier.replaceAll('"', '""')}"`);
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
