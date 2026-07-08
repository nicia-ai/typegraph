import { type SQL } from "drizzle-orm";

import type { QueryAst } from "../../ast";
import {
  compileTemporalFilter,
  currentReadInstant,
  extractTemporalOptions,
} from "../temporal";

export type TemporalFilterPass = Readonly<{
  forAlias: (tableAlias?: string) => SQL;
}>;

/**
 * Creates a temporal filter pass bound to a query AST.
 *
 * Invariant: all temporal clauses for a query use the same "current" instant,
 * bound once here from the application clock (see {@link currentReadInstant}).
 */
export function createTemporalFilterPass(ast: QueryAst): TemporalFilterPass {
  const currentTimestamp = currentReadInstant();
  return {
    forAlias(tableAlias?: string): SQL {
      return compileTemporalFilter({
        ...extractTemporalOptions(ast, tableAlias),
        currentTimestamp,
      });
    },
  };
}
