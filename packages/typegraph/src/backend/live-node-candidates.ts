import { sql, type SqlFragment } from "../query/sql-fragment";

/** Builds the portable current-node candidate set used by direct searches. */
export function buildLiveNodeCandidates(
  nodesTableName: string,
  graphId: string,
  nodeKind: string,
  now: string,
): SqlFragment {
  const nodes = sql.identifier(nodesTableName);
  return sql`
    SELECT "id" AS node_id
    FROM ${nodes}
    WHERE "graph_id" = ${graphId}
      AND "kind" = ${nodeKind}
      AND "deleted_at" IS NULL
      AND ("valid_from" IS NULL OR "valid_from" <= ${now})
      AND ("valid_to" IS NULL OR "valid_to" > ${now})
  `;
}
