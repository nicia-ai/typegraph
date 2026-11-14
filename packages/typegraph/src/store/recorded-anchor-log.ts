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
import { executeStatement } from "./recorded-capture/guards";

function requireRecordedAnchorLookup(
  target: Pick<GraphBackend, "capabilities" | "dialect">,
  graphId: string,
  surface: string,
): void {
  if (target.capabilities.recordedAnchorLookup !== true)
    throw new UnsupportedBackendCapabilityError(
      surface,
      "recordedAnchorLookup",
      { graphId, dialect: target.dialect },
    );
}

/** Allocation time, not the database's later COMMIT visibility time. */
export async function lookupRecordedAnchor(
  target: Pick<GraphBackend, "capabilities" | "execute" | "dialect">,
  schema: SqlSchema,
  graphId: string,
  wallTime: string,
): Promise<RecordedInstant | undefined> {
  validateCanonicalIsoDate(wallTime, "wallTime");
  requireRecordedAnchorLookup(target, graphId, "resolveRecordedInstant");
  const rows = await withRecordedRelationsPrecondition(
    target.execute<
      Readonly<{
        origin: unknown;
        revision: unknown;
        recorded_at: unknown;
        first_revision: unknown;
        next_revision: unknown;
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
        ), next_retained AS (
          SELECT anchors.revision FROM ${recordedAnchorsTable(schema)} anchors
          WHERE anchors.graph_id=${graphId}
            AND anchors.origin=(SELECT origin FROM ${schema.revisionOriginsTable} WHERE graph_id=${graphId})
            AND anchors.revision > 1
          ORDER BY anchors.revision ASC LIMIT 1
        )
        SELECT origins.origin,candidate.revision,candidate.recorded_at,first_retained.revision AS first_revision,next_retained.revision AS next_revision
        FROM ${schema.recordedClockTable} clock
        LEFT JOIN ${schema.revisionOriginsTable} origins ON clock.graph_id=origins.graph_id
        LEFT JOIN candidate ON candidate.origin=origins.origin
        LEFT JOIN first_retained ON 1=1
        LEFT JOIN next_retained ON 1=1
        WHERE clock.graph_id=${graphId}
      `),
    ),
    { dialect: target.dialect, surface: "resolve-recorded-anchor" },
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  // Revision one is retained as evidence of the first allocation, not as a
  // candidate inside a pruned interval. The remaining rows form a suffix.
  if (Number(row.revision) === 1 && Number(row.next_revision) > 2) {
    throw new ConfigurationError(
      "The requested wall time falls outside retained recorded allocation coverage.",
      { code: "RECORDED_LOOKUP_HISTORY_PRUNED", graphId, wallTime },
      {
        suggestion:
          "Use a saved recorded instant or a wall time within retained coverage.",
      },
    );
  }
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

/**
 * Retain the latest allocation at/before `before`, all later allocations, and
 * revision one as a first-allocation witness. One statement selects and deletes
 * within the same snapshot: concurrent writers allocate higher revisions and
 * concurrent prunes can only advance the retained suffix. Origin predicates
 * prevent an overlapping clear/reset from touching a replacement graph owner.
 */
export async function pruneRecordedAnchors(
  target: Pick<
    GraphBackend,
    "capabilities" | "execute" | "executeStatement" | "dialect"
  >,
  schema: SqlSchema,
  graphId: string,
  before: string,
): Promise<void> {
  validateCanonicalIsoDate(before, "before");
  requireRecordedAnchorLookup(target, graphId, "pruneRecordedInstants");
  await withRecordedRelationsPrecondition(
    executeStatement(
      target,
      sql`
        DELETE FROM ${recordedAnchorsTable(schema)}
        WHERE graph_id=${graphId}
          AND origin=(SELECT origin FROM ${schema.revisionOriginsTable} WHERE graph_id=${graphId})
          AND revision > 1
          AND revision < (
            SELECT anchors.revision FROM ${recordedAnchorsTable(schema)} anchors
            WHERE anchors.graph_id=${graphId}
              AND anchors.origin=(SELECT origin FROM ${schema.revisionOriginsTable} WHERE graph_id=${graphId})
              AND anchors.recorded_at <= ${before}
            ORDER BY anchors.recorded_at DESC, anchors.revision DESC LIMIT 1
          )
      `,
    ),
    { dialect: target.dialect, surface: "prune-recorded-anchors" },
  );
}
