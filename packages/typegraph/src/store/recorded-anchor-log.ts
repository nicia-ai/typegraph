import { z } from "zod";

import {
  OPTIMISTIC_RETRY_ATTEMPTS,
  runRetriedUnit,
} from "../backend/capabilities/retried-unit";
import { CURRENT_BASE_SCHEMA_VERSION } from "../backend/drizzle/base-schema";
import { type GraphBackend } from "../backend/types";
import {
  createRecordedInstant,
  RECORDED_MAX_REVISION,
  type RecordedInstant,
} from "../core/temporal";
import {
  BaseSchemaMigrationError,
  ConfigurationError,
  ValidationError,
} from "../errors";
import { recordedAnchorsTable, type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { validateCanonicalIsoDate } from "../utils/date";
import { requireDefined } from "../utils/presence";
import {
  isMissingColumnError,
  withRecordedRelationsPrecondition,
} from "../utils/sql-errors";
import {
  recordedAnchorCandidate,
  recordedAnchorOrigin,
  recordedAnchorScope,
} from "./recorded-anchor-log-sql";
import { recordedAnchorOwner } from "./recorded-anchor-origin";
import {
  lockRecordedGraphWrite,
  RECORDED_FIRST_REVISION,
} from "./recorded-capture/clock";
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
const RETENTION_STATE_VERSION = 2;
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
const LegacyRetentionStateSchema = RetentionStateSchema.omit({
  version: true,
  loggedFromFirstAllocation: true,
})
  .extend({
    version: z.literal(1),
    firstAllocationAt: z.string().optional(),
  })
  .refine(
    (state) =>
      state.firstAllocationAt === undefined ||
      state.firstAllocationAt === state.loggedFrom,
  )
  .transform(
    ({
      firstAllocationAt,
      ...state
    }): z.infer<typeof RetentionStateSchema> => ({
      ...state,
      version: RETENTION_STATE_VERSION,
      loggedFromFirstAllocation: firstAllocationAt !== undefined,
    }),
  );
const ReadRetentionStateSchema = z.union([
  RetentionStateSchema,
  LegacyRetentionStateSchema,
]);
type RecordedAnchorRetentionState = Readonly<
  z.infer<typeof RetentionStateSchema>
>;

type RecordedAnchorSnapshot = Readonly<{
  origin: unknown;
  revision: unknown;
  recorded_at: unknown;
  first_revision: unknown;
  first_recorded_at: unknown;
  anchor_retention: unknown;
}>;

async function readRecordedAnchorSnapshot(
  target: Pick<GraphBackend, "execute" | "dialect">,
  schema: SqlSchema,
  graphId: string,
  wallTime: string,
  surface: string,
): Promise<RecordedAnchorSnapshot | undefined> {
  const rows = await withRecordedRelationsPrecondition(
    target.execute<RecordedAnchorSnapshot>(
      asCompiledRowsSql(sql`
        WITH candidate AS (${recordedAnchorCandidate(schema, graphId, wallTime)}), first_retained AS (
          SELECT anchors.revision, anchors.recorded_at FROM ${recordedAnchorsTable(schema)} anchors
          WHERE ${recordedAnchorScope(schema, graphId)}
          ORDER BY anchors.recorded_at ASC, anchors.revision ASC LIMIT 1
        )
        SELECT origins.origin, candidate.revision, candidate.recorded_at,
          first_retained.revision AS first_revision, first_retained.recorded_at AS first_recorded_at,
          clock.anchor_retention
        FROM ${schema.recordedClockTable} clock
        LEFT JOIN ${schema.revisionOriginsTable} origins ON clock.graph_id=origins.graph_id
        LEFT JOIN candidate ON candidate.origin=origins.origin
        LEFT JOIN first_retained ON 1=1
        WHERE clock.graph_id=${graphId}
      `),
    ),
    { dialect: target.dialect, surface },
  ).catch((error: unknown) => {
    if (!isMissingColumnError(error, "anchor_retention")) throw error;
    throw new BaseSchemaMigrationError(
      {
        installedVersion: undefined,
        requiredVersion: CURRENT_BASE_SCHEMA_VERSION,
        reason: "stale",
        missingColumn: "anchor_retention",
      },
      { cause: error },
    );
  });
  return rows[0];
}

function retentionState(
  row: RecordedAnchorSnapshot,
  graphId: string,
): RecordedAnchorRetentionState | undefined {
  if (row.anchor_retention === undefined || row.anchor_retention === null)
    return undefined;
  try {
    if (typeof row.anchor_retention !== "string")
      throw new TypeError("Expected serialized retention state");
    const state = ReadRetentionStateSchema.parse(
      JSON.parse(row.anchor_retention) as unknown,
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
  validateCanonicalIsoDate(wallTime, "wallTime");
  requireRecordedAnchorLog(context, "resolveRecordedInstant");
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
    row.revision === undefined ||
    row.revision === null ||
    (state !== undefined && Number(row.revision) < state.retainedRevision)
  )
    return historyNotLogged(graphId, wallTime);
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
  validateCanonicalIsoDate(before, "before");
  const limit = pruneLimit(options);
  const { backend, schema, graphId } = context;
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
          row.revision === undefined || row.revision === null ?
            undefined
          : Number(row.revision);
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
          advance ? row.recorded_at : requireDefined(previous).prunedBefore;
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
        const state: RecordedAnchorRetentionState = {
          version: RETENTION_STATE_VERSION,
          loggedFromFirstAllocation: first !== undefined,
          loggedFrom: previous?.loggedFrom ?? String(row.first_recorded_at),
          prunedBefore: recordedAt,
          retainedRevision: revision,
        };
        const victims = await target.execute<Readonly<{ revision: unknown }>>(
          asCompiledRowsSql(sql`
            SELECT anchors.revision FROM ${recordedAnchorsTable(schema)} anchors
            WHERE ${recordedAnchorScope(schema, graphId, row.origin)} AND anchors.revision < ${revision}
            ORDER BY anchors.revision ASC LIMIT ${limit + 1}
          `),
        );
        const deletedCount = Math.min(victims.length, limit);
        // Publish the logical coverage floor in the SAME commit as this bounded deletion.
        const written = await target.execute(
          asCompiledRowsSql(sql`
            UPDATE ${schema.recordedClockTable} SET anchor_retention=${JSON.stringify(state)} WHERE graph_id=${graphId}
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
        if (deletedCount > 0) {
          const firstRevision = Number(requireDefined(victims[0]).revision);
          const lastRevision = Number(
            requireDefined(victims[deletedCount - 1]).revision,
          );
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
          hasMore: victims.length > limit,
        };
      }),
  );
}
