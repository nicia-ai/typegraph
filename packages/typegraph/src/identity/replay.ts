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
  loadCurrentStructuralClasses,
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
  isRestoredTransitionRow,
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
 * Resolves `ref`'s CURRENT class canonical (§3.2 step 2's "one closure
 * probe"), to seed the lineage WALK — never the historical reconstruction.
 * Every transition note names the class canonical — never an arbitrary
 * member — as its `class` / `priorClass` columns, so `walkClassLineage` must
 * be seeded from the canonical, not from `ref` itself: in a k-member class,
 * k-1 members are non-canonical and no note ever names them, so seeding the
 * walk with one of them finds nothing.
 *
 * `reconstructAt`, by contrast, keeps reconstructing against the CALLER's
 * original `ref` throughout `identityReplay` — never this resolved canonical.
 * The canonical is a label that can itself postdate part of the walked
 * lineage (the member that ends up canonical need not be the oldest one), so
 * reconstructing at an early boundary through it can ask about a node that
 * did not exist yet and get back an empty class where the caller's own `ref`
 * already had one. `historicalIdentityReconstructionCtes` resolves the same
 * class from any live member, canonical or not, so anchoring on the ORIGINAL
 * `ref` — which is guaranteed to exist for every boundary the walk from its
 * own canonical discovers — is both correct and what §9.3's brute-force
 * oracle (`store.asOfRecorded(r).identity.membersOf(seed)`, using that same
 * original `ref`) is checked against.
 */
async function currentClassCanonicalSeed<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: PlainNodeRef,
): Promise<PlainNodeRef> {
  const classes = await loadCurrentStructuralClasses(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    [ref],
  );
  const members = requireDefined(classes.get(refKey(ref)));
  return requireDefined(members[0]);
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
    // A round that read exactly the ceiling cannot tell "these are all the
    // rows there are" from "the read cut off before the seed set converged" —
    // exactly the hazard this constant's docblock names. Refuse rather than
    // silently return a lineage that might be missing the rows that would
    // have grown the seed set further.
    if (rows.length === IDENTITY_REPLAY_WALK_READ_CEILING) {
      throw new IdentityReplayError(
        "Identity replay's lineage walk read more transition rows in one round than its internal ceiling allows, so completeness cannot be guaranteed.",
        {
          code: "IDENTITY_REPLAY_WALK_INCOMPLETE",
          ceiling: IDENTITY_REPLAY_WALK_READ_CEILING,
        },
        {
          suggestion:
            "Narrow fromRecorded/toRecorded to shrink the scanned range, or prune older transitions with pruneIdentityTransitions.",
        },
      );
    }
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
 * The reconstruction coordinate's valid-time vantage: always "now".
 *
 * This is a deliberate coordinate choice, not a consequence of every
 * historical window happening to have already closed — identity DOES support
 * future-dated windows (`assertSame` / `assertDifferent` accept an explicit
 * `IdentityValidityWindow`, and a node's own `validTo` can be future-dated
 * too; the window-end note itself is taken against a future window in the
 * shipped tests). Replay answers "what did this class look like once
 * revision `r` had been recorded, read from TODAY's valid-time vantage" — the
 * same hybrid `(recorded = r, valid = now)` coordinate `asOfRecorded` reads
 * use — so that `after(r)` here and `store.asOfRecorded(r).identity.membersOf`
 * can never disagree (the equivalence the exhaustiveness property test, §9.3,
 * pins). A future-scheduled window simply has not closed yet at "now",
 * exactly as it has not closed for any other current-vantage read; replay
 * does not need it to have closed for this coordinate to be sound.
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
  requestedFrom: string | undefined,
  requestedTo: string,
  prunedBefore: string,
): IdentityReplayError {
  return new IdentityReplayError(
    "The requested replay range lies entirely below the retention watermark: its history has been pruned.",
    {
      code: "IDENTITY_REPLAY_HISTORY_TRUNCATED",
      ...(requestedFrom === undefined ? {} : { requestedFrom }),
      requestedTo,
      prunedBefore,
    },
    {
      suggestion:
        "Request a range at or after the watermark, or omit fromRecorded to see everything retained.",
    },
  );
}

type WalkedTransitions = Readonly<{
  seed: PlainNodeRef;
  fromRevision: number | undefined;
  toRevision: number | undefined;
  limit: number;
  rows: readonly IdentityTransitionRow[];
}>;

/**
 * The shared setup both `identityTransitionsOf` and `identityReplay` need
 * before they diverge: enforce `history: true`, resolve the requested limit
 * and revision bounds, seed and run the lineage walk (§3.2 step 2), and
 * enforce the boundary-count limit (§3.2 step 3) on the result. `seed` is the
 * caller's ORIGINAL reference (not the resolved class canonical), for
 * `identityReplay`'s `reconstructAt` calls — see that function's docblock for
 * why the two must not be conflated.
 */
async function walkedTransitionsFor<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: IdentityNodeRefInput<G>,
  options: IdentityReplayOptions | undefined,
): Promise<WalkedTransitions> {
  requireHistoryEnabled(ctx);
  const limit = resolveLimit(options?.limit);
  const seed = registeredPlainRef(ctx, ref);
  const walkSeed = await currentClassCanonicalSeed(ctx, seed);
  const fromRevision =
    options?.fromRecorded === undefined ?
      undefined
    : parseRecordedInstant(options.fromRecorded, "fromRecorded").revision;
  const toRevision =
    options?.toRecorded === undefined ?
      undefined
    : parseRecordedInstant(options.toRecorded, "toRecorded").revision;
  const rows = await walkClassLineage(ctx, walkSeed, fromRevision, toRevision);
  assertBoundaryLimit(rows, limit);
  return { seed, fromRevision, toRevision, limit, rows };
}

/**
 * Every transition touching `ref`'s class lineage, ascending by recorded
 * revision. `store.identity.transitionsOf` is a thin wrapper over this.
 */
export async function identityTransitionsOf<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): Promise<readonly IdentityTransition<G>[]> {
  const { rows } = await walkedTransitionsFor(ctx, ref, options);
  return rows.map((row) => publicTransition<G>(row));
}

/**
 * The full replay algorithm: every transition touching `ref`'s class
 * lineage, each paired with the class membership immediately before and
 * after it. `before(b_i) := after(b_{i-1})` for every boundary but the first —
 * sound because the transition cause set is exhaustive (see
 * `IdentityTransitionCause`), so no membership-changing revision can fall
 * between two consecutive boundaries undetected. `store.identity.replay` is
 * a thin wrapper over this.
 */
export async function identityReplay<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): Promise<IdentityReplay<G>> {
  const { seed, fromRevision, toRevision, rows } = await walkedTransitionsFor(
    ctx,
    ref,
    options,
  );

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
      options?.fromRecorded,
      requireDefined(options?.toRecorded),
      createRecordedInstant(watermark, retention.prunedAt),
    );
  }

  // Restored rows carry the SOURCE graph's own revision number, which
  // interleaves arbitrarily with this graph's — a numeric watermark
  // comparison cannot tell "a foreign row that happens to sit above the
  // floor" from "this graph's own later history" apart (see
  // `isRestoredTransitionRow`'s docblock, and the retention watermark's own
  // "cannot vouch below N" contract, which is coarser and orthogonal). Steps
  // are therefore built ONLY from this graph's own (never restored) rows;
  // `transitionsOf` (no such filter) remains the complete answer for "what
  // changed and why". Filtering the boundary set itself — not merely the
  // rows matched at each boundary — also means the next NATIVE boundary
  // computes its own fresh `before` here (`previousAfter` never chains
  // through a boundary that held only restored rows).
  const nativeRows = rows.filter((row) => !isRestoredTransitionRow(row));
  const boundaries = distinctBoundaries(nativeRows);

  const steps: IdentityReplayStep<G>[] = [];
  let previousAfter: readonly IdentityNodeReference<G>[] | undefined;
  for (const boundary of boundaries) {
    const before =
      previousAfter ?? (await reconstructAt(ctx, seed, boundary - 1));
    const after = await reconstructAt(ctx, seed, boundary);
    previousAfter = after;
    for (const row of nativeRows) {
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
