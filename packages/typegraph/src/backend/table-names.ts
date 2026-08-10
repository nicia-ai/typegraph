/**
 * The one owner of "which physical relations does this offline operation
 * touch?" for the maintenance entrypoints that accept a `tableNames` override.
 */
import {
  createSqlSchema,
  type ResolvedSqlTableNames,
  type SqlTableNames,
} from "../query/compiler/schema";
import type { GraphBackend } from "./types";

function definedTableNameOverrides(
  override: Partial<SqlTableNames> | undefined,
): Partial<SqlTableNames> {
  if (override === undefined) return {};
  return Object.fromEntries(
    Object.entries(override).filter(([, tableName]) => tableName !== undefined),
  );
}

/**
 * Resolves the relations an offline maintenance call targets.
 *
 * An override is a PATCH over the backend's own names. This matches the
 * `Partial<SqlTableNames>` input contract: naming only `nodes`, for example,
 * must not silently retarget edges and recorded relations to the built-in
 * defaults. `migrateLegacyRecordedTime` and
 * `repairInvertedValidityWindows` share this owner so an offline write can never
 * resolve the same partial override two different ways.
 */
export function resolvedTableNames(
  backend: Pick<GraphBackend, "tableNames">,
  override: Partial<SqlTableNames> | undefined,
): ResolvedSqlTableNames {
  return createSqlSchema({
    ...backend.tableNames,
    ...definedTableNameOverrides(override),
  }).tables;
}
