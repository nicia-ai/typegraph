import type { QueryAst } from "../../ast";
import { type SqlFragment } from "../../sql-fragment";
import {
  compileTemporalFilter,
  currentReadInstantFor,
  extractTemporalOptions,
  type ReadInstantMode,
  RECORDED_TEMPORAL_COLUMNS,
} from "../temporal";

export type TemporalFilterPass = Readonly<{
  forAlias: (tableAlias?: string) => SqlFragment;
  /**
   * The bound "current" valid-time read instant, sampled once when this pass is
   * created — the same value {@link forAlias} compares against. Exposed so
   * point-in-time predicates that must NOT widen with the node-visibility mode
   * (e.g. identity-assertion validity) can pin to the identical instant instead
   * of resampling the clock, which would break the single-snapshot invariant.
   */
  currentInstant: SqlFragment;
  /**
   * Column names, beyond the always-present `valid_from`/`valid_to`/
   * `deleted_at`, that {@link forAlias}'s filter will reference for this AST
   * — `recorded_from`/`recorded_to` when the read is recorded-pinned,
   * otherwise empty. A caller that narrows an edge/node projection to avoid
   * a wildcard select (rather than emitting `alias.*`) must include these so
   * its column list stays correct if the recorded pin is ever added to or
   * removed from this AST; deriving that answer here, instead of a second
   * `ast.recordedAsOf !== undefined` check at the narrowing site, is what
   * keeps the two decisions from drifting apart (see recursive.ts's
   * `<edgeAlias>_directed_edges` CTE).
   */
  recordedColumns: readonly string[];
}>;

/**
 * Creates a temporal filter pass bound to a query AST.
 *
 * Invariant: all temporal clauses for a query use the same "current" instant,
 * bound once here from the application clock. In `"literal"` mode that is a
 * concrete value; in `"placeholder"` mode it is the reserved read-instant
 * placeholder (filled fresh per execution by the query builder's template
 * cache) — see {@link currentReadInstantFor}.
 */
export function createTemporalFilterPass(
  ast: QueryAst,
  readInstant: ReadInstantMode = "literal",
): TemporalFilterPass {
  const currentTimestamp = currentReadInstantFor(readInstant);
  const recordedColumns: readonly string[] =
    ast.recordedAsOf === undefined ? [] : RECORDED_TEMPORAL_COLUMNS;
  return {
    forAlias(tableAlias?: string): SqlFragment {
      return compileTemporalFilter({
        ...extractTemporalOptions(ast, tableAlias),
        currentTimestamp,
      });
    },
    currentInstant: currentTimestamp,
    recordedColumns,
  };
}
