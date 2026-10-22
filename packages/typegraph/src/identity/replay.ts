/**
 * The replay algorithm: pairs every identity transition with the class
 * membership before and after it, reconstructed through the SAME historical
 * reader `asOfRecorded` reads use, at the SAME coordinate
 * (`recordedDiagonalCoordinate`): a step's `after` is what
 * `store.asOfRecorded(step.transition.recorded)` answers, under the graph's
 * current schema. See `historicalIdentityReconstructionCtes`
 * (historical-sql.ts), which every membership answer below is produced by,
 * through `loadHistoricalClasses` (service-read.ts). The transition log
 * itself supplies boundaries and explanations ONLY; it is never consulted for
 * membership.
 */
import { requireTypeGraphRecordedRevision } from "../backend/capabilities/recorded-time-ownership";
import { type GraphDef } from "../core/define-graph";
import {
  createRecordedInstant,
  RECORDED_FIRST_REVISION,
  recordedDiagonalCoordinate,
  type RecordedInstant,
  recordedInstantRevision,
  recordedInstantWallTime,
  type RestoredRecordedInstant,
} from "../core/temporal";
import { IdentityReplayError, ValidationError } from "../errors";
import { requireDefined } from "../utils/presence";
import { readIdentityEvidenceNeighbours } from "./lineage-evidence";
import { identityActiveKinds } from "./service-components";
import {
  type HistoricalClass,
  loadCurrentStructuralClasses,
  loadHistoricalClasses,
  publicNodeRef,
  refKey,
  registeredPlainRef,
} from "./service-read";
import { type IdentityServiceContext } from "./service-types";
import { type PlainNodeRef } from "./sql-target";
import {
  countRestoredIdentityTransitions,
  type IdentityDecisionProvenance,
  type IdentityTransitionCause,
  type IdentityTransitionCursor,
  type IdentityTransitionRow,
  isRestoredTransitionRow,
  readIdentityTransitions,
  readTransitionRetentionDetails,
  requireIdentityTransitionLog,
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

/** A transition this graph's own history capture recorded. */
export type RecordedIdentityTransition<G extends GraphDef> = Readonly<{
  transitionId: string;
  cause: IdentityTransitionCause;
  recorded: RecordedInstant;
  validAt: string;
  class: IdentityNodeReference<G>;
  priorClass?: IdentityNodeReference<G> | undefined;
  assertionIds: readonly IdentityAssertionId[];
  decision?: IdentityDecisionProvenance | undefined;
  restored?: undefined;
}>;

/** What every transition carries whoever recorded it. */
type IdentityTransitionFields<G extends GraphDef> = Omit<
  RecordedIdentityTransition<G>,
  "recorded" | "restored"
>;

/**
 * A transition an ARCHIVAL RESTORE inserted into the graph being read, rather
 * than this graph's own history capture recording it — the public face of the
 * internal marker `isRestoredTransitionRow` reads. An audit surface uses it to
 * tell an imported explanation from a locally replayable event: `replay`
 * deliberately excludes every restored transition from `steps` (a restored
 * row's revision was minted by the SOURCE graph's clock and interleaves
 * arbitrarily with this graph's, so no before/after could be reconstructed for
 * it honestly), while `transitionsOf` returns it like any other.
 *
 * `recorded` is therefore a {@link RestoredRecordedInstant}, not a
 * {@link RecordedInstant}. `restored.at` is the destination graph's WALL
 * CLOCK at restore time: a restore records history, it does not relive it, so
 * it never advances this graph's recorded revision counter and there is no
 * revision on this graph's own axis to pair the timestamp with. The coarser
 * retention watermark (`truncatedBefore`) is the only revision-shaped signal a
 * restore leaves behind.
 */
export type RestoredIdentityTransition<G extends GraphDef> = Omit<
  RecordedIdentityTransition<G>,
  "recorded" | "restored"
> &
  Readonly<{
    recorded: RestoredRecordedInstant;
    restored: Readonly<{ at: string }>;
  }>;

/** One entry of a `transitionsOf` page; `restored` tells the two apart. */
export type IdentityTransition<G extends GraphDef> =
  RecordedIdentityTransition<G> | RestoredIdentityTransition<G>;

/**
 * One paired boundary from {@link identityReplay}. Its transition is always
 * one this graph recorded: `identityReplay` builds `steps` only from native
 * rows, because a restored row's revision is minted by the source graph's
 * clock and cannot be paired with a before/after reconstructed on THIS
 * graph's historical reader (see {@link RestoredIdentityTransition}).
 */
export type IdentityReplayStep<G extends GraphDef> = Readonly<{
  transition: RecordedIdentityTransition<G>;
  before: readonly IdentityNodeReference<G>[];
  after: readonly IdentityNodeReference<G>[];
}>;

declare const TRANSITION_PAGE_CURSOR_BRAND: unique symbol;

/**
 * The continuation cursor a paged transition read hands back: it names the
 * first BOUNDARY the page did not include, and is `undefined` when the page
 * reached the end of the lineage. Pass it back as `options.cursor` to read the
 * next page; the boundary it names opens that page exactly once.
 *
 * A cursor is NOT a recorded instant. It is minted from one, including one a
 * restored row's SOURCE graph allocated (see {@link RestoredIdentityTransition}),
 * so it must never reach `store.asOfRecorded`, which anchors a historical read
 * on THIS graph's own recorded axis. To keep the two apart at runtime as well
 * as in the type system, its string form carries a prefix no recorded instant
 * has: `fromRecorded` / `toRecorded` refuse it, and `cursor` refuses a bare
 * recorded instant.
 *
 * A cursor is also bound to the reference whose lineage it pages. A position
 * in one reference's lineage says nothing about another's, so a cursor handed
 * to a read for a different reference is refused rather than silently
 * skipping every boundary of that reference below the revision it names.
 */
export type TransitionPageCursor = string & {
  readonly [TRANSITION_PAGE_CURSOR_BRAND]: "TransitionPageCursor";
};

const TRANSITION_PAGE_CURSOR_PREFIX = "tpc1:";
const TRANSITION_PAGE_CURSOR_SEPARATOR = ":";

function transitionPageCursor(
  reference: PlainNodeRef,
  revision: number,
  recordedAt: string,
): TransitionPageCursor {
  // `encodeURIComponent` escapes the separator, so a kind or id containing it
  // can never shift where the instant begins.
  return [
    `${TRANSITION_PAGE_CURSOR_PREFIX}${encodeURIComponent(reference.kind)}`,
    encodeURIComponent(reference.id),
    createRecordedInstant(revision, recordedAt),
  ].join(TRANSITION_PAGE_CURSOR_SEPARATOR) as TransitionPageCursor;
}

function isTransitionPageCursorShaped(value: string): boolean {
  return value.startsWith(TRANSITION_PAGE_CURSOR_PREFIX);
}

function invalidCursorError(message: string): ValidationError {
  return new ValidationError(
    `cursor must be a page cursor returned as nextCursor by a previous transitionsOf / replay page for the same reference. ${message}`,
    { issues: [{ path: "cursor", message }] },
  );
}

function decodeCursorReference(
  encodedKind: string,
  encodedId: string,
): PlainNodeRef {
  try {
    return {
      kind: decodeURIComponent(encodedKind),
      id: decodeURIComponent(encodedId),
    };
  } catch (error) {
    if (error instanceof URIError)
      throw invalidCursorError("Malformed transition page cursor.");
    throw error;
  }
}

/**
 * The revision a cursor names, for a read of `reference`'s lineage. Refuses
 * anything that was not minted as a cursor, and a cursor minted for another
 * reference.
 */
function requireCursorRevision(
  cursor: string,
  reference: PlainNodeRef,
): number {
  if (!isTransitionPageCursorShaped(cursor))
    throw invalidCursorError(
      "Not a transition page cursor. A recorded instant belongs in fromRecorded / toRecorded.",
    );
  const body = cursor.slice(TRANSITION_PAGE_CURSOR_PREFIX.length);
  const kindEnd = body.indexOf(TRANSITION_PAGE_CURSOR_SEPARATOR);
  const idEnd = body.indexOf(TRANSITION_PAGE_CURSOR_SEPARATOR, kindEnd + 1);
  if (kindEnd === -1 || idEnd === -1)
    throw invalidCursorError("Malformed transition page cursor.");
  const cursorReference = decodeCursorReference(
    body.slice(0, kindEnd),
    body.slice(kindEnd + 1, idEnd),
  );
  if (refKey(cursorReference) !== refKey(reference))
    throw invalidCursorError(
      `This cursor pages the lineage of ${cursorReference.kind}/${cursorReference.id}, not ${reference.kind}/${reference.id}.`,
    );
  return requireTypeGraphRecordedRevision(body.slice(idEnd + 1), "cursor");
}

/** A window bound is a recorded instant; a page cursor handed to one is a misuse with a specific remedy. */
function requireWindowRevision(
  value: string,
  surface: "fromRecorded" | "toRecorded",
): number {
  if (isTransitionPageCursorShaped(value))
    throw new ValidationError(
      `${surface} must be a recorded instant, not a page cursor.`,
      {
        issues: [
          {
            path: surface,
            message:
              "Got a transition page cursor. Pass nextCursor as options.cursor.",
          },
        ],
      },
    );
  return requireTypeGraphRecordedRevision(value, surface);
}

/**
 * Set on a `transitionsOf` / `replay` result when lineage discovery could not
 * vouch for the whole answer, so a short or empty page is never mistaken for
 * "nothing happened".
 *
 * `unattributedRestoredTransitions` counts the transitions an archival restore
 * brought into this graph that discovery could neither tie to the requested
 * reference nor rule out. Discovery follows this graph's own recorded
 * evidence, and a restore carries none for what happened on the source graph
 * before the archive was taken, so a member that had already left its class
 * there cannot be traced to the restored rows that explain it.
 */
export type IdentityLineageIncompleteDiscovery = Readonly<{
  unattributedRestoredTransitions: number;
}>;

export type IdentityReplay<G extends GraphDef> = Readonly<{
  steps: readonly IdentityReplayStep<G>[];
  /** Set when the retention watermark cut history above the requested start. */
  truncatedBefore?: RecordedInstant | undefined;
  /**
   * Set when `limit` capped this page; pass it as `cursor` for the next one.
   * Addresses the TRANSITION LOG only — like
   * {@link RestoredIdentityTransition}'s `recorded`, this can name a revision a
   * restored row's SOURCE graph allocated, not this graph. Never pass it to
   * `store.asOfRecorded`; pass it only as `cursor`.
   */
  nextCursor?: TransitionPageCursor | undefined;
  /** Set when discovery could not vouch for the whole lineage; identical on every page. */
  incompleteDiscovery?: IdentityLineageIncompleteDiscovery | undefined;
}>;

/** One page of {@link identityTransitionsOf}'s answer. */
export type IdentityTransitionHistory<G extends GraphDef> = Readonly<{
  transitions: readonly IdentityTransition<G>[];
  /**
   * Set when `limit` capped this page; pass it as `cursor` for the next one.
   * Addresses the TRANSITION LOG only — like
   * {@link RestoredIdentityTransition}'s `recorded`, this can name a revision a
   * restored row's SOURCE graph allocated, not this graph. Never pass it to
   * `store.asOfRecorded`; pass it only as `cursor`.
   */
  nextCursor?: TransitionPageCursor | undefined;
  /** Set when discovery could not vouch for the whole lineage; identical on every page. */
  incompleteDiscovery?: IdentityLineageIncompleteDiscovery | undefined;
}>;

/**
 * `fromRecorded` / `toRecorded` bound the recorded window (inclusive).
 * `cursor` continues a paged read from the `nextCursor` a previous page
 * returned. The cursor is a position within the windowed lineage, so it
 * composes with the window by intersection: the page starts at the later of
 * `fromRecorded` and the cursor, and ends at `toRecorded`. A cursor combined
 * with a different window than the one it came from is therefore well
 * defined, never an error.
 */
export type IdentityReplayOptions = Readonly<{
  fromRecorded?: string | undefined;
  toRecorded?: string | undefined;
  cursor?: TransitionPageCursor | undefined;
  limit?: number | undefined;
}>;

function transitionFields<G extends GraphDef>(
  row: IdentityTransitionRow,
): IdentityTransitionFields<G> {
  const priorClassRef = transitionPriorClassRef(row);
  return {
    transitionId: row.transition_id,
    cause: row.cause,
    validAt: row.valid_at,
    class: publicNodeRef<G>(transitionClassRef(row)),
    priorClass:
      priorClassRef === undefined ? undefined : publicNodeRef<G>(priorClassRef),
    assertionIds: row.assertion_ids as readonly IdentityAssertionId[],
    decision: row.decision,
  };
}

function recordedTransition<G extends GraphDef>(
  row: IdentityTransitionRow,
): RecordedIdentityTransition<G> {
  return {
    ...transitionFields<G>(row),
    recorded: createRecordedInstant(row.recorded_revision, row.recorded_at),
  };
}

function publicTransition<G extends GraphDef>(
  row: IdentityTransitionRow,
): IdentityTransition<G> {
  if (row.restored_at === undefined) return recordedTransition<G>(row);
  return {
    ...transitionFields<G>(row),
    recorded: createRecordedInstant(
      row.recorded_revision,
      row.recorded_at,
    ) as string as RestoredRecordedInstant,
    restored: { at: row.restored_at },
  };
}

/**
 * Resolves `ref`'s CURRENT class canonical (one closure probe), one of the seeds of the lineage WALK (see
 * {@link lineageWalkSeeds}) — never the historical reconstruction.
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
 * own canonical discovers — is both correct and what the brute-force
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
 * Every reference `ref` was ever tied to by recorded identity evidence — the
 * fixed point of {@link readIdentityEvidenceNeighbours} from `ref` itself.
 *
 * This is what makes a DEPARTED member's lineage discoverable. Once a member
 * leaves its class its current canonical is itself, and its own departure is
 * noted against the surviving class's canonical (`diffClosureTransitions`'s
 * "absent from the new state" branch), so {@link currentClassCanonicalSeed}
 * alone seeds a walk that matches nothing. The evidence that once put the
 * member in the class still names it, and every canonical its classes ever
 * carried is reachable through that evidence, so seeding the walk with this
 * set reaches the notes the current closure can no longer point at.
 *
 * Bounded by the same ceiling as the walk it seeds, for the same reason: the
 * alternative to refusing is an unbounded read.
 */
async function everConnectedReferences<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: PlainNodeRef,
): Promise<readonly PlainNodeRef[]> {
  const connected = new Map<string, PlainNodeRef>([[refKey(ref), ref]]);
  let frontier: readonly PlainNodeRef[] = [ref];
  while (frontier.length > 0) {
    const neighbours = await readIdentityEvidenceNeighbours(
      ctx.backend,
      ctx.schema,
      ctx.graphId,
      frontier,
      ctx.sameIdAcrossKinds,
    );
    const discovered = new Map<string, PlainNodeRef>();
    for (const neighbour of neighbours) {
      const key = refKey(neighbour);
      if (!connected.has(key)) discovered.set(key, neighbour);
    }
    for (const [key, neighbour] of discovered) connected.set(key, neighbour);
    if (connected.size > IDENTITY_REPLAY_WALK_ROW_CEILING) {
      throw identityReplayWalkIncompleteError(IDENTITY_REPLAY_WALK_ROW_CEILING);
    }
    frontier = [...discovered.values()];
  }
  return [...connected.values()];
}

/**
 * The references the lineage walk starts from: `ref`'s current class canonical
 * (see {@link currentClassCanonicalSeed}) together with everything recorded
 * evidence ever tied `ref` to (see {@link everConnectedReferences}). The ONE
 * owner of "where does a lineage walk begin", so `transitionsOf` and `replay`
 * cannot discover different lineages for the same reference.
 */
async function lineageWalkSeeds<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: PlainNodeRef,
): Promise<readonly PlainNodeRef[]> {
  return [
    await currentClassCanonicalSeed(ctx, ref),
    ...(await everConnectedReferences(ctx, ref)),
  ];
}

/**
 * How many restored transitions the walk could neither attribute to the
 * lineage nor rule out of it, or `undefined` when there are none.
 *
 * A restored row names class canonicals on the SOURCE graph's timeline. The
 * evidence the walk is seeded from is this graph's own recorded relations,
 * which hold nothing about what happened on the source before the restore, so
 * a restored row the walk did not reach may still belong to this reference —
 * a member that had already left its class when the archive was taken leaves
 * no trace here to find it by. That cannot be told apart from a row that is
 * simply about another class, so it is reported rather than silently omitted.
 */
async function unattributedRestoredTransitions<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  discovered: readonly IdentityTransitionRow[],
): Promise<number | undefined> {
  const restored = await countRestoredIdentityTransitions(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
  );
  const attributed = discovered.filter((row) =>
    isRestoredTransitionRow(row),
  ).length;
  return restored > attributed ? restored - attributed : undefined;
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
 * The fixed-point class-lineage walk: starting from
 * {@link lineageWalkSeeds}, repeatedly reads every transition touching the
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
  walkSeeds: readonly PlainNodeRef[],
): Promise<readonly IdentityTransitionRow[]> {
  const seeds = new Map<string, PlainNodeRef>(
    walkSeeds.map((seed) => [refKey(seed), seed]),
  );
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
 * How a reconstruction reads identity: under which same-id profile and over
 * which node kinds. The graph's CURRENT reading is what a recorded view uses;
 * {@link membershipReadings} adds the readings an earlier schema could have
 * used.
 */
type IdentityReading = Readonly<{
  sameIdAcrossKinds: "fold" | "ignore";
  kinds: ReadonlySet<string>;
}>;

function currentReading<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
): IdentityReading {
  return {
    sameIdAcrossKinds: ctx.sameIdAcrossKinds,
    kinds: identityActiveKinds(ctx.registry),
  };
}

/**
 * Reconstructs the visible class membership of `seed` at `recordedAsOf`, on
 * the diagonal `store.asOfRecorded` reads: the anchor's revision, seen from
 * the valid instant the anchor carries. That shared coordinate
 * ({@link recordedDiagonalCoordinate}) is what makes a step's `after` and
 * `store.asOfRecorded(step.transition.recorded).identity.membersOf` one read,
 * and what keeps a step's answer fixed: a validity window that was still
 * open when the step was recorded stays open in the step, however long after
 * it lapses the replay is asked for.
 *
 * Unless a `reading` is given, the class is read under the graph's CURRENT
 * identity profile and node kinds, exactly as a recorded view is. A step
 * recorded before a `sameIdAcrossKinds` flip or a kind removal is therefore
 * shown as the current schema reads that revision, not as the schema then in
 * force did.
 */
async function reconstructAt<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  seed: PlainNodeRef,
  recordedAsOf: RecordedInstant,
  reading: IdentityReading = currentReading(ctx),
): Promise<HistoricalClass> {
  const classes = await loadHistoricalClasses(
    ctx.backend,
    ctx.schema,
    ctx.graphId,
    [seed],
    recordedDiagonalCoordinate(recordedAsOf),
    reading.sameIdAcrossKinds,
    reading.kinds,
  );
  return requireDefined(classes.get(refKey(seed)));
}

const NO_HISTORICAL_CLASS: HistoricalClass = {
  structural: [],
  visible: [],
  foldEligible: [],
};

/**
 * The membership immediately BEFORE the commit recorded at `boundary`: one
 * revision earlier, seen from the same valid instant, so the only thing that
 * differs between a step's `before` and `after` is that one commit. Nothing
 * was recorded before revision 1.
 */
async function reconstructBefore<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  seed: PlainNodeRef,
  boundary: RecordedInstant,
  reading?: IdentityReading,
): Promise<HistoricalClass> {
  const priorRevision = recordedInstantRevision(boundary) - 1;
  if (priorRevision < RECORDED_FIRST_REVISION) return NO_HISTORICAL_CLASS;
  return reconstructAt(
    ctx,
    seed,
    createRecordedInstant(priorRevision, recordedInstantWallTime(boundary)),
    reading,
  );
}

/** `seed`'s class on either side of one native boundary. */
type BoundaryClasses = Readonly<{
  before: HistoricalClass;
  after: HistoricalClass;
}>;

/**
 * The readings a row's membership is judged under, current reading first.
 *
 * A note names a class under the schema in force when it was written, and a
 * kind drop or a same-id profile change is exactly what makes today's reading
 * unable to see that class: the dropped kind's members are not in it, and a
 * cross-kind pair is no longer one class. Judging such a note by today's
 * reading alone would discard the history that explains how the member got
 * where it is. The log itself says which schema changes touched this lineage,
 * so the readings are widened by exactly that: every kind a note names (not
 * only the registered ones), and, when a schema transition was noted, the
 * other same-id profile.
 */
function membershipReadings<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  lineage: readonly IdentityTransitionRow[],
): readonly IdentityReading[] {
  const current = currentReading(ctx);
  const namedKinds = new Set(current.kinds);
  for (const row of lineage) {
    namedKinds.add(row.class_kind);
    if (row.prior_class_kind !== undefined)
      namedKinds.add(row.prior_class_kind);
  }
  const profiles: readonly ("fold" | "ignore")[] =
    lineage.some((row) => row.cause === "schema-transition") ?
      ["fold", "ignore"]
    : [current.sameIdAcrossKinds];
  const widened = profiles
    .map((sameIdAcrossKinds) => ({ sameIdAcrossKinds, kinds: namedKinds }))
    .filter(
      (reading) =>
        reading.sameIdAcrossKinds !== current.sameIdAcrossKinds ||
        reading.kinds.size !== current.kinds.size,
    );
  return [current, ...widened];
}

/**
 * Whether a native transition row explains a change to the class `seed`
 * belonged to on either side of its boundary: its `class` or `priorClass`
 * canonical is a member of that class just before or at the boundary, under
 * any of the {@link membershipReadings}.
 *
 * The lineage walk reaches every class `seed`'s evidence ever touched,
 * including classes it has since left, so a row it finds is about `seed` only
 * while `seed` was in that class. Membership is the STRUCTURAL class (every
 * member the reconstruction reaches, visible or not), because a note names
 * its class's closure canonical, which can be a member whose own validity
 * window has not opened or has already closed at the boundary.
 */
function namesBoundaryClass(
  row: IdentityTransitionRow,
  members: ReadonlySet<string>,
): boolean {
  const priorClassRef = transitionPriorClassRef(row);
  return (
    members.has(refKey(transitionClassRef(row))) ||
    (priorClassRef !== undefined && members.has(refKey(priorClassRef)))
  );
}

/** Every reference `seed`'s class held on either side of a boundary under `reading`. */
async function structuralMembersAround<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  seed: PlainNodeRef,
  recordedAsOf: RecordedInstant,
  reading: IdentityReading,
): Promise<readonly PlainNodeRef[]> {
  const [before, after] = [
    await reconstructBefore(ctx, seed, recordedAsOf, reading),
    await reconstructAt(ctx, seed, recordedAsOf, reading),
  ];
  return [...before.structural, ...after.structural];
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
 * `limit: 0` would hand back an empty page whose `nextCursor` names the very
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

function laterRevision(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined || right === undefined) return left ?? right;
  return Math.max(left, right);
}

/** The rows of each boundary (distinct recorded revision), ascending, each group in arrival order. */
function groupByBoundary(
  rows: readonly IdentityTransitionRow[],
): readonly (readonly IdentityTransitionRow[])[] {
  const groups = new Map<number, IdentityTransitionRow[]>();
  for (const row of rows) {
    const group = groups.get(row.recorded_revision) ?? [];
    group.push(row);
    groups.set(row.recorded_revision, group);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, group]) => group);
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
 * One boundary of a page: the rows kept at one recorded revision and, when any
 * of them is native, the seed's class on either side of it.
 */
type MemberBoundary = Readonly<{
  rows: readonly IdentityTransitionRow[];
  classes?: BoundaryClasses | undefined;
}>;

type MemberBoundaryPage = Readonly<{
  boundaries: readonly MemberBoundary[];
  nextCursor?: TransitionPageCursor | undefined;
}>;

/**
 * Keeps, of one boundary's rows, the ones that belong to `seed`'s own history:
 * a native row only while `seed` was a member of the class it names (see
 * {@link namesBoundaryClass}), and every restored row. A restored row names a
 * class on the SOURCE graph's timeline, which this graph cannot reconstruct,
 * so it stays governed by discovery alone and is reported through
 * `incompleteDiscovery` when discovery cannot vouch for it.
 */
async function memberBoundary<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  seed: PlainNodeRef,
  readings: readonly IdentityReading[],
  rows: readonly IdentityTransitionRow[],
): Promise<MemberBoundary> {
  const firstNative = rows.find((row) => !isRestoredTransitionRow(row));
  if (firstNative === undefined) return { rows };
  // Every native row of one boundary was flushed by one commit and carries
  // its recorded instant.
  const recordedAsOf = createRecordedInstant(
    firstNative.recorded_revision,
    firstNative.recorded_at,
  );
  const classes: BoundaryClasses = {
    before: await reconstructBefore(ctx, seed, recordedAsOf),
    after: await reconstructAt(ctx, seed, recordedAsOf),
  };
  const members = new Set(
    [...classes.before.structural, ...classes.after.structural].map((member) =>
      refKey(member),
    ),
  );
  for (const reading of readings.slice(1)) {
    for (const member of await structuralMembersAround(
      ctx,
      seed,
      recordedAsOf,
      reading,
    ))
      members.add(refKey(member));
  }
  const kept = rows.filter(
    (row) => isRestoredTransitionRow(row) || namesBoundaryClass(row, members),
  );
  return {
    rows: kept,
    ...(kept.some((row) => !isRestoredTransitionRow(row)) ? { classes } : {}),
  };
}

/**
 * Cuts the windowed lineage into one page of at most `limit` BOUNDARIES
 * (distinct recorded revisions) of `seed`'s own history, not `limit` rows — a
 * page counts boundaries, and every note sharing a boundary shares one replay
 * step, so a row-counted page could split a single step's rows across two
 * pages. A boundary none of whose rows belongs to `seed` (see
 * {@link memberBoundary}) is skipped, and does not count.
 *
 * Boundaries are judged in order and only until the page is full, so a page
 * reconstructs the boundaries it returns plus the ones it skipped on the way,
 * never the whole lineage. `nextCursor` names the first kept boundary this
 * page did NOT include, so a caller pages by re-issuing the identical call
 * with `cursor: nextCursor` (the cursor's boundary is inclusive). One owner for
 * both `transitionsOf` and `replay`: they page identically, or a caller
 * pairing an explanation from one with a membership step from the other would
 * see the two disagree about where the page ended.
 */
async function pageMemberBoundaries<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  seed: PlainNodeRef,
  readings: readonly IdentityReading[],
  rows: readonly IdentityTransitionRow[],
  limit: number,
): Promise<MemberBoundaryPage> {
  const boundaries: MemberBoundary[] = [];
  for (const group of groupByBoundary(rows)) {
    const boundary = await memberBoundary(ctx, seed, readings, group);
    const first = boundary.rows[0];
    if (first === undefined) continue;
    if (boundaries.length === limit) {
      return {
        boundaries,
        nextCursor: transitionPageCursor(
          seed,
          first.recorded_revision,
          first.recorded_at,
        ),
      };
    }
    boundaries.push(boundary);
  }
  return { boundaries };
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
  fromRevision: number | undefined;
  toRevision: number | undefined;
  boundaries: readonly MemberBoundary[];
  nextCursor?: TransitionPageCursor | undefined;
  incompleteDiscovery?: IdentityLineageIncompleteDiscovery | undefined;
}>;

/**
 * The shared setup both `identityTransitionsOf` and `identityReplay` need
 * before they diverge: enforce `history: true`, resolve the requested limit
 * and revision bounds, seed and run the lineage walk, report what the walk
 * could not vouch for, narrow the converged result to the requested window,
 * and cut one page of at most `limit` boundaries of the reference's own
 * history from it. Classes are reconstructed against the caller's ORIGINAL
 * reference (not the resolved class canonical) — see `reconstructAt`'s
 * docblock for why the two must not be conflated.
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
  requireIdentityTransitionLog(ctx);
  const limit = resolveLimit(options?.limit);
  const seed = registeredPlainRef(ctx, ref);
  const windowFromRevision =
    options?.fromRecorded === undefined ?
      undefined
    : requireWindowRevision(options.fromRecorded, "fromRecorded");
  const toRevision =
    options?.toRecorded === undefined ?
      undefined
    : requireWindowRevision(options.toRecorded, "toRecorded");
  const cursorRevision =
    options?.cursor === undefined ?
      undefined
    : requireCursorRevision(options.cursor, seed);
  const fromRevision = laterRevision(windowFromRevision, cursorRevision);
  const discovered = await walkClassLineage(
    ctx,
    await lineageWalkSeeds(ctx, seed),
  );
  const unattributed = await unattributedRestoredTransitions(ctx, discovered);
  const page = await pageMemberBoundaries(
    ctx,
    seed,
    membershipReadings(ctx, discovered),
    windowedRows(discovered, fromRevision, toRevision),
    limit,
  );
  return {
    fromRevision,
    toRevision,
    boundaries: page.boundaries,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    ...(unattributed === undefined ?
      {}
    : {
        incompleteDiscovery: { unattributedRestoredTransitions: unattributed },
      }),
  };
}

/**
 * Every transition that changed `ref`'s own identity class — the class it was
 * a member of on either side of the transition — ascending by recorded
 * revision, in pages of at most `limit` boundaries. A class `ref` has left
 * keeps a history of its own, and none of it is reported here.
 * `store.identity.transitionsOf` is a thin wrapper over this.
 */
export async function identityTransitionsOf<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): Promise<IdentityTransitionHistory<G>> {
  const { boundaries, nextCursor, incompleteDiscovery } =
    await walkedTransitionsFor(ctx, ref, options);
  return {
    transitions: boundaries.flatMap((boundary) =>
      boundary.rows.map((row) => publicTransition<G>(row)),
    ),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(incompleteDiscovery === undefined ? {} : { incompleteDiscovery }),
  };
}

/**
 * The full replay algorithm: every transition `identityTransitionsOf` reports,
 * each paired with the class membership immediately before and after it.
 * Both are reconstructed for every boundary — `after` at the boundary's own
 * revision, `before` one revision earlier — and neither is carried over from
 * the previous boundary. A class can change between two boundaries without a
 * note under the schema then in force (a same-id node created while the graph
 * ignored same ids, read back after it folds them), and carrying `after`
 * forward would pin that change on the next transition. They are the same
 * reconstruction that decided the boundary belongs to `ref`
 * ({@link memberBoundary}), so the membership a step shows and the decision to
 * show it cannot disagree. `store.identity.replay` is a thin wrapper over this.
 *
 * Paged by boundary exactly as `transitionsOf` is: `nextCursor` names the first
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
  const {
    fromRevision,
    toRevision,
    boundaries,
    nextCursor,
    incompleteDiscovery,
  } = await walkedTransitionsFor(ctx, ref, options);

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
  // changed and why". A boundary holding only restored rows carries no
  // reconstruction, so no step is ever built at a revision this graph did not
  // allocate.
  const steps: IdentityReplayStep<G>[] = [];
  for (const { rows, classes } of boundaries) {
    if (classes === undefined) continue;
    const before = classes.before.visible.map((member) =>
      publicNodeRef<G>(member),
    );
    const after = classes.after.visible.map((member) =>
      publicNodeRef<G>(member),
    );
    for (const row of rows) {
      if (isRestoredTransitionRow(row)) continue;
      steps.push({ transition: recordedTransition<G>(row), before, after });
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
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(incompleteDiscovery === undefined ? {} : { incompleteDiscovery }),
  };
}
