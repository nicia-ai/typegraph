import { getTableName, type SQL, sql } from "drizzle-orm";

import { quotedTableName, type Tables } from "./shared";

export type ClearGraphStatement = Readonly<{
  query: SQL;
  ignoreMissingTable?: boolean;
  requiredTableName?: string;
}>;

/**
 * Builds DELETE FROM statements for all per-graph base tables filtered by
 * graph_id. Delete order respects implicit FK-like dependencies:
 * fulltext → recorded_edges → recorded_nodes → recorded_clock → uniques →
 * edges → nodes → schema_versions.
 *
 * Embeddings are NOT cleared here: they live in per-`(nodeKind, fieldPath)`
 * strategy-owned tables that this graph-agnostic builder cannot enumerate.
 * The store's `clear()` drives their per-field cleanup through the active
 * vector strategy.
 *
 * Per-deployment status tables (`indexMaterializations`, `kindRemovals`,
 * `reconciliationMarkers`) also get cleaned because reuse of the same
 * graphId after `clearGraph` would otherwise inherit stale state. The
 * reconciliation marker is the sharpest case: a stale high-water mark
 * would cause `materializeRemovals` to skip the recovery walk entirely
 * for the freshly-created graph.
 */
export function buildClearGraph(
  tables: Tables,
  graphId: string,
): readonly ClearGraphStatement[] {
  const fulltext = quotedTableName(tables.fulltextTableName);
  return [
    { query: sql`DELETE FROM ${fulltext} WHERE "graph_id" = ${graphId}` },
    {
      query: sql`DELETE FROM ${tables.recordedEdges} WHERE ${tables.recordedEdges.graphId} = ${graphId}`,
      ignoreMissingTable: true,
      requiredTableName: getTableName(tables.recordedEdges),
    },
    {
      query: sql`DELETE FROM ${tables.recordedNodes} WHERE ${tables.recordedNodes.graphId} = ${graphId}`,
      ignoreMissingTable: true,
      requiredTableName: getTableName(tables.recordedNodes),
    },
    {
      query: sql`DELETE FROM ${tables.recordedClock} WHERE ${tables.recordedClock.graphId} = ${graphId}`,
      ignoreMissingTable: true,
      requiredTableName: getTableName(tables.recordedClock),
    },
    {
      query: sql`DELETE FROM ${tables.uniques} WHERE ${tables.uniques.graphId} = ${graphId}`,
    },
    {
      query: sql`DELETE FROM ${tables.edges} WHERE ${tables.edges.graphId} = ${graphId}`,
    },
    {
      query: sql`DELETE FROM ${tables.nodes} WHERE ${tables.nodes.graphId} = ${graphId}`,
    },
    {
      query: sql`DELETE FROM ${tables.indexMaterializations} WHERE ${tables.indexMaterializations.graphId} = ${graphId}`,
    },
    {
      query: sql`DELETE FROM ${tables.kindRemovals} WHERE ${tables.kindRemovals.graphId} = ${graphId}`,
    },
    {
      query: sql`DELETE FROM ${tables.reconciliationMarkers} WHERE ${tables.reconciliationMarkers.graphId} = ${graphId}`,
    },
    {
      query: sql`DELETE FROM ${tables.schemaVersions} WHERE ${tables.schemaVersions.graphId} = ${graphId}`,
    },
  ];
}
