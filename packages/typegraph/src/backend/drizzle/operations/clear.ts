import { type SQL, sql } from "drizzle-orm";

import type { Tables } from "./shared";

/**
 * Builds DELETE FROM statements for all 5 tables filtered by graph_id.
 * Delete order respects implicit FK-like dependencies:
 * embeddings → uniques → edges → nodes → schema_versions
 */
export function buildClearGraph(
  tables: Tables,
  graphId: string,
): readonly SQL[] {
  return [
    sql`DELETE FROM ${tables.embeddings} WHERE ${tables.embeddings.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.uniques} WHERE ${tables.uniques.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.edges} WHERE ${tables.edges.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.nodes} WHERE ${tables.nodes.graphId} = ${graphId}`,
    sql`DELETE FROM ${tables.schemaVersions} WHERE ${tables.schemaVersions.graphId} = ${graphId}`,
  ];
}
