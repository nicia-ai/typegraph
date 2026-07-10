import { type SQL } from "drizzle-orm";

import type { QueryAst } from "../../ast";
import {
  compileTemporalFilter,
  currentReadInstantFor,
  extractTemporalOptions,
  type ReadInstantMode,
} from "../temporal";

export type TemporalFilterPass = Readonly<{
  forAlias: (tableAlias?: string) => SQL;
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
    forAlias(tableAlias?: string): SQL {
      return compileTemporalFilter({
        ...extractTemporalOptions(ast, tableAlias),
        currentTimestamp,
      });
    },
  };
}
