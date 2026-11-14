import { recordedAnchorsTable, type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";

/** One owner for the active allocation origin in every read and deletion. */
export function recordedAnchorOrigin(
  schema: SqlSchema,
  graphId: string,
): SqlFragment {
  return sql`(SELECT origin FROM ${schema.revisionOriginsTable} WHERE graph_id=${graphId})`;
}

export function recordedAnchorScope(
  schema: SqlSchema,
  graphId: string,
  origin?: string,
): SqlFragment {
  return sql`anchors.graph_id=${graphId} AND anchors.origin=${origin ?? recordedAnchorOrigin(schema, graphId)}`;
}

/** Both resolution and pruning choose exactly this deterministic indexed candidate. */
export function recordedAnchorCandidate(
  schema: SqlSchema,
  graphId: string,
  wallTime: string,
): SqlFragment {
  return sql`
    SELECT anchors.origin, anchors.revision, anchors.recorded_at
    FROM ${recordedAnchorsTable(schema)} anchors
    WHERE ${recordedAnchorScope(schema, graphId)} AND anchors.recorded_at <= ${wallTime}
    ORDER BY anchors.recorded_at DESC, anchors.revision DESC LIMIT 1
  `;
}
