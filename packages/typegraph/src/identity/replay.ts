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
import { requireTypeGraphRecordedRevision } from "../backend/capabilities/recorded-time-ownership";
import { type GraphDef } from "../core/define-graph";
import {
  createRecordedInstant,
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
  type IdentityTransitionCursor,
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

/** Default and maximum boundary counts a single `replay` PAGE returns. */
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
  /**
   * Present when an ARCHIVAL RESTORE inserted this row into the graph being
   * read, rather than this graph's own history capture recording it — the
   * public face of the internal marker `isRestoredTransitionRow` reads. An
   * audit surface uses it to tell an imported explanation from a locally
   * replayable event: `replay` deliberately excludes every restored
   * transition from `steps` (a restored row's `recorded` revision was minted
   * by the SOURCE graph's clock and interleaves arbitrarily with this
   * graph's, so no before/after could be reconstructed for it honestly),
   * while `transitionsOf` returns it like any other.
   *
   * `at` is the destination graph's WALL CLOCK at restore time, not a
   * {@link RecordedInstant}: a restore records history, it does not relive
   * it, so it never advances this graph's recorded revision counter and
   * there is no revision on this graph's own axis to pair the timestamp
   * with. The coarser retention watermark (`truncatedBefore`) is the only
   * revision-shaped signal a restore leaves behind.
   */
  restored?: Readonly<{ at: string }> | undefined;
}>;

/**
 * One paired boundary from {@link identityReplay}. `transition.restored` is
 * NEVER set here — `identityReplay` builds `steps` only from `nativeRows`
 * (rows this graph's own history capture recorded), by construction; a
 * restored row's revision is minted by the source graph's clock and cannot
 * be paired with a before/after reconstructed on THIS graph's historical
 * reader (see {@link IdentityTransition.restored}'s docblock for why). The
 * invariant lives on the `IdentityTransition` field rather than a narrower
 * type here so the two APIs share one transition shape; a step's `restored`
 * check, if ever written, is permanently dead code.
 */
export type IdentityReplayStep<G extends GraphDef> = Readonly<{
  transition: IdentityTransition<G>;
  before: readonly IdentityNodeReference<G>[];
  after: readonly IdentityNodeReference<G>[];
}>;

/**
 * The continuation cursor a paged transition read hands back: the recorded
 * instant of the first BOUNDARY the page did not include, or `undefined` when
 * the page reached the end of the lineage. Pass it back as `fromRecorded` to
 * read the next page — `fromRecorded` is inclusive, so the boundary this
 * names opens the next page exactly once.
 *
 * SCOPED TO THE TRANSITION LOG ONLY. When the cutoff boundary holds a
 * restored row (see {@link IdentityTransition.restored}), the revision this
 * names was minted by the SOURCE graph's clock, not this graph's — it is
 * `RecordedInstant`-shaped by construction (`requireTypeGraphRecordedRevision`
 * cannot tell the two apart), but it must never be passed to
 * `store.asOfRecorded`, which anchors a historical read on THIS graph's own
 * recorded axis. Use it only as `fromRecorded` on the next `transitionsOf` /
 * `replay` call.
 */
type PagedTransitions = Readonly<{
  rows: readonly IdentityTransitionRow[];
  nextFrom?: RecordedInstant | undefined;
}>;

export type IdentityReplay<G extends GraphDef> = Readonly<{
  steps: readonly IdentityReplayStep<G>[];
  /** Set when the retention watermark cut history above the requested start. */
  truncatedBefore?: RecordedInstant | undefined;
  /**
   * Set when `limit` capped this page; pass it as `fromRecorded` for the
   * next one. Addresses the TRANSITION LOG only — like
   * {@link IdentityTransition.restored}'s `at`, this can name a revision a
   * restored row's SOURCE graph allocated, not this graph. Never pass it to
   * `store.asOfRecorded`; pass it only as `fromRecorded`.
   */
  nextFrom?: RecordedInstant | undefined;
}>;

/** One page of {@link identityTransitionsOf}'s answer. */
export type IdentityTransitionHistory<G extends GraphDef> = Readonly<{
  transitions: readonly IdentityTransition<G>[];
  /**
   * Set when `limit` capped this page; pass it as `fromRecorded` for the
   * next one. Addresses the TRANSITION LOG only — like
   * {@link IdentityTransition.restored}'s `at`, this can name a revision a
   * restored row's SOURCE graph allocated, not this graph. Never pass it to
   * `store.asOfRecorded`; pass it only as `fromRecorded`.
   */
  nextFrom?: RecordedInstant | undefined;
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
    ...(row.restored_at === undefined ?
      {}
    : { restored: { at: row.restored_at } }),
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
 * Page size for each ROUND-TRIP the seed-lineage walk issues while reading
 * one round to exhaustion (see {@link walkClassLineage}): generous enough
 * that a typical lineage's round completes in a single page, but never the
 * caller's `limit`, which caps the PAGE assembled from the fully-converged
 * result below.
 */
const IDENTITY_REPLAY_WALK_PAGE_SIZE = 100_000;

/**
 * Safety backstop on the fixed-point walk's TOTAL accumulated row count,
 * across every round and every page within a round combined. This is not a
 * bound on any lineage's legitimate size — a real lineage, however large,
 * pages through {@link IDENTITY_REPLAY_WALK_PAGE_SIZE}-sized reads via the
 * `after` keyset cursor with no destructive remedy required, up to this
 * ceiling. Reached only by a pathologically large or corrupted transition
 * log, where the alternative is an unbounded read; see
 * `identityReplayWalkIncompleteError`.
 */
const IDENTITY_REPLAY_WALK_ROW_CEILING = 2_000_000;

/**
 * The fixed-point class-lineage walk (§3.2 step 2): starting from `ref`'s
 * CURRENT class canonical, repeatedly reads every transition touching the
 * known set of class keys (forward AND reverse — a note's `class` or
 * `priorClass`), adding any newly discovered keys, until a round adds
 * nothing new.
 *
 * DISCOVERY IS UNBOUNDED BY THE CALLER'S WINDOW, deliberately: the seed set
 * has to reach every class name the node ever carried before any window can
 * be applied to the result. A class key enters the set only by appearing on
 * some note, and the note that names it can sit anywhere on the recorded
 * axis — typically ABOVE the requested window, since the walk starts from
 * the node's CURRENT canonical and works backwards through `priorClass`
 * hops. Scoping the read by the caller's `fromRecorded`/`toRecorded` cut
 * exactly those hops and silently returned an empty lineage for a window
 * whose transitions were sitting in the log: B and C merge at revision 1, A
 * joins and becomes canonical at revision 2, and a walk bounded at revision
 * 1 never sees the revision-2 note that would have taught it B's name.
 * `readIdentityTransitions` therefore takes no revision bounds at all
 * (transition-log.ts) — the window is applied once, by
 * {@link windowedRows}, to the converged result.
 *
 * DISCOVERY IS ALSO UNBOUNDED BY ROW COUNT, deliberately: each round pages
 * to exhaustion through `readIdentityTransitions`'s `after` keyset cursor
 * rather than capping at a fixed ceiling, so a class lineage with more rows
 * than any one page holds still converges correctly — it costs more round
 * trips, never an incomplete or refused read. Only
 * {@link IDENTITY_REPLAY_WALK_ROW_CEILING}, a backstop against a
 * pathologically large or corrupted log, can still refuse.
 */
async function walkClassLineage<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  seed: PlainNodeRef,
): Promise<readonly IdentityTransitionRow[]> {
  const seeds = new Map<string, PlainNodeRef>([[refKey(seed), seed]]);
  let totalRowsRead = 0;
  for (;;) {
    const scopeReferences = [...seeds.values()];
    const roundRows: IdentityTransitionRow[] = [];
    let after: IdentityTransitionCursor | undefined;
    for (;;) {
      const page = await readIdentityTransitions(
        ctx.backend,
        ctx.schema,
        ctx.graphId,
        {
          classRefs: scopeReferences,
          limit: IDENTITY_REPLAY_WALK_PAGE_SIZE,
          ...(after === undefined ? {} : { after }),
        },
      );
      roundRows.push(...page);
      totalRowsRead += page.length;
      if (totalRowsRead > IDENTITY_REPLAY_WALK_ROW_CEILING) {
        throw identityReplayWalkIncompleteError(
          IDENTITY_REPLAY_WALK_ROW_CEILING,
        );
      }
      if (page.length < IDENTITY_REPLAY_WALK_PAGE_SIZE) break;
      const lastOfPage = requireDefined(page.at(-1));
      after = {
        recordedRevision: lastOfPage.recorded_revision,
        transitionId: lastOfPage.transition_id,
      };
    }
    let grew = false;
    for (const row of roundRows) {
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
    if (!grew) return roundRows;
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

function invalidReplayLimitError(
  requirement: string,
  resolved: number,
): ValidationError {
  return new ValidationError(`replay limit must be ${requirement}.`, {
    issues: [{ path: "limit", message: `Got ${String(resolved)}.` }],
  });
}

/**
 * The typed refusal `walkClassLineage` throws when
 * {@link IDENTITY_REPLAY_WALK_ROW_CEILING} is exceeded. Exported (module
 * path only, not through a package barrel — mirrors how `readIdentityTransitions`
 * is imported "by module path directly" in transition-log.ts's own tests) so
 * a unit test can assert its `code`, `ceiling` detail, and suggestion string
 * directly, without constructing a lineage large enough to trigger it for
 * real.
 */
export function identityReplayWalkIncompleteError(
  ceiling: number,
): IdentityReplayError {
  return new IdentityReplayError(
    "Identity replay's lineage walk accumulated more transition rows than its internal safety ceiling allows, so completeness cannot be guaranteed.",
    { code: "IDENTITY_REPLAY_WALK_INCOMPLETE", ceiling },
    {
      suggestion:
        "Prune older transitions with pruneIdentityTransitions. Narrowing fromRecorded/toRecorded does not help: lineage discovery reads the whole log on purpose, so that a window can never hide the notes that name a class.",
    },
  );
}

/**
 * A page size must be a whole number of at least one. The lower bound is not
 * decoration: {@link pageBoundaries} cuts the page at `boundaries[limit]`, so
 * `limit: 0` would hand back an empty page whose `nextFrom` names the very
 * first boundary — re-issuing with that cursor returns the identical empty
 * page forever, and the documented `while (cursor !== undefined)` paging loop
 * never terminates. A fractional limit indexes past a boundary that is not
 * there and escapes as a bare `TypeError` from `requireDefined`.
 */
function resolveLimit(limit: number | undefined): number {
  const resolved = limit ?? IDENTITY_REPLAY_DEFAULT_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1)
    throw invalidReplayLimitError("an integer of at least 1", resolved);
  if (resolved > IDENTITY_REPLAY_MAX_LIMIT)
    throw invalidReplayLimitError(
      `at most ${String(IDENTITY_REPLAY_MAX_LIMIT)}`,
      resolved,
    );
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

/** Applies the caller's recorded window to the fully-discovered lineage — the ONE place `fromRecorded`/`toRecorded` narrow anything, since discovery itself must stay unbounded (see {@link walkClassLineage}). */
function windowedRows(
  rows: readonly IdentityTransitionRow[],
  fromRevision: number | undefined,
  toRevision: number | undefined,
): readonly IdentityTransitionRow[] {
  return rows.filter(
    (row) =>
      (fromRevision === undefined || row.recorded_revision >= fromRevision) &&
      (toRevision === undefined || row.recorded_revision <= toRevision),
  );
}

/**
 * Cuts the windowed lineage into one page of at most `limit` BOUNDARIES
 * (distinct recorded revisions), not `limit` rows — §3.2 step 3 counts
 * boundaries, and every note sharing a boundary shares one replay step, so a
 * row-counted page could split a single step's rows across two pages.
 *
 * `nextFrom` names the first boundary this page did NOT include, so a caller
 * pages by re-issuing the identical call with `fromRecorded: nextFrom`
 * (`fromRecorded` is inclusive). One owner for both `transitionsOf` and
 * `replay`: they page identically, or a caller pairing an explanation from
 * one with a membership step from the other would see the two disagree about
 * where the page ended.
 */
function pageBoundaries(
  rows: readonly IdentityTransitionRow[],
  limit: number,
): PagedTransitions {
  const boundaries = distinctBoundaries(rows);
  if (boundaries.length <= limit) return { rows };
  const cutoffRevision = requireDefined(boundaries[limit]);
  const cutoffRow = requireDefined(
    rows.find((row) => row.recorded_revision === cutoffRevision),
  );
  return {
    rows: rows.filter((row) => row.recorded_revision < cutoffRevision),
    nextFrom: createRecordedInstant(
      cutoffRow.recorded_revision,
      cutoffRow.recorded_at,
    ),
  };
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
  rows: readonly IdentityTransitionRow[];
  nextFrom?: RecordedInstant | undefined;
}>;

/**
 * The shared setup both `identityTransitionsOf` and `identityReplay` need
 * before they diverge: enforce `history: true`, resolve the requested limit
 * and revision bounds, seed and run the lineage walk (§3.2 step 2), narrow
 * the converged result to the requested window, and cut it into one page of
 * at most `limit` boundaries (§3.2 step 3). `seed` is the caller's ORIGINAL
 * reference (not the resolved class canonical), for `identityReplay`'s
 * `reconstructAt` calls — see that function's docblock for why the two must
 * not be conflated.
 *
 * The three stages are ordered and cannot be reshuffled: discovery must run
 * unbounded, the window applies to what discovery found, and the page is cut
 * from what the window kept.
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
    : requireTypeGraphRecordedRevision(options.fromRecorded, "fromRecorded");
  const toRevision =
    options?.toRecorded === undefined ?
      undefined
    : requireTypeGraphRecordedRevision(options.toRecorded, "toRecorded");
  const discovered = await walkClassLineage(ctx, walkSeed);
  const page = pageBoundaries(
    windowedRows(discovered, fromRevision, toRevision),
    limit,
  );
  return {
    seed,
    fromRevision,
    toRevision,
    rows: page.rows,
    ...(page.nextFrom === undefined ? {} : { nextFrom: page.nextFrom }),
  };
}

/**
 * Every transition touching `ref`'s class lineage, ascending by recorded
 * revision, in pages of at most `limit` boundaries.
 * `store.identity.transitionsOf` is a thin wrapper over this.
 */
export async function identityTransitionsOf<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): Promise<IdentityTransitionHistory<G>> {
  const { rows, nextFrom } = await walkedTransitionsFor(ctx, ref, options);
  return {
    transitions: rows.map((row) => publicTransition<G>(row)),
    ...(nextFrom === undefined ? {} : { nextFrom }),
  };
}

/**
 * The full replay algorithm: every transition touching `ref`'s class
 * lineage, each paired with the class membership immediately before and
 * after it. `before(b_i) := after(b_{i-1})` for every boundary but the first —
 * sound because the transition cause set is exhaustive (see
 * `IdentityTransitionCause`), so no membership-changing revision can fall
 * between two consecutive boundaries undetected. `store.identity.replay` is
 * a thin wrapper over this.
 *
 * Paged by boundary exactly as `transitionsOf` is: `nextFrom` names the first
 * boundary this page stopped short of. Because the page is cut BEFORE
 * restored rows are excluded, `steps` can be shorter than `limit` boundaries
 * on a page whose lineage mixes restored and native rows — the page boundary
 * stays identical between the two methods, which is what lets a caller pair
 * a `transitionsOf` explanation with a `replay` step page for page.
 */
export async function identityReplay<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): Promise<IdentityReplay<G>> {
  const { seed, fromRevision, toRevision, rows, nextFrom } =
    await walkedTransitionsFor(ctx, ref, options);

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
  // rows matched at each boundary — also means `previousAfter` is only ever
  // set from a `reconstructAt` at a revision THIS graph allocated: a
  // restored-only boundary is dropped from `boundaries` entirely, so it can
  // never overwrite `previousAfter` with a reconstruction at a foreign
  // revision, and the next NATIVE boundary's `before` stays sound.
  const nativeRows = rows.filter((row) => !isRestoredTransitionRow(row));
  // Grouped in ONE pass: a boundary's rows are read from the map rather than
  // re-scanning the whole lineage per boundary, which a wide page (up to
  // `IDENTITY_REPLAY_MAX_LIMIT` boundaries, each with unbounded rows) pays for
  // quadratically. Insertion order within a revision is preserved, so each
  // boundary emits its steps in the order the rows arrived, and the sorted keys
  // ARE the boundary list.
  const rowsByBoundary = new Map<number, IdentityTransitionRow[]>();
  for (const row of nativeRows) {
    const group = rowsByBoundary.get(row.recorded_revision) ?? [];
    group.push(row);
    rowsByBoundary.set(row.recorded_revision, group);
  }
  const boundaries = [...rowsByBoundary.keys()].toSorted(
    (left, right) => left - right,
  );

  const steps: IdentityReplayStep<G>[] = [];
  let previousAfter: readonly IdentityNodeReference<G>[] | undefined;
  for (const boundary of boundaries) {
    const before =
      previousAfter ?? (await reconstructAt(ctx, seed, boundary - 1));
    const after = await reconstructAt(ctx, seed, boundary);
    previousAfter = after;
    for (const row of rowsByBoundary.get(boundary) ?? []) {
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
    ...(nextFrom === undefined ? {} : { nextFrom }),
  };
}
