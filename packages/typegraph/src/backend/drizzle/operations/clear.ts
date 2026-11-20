import { getTableName, sql } from "drizzle-orm";

import {
  buildFulltextGraphDelete,
  type FulltextStrategy,
} from "../../../query/dialect/fulltext-strategy";
import {
  GRAPH_RELATION_CLEAR_SEQUENCE,
  type GraphRelationClearStep,
} from "../../graph-relations";
import { type ExecutableSql } from "../execution/types";
import { graphScopedTable } from "../graph-relation-tables";
import { type Tables } from "./shared";

export type ClearGraphStatement = Readonly<{
  query: ExecutableSql;
  ignoreMissingTable?: boolean;
  requiredTableName?: string;
}>;

/**
 * Builds DELETE FROM statements for all per-graph base tables filtered by
 * graph_id. The relations, their order, and which of them tolerate a missing
 * table or may be preserved are declared once in `../../graph-relations`
 * (`GRAPH_RELATION_CLEAR_SEQUENCE`); this builder only renders that sequence.
 * The fulltext delete is omitted entirely when `fulltextStrategy` is
 * `undefined` — the table does not exist on a backend with no fulltext
 * strategy. The revision-origins row is deleted here like any other graph
 * relation, so a graph cleared by a store that mints no origin still leaves no
 * origin behind.
 *
 * Embeddings are NOT cleared here: they live in per-`(nodeKind, fieldPath)`
 * strategy-owned tables that this graph-agnostic builder cannot enumerate.
 * The store's `clear()` drives their per-field cleanup through the active
 * vector strategy.
 *
 * Per-deployment status tables (`indexMaterializations`, `kindRemovals`,
 * and `reconciliationMarkers`) also get cleaned
 * because reuse of the same graphId after `clearGraph` would otherwise inherit
 * stale state. The reconciliation marker is the sharpest case: a stale
 * high-water mark would cause `materializeRemovals` to skip the recovery walk
 * entirely for the freshly-created graph. By default, graph-scoped contribution
 * markers are deleted too; `Store.clear()` may preserve them when it retains
 * initialized storage for immediate reuse. Deployment contributions' physical
 * markers remain keyed by the reserved deployment graph id.
 */
export function buildClearGraph(
  tables: Tables,
  graphId: string,
  fulltextStrategy: FulltextStrategy | undefined,
  options?: Readonly<{ preserveContributionMaterializations?: boolean }>,
): readonly ClearGraphStatement[] {
  return GRAPH_RELATION_CLEAR_SEQUENCE.flatMap((step) => {
    const statement = clearStatement(step, tables, graphId, fulltextStrategy, options);
    return statement === undefined ? [] : [statement];
  });
}

function clearStatement(
  step: GraphRelationClearStep,
  tables: Tables,
  graphId: string,
  fulltextStrategy: FulltextStrategy | undefined,
  options: Readonly<{ preserveContributionMaterializations?: boolean }> | undefined,
): ClearGraphStatement | undefined {
  const { clear } = step;
  switch (clear.kind) {
    case "fulltextStrategy": {
      // The fulltext table is shared by every graph in the database, so its
      // graph-scoped delete is owned by one builder the destructive
      // contribution rebuild calls too — see `buildFulltextGraphDelete`.
      // Omitted entirely when no fulltext strategy is active: the table was
      // never created, so there is nothing to delete from.
      return fulltextStrategy === undefined ? undefined : (
          { query: buildFulltextGraphDelete(tables.fulltextTableName, graphId) }
        );
    }
    case "delete": {
      if (
        clear.preservable === true &&
        options?.preserveContributionMaterializations === true
      ) {
        return undefined;
      }
      const table = graphScopedTable(tables, step.key);
      const query = sql`DELETE FROM ${table} WHERE ${table.graphId} = ${graphId}`;
      // A tolerated relation is provisioned lazily or after first boot, so a
      // database initialized before it existed has no such table, and clearing
      // a graph must not become the operation that fails on it.
      return clear.missingTable === "tolerated" ?
          {
            query,
            ignoreMissingTable: true,
            requiredTableName: getTableName(table),
          }
        : { query };
    }
  }
}
