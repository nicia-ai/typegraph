/** Binds the graph-relation inventory (`../graph-relations`) to Drizzle tables. */
import type { GraphRelationKey } from "../graph-relations";
import type { Tables } from "./operations/shared";

/** Every graph-scoped relation that has a Drizzle table (all but fulltext). */
type GraphScopedTableKey = Exclude<GraphRelationKey, "fulltext">;

/** One graph-scoped relation's Drizzle table. */
export type GraphScopedTable = Tables[GraphScopedTableKey];

/**
 * The Drizzle table of a graph-scoped relation. The fulltext relation is a
 * strategy-owned virtual or generated table that Drizzle cannot model, so it
 * has none; every consumer reaches it through `Tables.fulltextTableName` and
 * the fulltext strategy instead.
 */
export function graphScopedTable(
  tables: Tables,
  key: GraphRelationKey,
): GraphScopedTable {
  if (key === "fulltext") {
    throw new TypeError(
      "The fulltext relation has no Drizzle table; use Tables.fulltextTableName.",
    );
  }
  return tables[key];
}
