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

/**
 * Resolves the relations an offline maintenance call targets.
 *
 * The policy is REPLACEMENT, not merge: a stated `override` is the whole
 * naming, so a partial one leaves every relation it does not mention on the
 * built-in default rather than on the backend's own name. That is a decision a
 * caller can be surprised by, which is exactly why it has a single owner —
 * `migrateLegacyRecordedTime` and `repairInvertedValidityWindows` document the
 * same rule and must not be able to drift into two rules.
 */
export function resolvedTableNames(
  backend: Pick<GraphBackend, "tableNames">,
  override: Partial<SqlTableNames> | undefined,
): ResolvedSqlTableNames {
  return createSqlSchema(override ?? backend.tableNames ?? {}).tables;
}
