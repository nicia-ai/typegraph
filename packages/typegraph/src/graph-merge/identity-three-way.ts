/**
 * The identity survivor rule, the semantic and window-aware dedupe keys, and
 * the THREE-WAY classifier built on them: ONE classifier for duplicate
 * assertions, opposing relations and retract/reassert races. Duplicates reduce
 * to one survivor and report the rest as dropped; opposing relations and a
 * retract/reassert race have no rule that settles them, so each fails the plan
 * with {@link IdentityMergeConflictError}.
 *
 * The plan-time dedupe and the post-remap re-dedupe that runs after endpoint
 * canonicalization call the SAME comparator — a second copy of the survivor
 * rule is exactly the kind of decision this repository's contract discipline
 * forbids re-spelling.
 */
import { identityAssertionSemanticKey } from "../identity/assertion-key";
import { identityValidityWindowsOverlap } from "../identity/validity-window";
import { requireDefined } from "../utils/presence";
import { encodeTupleKey } from "../utils/tuple-key";
import { IdentityMergeConflictError } from "./errors";
import { type EntityRef, entityRef } from "./evidence";
import { mergeKeyOf } from "./node-key";
import type {
  StagedIdentityAssertion,
  StagedRetraction,
  StagingSet,
} from "./staging";
import {
  compareCodePoints,
  type IdentityTransferAssertion,
} from "./typegraph-internal";
import type { DroppedItem } from "./types";

/**
 * The semantic key two identity assertions are compared under: the relation
 * plus the code-point-normalized endpoint pair, WITHOUT the validity window.
 * Two assertions sharing this key describe the same claim about the same
 * pair, whatever window each one carries.
 */
function identitySemanticKey(assertion: IdentityTransferAssertion): string {
  return identityAssertionSemanticKey(
    assertion.relation,
    assertion.a,
    assertion.b,
  );
}

/**
 * The WINDOW-AWARE dedupe key: the semantic key, further split by validity
 * window for a BOUNDED assertion (one with a `validTo`). An unbounded
 * (current) assertion dedupes purely on the semantic key — there is only ever
 * one "current" truth for a pair — while two branches asserting the SAME
 * bounded window are treated as the same claim and two DIFFERENT bounded
 * windows are kept distinct.
 */
export function identityDedupeKey(
  assertion: IdentityTransferAssertion,
): string {
  const semantic = identitySemanticKey(assertion);
  if (assertion.validTo === undefined) return semantic;
  return encodeTupleKey([semantic, assertion.validFrom, assertion.validTo]);
}

/**
 * Orders two colliding identity assertions so the caller can pick a
 * deterministic survivor: earliest `validFrom` wins, and a tie breaks on the
 * assertion id's code-point order. Callers needing the COMMITTED-id override
 * (an id the target already holds with the exact staged truth always wins
 * regardless of this order) apply it before falling back to this comparator.
 */
function compareIdentitySurvivors(
  left: IdentityTransferAssertion,
  right: IdentityTransferAssertion,
): number {
  const byValidity = compareCodePoints(left.validFrom, right.validFrom);
  return byValidity === 0 ? compareCodePoints(left.id, right.id) : byValidity;
}

/**
 * THE survivor decision for two identity assertions describing one semantic
 * pair, and the only place the committed-id override and the comparator are
 * spelled. Both paths that must choose between two colliding assertions — the
 * staged classifier and the post-remap re-dedupe — reduce through this one
 * function, so neither can spell a survivor rule of its own and drift.
 *
 * An id the target ALREADY holds with the exact staged truth always wins: the
 * applier is idempotent per semantic pair, so a freshly minted branch id could
 * never displace the target's committed row, and choosing it would report an
 * id as applied that is never written while listing the target's own row as
 * dropped.
 */
function pickIdentitySurvivor<
  T extends Readonly<{ assertion: IdentityTransferAssertion }>,
>(
  candidate: T,
  incumbent: T,
  committedIds: ReadonlySet<string>,
): Readonly<{ winner: T; loser: T }> {
  const candidateCommitted = committedIds.has(candidate.assertion.id);
  const incumbentCommitted = committedIds.has(incumbent.assertion.id);
  if (candidateCommitted !== incumbentCommitted) {
    const [winner, loser] =
      candidateCommitted ?
        ([candidate, incumbent] as const)
      : ([incumbent, candidate] as const);
    return { winner, loser };
  }
  const [winner, loser] =
    compareIdentitySurvivors(candidate.assertion, incumbent.assertion) < 0 ?
      ([candidate, incumbent] as const)
    : ([incumbent, candidate] as const);
  return { winner, loser };
}

/**
 * Whether the loser is the very row that won: the same id carrying the same
 * complete truth. Two branches staging the IDENTICAL row collapse silently —
 * reporting one as dropped while it is the row applied would make the report
 * self-contradictory.
 */
function isIdenticalIdentityRow(
  left: IdentityTransferAssertion,
  right: IdentityTransferAssertion,
): boolean {
  return (
    left.id === right.id &&
    left.validFrom === right.validFrom &&
    (left.validTo ?? undefined) === (right.validTo ?? undefined)
  );
}

/**
 * Reason recorded when two branches asserted the SAME semantic pair and the
 * survivor rule kept only one of the two assertion ids.
 */
export const DUPLICATE_IDENTITY_ASSERTION_DROP_REASON =
  "identity:duplicate-assertion";

function droppedIdentityAssertion(
  assertion: IdentityTransferAssertion,
  reason: string,
): DroppedItem {
  return { kind: "identity", id: assertion.id, reason };
}

/** Structural (kind, id) tuple key for one identity assertion ENDPOINT PAIR. */
function pairEndpointKey(
  assertion: Readonly<{ a: EntityRef; b: EntityRef }>,
): string {
  return encodeTupleKey([
    assertion.a.kind,
    assertion.a.id,
    assertion.b.kind,
    assertion.b.id,
  ]);
}

function entityRefOf(ref: Readonly<{ kind: string; id: string }>): EntityRef {
  return entityRef(mergeKeyOf(ref));
}

/**
 * One endpoint pair whose staged claims OPPOSE each other: the `same` side, the
 * `different` side, and the first pair of the two whose validity windows
 * actually overlap — the witness a refusal names.
 */
type OpposingRelationGroup<T> = Readonly<{
  endpoint: string;
  items: readonly T[];
  same: readonly T[];
  different: readonly T[];
  overlap: Readonly<{ same: T; different: T }>;
}>;

function firstOverlappingOpposingPair<T>(
  same: readonly T[],
  different: readonly T[],
  assertionOf: (item: T) => IdentityTransferAssertion,
): Readonly<{ same: T; different: T }> | undefined {
  for (const sameItem of same) {
    for (const differentItem of different) {
      if (
        identityValidityWindowsOverlap(
          assertionOf(sameItem),
          assertionOf(differentItem),
        )
      ) {
        return { same: sameItem, different: differentItem };
      }
    }
  }
  return undefined;
}

/**
 * THE "do these staged claims oppose each other" decision: groups items by
 * endpoint pair, splits each group into `same` and `different`, and keeps only
 * the groups where the two sides overlap in valid time. Both callers — the
 * staged classifier and the post-remap re-validation — read their groups from
 * here, so neither can spell its own overlap rule or group the endpoints its
 * own way.
 */
function opposingRelationGroups<T>(
  items: readonly T[],
  assertionOf: (item: T) => IdentityTransferAssertion,
): readonly OpposingRelationGroup<T>[] {
  const byEndpoint = new Map<string, T[]>();
  for (const item of items) {
    const assertion = assertionOf(item);
    const key = pairEndpointKey({
      a: entityRefOf(assertion.a),
      b: entityRefOf(assertion.b),
    });
    const group = byEndpoint.get(key) ?? [];
    group.push(item);
    byEndpoint.set(key, group);
  }
  const groups: OpposingRelationGroup<T>[] = [];
  for (const [endpoint, group] of byEndpoint) {
    const same = group.filter((item) => assertionOf(item).relation === "same");
    const different = group.filter(
      (item) => assertionOf(item).relation === "different",
    );
    const overlap = firstOverlappingOpposingPair(same, different, assertionOf);
    if (overlap === undefined) continue;
    groups.push({ endpoint, items: group, same, different, overlap });
  }
  return groups;
}

/** The one refusal both opposing-relations checks throw. */
function opposingRelationsConflictError(
  same: IdentityTransferAssertion,
  different: IdentityTransferAssertion,
  endpoint: string,
): IdentityMergeConflictError {
  return new IdentityMergeConflictError(
    "Branches asserted opposing identity relations for one endpoint pair.",
    { details: { endpoint, assertions: [same, different] } },
  );
}

/** What classifying one identity pair (one semantic key, one validity window) decided. */
export type IdentityPairOutcome =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{
      kind: "asserted";
      survivor: IdentityTransferAssertion;
      superseded: readonly DroppedItem[];
    }>
  | Readonly<{ kind: "retracted"; retraction: IdentityTransferAssertion }>;

/**
 * Reduces N candidate assertions for the SAME window to one survivor: an id
 * already committed on the target with the exact staged truth ALWAYS wins
 * (the applier is idempotent per pair; a fresh challenger would never be
 * written), otherwise {@link compareIdentitySurvivors} decides. Two branches
 * staging the IDENTICAL row (same id, same complete truth) collapse silently
 * — reporting one as dropped while it is the very row applied would make the
 * report self-contradictory.
 */
function assertedOutcome(
  candidates: readonly StagedIdentityAssertion[],
  committedIds: ReadonlySet<string>,
): IdentityPairOutcome {
  const [first, ...rest] = candidates;
  let survivor = requireDefined(first);
  const superseded: DroppedItem[] = [];
  for (const candidate of rest) {
    const picked = pickIdentitySurvivor(candidate, survivor, committedIds);
    survivor = picked.winner;
    if (isIdenticalIdentityRow(picked.loser.assertion, picked.winner.assertion))
      continue;
    superseded.push(
      droppedIdentityAssertion(
        picked.loser.assertion,
        DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      ),
    );
  }
  return { kind: "asserted", survivor: survivor.assertion, superseded };
}

/**
 * Reduces N staged retractions of the SAME base row to one: the EARLIEST
 * staged `validTo` wins, so two branches ending the same base assertion at
 * different instants settle deterministically rather than on staging order.
 */
function reduceIdentityRetraction(
  candidates: readonly StagedRetraction[],
): StagedRetraction {
  return candidates.reduce((earliest, candidate) =>
    (
      compareCodePoints(
        candidate.assertion.validTo ?? "",
        earliest.assertion.validTo ?? "",
      ) < 0
    ) ?
      candidate
    : earliest,
  );
}

/**
 * Reduces raw (unstaged) identity assertions across POTENTIALLY MANY semantic
 * pairs to one survivor per pair, via {@link identityDedupeKey} /
 * {@link compareIdentitySurvivors} — the same rule
 * {@link classifyIdentityPair}'s absent-pair arm applies, generalized to a
 * flat list spanning multiple pairs.
 *
 * `remapIdentityAssertionEndpoints` (`merge-identity.ts`) re-dedupes through
 * here after canonicalization, which can collapse two previously-distinct
 * pairs onto one semantic key after the plan-time classification already ran.
 */
export function dedupeIdentityAssertionsRaw(
  assertions: readonly IdentityTransferAssertion[],
  committedIds: ReadonlySet<string>,
): Readonly<{
  survivors: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
}> {
  const survivorBySemantic = new Map<string, IdentityTransferAssertion>();
  const dropped: DroppedItem[] = [];
  for (const assertion of assertions) {
    const key = identityDedupeKey(assertion);
    const previous = survivorBySemantic.get(key);
    if (previous === undefined) {
      survivorBySemantic.set(key, assertion);
      continue;
    }
    const picked = pickIdentitySurvivor(
      { assertion },
      { assertion: previous },
      committedIds,
    );
    const survivor = picked.winner.assertion;
    const loser = picked.loser.assertion;
    survivorBySemantic.set(key, survivor);
    if (isIdenticalIdentityRow(loser, survivor)) continue;
    dropped.push(
      droppedIdentityAssertion(loser, DUPLICATE_IDENTITY_ASSERTION_DROP_REASON),
    );
  }
  return {
    survivors: [...survivorBySemantic.values()].toSorted((left, right) =>
      compareCodePoints(identityDedupeKey(left), identityDedupeKey(right)),
    ),
    dropped,
  };
}

/**
 * Opposing-relations re-validation over a FLAT, unstaged assertion list — what
 * `remapIdentityAssertionEndpoints` runs after canonicalization, since node
 * reconciliation can pull two previously distinct endpoint pairs onto one
 * canonical pair and manufacture a collision no branch ever staged.
 */
export function assertNoOpposingIdentityRelationsRaw(
  assertions: readonly IdentityTransferAssertion[],
): void {
  const [group] = opposingRelationGroups(assertions, (assertion) => assertion);
  if (group === undefined) return;
  throw opposingRelationsConflictError(
    group.overlap.same,
    group.overlap.different,
    group.endpoint,
  );
}

/**
 * Classifies one identity pair — one semantic key, one validity window —
 * against the staged base slice. `base` is the target's CURRENT truth for
 * this pair at staging time (empty when the pair has none); `asserted` /
 * `retracted` are every branch's staged claims for it.
 *
 *  - no branch asserts and none retracts → `unchanged`.
 *  - base absent, one or more branches assert → `asserted`, with every
 *    duplicate id but the survivor `superseded`.
 *  - base present, branches retract and nobody reasserts → `retracted`
 *    (earliest end).
 *  - base present, a branch reasserts → `asserted`; when a retraction is also
 *    staged, {@link planIdentityThreeWay} ends the base row at the
 *    retraction's own instant.
 *
 * A fresh assertion for an already-present pair with NO accompanying
 * retraction is not a race at plan time: the race detector only fires when a
 * retraction is staged.
 *
 * A genuine RACE (base present, one branch retracts while a DIFFERENT branch
 * reasserts under a new id without retracting) and an OPPOSING-RELATIONS
 * collision (both `same` and `different` staged for one endpoint with
 * overlapping windows) span more than one pair, so
 * {@link planIdentityThreeWay} refuses them before any pair reaches here.
 */
export function classifyIdentityPair(
  base: readonly IdentityTransferAssertion[],
  asserted: readonly StagedIdentityAssertion[],
  retracted: readonly StagedRetraction[],
  committedIds: ReadonlySet<string>,
): IdentityPairOutcome {
  if (asserted.length > 0) return assertedOutcome(asserted, committedIds);
  if (base.length === 0 || retracted.length === 0) return { kind: "unchanged" };
  return {
    kind: "retracted",
    retraction: reduceIdentityRetraction(retracted).assertion,
  };
}

/**
 * The plan-time result of three-way classifying every staged identity pair.
 * Every staged assertion is either in `assertions` or named in `dropped`;
 * every staged retraction is either in `retractions` or was reduced into the
 * earliest-ending retraction of the same base row.
 */
export type IdentityThreeWayResult = Readonly<{
  assertions: readonly IdentityTransferAssertion[];
  retractions: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
}>;

/**
 * Refuses an OPPOSING-RELATIONS collision: branches asserted BOTH `same` and
 * `different` for one endpoint pair with overlapping validity windows. Spans
 * two semantic keys (one per relation) sharing an endpoint pair, so it is
 * checked once, up front, over every staged new assertion.
 */
function assertNoStagedOpposingRelations(staging: StagingSet): void {
  const [group] = opposingRelationGroups(
    staging.newIdentityAssertions,
    (staged) => staged.assertion,
  );
  if (group === undefined) return;
  throw opposingRelationsConflictError(
    requireDefined(group.same[0]).assertion,
    requireDefined(group.different[0]).assertion,
    group.endpoint,
  );
}

/**
 * Refuses a RETRACT/REASSERT RACE: one branch retracts a pair's committed
 * truth while a DIFFERENT branch reasserts that pair under a new id WITHOUT
 * also retracting it. A branch that retracts AND reasserts the same pair
 * itself is convergent, not a race.
 */
function assertNoRetractReassertRace(staging: StagingSet): void {
  const retractedBySemantic = new Map<string, StagedRetraction[]>();
  for (const staged of staging.retractedIdentityAssertions) {
    const key = identitySemanticKey(staged.assertion);
    const group = retractedBySemantic.get(key) ?? [];
    group.push(staged);
    retractedBySemantic.set(key, group);
  }
  for (const staged of staging.newIdentityAssertions) {
    const retractions =
      retractedBySemantic.get(identitySemanticKey(staged.assertion)) ?? [];
    const selfRetracted = retractions.some(
      (retraction) => retraction.branchId === staged.branchId,
    );
    if (selfRetracted) continue;
    const retraction = retractions.find(
      (candidate) => candidate.assertion.id !== staged.assertion.id,
    );
    if (retraction === undefined) continue;
    throw new IdentityMergeConflictError(
      "Branches contain a retract/reassert race for one identity pair.",
      {
        details: {
          retractedAssertion: retraction.assertion,
          retractedBy: retraction.branchId,
          reassertedAssertion: staged.assertion,
          reassertedBy: staged.branchId,
        },
      },
    );
  }
}

/**
 * Three-way classifies every staged identity pair against the staged base
 * slice. Opposing relations and a retract/reassert race fail the plan;
 * everything else reduces to one assertion, one retraction, or no change per
 * pair, with every displaced duplicate reported as dropped.
 */
export function planIdentityThreeWay(
  staging: StagingSet,
  committedIds: ReadonlySet<string>,
): IdentityThreeWayResult {
  assertNoStagedOpposingRelations(staging);
  assertNoRetractReassertRace(staging);

  const assertions: IdentityTransferAssertion[] = [];
  const retractions: IdentityTransferAssertion[] = [];
  const dropped: DroppedItem[] = [];

  const baseByDedupe = new Map<string, IdentityTransferAssertion[]>();
  const baseIdToDedupeKey = new Map<string, string>();
  for (const assertion of staging.baseIdentityAssertions) {
    const key = identityDedupeKey(assertion);
    const group = baseByDedupe.get(key) ?? [];
    group.push(assertion);
    baseByDedupe.set(key, group);
    baseIdToDedupeKey.set(assertion.id, key);
  }
  const assertedByDedupe = new Map<string, StagedIdentityAssertion[]>();
  for (const staged of staging.newIdentityAssertions) {
    const key = identityDedupeKey(staged.assertion);
    const group = assertedByDedupe.get(key) ?? [];
    group.push(staged);
    assertedByDedupe.set(key, group);
  }
  const retractedByDedupe = new Map<string, StagedRetraction[]>();
  for (const staged of staging.retractedIdentityAssertions) {
    const key = baseIdToDedupeKey.get(staged.assertion.id);
    if (key === undefined) {
      // A retraction with NO base group to classify against. The base slice is
      // the target's CURRENT truth (open rows only) while a retraction is
      // derived from an archival read, so a branch that retracts a row the
      // target has ALREADY ended stages a retraction whose base row is absent
      // here. That is still a stated retraction: it is planned, and
      // `planIdentityChanges`' stored-truth filter is the one owner that
      // decides whether it applies or is dropped with
      // `identity:retraction-target-mismatch`. Dropping it here would make it
      // vanish from the plan with no reported reason.
      retractions.push(staged.assertion);
      continue;
    }
    const group = retractedByDedupe.get(key) ?? [];
    group.push(staged);
    retractedByDedupe.set(key, group);
  }

  const groupKeys = new Set<string>([
    ...baseByDedupe.keys(),
    ...assertedByDedupe.keys(),
  ]);
  for (const groupKey of groupKeys) {
    const retracted = retractedByDedupe.get(groupKey) ?? [];
    const outcome = classifyIdentityPair(
      baseByDedupe.get(groupKey) ?? [],
      assertedByDedupe.get(groupKey) ?? [],
      retracted,
      committedIds,
    );
    if (outcome.kind === "unchanged") continue;
    if (outcome.kind === "retracted") {
      retractions.push(outcome.retraction);
      continue;
    }
    assertions.push(outcome.survivor);
    dropped.push(...outcome.superseded);
    // CONVERGENT case: the base row is present and SOME branch retracted it
    // (not a race — a race was refused above) while a reassertion also
    // survived. The base row still ends, at its own honestly staged instant.
    if (retracted.length > 0) {
      retractions.push(reduceIdentityRetraction(retracted).assertion);
    }
  }

  return { assertions, retractions, dropped };
}
