/**
 * The replay algorithm (§3): pairs every identity transition with the class
 * membership before and after it, reconstructed through the SAME historical
 * reader `asOf` / `asOfRecorded` reads already use. Replay can therefore never
 * disagree with a live read — see `historicalIdentityReconstructionCtes`
 * (historical-sql.ts), which every membership answer below is produced by,
 * through `loadHistoricalClasses` (service-read.ts). The transition log
 * itself supplies boundaries and explanations ONLY; it is never consulted for
 * membership.
 */
import { type GraphDef } from "../core/define-graph";
import {
  createRecordedInstant,
  parseRecordedInstant,
  type RecordedInstant,
  recordedInstantWallTime,
  resolveReadCoordinate,
  withRecordedCoordinate,
} from "../core/temporal";
import { IdentityReplayError, ValidationError } from "../errors";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import {
  loadHistoricalClasses,
  publicNodeRef,
  refKey,
  registeredPlainRef,
} from "./service-read";
import { type IdentityServiceContext } from "./service-types";
import { type PlainNodeRef } from "./sql-target";
import {
  type IdentityDecisionProvenance,
  identityReplayRequiresHistoryError,
  type IdentityTransitionCause,
  type IdentityTransitionRow,
  readIdentityTransitions,
  readTransitionRetentionDetails,
  transitionClassRef,
  transitionPriorClassRef,
} from "./transition-log";
import {
  type IdentityAssertionId,
  type IdentityNodeReference,
  type IdentityNodeRefInput,
} from "./types";

/** Default and maximum boundary counts a single `replay` call returns. */
export const IDENTITY_REPLAY_DEFAULT_LIMIT = 200;
export const IDENTITY_REPLAY_MAX_LIMIT = 2000;

export type IdentityTransition<G extends GraphDef> = Readonly<{
  transitionId: string;
  cause: IdentityTransitionCause;
  recorded: RecordedInstant;
  validAt: string;
  class: IdentityNodeReference<G>;
  priorClass?: IdentityNodeReference<G> | undefined;
  assertionIds: readonly IdentityAssertionId[];
  decision?: IdentityDecisionProvenance | undefined;
}>;

export type IdentityReplayStep<G extends GraphDef> = Readonly<{
  transition: IdentityTransition<G>;
  before: readonly IdentityNodeReference<G>[];
  after: readonly IdentityNodeReference<G>[];
}>;

export type IdentityReplay<G extends GraphDef> = Readonly<{
  steps: readonly IdentityReplayStep<G>[];
  /** Set when the retention watermark cut history above the requested start. */
  truncatedBefore?: RecordedInstant | undefined;
}>;

export type IdentityReplayOptions = Readonly<{
  fromRecorded?: string | undefined;
  toRecorded?: string | undefined;
  limit?: number | undefined;
}>;

function publicTransition<G extends GraphDef>(
  row: IdentityTransitionRow,
): IdentityTransition<G> {
  return {
    transitionId: row.transition_id,
    cause: row.cause,
    recorded: createRecordedInstant(row.recorded_revision, row.recorded_at),
    validAt: row.valid_at,
    class: publicNodeRef<G>(transitionClassRef(row)),
    priorClass:
      transitionPriorClassRef(row) === undefined ? undefined : (
        publicNodeRef<G>(requireDefined(transitionPriorClassRef(row)))
      ),
    assertionIds: row.assertion_ids as readonly IdentityAssertionId[],
    decision: row.decision,
  };
}

/**
 * Generous internal ceiling for the seed-lineage walk's OWN reads (never the
 * caller's `limit`, which is enforced once, on the fully-converged result
 * below): a round that truncated its read before the seed set converged
 * could hide the very rows that would have grown that set, silently
 * returning an incomplete lineage instead of the caller's requested
 * `IDENTITY_REPLAY_LIMIT_EXCEEDED` refusal.
 */
const IDENTITY_REPLAY_WALK_READ_CEILING = 100_000;

/**
 * The fixed-point class-lineage walk (§3.2 step 2): starting from `ref`'s
 * CURRENT class canonical, repeatedly reads every transition touching the
 * known set of class keys (forward AND reverse — a note's `class` or
 * `priorClass`), adding any newly discovered keys, until a round adds
 * nothing new.
 */
async function walkClassLineage<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  seed: PlainNodeRef,
  fromRevision: number | undefined,
  toRevision: number | undefined,
): Promise<readonly IdentityTransitionRow[]> {
  const seeds = new Map<string, PlainNodeRef>([[refKey(seed), seed]]);
  for (;;) {
    const scopeReferences = [...seeds.values()];
    const rows = await readIdentityTransitions(
      ctx.backend,
      ctx.schema,
      ctx.graphId,
      {
        classRefs: scopeReferences,
        fromRevision,
        toRevision,
        limit: IDENTITY_REPLAY_WALK_READ_CEILING,
      },
    );
    let grew = false;
    for (const row of rows) {
      const classRef = transitionClassRef(row);
      const priorClassRef = transitionPriorClassRef(row);
      if (!seeds.has(refKey(classRef))) {
        seeds.set(refKey(classRef), classRef);
        grew = true;
      }
      if (priorClassRef !== undefined && !seeds.has(refKey(priorClassRef))) {
        seeds.set(refKey(priorClassRef), priorClassRef);
        grew = true;
      }
    }
    if (!grew) return rows;
  }
}

/**
 * The reconstruction coordinate's valid-time instant.
 *
 * The RECORDED (revision) filter alone already selects the exact row IMAGE
 * that was current as of `revision` — `recorded_from <= revision <
 * recorded_to` — so the remaining valid-time check only has to tell open
 * (`valid_to IS NULL`, always visible) from closed rows apart. A closed row's
 * `valid_to` is always assigned in the SAME commit as the row's own
 * `recorded_from` (retract/detach/window-end stamp both together), so any
 * instant at or after "now" is at or after every real `valid_to` ever
 * written — the row reads as closed at exactly the revisions it is, whichever
 * wall clock is used to ask. No historical relation retains a genuine
 * per-revision wall clock to look one up instead (only
 * `typegraph_identity_transitions` and the single-row
 * `typegraph_recorded_clock` carry `recorded_at` at all), so "now" is not an
 * approximation here — it is the one instant guaranteed to postdate every
 * `valid_to` this graph has ever written, for any graph with no
 * future-scheduled validity window (identity carries no such concept).
 */
function reconstructionInstant(): string {
  return nowIso();
}

/** Reconstructs the visible class membership of `seed` at recorded revision `revision`, or `[]` for revision 0 (nothing recorded yet). */
async function reconstructAt<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  seed: PlainNodeRef,
  revision: number,
): Promise<readonly IdentityNodeReference<G>[]> {
  if (revision <= 0) return [];
  const recordedInstant = createRecordedInstant(
    revision,
    reconstructionInstant(),
  );
  const validCoordinate = resolveReadCoordinate(
    "asOf",
    recordedInstantWallTime(recordedInstant),
  );
  const coordinate = withRecordedCoordinate(validCoordinate, recordedInstant);
  const classes = await loadHistoricalClasses(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    [seed],
    coordinate,
    ctx.sameIdAcrossKinds,
  );
  const found = requireDefined(classes.get(refKey(seed)));
  return found.visible.map((ref) => publicNodeRef<G>(ref));
}

function resolveLimit(limit: number | undefined): number {
  const resolved = limit ?? IDENTITY_REPLAY_DEFAULT_LIMIT;
  if (resolved > IDENTITY_REPLAY_MAX_LIMIT) {
    throw new ValidationError(
      `replay limit must be at most ${String(IDENTITY_REPLAY_MAX_LIMIT)}.`,
      {
        issues: [
          {
            path: "limit",
            message: `Got ${String(resolved)}.`,
          },
        ],
      },
    );
  }
  return resolved;
}

function requireHistoryEnabled<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): void {
  if (!ctx.historyEnabled)
    throw identityReplayRequiresHistoryError(ctx.graphId);
}

function distinctBoundaries(
  rows: readonly IdentityTransitionRow[],
): readonly number[] {
  return [...new Set(rows.map((row) => row.recorded_revision))].toSorted(
    (left, right) => left - right,
  );
}

function identityReplayLimitExceededError(
  rows: readonly IdentityTransitionRow[],
  boundaries: readonly number[],
  limit: number,
): IdentityReplayError {
  const cutoffRevision = requireDefined(boundaries[limit]);
  const cutoffRow = requireDefined(
    rows.find((row) => row.recorded_revision === cutoffRevision),
  );
  return new IdentityReplayError(
    `Identity replay found more transition boundaries than the requested limit (${String(limit)}).`,
    {
      code: "IDENTITY_REPLAY_LIMIT_EXCEEDED",
      limit,
      resumeFromRecorded: createRecordedInstant(
        cutoffRow.recorded_revision,
        cutoffRow.recorded_at,
      ),
    },
    {
      suggestion:
        "Pass a larger limit, or page by re-calling with fromRecorded set to details.resumeFromRecorded.",
    },
  );
}

/** Throws `IDENTITY_REPLAY_LIMIT_EXCEEDED` when the walk found more DISTINCT boundaries (recorded revisions) than `limit` allows — §3.2 step 3 compares boundary count, not raw row count. */
function assertBoundaryLimit(
  rows: readonly IdentityTransitionRow[],
  limit: number,
): void {
  const boundaries = distinctBoundaries(rows);
  if (boundaries.length > limit) {
    throw identityReplayLimitExceededError(rows, boundaries, limit);
  }
}

function identityReplayHistoryTruncatedError(
  requestedFrom: string,
  prunedBefore: string,
): IdentityReplayError {
  return new IdentityReplayError(
    "The requested replay range lies entirely below the retention watermark: its history has been pruned.",
    { code: "IDENTITY_REPLAY_HISTORY_TRUNCATED", requestedFrom, prunedBefore },
    {
      suggestion:
        "Request a range at or after the watermark, or omit fromRecorded to see everything retained.",
    },
  );
}

/**
 * Every transition (§3.1's `transitionsOf`) touching `ref`'s class lineage,
 * ascending by recorded revision. `store.identity.transitionsOf` (PR-3) is a
 * thin wrapper over this.
 */
export async function identityTransitionsOf<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): Promise<readonly IdentityTransition<G>[]> {
  requireHistoryEnabled(ctx);
  const limit = resolveLimit(options?.limit);
  const seed = registeredPlainRef(ctx, ref);
  const fromRevision =
    options?.fromRecorded === undefined ?
      undefined
    : parseRecordedInstant(options.fromRecorded, "fromRecorded").revision;
  const toRevision =
    options?.toRecorded === undefined ?
      undefined
    : parseRecordedInstant(options.toRecorded, "toRecorded").revision;
  const rows = await walkClassLineage(ctx, seed, fromRevision, toRevision);
  assertBoundaryLimit(rows, limit);
  return rows.map((row) => publicTransition<G>(row));
}

/**
 * The full replay algorithm (§3.2): every transition touching `ref`'s class
 * lineage, each paired with the class membership immediately before and
 * after it. `before(b_i) := after(b_{i-1})` for every boundary but the first —
 * sound because §2.3's cause set is exhaustive, so no membership-changing
 * revision can fall between two consecutive boundaries undetected.
 * `store.identity.replay` (PR-3) is a thin wrapper over this.
 */
export async function identityReplay<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): Promise<IdentityReplay<G>> {
  requireHistoryEnabled(ctx);
  const limit = resolveLimit(options?.limit);
  const seed = registeredPlainRef(ctx, ref);
  const fromRevision =
    options?.fromRecorded === undefined ?
      undefined
    : parseRecordedInstant(options.fromRecorded, "fromRecorded").revision;
  const toRevision =
    options?.toRecorded === undefined ?
      undefined
    : parseRecordedInstant(options.toRecorded, "toRecorded").revision;
  const rows = await walkClassLineage(ctx, seed, fromRevision, toRevision);
  assertBoundaryLimit(rows, limit);

  const retention = await readTransitionRetentionDetails(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
  );
  const watermark = retention.prunedBeforeRevision;
  // "Entirely below the watermark" is a property of the REQUESTED range, not
  // of what came back: only a range bounded on both ends (`toRecorded` given)
  // can lie wholly in pruned territory — an open-ended range always reaches
  // up to "now", which the watermark can never exceed.
  if (watermark > 0 && toRevision !== undefined && toRevision < watermark) {
    throw identityReplayHistoryTruncatedError(
      options?.fromRecorded ?? requireDefined(options?.toRecorded),
      createRecordedInstant(watermark, retention.prunedAt),
    );
  }

  const boundaries = distinctBoundaries(rows);

  const steps: IdentityReplayStep<G>[] = [];
  let previousAfter: readonly IdentityNodeReference<G>[] | undefined;
  for (const boundary of boundaries) {
    const before =
      previousAfter ?? (await reconstructAt(ctx, seed, boundary - 1));
    const after = await reconstructAt(ctx, seed, boundary);
    previousAfter = after;
    for (const row of rows) {
      if (row.recorded_revision !== boundary) continue;
      steps.push({
        transition: publicTransition<G>(row),
        before,
        after,
      });
    }
  }

  const requestedFromRevision = fromRevision ?? 0;
  const truncatedBefore =
    watermark > requestedFromRevision ?
      createRecordedInstant(watermark, retention.prunedAt)
    : undefined;

  return {
    steps,
    ...(truncatedBefore === undefined ? {} : { truncatedBefore }),
  };
}
