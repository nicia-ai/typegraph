import { type SQL, sql } from "drizzle-orm";

import { quotedTableName, type Tables } from "./shared";

/**
 * Builds DELETE FROM statements for all per-graph tables filtered by
 * graph_id. Delete order respects implicit FK-like dependencies:
 * fulltext → embeddings → uniques → edges → nodes → schema_versions.
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
): readonly SQL[] {
  const fulltext = quotedTableName(tables.fulltextTableName);
  return [
    sql`DELETE FROM ${fulltext} WHERE "graph_id" = ${graphId}`,
    sql`DELETE FROM ${tables.embeddings} WHERE ${tables.embeddings.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.uniques} WHERE ${tables.uniques.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.edges} WHERE ${tables.edges.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.nodes} WHERE ${tables.nodes.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.indexMaterializations} WHERE ${tables.indexMaterializations.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.kindRemovals} WHERE ${tables.kindRemovals.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.reconciliationMarkers} WHERE ${tables.reconciliationMarkers.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.schemaVersions} WHERE ${tables.schemaVersions.graphId} = ${graphId}`,
  ];
}
