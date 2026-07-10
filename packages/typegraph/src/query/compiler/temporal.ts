/**
 * Temporal Filter Compilation
 *
 * Generates SQL clauses for temporal filtering based on valid_from/valid_to
 * and deleted_at timestamps. Consolidates the previously duplicated temporal
 * filter functions into a single, parameterized implementation.
 */
import { type SQL, sql } from "drizzle-orm";

import { type TemporalMode } from "../../core/types";
import { nowIso } from "../../utils/date";

/**
 * The instant every `currentReadInstant()` inside {@link withPinnedReadInstant}
 * returns. Compilation is synchronous and single-threaded, so this dynamic
 * scope needs no async-context machinery: nothing can interleave between the
 * assignment and the `finally` that clears it.
 */
let pinnedReadInstant: string | undefined;

/**
 * Compiles `emit` with one shared "current" instant.
 *
 * A set operation is a single statement whose operands are compiled
 * independently, so each operand would otherwise sample its own `nowIso()`.
 * Two instants microseconds apart mean the two halves of an `INTERSECT` or
 * `EXCEPT` disagree about whether a row created between them is current — the
 * one thing a compound SELECT, evaluated against one snapshot, must never do.
 *
 * Re-entrant: a nested set operation keeps the outer pin rather than resampling.
 */
export function withPinnedReadInstant<T>(emit: () => T): T {
  if (pinnedReadInstant !== undefined) return emit();
  pinnedReadInstant = nowIso();
  try {
    return emit();
  } finally {
    pinnedReadInstant = undefined;
  }
}

/**
 * The "current" valid-time read instant, bound as a parameter — the
 * APPLICATION clock (`nowIso()`), NOT the database clock (`NOW()`).
 *
 * `valid_from` is stamped from the application clock on write, so a "current"
 * read must compare against the same clock. Comparing `valid_from` (app clock)
 * against the database `NOW()` would hide a freshly-created row from an
 * immediately-following current read whenever the app server's clock runs
 * ahead of the database server's clock — a read-after-write consistency
 * violation on Postgres (issue #242; SQLite is single-process so it was never
 * exposed). This binds the same clock the facade search-currency filter
 * (`liveNodeIdsSubquery`) and the recorded/logical clock already use, and the
 * same form the `asOf` predicate uses (a bound ISO instant), so it needs no
 * dialect-specific expression.
 *
 * Samples the clock per call unless a {@link withPinnedReadInstant} scope is
 * open, in which case every call in that scope binds the same instant.
 */
export function currentReadInstant(): SQL {
  return sql`${pinnedReadInstant ?? nowIso()}`;
}

/**
 * How a "current" valid-time read instant is emitted into compiled SQL:
 *
 * - `"literal"` — bound as a concrete value at compile time
 *   ({@link currentReadInstant}). The instant is frozen into the compiled
 *   statement, so the statement must be recompiled to observe a newer "now".
 * - `"placeholder"` — bound as a reserved execution-time placeholder
 *   ({@link currentReadInstantPlaceholder}). The statement can be compiled
 *   once and reused across executions, filling a fresh instant each call.
 *
 * Defaults to `"literal"` everywhere except the query builder's compiled
 * template cache, which opts into `"placeholder"` so a reused/prepared query
 * never freezes "now" the way a cached literal would (the #246 regression).
 */
export type ReadInstantMode = "literal" | "placeholder";

/**
 * Reserved Drizzle placeholder name for the "current" valid-time read instant.
 * The query builder's template cache fills it with a fresh application-clock
 * value on every execution. The `__typegraph_` prefix keeps it disjoint from
 * every user `param()` name.
 */
export const CURRENT_READ_INSTANT_PLACEHOLDER =
  "__typegraph_current_read_instant__";

/**
 * The "current" read instant as a reserved execution-time placeholder rather
 * than a frozen value. Compiles to the same SQL text as
 * {@link currentReadInstant} (a bound parameter), but leaves the value unbound
 * so one compiled statement can be reused across executions with a fresh
 * instant filled in per call. See {@link CURRENT_READ_INSTANT_PLACEHOLDER}.
 */
function currentReadInstantPlaceholder(): SQL {
  return sql`${sql.placeholder(CURRENT_READ_INSTANT_PLACEHOLDER)}`;
}

/** Emits the "current" read instant for the requested {@link ReadInstantMode}. */
export function currentReadInstantFor(mode: ReadInstantMode): SQL {
  return mode === "placeholder" ?
      currentReadInstantPlaceholder()
    : currentReadInstant();
}

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
  /** Recorded/system-time timestamp for recorded-pinned reads. */
  recordedAsOf?: string | undefined;
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
 * compileTemporalFilter({ mode: "asOf", asOf: "2024-01-01T00:00:00.000Z" })
 * // → deleted_at IS NULL AND (valid_from IS NULL OR valid_from <= '2024-01-01...') AND ...
 * ```
 */
export function compileTemporalFilter(options: TemporalFilterOptions): SQL {
  const { mode, asOf, tableAlias, currentTimestamp, recordedAsOf } = options;

  // Build column references with optional prefix
  const prefix = tableAlias ? sql.raw(`${tableAlias}.`) : sql.raw("");
  const deletedAt = sql`${prefix}deleted_at`;
  const validFrom = sql`${prefix}valid_from`;
  const validTo = sql`${prefix}valid_to`;

  const validFilter = (() => {
    switch (mode) {
      case "current": {
        // When pinned to a recorded instant, "current" valid-time means
        // valid-current *as of that recorded instant* — not the wall clock at
        // read time. Pinning here collapses
        // view({mode:'current'}).asOfRecorded(rt) to the diagonal
        // store.asOfRecorded(rt) and stops silently dropping rows that were
        // valid-current when recorded but ended before the read.
        const now =
          recordedAsOf === undefined ?
            (currentTimestamp ?? currentReadInstant())
          : sql`${recordedAsOf}`;
        return sql`${deletedAt} IS NULL AND (${validFrom} IS NULL OR ${validFrom} <= ${now}) AND (${validTo} IS NULL OR ${validTo} > ${now})`;
      }

      case "asOf": {
        if (asOf === undefined) {
          throw new Error(
            `asOf timestamp is required for temporal mode "asOf"`,
          );
        }
        const timestamp = asOf;
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
  })();

  if (recordedAsOf === undefined) return validFilter;

  const recordedFrom = sql`${prefix}recorded_from`;
  const recordedTo = sql`${prefix}recorded_to`;
  return sql`(${validFilter}) AND ${recordedFrom} <= ${recordedAsOf} AND ${recordedAsOf} < ${recordedTo}`;
}

/**
 * Extracts temporal options from a query AST.
 *
 * @param ast - Query AST with temporalMode
 * @param tableAlias - Optional table alias for column references
 * @returns TemporalFilterOptions for use with compileTemporalFilter
 */
export function extractTemporalOptions(
  ast: {
    temporalMode: { mode: TemporalMode; asOf?: string };
    recordedAsOf?: string;
  },
  tableAlias?: string,
): TemporalFilterOptions {
  return {
    mode: ast.temporalMode.mode,
    asOf: ast.temporalMode.asOf,
    recordedAsOf: ast.recordedAsOf,
    tableAlias,
  };
}
