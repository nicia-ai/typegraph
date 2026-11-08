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
      "resolveRecordedAnchor",
      "recordedAnchorLookup",
      { graphId, dialect: target.dialect },
    );
  const rows = await target.execute<
    Readonly<{ origin: unknown; revision: unknown; recorded_at: unknown }>
  >(
    asCompiledRowsSql(sql`
      SELECT anchors.origin, anchors.revision, anchors.recorded_at
      FROM ${recordedAnchorsTable(schema)} anchors
      WHERE anchors.graph_id = ${graphId}
        AND anchors.origin = (SELECT origin FROM ${schema.revisionOriginsTable} WHERE graph_id = ${graphId})
        AND anchors.recorded_at <= ${wallTime}
      ORDER BY anchors.recorded_at DESC, anchors.revision DESC
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (row === undefined) return undefined;
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
