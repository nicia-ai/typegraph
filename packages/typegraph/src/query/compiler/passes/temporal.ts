import type { QueryAst } from "../../ast";
import { type SqlFragment } from "../../sql-fragment";
import {
  compileTemporalFilter,
  currentReadInstantFor,
  extractTemporalOptions,
  type ReadInstantMode,
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
  return {
    forAlias(tableAlias?: string): SqlFragment {
      return compileTemporalFilter({
        ...extractTemporalOptions(ast, tableAlias),
        currentTimestamp,
      });
    },
    currentInstant: currentTimestamp,
  };
}
