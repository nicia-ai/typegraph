import { getTableName, sql } from "drizzle-orm";

import {
  buildFulltextGraphDelete,
  type FulltextStrategy,
} from "../../../query/dialect/fulltext-strategy";
import { type ExecutableSql } from "../execution/types";
import { type Tables } from "./shared";

export type ClearGraphStatement = Readonly<{
  query: ExecutableSql;
  ignoreMissingTable?: boolean;
  requiredTableName?: string;
}>;

/**
 * Builds DELETE FROM statements for all per-graph base tables filtered by
 * graph_id. Delete order respects implicit FK-like dependencies:
 * fulltext → recorded identity/edges/nodes → identity closure/assertions →
 * recorded_clock → uniques → edge_claims → edges → nodes → schema_versions.
 * The fulltext delete is omitted entirely when `fulltextStrategy` is
 * `undefined` — the table does not exist on a backend with no fulltext
 * strategy.
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
  fulltextStrategy: FulltextStrategy | undefined,
): readonly ClearGraphStatement[] {
  return [
    // The fulltext table is shared by every graph in the database, so its
    // graph-scoped delete is owned by one builder the destructive
    // contribution rebuild calls too — see `buildFulltextGraphDelete`. Omitted
    // entirely when no fulltext strategy is active: the table was never
    // created, so there is nothing to delete from.
    ...(fulltextStrategy === undefined
      ? []
      : [{ query: buildFulltextGraphDelete(tables.fulltextTableName, graphId) }]),
    {
      query: sql`DELETE FROM ${tables.recordedIdentityAssertions} WHERE ${tables.recordedIdentityAssertions.graphId} = ${graphId}`,
      ignoreMissingTable: true,
      requiredTableName: getTableName(tables.recordedIdentityAssertions),
    },
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
      query: sql`DELETE FROM ${tables.identitySeparation} WHERE ${tables.identitySeparation.graphId} = ${graphId}`,
      ignoreMissingTable: true,
      requiredTableName: getTableName(tables.identitySeparation),
    },
    {
      query: sql`DELETE FROM ${tables.identityClosure} WHERE ${tables.identityClosure.graphId} = ${graphId}`,
      ignoreMissingTable: true,
      requiredTableName: getTableName(tables.identityClosure),
    },
    {
      query: sql`DELETE FROM ${tables.identityAssertions} WHERE ${tables.identityAssertions.graphId} = ${graphId}`,
      ignoreMissingTable: true,
      requiredTableName: getTableName(tables.identityAssertions),
    },
    {
      query: sql`DELETE FROM ${tables.uniques} WHERE ${tables.uniques.graphId} = ${graphId}`,
    },
    // Edge claims name the edges they are held by, so they are cleared
    // BEFORE the edges — the same ordering `uniques` gets against `nodes`.
    // Tolerates absence for the reason the recorded relations do: bootstrap DDL
    // runs only on first boot, so a database initialized before this relation
    // existed has no such table, and clearing a graph must not become the
    // operation that fails on it.
    {
      query: sql`DELETE FROM ${tables.edgeClaims} WHERE ${tables.edgeClaims.graphId} = ${graphId}`,
      ignoreMissingTable: true,
      requiredTableName: getTableName(tables.edgeClaims),
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
