import { type GraphBackend } from "../backend/types";
import { createRecordedInstant, type RecordedInstant } from "../core/temporal";
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
} from "../errors";
import { recordedAnchorsTable, type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { validateCanonicalIsoDate } from "../utils/date";
import { withRecordedRelationsPrecondition } from "../utils/sql-errors";
import { recordedAnchorOwner } from "./recorded-anchor-origin";

/** Allocation time, not the database's later COMMIT visibility time. */
export async function lookupRecordedAnchor(
  target: Pick<GraphBackend, "capabilities" | "execute" | "dialect">,
  schema: SqlSchema,
  graphId: string,
  wallTime: string,
): Promise<RecordedInstant | undefined> {
  validateCanonicalIsoDate(wallTime, "wallTime");
  if (target.capabilities.recordedAnchorLookup !== true)
    throw new UnsupportedBackendCapabilityError(
      "resolveRecordedInstant",
      "recordedAnchorLookup",
      { graphId, dialect: target.dialect },
    );
  const rows = await withRecordedRelationsPrecondition(
    target.execute<
      Readonly<{
        origin: unknown;
        revision: unknown;
        recorded_at: unknown;
        first_revision: unknown;
      }>
    >(
      asCompiledRowsSql(sql`
        WITH candidate AS (
          SELECT anchors.origin, anchors.revision, anchors.recorded_at
          FROM ${recordedAnchorsTable(schema)} anchors
          WHERE anchors.graph_id = ${graphId}
            AND anchors.origin = (SELECT origin FROM ${schema.revisionOriginsTable} WHERE graph_id = ${graphId})
            AND anchors.recorded_at <= ${wallTime}
          ORDER BY anchors.recorded_at DESC, anchors.revision DESC LIMIT 1
        ), first_retained AS (
          SELECT anchors.revision FROM ${recordedAnchorsTable(schema)} anchors
          WHERE anchors.graph_id=${graphId}
            AND anchors.origin=(SELECT origin FROM ${schema.revisionOriginsTable} WHERE graph_id=${graphId})
          ORDER BY anchors.recorded_at ASC, anchors.revision ASC LIMIT 1
        )
        SELECT origins.origin,candidate.revision,candidate.recorded_at,first_retained.revision AS first_revision
        FROM ${schema.recordedClockTable} clock
        LEFT JOIN ${schema.revisionOriginsTable} origins ON clock.graph_id=origins.graph_id
        LEFT JOIN candidate ON candidate.origin=origins.origin
        LEFT JOIN first_retained ON 1=1
        WHERE clock.graph_id=${graphId}
      `),
    ),
    { dialect: target.dialect, surface: "resolve-recorded-anchor" },
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  if (row.revision === undefined || row.revision === null) {
    if (Number(row.first_revision) === 1) return undefined;
    throw new ConfigurationError(
      "The requested wall time is outside the retained allocation log's known coverage.",
      { code: "RECORDED_LOOKUP_HISTORY_NOT_LOGGED", graphId, wallTime },
      {
        suggestion:
          "Use a previously retained recorded instant, or reacquire a cut after recorded allocation logging began. Unlogged history cannot be interpreted as an empty graph.",
      },
    );
  }
  if (typeof row.origin !== "string" || typeof row.recorded_at !== "string")
    throw new ConfigurationError(
      "Retained recorded anchor storage contains an invalid coordinate.",
      { graphId },
    );
  return createRecordedInstant(
    Number(row.revision),
    row.recorded_at,
    await recordedAnchorOwner(schema, row.origin),
  );
}
