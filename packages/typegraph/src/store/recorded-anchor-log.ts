import { z } from "zod";

import {
  OPTIMISTIC_RETRY_ATTEMPTS,
  runRetriedUnit,
} from "../backend/capabilities/retried-unit";
import { RECORDED_ANCHOR_RETENTION_COLUMN } from "../backend/recorded-storage";
import { type GraphBackend } from "../backend/types";
import {
  createRecordedInstant,
  RECORDED_FIRST_REVISION,
  RECORDED_MAX_REVISION,
  type RecordedInstant,
} from "../core/temporal";
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
  ValidationError,
} from "../errors";
import { recordedAnchorsTable, type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql, markForceCustomPlan } from "../query/sql-intent";
import { validateCanonicalIsoDate } from "../utils/date";
import { requireDefined } from "../utils/presence";
import { withRecordedRelationsPrecondition } from "../utils/sql-errors";
import {
  recordedAnchorCandidate,
  recordedAnchorOrigin,
  recordedAnchorScope,
} from "./recorded-anchor-log-sql";
import { recordedAnchorOwner } from "./recorded-anchor-origin";
import { lockRecordedGraphWrite } from "./recorded-capture/clock";
import { requireRecordedAnchorLog } from "./recorded-capture/guards";

export type PruneRecordedInstantsOptions = Readonly<{
  /** Maximum allocation rows deleted by this call (1–10,000; default 1,000). */
  limit?: number;
}>;

export type PruneRecordedInstantsResult = Readonly<{
  deletedCount: number;
  retainedBoundary: RecordedInstant | undefined;
  hasMore: boolean;
}>;

/** Every entrypoint states capture ownership explicitly, including internal callers. */
export type RecordedAnchorLogContext = Readonly<{
  backend: GraphBackend;
  schema: SqlSchema;
  graphId: string;
  captureEnabled: boolean;
}>;

const DEFAULT_PRUNE_LIMIT = 1000;
const MAX_PRUNE_LIMIT = 10_000;
const RETENTION_STATE_VERSION = 1;
const RetentionStateSchema = z
  .object({
    version: z.literal(RETENTION_STATE_VERSION),
    loggedFromFirstAllocation: z.boolean(),
    loggedFrom: z.string(),
    prunedBefore: z.string(),
    retainedRevision: z
      .number()
      .int()
      .min(RECORDED_FIRST_REVISION)
      .max(RECORDED_MAX_REVISION - 1),
  })
  .strict();
type RecordedAnchorRetentionState = Readonly<
  z.infer<typeof RetentionStateSchema>
>;

type RecordedAnchorSnapshot = Readonly<{
  origin: unknown;
  anchor_revision: unknown;
  anchor_recorded_at: unknown;
  first_revision: unknown;
  first_recorded_at: unknown;
  [RECORDED_ANCHOR_RETENTION_COLUMN]?: unknown;
}>;

async function readRecordedAnchorSnapshot(
  target: Pick<GraphBackend, "execute" | "dialect">,
  schema: SqlSchema,
  graphId: string,
  wallTime: string,
  surface: string,
): Promise<RecordedAnchorSnapshot | undefined> {
  // Selecting the complete clock row keeps pre-v9 allocations readable without
  // probing a marker or naming a column their storage does not have yet.
  // Candidate coordinates have distinct aliases: the clock time may be timestamptz.
  const query = asCompiledRowsSql(sql`
    SELECT clock.*, origins.origin,
      candidate.revision AS anchor_revision, candidate.recorded_at AS anchor_recorded_at,
      first_retained.revision AS first_revision, first_retained.recorded_at AS first_recorded_at
    FROM ${schema.recordedClockTable} clock
    LEFT JOIN ${schema.revisionOriginsTable} origins ON clock.graph_id=origins.graph_id
    LEFT JOIN (${recordedAnchorCandidate(schema, graphId, wallTime)}) candidate ON candidate.origin=origins.origin
    LEFT JOIN (
      SELECT anchors.revision, anchors.recorded_at FROM ${recordedAnchorsTable(schema)} anchors
      WHERE ${recordedAnchorScope(schema, graphId)}
      ORDER BY anchors.recorded_at ASC, anchors.revision ASC LIMIT 1
    ) first_retained ON 1=1
    WHERE clock.graph_id=${graphId}
  `);
  // The clock projection changes after ADD COLUMN. Reparse it on each call
  // rather than retaining a named statement with the old result descriptor.
  markForceCustomPlan(query);
  const rows = await withRecordedRelationsPrecondition(
    target.execute<RecordedAnchorSnapshot>(query),
    { dialect: target.dialect, surface },
  );
  return rows[0];
}

function retentionState(
  row: RecordedAnchorSnapshot,
  graphId: string,
): RecordedAnchorRetentionState | undefined {
  if (
    row[RECORDED_ANCHOR_RETENTION_COLUMN] === undefined ||
    row[RECORDED_ANCHOR_RETENTION_COLUMN] === null
  )
    return undefined;
  try {
    if (typeof row[RECORDED_ANCHOR_RETENTION_COLUMN] !== "string")
      throw new TypeError("Expected serialized retention state");
    const state = RetentionStateSchema.parse(
      JSON.parse(row[RECORDED_ANCHOR_RETENTION_COLUMN]) as unknown,
    );
    validateCanonicalIsoDate(state.loggedFrom, "loggedFrom");
    validateCanonicalIsoDate(state.prunedBefore, "prunedBefore");
    if (state.loggedFrom > state.prunedBefore)
      throw new TypeError("Retention coverage is inverted");
    return state;
  } catch (error) {
    throw new ConfigurationError(
      "Recorded allocation retention storage is invalid.",
      { code: "RECORDED_RETENTION_STATE_INVALID", graphId },
      { cause: error },
    );
  }
}

function firstAllocationAt(
  row: RecordedAnchorSnapshot,
  state: RecordedAnchorRetentionState | undefined,
): string | undefined {
  return (
    (state?.loggedFromFirstAllocation === true ?
      state.loggedFrom
    : undefined) ??
    ((
      Number(row.first_revision) === RECORDED_FIRST_REVISION &&
      typeof row.first_recorded_at === "string"
    ) ?
      row.first_recorded_at
    : undefined)
  );
}

function historyNotLogged(graphId: string, wallTime: string): never {
  throw new ConfigurationError(
    "The requested wall time is outside the allocation log's known coverage.",
    { code: "RECORDED_LOOKUP_HISTORY_NOT_LOGGED", graphId, wallTime },
    {
      suggestion:
        "Use a saved recorded instant or a wall time within logged coverage. Unlogged history does not prove an empty graph.",
    },
  );
}

/** Allocation time, not the database's later COMMIT visibility time. */
export async function lookupRecordedAnchor(
  context: RecordedAnchorLogContext,
  wallTime: string,
): Promise<RecordedInstant | undefined> {
  requireRecordedAnchorLog(context, "resolveRecordedInstant");
  validateCanonicalIsoDate(wallTime, "wallTime");
  const { backend, schema, graphId } = context;
  const row = await readRecordedAnchorSnapshot(
    backend,
    schema,
    graphId,
    wallTime,
    "resolve-recorded-anchor",
  );
  if (row === undefined) return undefined;
  const state = retentionState(row, graphId);
  const first = firstAllocationAt(row, state);
  if (first !== undefined && wallTime < first) return undefined;
  if (
    state !== undefined &&
    wallTime >= state.loggedFrom &&
    wallTime < state.prunedBefore
  )
    throw new ConfigurationError(
      "The requested wall time falls within explicitly pruned allocation coverage.",
      {
        code: "RECORDED_LOOKUP_HISTORY_PRUNED",
        graphId,
        wallTime,
        prunedBefore: state.prunedBefore,
      },
      {
        suggestion:
          "Use a saved recorded instant or a wall time at or after the retained boundary.",
      },
    );
  if (
    row.anchor_revision === undefined ||
    row.anchor_revision === null ||
    (state !== undefined &&
      Number(row.anchor_revision) < state.retainedRevision)
  )
    return historyNotLogged(graphId, wallTime);
  if (
    typeof row.origin !== "string" ||
    typeof row.anchor_recorded_at !== "string"
  )
    throw new ConfigurationError(
      "Retained recorded anchor storage contains an invalid coordinate.",
      { graphId },
    );
  return createRecordedInstant(
    Number(row.anchor_revision),
    row.anchor_recorded_at,
    await recordedAnchorOwner(schema, row.origin),
  );
}

function pruneLimit(options: PruneRecordedInstantsOptions): number {
  const limit = options.limit ?? DEFAULT_PRUNE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PRUNE_LIMIT)
    throw new ValidationError(
      `Recorded pruning limit must be an integer between 1 and ${MAX_PRUNE_LIMIT}.`,
      {
        issues: [{ path: "limit", message: "Invalid recorded pruning limit" }],
      },
    );
  return limit;
}

/** One bounded transaction per call; a retention job resumes while hasMore. */
export async function pruneRecordedAnchors(
  context: RecordedAnchorLogContext,
  before: string,
  options: PruneRecordedInstantsOptions = {},
): Promise<PruneRecordedInstantsResult> {
  requireRecordedAnchorLog(context, "pruneRecordedInstants");
  if (context.backend.capabilities.recordedAnchorPruning !== true)
    throw new UnsupportedBackendCapabilityError(
      "pruneRecordedInstants",
      "recordedAnchorPruning",
      { graphId: context.graphId, dialect: context.backend.dialect },
    );
  const { backend, schema, graphId } = context;
  const assertStorage = backend.assertBaseSchemaCurrent;
  if (assertStorage === undefined)
    throw new ConfigurationError(
      "recordedAnchorPruning requires backend.assertBaseSchemaCurrent.",
      {
        capability: "recordedAnchorPruning",
        missingMember: "assertBaseSchemaCurrent",
        graphId,
        dialect: backend.dialect,
      },
    );
  validateCanonicalIsoDate(before, "before");
  const limit = pruneLimit(options);
  await assertStorage();
  return runRetriedUnit(
    {
      target: backend,
      operation: "pruneRecordedInstants",
      attempts: OPTIMISTIC_RETRY_ATTEMPTS,
    },
    () =>
      backend.transaction(async (target) => {
        // The same transaction-scoped graph fence used by writers, clear, and owner rotation.
        await lockRecordedGraphWrite(target, graphId);
        const row = await readRecordedAnchorSnapshot(
          target,
          schema,
          graphId,
          before,
          "prune-recorded-anchors",
        );
        if (row === undefined)
          return {
            deletedCount: 0,
            retainedBoundary: undefined,
            hasMore: false,
          };
        const previous = retentionState(row, graphId);
        const candidate =
          row.anchor_revision === undefined || row.anchor_revision === null ?
            undefined
          : Number(row.anchor_revision);
        if (candidate === undefined && previous === undefined)
          return {
            deletedCount: 0,
            retainedBoundary: undefined,
            hasMore: false,
          };
        const advance =
          candidate !== undefined &&
          (previous === undefined || candidate > previous.retainedRevision);
        const revision =
          advance ? candidate : requireDefined(previous).retainedRevision;
        const recordedAt =
          advance ?
            row.anchor_recorded_at
          : requireDefined(previous).prunedBefore;
        if (typeof row.origin !== "string" || typeof recordedAt !== "string")
          throw new ConfigurationError(
            "Recorded pruning has no valid allocation owner or boundary.",
            { graphId },
          );
        const retainedBoundary = createRecordedInstant(
          revision,
          recordedAt,
          await recordedAnchorOwner(schema, row.origin),
        );
        const first = firstAllocationAt(row, previous);
        if (previous === undefined && typeof row.first_recorded_at !== "string")
          throw new ConfigurationError(
            "Recorded pruning has no logged coverage start.",
            { graphId },
          );
        const batches = await target.execute<
          Readonly<{
            deleted_count: unknown;
            first_revision: unknown;
            last_revision: unknown;
            has_more: unknown;
          }>
        >(
          asCompiledRowsSql(sql`
            SELECT deletion_range.*, EXISTS (
              SELECT 1 FROM ${recordedAnchorsTable(schema)} anchors
              WHERE ${recordedAnchorScope(schema, graphId, row.origin)}
                AND anchors.revision > deletion_range.last_revision AND anchors.revision < ${revision}
            ) AS has_more
            FROM (
              SELECT COUNT(*) AS deleted_count, MIN(revision) AS first_revision, MAX(revision) AS last_revision
              FROM (
                SELECT anchors.revision FROM ${recordedAnchorsTable(schema)} anchors
                WHERE ${recordedAnchorScope(schema, graphId, row.origin)} AND anchors.revision < ${revision}
                ORDER BY anchors.revision ASC LIMIT ${limit}
              ) victims
            ) deletion_range
          `),
        );
        const batch = requireDefined(batches[0]);
        const deletedCount = Number(batch.deleted_count);
        if (advance) {
          const state: RecordedAnchorRetentionState = {
            version: RETENTION_STATE_VERSION,
            loggedFromFirstAllocation: first !== undefined,
            loggedFrom: previous?.loggedFrom ?? String(row.first_recorded_at),
            prunedBefore: recordedAt,
            retainedRevision: revision,
          };
          // Publish the logical coverage floor in the SAME commit as this bounded deletion.
          const written = await target.execute(
            asCompiledRowsSql(sql`
              UPDATE ${schema.recordedClockTable} SET ${sql.identifier(RECORDED_ANCHOR_RETENTION_COLUMN)}=${JSON.stringify(state)} WHERE graph_id=${graphId}
                AND revision>=${revision}
                AND ${recordedAnchorOrigin(schema, graphId)}=${row.origin}
              RETURNING graph_id
            `),
          );
          if (written.length !== 1)
            throw new ConfigurationError(
              "Recorded pruning could not persist its coverage watermark.",
              { code: "RECORDED_RETENTION_WRITE_REFUSED", graphId },
            );
        }
        if (deletedCount > 0) {
          const firstRevision = Number(batch.first_revision);
          const lastRevision = Number(batch.last_revision);
          const deleted = await target.execute(
            asCompiledRowsSql(sql`
              DELETE FROM ${recordedAnchorsTable(schema)} AS anchors
              WHERE ${recordedAnchorScope(schema, graphId, row.origin)}
                AND anchors.revision BETWEEN ${firstRevision} AND ${lastRevision}
              RETURNING revision
            `),
          );
          if (deleted.length !== deletedCount)
            throw new ConfigurationError(
              "Recorded pruning did not delete exactly its bounded allocation range.",
              {
                code: "RECORDED_RETENTION_DELETE_REFUSED",
                graphId,
                expected: deletedCount,
                actual: deleted.length,
              },
            );
        }
        return {
          deletedCount,
          retainedBoundary,
          hasMore: Number(batch.has_more) > 0,
        };
      }),
  );
}
