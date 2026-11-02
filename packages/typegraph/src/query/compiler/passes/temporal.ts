import type { QueryAst, Traversal } from "../../ast";
import { sql, type SqlFragment } from "../../sql-fragment";
import { type RecordedReadBinding } from "../schema";
import {
  compileEdgeMembershipFilters,
  compileTemporalFilter,
  currentReadInstantFor,
  extractTemporalOptions,
  type ReadInstantMode,
  RECORDED_TEMPORAL_COLUMNS,
} from "../temporal";

export type TemporalFilterPass = Readonly<{
  forAlias: (tableAlias?: string) => SqlFragment;
  /**
   * The row filter a traversal's edges read through: the composition
   * membership a `parts()`/`wholes()` traversal carries
   * (`Traversal.compositionMembership`), evaluated at this read's coordinate,
   * or {@link forAlias}'s validity window for every other traversal. Every
   * emitter of a traversal's edge rows calls this, so a composition walk can
   * never fall back to the window on one path.
   */
  forTraversalEdges: (traversal: Traversal, tableAlias: string) => SqlFragment;
  /**
   * The bound "current" valid-time read instant, sampled once when this pass is
   * created — the same value {@link forAlias} compares against. Exposed so
   * point-in-time predicates that must NOT widen with the node-visibility mode
   * (e.g. identity-assertion validity) can pin to the identical instant instead
   * of resampling the clock, which would break the single-snapshot invariant.
   */
  currentInstant: SqlFragment;
  /**
   * {@link RECORDED_TEMPORAL_COLUMNS} when the read is recorded-pinned to a
   * source that carries them (`RecordedReadSource.carriesInterval`), otherwise
   * empty: the extra columns {@link forAlias}'s filter references. An
   * engine-native `AS OF` source has no recorded interval and its filter reads
   * none.
   */
  recordedColumns: readonly (typeof RECORDED_TEMPORAL_COLUMNS)[number][];
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
  recordedReadBinding?: RecordedReadBinding,
): TemporalFilterPass {
  const currentTimestamp = currentReadInstantFor(readInstant);
  const recordedColumns: TemporalFilterPass["recordedColumns"] =
    (
      ast.recordedAsOf !== undefined &&
      recordedReadBinding?.carriesInterval === true
    ) ?
      RECORDED_TEMPORAL_COLUMNS
    : [];
  function forAlias(tableAlias?: string): SqlFragment {
    return compileTemporalFilter({
      ...extractTemporalOptions(ast, tableAlias),
      currentTimestamp,
      recordedReadBinding,
    });
  }
  return {
    forAlias,
    forTraversalEdges(traversal, tableAlias): SqlFragment {
      if (traversal.compositionMembership === undefined) {
        return forAlias(tableAlias);
      }
      const { mode, asOf, recordedAsOf } = extractTemporalOptions(ast);
      return sql.join(
        [
          ...compileEdgeMembershipFilters({
            members: traversal.compositionMembership,
            tableAlias,
            mode,
            asOf,
            recordedAsOf,
            recordedReadBinding,
          }),
        ],
        sql` AND `,
      );
    },
    currentInstant: currentTimestamp,
    recordedColumns,
  };
}
