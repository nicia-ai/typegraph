/**
 * Temporal Filter Compilation
 *
 * Generates SQL clauses for temporal filtering based on valid_from/valid_to
 * and deleted_at timestamps. Consolidates the previously duplicated temporal
 * filter functions into a single, parameterized implementation.
 */
import { type SQL, sql } from "drizzle-orm";

import { type TemporalMode } from "../../core/types";

/**
 * Temporal filter options.
 */
export type TemporalFilterOptions = Readonly<{
  /** The temporal mode to apply */
  mode: TemporalMode;
  /** Timestamp for asOf queries (required when mode is "asOf") */
  asOf?: string | undefined;
  /** Optional table alias prefix for column references */
  tableAlias?: string | undefined;
  /** Optional execution-time current timestamp SQL expression */
  currentTimestamp?: SQL | undefined;
}>;

/**
 * Compiles a temporal filter to SQL.
 *
 * This is the unified temporal filter function that handles all temporal modes
 * and optional table alias prefixes. It replaces the previous three separate
 * functions (compileTemporalFilter, compileEdgeTemporalFilter, compileNodeTemporalFilter).
 *
 * @param options - Temporal filter configuration
 * @returns SQL clause for the temporal filter
 *
 * @example
 * ```typescript
 * // Without table alias (for CTEs)
 * compileTemporalFilter({ mode: "current" })
 * // → deleted_at IS NULL AND (valid_from IS NULL OR ...) AND ...
 *
 * // With table alias (for JOINs)
 * compileTemporalFilter({ mode: "current", tableAlias: "e" })
 * // → e.deleted_at IS NULL AND (e.valid_from IS NULL OR ...) AND ...
 *
 * // AsOf mode
 * compileTemporalFilter({ mode: "asOf", asOf: "2024-01-01T00:00:00Z" })
 * // → deleted_at IS NULL AND (valid_from IS NULL OR valid_from <= '2024-01-01...') AND ...
 * ```
 */
export function compileTemporalFilter(options: TemporalFilterOptions): SQL {
  const { mode, asOf, tableAlias, currentTimestamp } = options;

  // Build column references with optional prefix
  const prefix = tableAlias ? sql.raw(`${tableAlias}.`) : sql.raw("");
  const deletedAt = sql`${prefix}deleted_at`;
  const validFrom = sql`${prefix}valid_from`;
  const validTo = sql`${prefix}valid_to`;

  switch (mode) {
    case "current": {
      const now = currentTimestamp ?? sql`CURRENT_TIMESTAMP`;
      return sql`${deletedAt} IS NULL AND (${validFrom} IS NULL OR ${validFrom} <= ${now}) AND (${validTo} IS NULL OR ${validTo} > ${now})`;
    }

    case "asOf": {
      // asOf is guaranteed to be defined - validated in QueryBuilder.temporal()
      const timestamp = asOf!;
      return sql`${deletedAt} IS NULL AND (${validFrom} IS NULL OR ${validFrom} <= ${timestamp}) AND (${validTo} IS NULL OR ${validTo} > ${timestamp})`;
    }

    case "includeEnded": {
      // Include records that have ended but not been deleted
      return sql`${deletedAt} IS NULL`;
    }

    case "includeTombstones": {
      // Include everything, no filter
      return sql.raw("1=1");
    }
  }
}

/**
 * Extracts temporal options from a query AST.
 *
 * @param ast - Query AST with temporalMode
 * @param tableAlias - Optional table alias for column references
 * @returns TemporalFilterOptions for use with compileTemporalFilter
 */
export function extractTemporalOptions(
  ast: { temporalMode: { mode: TemporalMode; asOf?: string } },
  tableAlias?: string,
): TemporalFilterOptions {
  return {
    mode: ast.temporalMode.mode,
    asOf: ast.temporalMode.asOf,
    tableAlias,
  };
}
