import { type SQL } from "drizzle-orm";

import type { QueryAst } from "../../ast";
import { compileTemporalFilter, extractTemporalOptions } from "../temporal";

export type TemporalFilterPass = Readonly<{
  forAlias: (tableAlias?: string) => SQL;
}>;

/**
 * Creates a temporal filter pass bound to a query AST and timestamp source.
 *
 * Invariant:
 * - All temporal clauses for a query use the same timestamp expression.
 */
export function createTemporalFilterPass(
  ast: QueryAst,
  currentTimestamp: SQL,
): TemporalFilterPass {
  return {
    forAlias(tableAlias?: string): SQL {
      return compileTemporalFilter({
        ...extractTemporalOptions(ast, tableAlias),
        currentTimestamp,
      });
    },
  };
}
