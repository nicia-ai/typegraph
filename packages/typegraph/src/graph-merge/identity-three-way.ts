/**
 * The identity survivor rule and semantic pair key, and the THREE-WAY
 * classifier built on top of them: one classifier absorbing what used to be
 * three separate inline arbitrations in `merge-identity.ts` —
 * `dedupeIdentityAssertions`, `assertNoOpposingIdentityRelations`, and
 * `assertNoRetractReassertRace`. Every arm keeps today's behavior verbatim
 * under the default `"refuse"` policy; a caller-supplied resolving policy
 * (`"assertWins"` / `"retractWins"` / `"flag"` / a function) turns a subset of
 * those refusals into a recorded resolution instead of a thrown error.
 *
 * Extracted out of `merge-identity.ts` so both the plan-time dedupe and the
 * post-remap re-dedupe it runs after endpoint canonicalization call the SAME
 * comparator — a second inline copy of the survivor rule is exactly the kind
 * of decision this repository's contract discipline forbids re-spelling.
 */
import { identityAssertionSemanticKey } from "../identity/assertion-key";
import type { IdentityRelation } from "../identity/types";
import { identityValidityWindowsOverlap } from "../identity/validity-window";
import { requireDefined } from "../utils/presence";
import { encodeTupleKey } from "../utils/tuple-key";
import { IdentityMergeConflictError, InvalidMergeOptionsError } from "./errors";
import { type EntityRef, entityRef } from "./evidence";
import { compareStrings, mergeKeyOf } from "./node-key";
import type {
  StagedIdentityAssertion,
  StagedRetraction,
  StagingSet,
} from "./staging";
import {
  compareCodePoints,
  type IdentityTransferAssertion,
} from "./typegraph-internal";
import type {
  DroppedItem,
  IdentityAssertionConflictReason,
  IdentityReconciliation,
  IdentityUnresolvedConflict,
} from "./types";

/**
 * The semantic key two identity assertions are compared under: the relation
 * plus the code-point-normalized endpoint pair, WITHOUT the validity window.
 * Two assertions sharing this key describe the same claim about the same
 * pair, whatever window each one carries.
 */
export function identitySemanticKey(
  assertion: IdentityTransferAssertion,
): string {
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
export function compareIdentitySurvivors(
  left: IdentityTransferAssertion,
  right: IdentityTransferAssertion,
): number {
  const byValidity = compareCodePoints(left.validFrom, right.validFrom);
  return byValidity === 0 ? compareCodePoints(left.id, right.id) : byValidity;
}

/**
 * Reason recorded when two branches asserted the SAME semantic pair and the
 * survivor rule kept only one of the two assertion ids.
 */
export const DUPLICATE_IDENTITY_ASSERTION_DROP_REASON =
  "identity:duplicate-assertion";

/**
 * Reason recorded when a `"retractWins"`/function resolution overruled a
 * branch's re-assertion of a pair another branch retracted.
 */
export const REASSERT_OVERRULED_DROP_REASON = "identity:reassert-overruled";

/**
 * Reason recorded when an `"assertWins"`/function resolution overruled a
 * branch's OWN staged end for a pair another branch re-asserted under a new
 * id — the pair's base row still ends (a merge can never leave the ledger
 * holding two CURRENT assertions for one pair), just not at the overruled
 * branch's chosen instant.
 */
export const RETRACT_OVERRULED_DROP_REASON = "identity:retract-overruled";

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
 * One irreconcilable identity-assertion disagreement, fully populated so a
 * resolving policy (a `"flag"` classification or a function callback) has
 * everything it needs to decide, and so `"refuse"` can report exactly what
 * collided.
 */
export type IdentityAssertionConflict = Readonly<{
  reason: IdentityAssertionConflictReason;
  semanticKey: string;
  a: EntityRef;
  b: EntityRef;
  relation: IdentityRelation;
  base: readonly IdentityTransferAssertion[];
  asserted: readonly StagedIdentityAssertion[];
  retracted: readonly StagedRetraction[];
}>;

/**
 * What a resolving policy decided for one {@link IdentityAssertionConflict}.
 * `"assert"` must name an id present in the conflict's own `asserted` array —
 * a callback cannot invent an assertion the merge never staged.
 */
export type IdentityAssertionDecision =
  | Readonly<{ kind: "assert"; assertionId: string }>
  | Readonly<{ kind: "retract" }>
  | Readonly<{ kind: "unresolved" }>;

/**
 * How the merge arbitrates an identity-assertion conflict it cannot resolve
 * by rule alone. `"refuse"` (the default) reproduces today's behavior
 * byte-for-byte: an unresolvable conflict throws {@link IdentityMergeConflictError}
 * and the merge plans nothing. A resolving policy turns that refusal into a
 * recorded resolution instead.
 */
export type IdentityAssertionConflictPolicy =
  | "refuse"
  | "assertWins"
  | "retractWins"
  | "flag"
  | ((conflict: IdentityAssertionConflict) => IdentityAssertionDecision);

/** What classifying one identity pair (one semantic key, one validity window) decided. */
export type IdentityPairOutcome =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{
      kind: "asserted";
      survivor: IdentityTransferAssertion;
      superseded: readonly DroppedItem[];
      reconciliation?: IdentityReconciliation | undefined;
    }>
  | Readonly<{ kind: "retracted"; retraction: IdentityTransferAssertion }>
  | Readonly<{ kind: "unresolved"; conflict: IdentityAssertionConflict }>;

/** Whether `policy` is anything other than the byte-identical default. */
function isResolvingPolicy(policy: IdentityAssertionConflictPolicy): boolean {
  return policy !== "refuse";
}

/**
 * Reduces N candidate assertions for the SAME window to one survivor: an id
 * already committed on the target with the exact staged truth ALWAYS wins
 * (the applier is idempotent per pair; a fresh challenger would never be
 * written), otherwise {@link compareIdentitySurvivors} decides. Two branches
 * staging the IDENTICAL row (same id, same complete truth) collapse silently
 * — reporting one as dropped while it is the very row applied would make the
 * report self-contradictory.
 */
function reduceIdentitySurvivor(
  candidates: readonly StagedIdentityAssertion[],
  committedIds: ReadonlySet<string>,
): Readonly<{
  survivor: StagedIdentityAssertion;
  superseded: readonly DroppedItem[];
  /** Why the final survivor beat the last candidate it displaced. */
  rule: IdentityReconciliation["rule"];
}> {
  const [first, ...rest] = candidates;
  let survivor = requireDefined(first);
  let rule: IdentityReconciliation["rule"] = "code-point-id";
  const superseded: DroppedItem[] = [];
  for (const candidate of rest) {
    const candidateCommitted = committedIds.has(candidate.assertion.id);
    const survivorCommitted = committedIds.has(survivor.assertion.id);
    if (candidateCommitted === survivorCommitted) {
      rule =
        (
          compareCodePoints(
            candidate.assertion.validFrom,
            survivor.assertion.validFrom,
          ) === 0
        ) ?
          "code-point-id"
        : "earliest-valid-from";
    } else {
      rule = "committed-id";
    }
    const [winner, loser] =
      candidateCommitted === survivorCommitted ?
        compareIdentitySurvivors(candidate.assertion, survivor.assertion) < 0 ?
          [candidate, survivor]
        : [survivor, candidate]
      : candidateCommitted ? [candidate, survivor]
      : [survivor, candidate];
    survivor = winner;
    if (
      loser.assertion.id === winner.assertion.id &&
      loser.assertion.validFrom === winner.assertion.validFrom &&
      (loser.assertion.validTo ?? undefined) ===
        (winner.assertion.validTo ?? undefined)
    ) {
      continue;
    }
    superseded.push(
      droppedIdentityAssertion(
        loser.assertion,
        DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      ),
    );
  }
  return { survivor, superseded, rule };
}

/** Reduces N staged retractions of the SAME base row to one: earliest end wins. */
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
 * Builds an {@link IdentityReconciliation} for a duplicate-assertion survivor
 * pick, when the merge is configured to make one visible (§3.2:
 * `policy !== "refuse"` — a plain default-policy merge stays byte-identical
 * to today, which never recorded this).
 */
function buildReconciliation(
  semanticKey: string,
  candidates: readonly StagedIdentityAssertion[],
  survivor: StagedIdentityAssertion,
  superseded: readonly DroppedItem[],
  rule: IdentityReconciliation["rule"],
  policy: IdentityAssertionConflictPolicy,
): IdentityReconciliation | undefined {
  if (!isResolvingPolicy(policy) || superseded.length === 0) return undefined;
  return {
    semanticKey,
    a: entityRefOf(survivor.assertion.a),
    b: entityRefOf(survivor.assertion.b),
    relation: survivor.assertion.relation,
    survivorAssertionId: survivor.assertion.id,
    supersededAssertionIds: superseded
      .map((item) => item.id)
      .toSorted(compareStrings),
    rule,
    branches: [
      ...new Set(candidates.map((staged) => staged.branchId)),
    ].toSorted(compareStrings),
  };
}

/**
 * Reduces raw (unstaged) identity assertions across POTENTIALLY MANY semantic
 * pairs to one survivor per pair, via {@link identityDedupeKey} /
 * {@link compareIdentitySurvivors} — the same rule
 * {@link classifyIdentityPair}'s absent-pair arm applies, generalized to a
 * flat list spanning multiple pairs.
 *
 * The single owner `remapIdentityAssertionEndpoints` (`merge-identity.ts`)
 * calls for its post-remap re-dedupe: node-reconciliation canonicalization
 * can collapse two previously-distinct pairs onto one semantic key AFTER
 * the plan-time classification above already ran, so that re-dedupe must
 * call the identical comparator rather than re-spell the survivor rule.
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
    const assertionCommitted = committedIds.has(assertion.id);
    const previousCommitted = committedIds.has(previous.id);
    const [survivor, loser] =
      assertionCommitted === previousCommitted ?
        compareIdentitySurvivors(assertion, previous) < 0 ?
          ([assertion, previous] as const)
        : ([previous, assertion] as const)
      : assertionCommitted ? ([assertion, previous] as const)
      : ([previous, assertion] as const);
    survivorBySemantic.set(key, survivor);
    if (
      loser.id === survivor.id &&
      loser.validFrom === survivor.validFrom &&
      (loser.validTo ?? undefined) === (survivor.validTo ?? undefined)
    ) {
      continue;
    }
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
 * Unconditional (non-policy) opposing-relations re-validation over a FLAT,
 * unstaged assertion list — what `remapIdentityAssertionEndpoints` runs after
 * canonicalization, since node reconciliation can pull two previously
 * distinct endpoint pairs onto one canonical pair and manufacture a
 * collision no branch ever staged. Always throws: there is no branch
 * attribution left to hand a resolving policy at this point, and the
 * pre-remap classification above already gave the caller's policy its say.
 */
export function assertNoOpposingIdentityRelationsRaw(
  assertions: readonly IdentityTransferAssertion[],
): void {
  const byEndpoint = new Map<string, IdentityTransferAssertion[]>();
  for (const assertion of assertions) {
    const key = pairEndpointKey({
      a: entityRefOf(assertion.a),
      b: entityRefOf(assertion.b),
    });
    const group = byEndpoint.get(key) ?? [];
    group.push(assertion);
    byEndpoint.set(key, group);
  }
  for (const [endpoint, group] of byEndpoint) {
    const same = group.filter((assertion) => assertion.relation === "same");
    const different = group.filter(
      (assertion) => assertion.relation === "different",
    );
    for (const sameAssertion of same) {
      for (const differentAssertion of different) {
        if (
          !identityValidityWindowsOverlap(sameAssertion, differentAssertion)
        ) {
          continue;
        }
        throw new IdentityMergeConflictError(
          "Branches asserted opposing identity relations for one endpoint pair.",
          {
            details: {
              endpoint,
              assertions: [sameAssertion, differentAssertion],
            },
          },
        );
      }
    }
  }
}

/**
 * Classifies one identity pair — one semantic key, one validity window —
 * against the staged base slice. `base` is the target's CURRENT truth for
 * this pair at staging time (empty when the pair has none); `asserted` /
 * `retracted` are every branch's staged claims for it.
 *
 * The four table arms this absorbs, arm-for-arm (design §4.2 / plan §1.4):
 *
 *  - base absent, one branch asserts → `asserted`.
 *  - base absent, ≥2 branches assert under different ids → `asserted`, with
 *    the loser(s) `superseded` (the old `dedupeIdentityAssertions` rule).
 *  - base present, every/some branch retracts and nobody reasserts →
 *    `retracted` (earliest end).
 *  - base present, one branch retracts AND reasserts (convergent) →
 *    `asserted`, ending the base row at the retraction's own instant.
 *
 * A genuine RACE (base present, one branch retracts while a DIFFERENT branch
 * reasserts under a new id without retracting) and an OPPOSING-RELATIONS
 * collision (both `same` and `different` staged for one endpoint with
 * overlapping windows) span more than one pair and are therefore classified
 * by {@link planIdentityThreeWay} itself, which calls this function only for
 * pairs neither cross-cutting check claimed.
 */
export function classifyIdentityPair(
  semanticKey: string,
  base: readonly IdentityTransferAssertion[],
  asserted: readonly StagedIdentityAssertion[],
  retracted: readonly StagedRetraction[],
  policy: IdentityAssertionConflictPolicy,
  committedIds: ReadonlySet<string>,
): IdentityPairOutcome {
  if (base.length === 0) {
    if (asserted.length === 0) return { kind: "unchanged" };
    if (asserted.length === 1) {
      return {
        kind: "asserted",
        survivor: requireDefined(asserted[0]).assertion,
        superseded: [],
      };
    }
    const { survivor, superseded, rule } = reduceIdentitySurvivor(
      asserted,
      committedIds,
    );
    return {
      kind: "asserted",
      survivor: survivor.assertion,
      superseded,
      reconciliation: buildReconciliation(
        semanticKey,
        asserted,
        survivor,
        superseded,
        rule,
        policy,
      ),
    };
  }

  if (retracted.length === 0) {
    if (asserted.length === 0) return { kind: "unchanged" };
    // Today's existing gap (documented, not introduced here): a fresh
    // assertion for an already-present pair with NO accompanying retraction
    // is not detected as a race at plan time — see `planIdentityThreeWay`'s
    // race detector, which only fires when a retraction is staged. Preserved
    // verbatim so the default policy stays byte-identical.
    const { survivor, superseded, rule } =
      asserted.length === 1 ?
        {
          survivor: requireDefined(asserted[0]),
          superseded: [],
          rule: "code-point-id" as const,
        }
      : reduceIdentitySurvivor(asserted, committedIds);
    return {
      kind: "asserted",
      survivor: survivor.assertion,
      superseded,
      reconciliation: buildReconciliation(
        semanticKey,
        asserted,
        survivor,
        superseded,
        rule,
        policy,
      ),
    };
  }

  if (asserted.length === 0) {
    const retraction = reduceIdentityRetraction(retracted);
    return { kind: "retracted", retraction: retraction.assertion };
  }

  // Convergent: at least one branch retracted AND (the same or another)
  // branch reasserted — but this call is only reached for pairs
  // `planIdentityThreeWay` did NOT classify as a cross-branch race, so every
  // reassertion here is accompanied by SOME branch's own retraction of the
  // pair. `planIdentityThreeWay` itself attaches the base row's ending (at
  // the retraction's own honest instant — nothing here is a policy question)
  // once it sees this outcome alongside a non-empty `retracted` group.
  const { survivor, superseded, rule } =
    asserted.length === 1 ?
      {
        survivor: requireDefined(asserted[0]),
        superseded: [],
        rule: "code-point-id" as const,
      }
    : reduceIdentitySurvivor(asserted, committedIds);
  return {
    kind: "asserted",
    survivor: survivor.assertion,
    superseded,
    reconciliation: buildReconciliation(
      semanticKey,
      asserted,
      survivor,
      superseded,
      rule,
      policy,
    ),
  };
}

/**
 * The plan-time result of three-way classifying every staged identity pair:
 * every arm's assertions/retractions on one side, and the two forms of
 * VISIBILITY the classifier adds beyond today's plain refuse-or-apply
 * behavior — resolved duplicate reconciliations and conflicts a `"flag"`
 * policy chose to keep rather than refuse.
 */
export type IdentityThreeWayResult = Readonly<{
  assertions: readonly IdentityTransferAssertion[];
  retractions: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
  reconciliations: readonly IdentityReconciliation[];
  unresolved: readonly IdentityUnresolvedConflict[];
}>;

/** Applies `policy` to a fully-populated conflict, honoring every arm. */
function resolveConflict(
  conflict: IdentityAssertionConflict,
  policy: IdentityAssertionConflictPolicy,
  refuse: () => never,
): IdentityAssertionDecision {
  if (policy === "refuse") refuse();
  if (policy === "flag") return { kind: "unresolved" };
  if (policy === "assertWins" || policy === "retractWins") {
    if (conflict.reason !== "retract-reassert") {
      throw new InvalidMergeOptionsError(
        `onAssertionConflict: ${JSON.stringify(policy)} only arbitrates a retract/reassert race; this conflict has no assert/retract axis to decide (reason: ${conflict.reason}).`,
        {
          details: {
            option: "onAssertionConflict",
            policy,
            reason: conflict.reason,
          },
        },
      );
    }
    if (policy === "assertWins") {
      const winner = conflict.asserted[0];
      if (winner === undefined) return { kind: "retract" };
      return { kind: "assert", assertionId: winner.assertion.id };
    }
    return { kind: "retract" };
  }
  const decision = policy(conflict);
  if (
    decision.kind === "assert" &&
    !conflict.asserted.some(
      (staged) => staged.assertion.id === decision.assertionId,
    )
  ) {
    throw new InvalidMergeOptionsError(
      `onAssertionConflict's callback returned an assertion id ${JSON.stringify(decision.assertionId)} that was never staged for this conflict.`,
      {
        details: {
          option: "onAssertionConflict",
          assertionId: decision.assertionId,
        },
      },
    );
  }
  return decision;
}

/**
 * Detects OPPOSING-RELATIONS collisions: branches asserted BOTH `same` and
 * `different` for one endpoint pair with overlapping validity windows. Spans
 * two semantic keys (one per relation) sharing an endpoint pair, so it is
 * detected once, up front, over every staged new assertion — exactly the
 * scope `assertNoOpposingIdentityRelations` always had.
 */
type OpposingRelationsGroup = Readonly<{
  sameKey: string;
  differentKey: string;
  a: EntityRef;
  b: EntityRef;
  same: readonly StagedIdentityAssertion[];
  different: readonly StagedIdentityAssertion[];
}>;

function detectOpposingRelationsConflicts(
  staging: StagingSet,
): readonly OpposingRelationsGroup[] {
  const byEndpoint = new Map<string, StagedIdentityAssertion[]>();
  for (const staged of staging.newIdentityAssertions) {
    const key = pairEndpointKey({
      a: entityRefOf(staged.assertion.a),
      b: entityRefOf(staged.assertion.b),
    });
    const group = byEndpoint.get(key) ?? [];
    group.push(staged);
    byEndpoint.set(key, group);
  }
  const conflicts: OpposingRelationsGroup[] = [];
  for (const group of byEndpoint.values()) {
    const same = group.filter((staged) => staged.assertion.relation === "same");
    const different = group.filter(
      (staged) => staged.assertion.relation === "different",
    );
    const overlaps = same.some((sameStaged) =>
      different.some((differentStaged) =>
        identityValidityWindowsOverlap(
          sameStaged.assertion,
          differentStaged.assertion,
        ),
      ),
    );
    if (!overlaps) continue;
    const anchor = requireDefined(group[0]);
    conflicts.push({
      sameKey: identitySemanticKey({ ...anchor.assertion, relation: "same" }),
      differentKey: identitySemanticKey({
        ...anchor.assertion,
        relation: "different",
      }),
      a: entityRefOf(anchor.assertion.a),
      b: entityRefOf(anchor.assertion.b),
      same,
      different,
    });
  }
  return conflicts;
}

/**
 * Detects a RETRACT/REASSERT RACE: one branch retracts a pair's committed
 * truth while a DIFFERENT branch reasserts that pair under a new id WITHOUT
 * also retracting it. Exactly `assertNoRetractReassertRace`'s scope: a branch
 * that retracts AND reasserts the same pair itself is convergent, not a race.
 */
function detectRetractReassertRaces(staging: StagingSet): ReadonlyMap<
  string,
  Readonly<{
    retracted: readonly StagedRetraction[];
    asserted: readonly StagedIdentityAssertion[];
  }>
> {
  const retractedBySemantic = new Map<string, StagedRetraction[]>();
  for (const staged of staging.retractedIdentityAssertions) {
    const key = identitySemanticKey(staged.assertion);
    const group = retractedBySemantic.get(key) ?? [];
    group.push(staged);
    retractedBySemantic.set(key, group);
  }
  const races = new Map<
    string,
    { retracted: StagedRetraction[]; asserted: StagedIdentityAssertion[] }
  >();
  for (const staged of staging.newIdentityAssertions) {
    const semanticKey = identitySemanticKey(staged.assertion);
    const retractions = retractedBySemantic.get(semanticKey) ?? [];
    const selfRetracted = retractions.some(
      (retraction) => retraction.branchId === staged.branchId,
    );
    if (selfRetracted) continue;
    const crossBranchRetractions = retractions.filter(
      (retraction) => retraction.assertion.id !== staged.assertion.id,
    );
    if (crossBranchRetractions.length === 0) continue;
    const race = races.get(semanticKey) ?? { retracted: [], asserted: [] };
    for (const retraction of crossBranchRetractions) {
      if (!race.retracted.includes(retraction)) race.retracted.push(retraction);
    }
    race.asserted.push(staged);
    races.set(semanticKey, race);
  }
  return races;
}

/**
 * Three-way classifies every staged identity pair against the staged base
 * slice: absorbs `dedupeIdentityAssertions`, `assertNoOpposingIdentityRelations`,
 * and `assertNoRetractReassertRace` into arms of ONE classifier, keyed by the
 * `IdentityAssertionConflictPolicy` a caller may supply. Under the default
 * `"refuse"` policy every arm reproduces today's behavior byte-for-byte —
 * same thrown errors, same drop reasons, same survivor rule.
 */
export function planIdentityThreeWay(
  staging: StagingSet,
  policy: IdentityAssertionConflictPolicy,
  committedIds: ReadonlySet<string>,
): IdentityThreeWayResult {
  const assertions: IdentityTransferAssertion[] = [];
  const retractions: IdentityTransferAssertion[] = [];
  const dropped: DroppedItem[] = [];
  const reconciliations: IdentityReconciliation[] = [];
  const unresolved: IdentityUnresolvedConflict[] = [];

  const refuseOpposing = (
    same: StagedIdentityAssertion,
    different: StagedIdentityAssertion,
    endpoint: string,
  ): never => {
    throw new IdentityMergeConflictError(
      "Branches asserted opposing identity relations for one endpoint pair.",
      {
        details: {
          endpoint,
          assertions: [same.assertion, different.assertion],
        },
      },
    );
  };

  const opposing = detectOpposingRelationsConflicts(staging);
  const handledOpposingKeys = new Set<string>();
  for (const group of opposing) {
    const semanticKey = group.sameKey;
    handledOpposingKeys.add(group.sameKey);
    handledOpposingKeys.add(group.differentKey);
    const endpoint = pairEndpointKey(group);
    const anchorSame = group.same[0];
    const anchorDifferent = group.different[0];
    const conflict: IdentityAssertionConflict = {
      reason: "opposing-relations",
      semanticKey,
      a: group.a,
      b: group.b,
      relation: "same",
      base: [],
      asserted: [...group.same, ...group.different],
      retracted: [],
    };
    const decision = resolveConflict(conflict, policy, () =>
      refuseOpposing(
        requireDefined(anchorSame),
        requireDefined(anchorDifferent),
        endpoint,
      ),
    );
    if (decision.kind === "unresolved") {
      unresolved.push({
        kind: "assertion",
        reason: "opposing-relations",
        semanticKey,
        a: group.a,
        b: group.b,
        relation: "same",
        assertionIds: conflict.asserted.map((staged) => staged.assertion.id),
        branches: [
          ...new Set(conflict.asserted.map((staged) => staged.branchId)),
        ].toSorted(compareStrings),
      });
      continue;
    }
    if (decision.kind === "retract") {
      for (const staged of conflict.asserted) {
        dropped.push(
          droppedIdentityAssertion(
            staged.assertion,
            REASSERT_OVERRULED_DROP_REASON,
          ),
        );
      }
      continue;
    }
    const winner = requireDefined(
      conflict.asserted.find(
        (staged) => staged.assertion.id === decision.assertionId,
      ),
    );
    assertions.push(winner.assertion);
    for (const staged of conflict.asserted) {
      if (staged.assertion.id === winner.assertion.id) continue;
      dropped.push(
        droppedIdentityAssertion(
          staged.assertion,
          REASSERT_OVERRULED_DROP_REASON,
        ),
      );
    }
  }

  const races = detectRetractReassertRaces(staging);
  const handledRaceKeys = new Set(races.keys());
  for (const [semanticKey, race] of races) {
    const anchor = race.retracted[0] ?? race.asserted[0];
    const anchorAssertion = (
      anchor as StagedIdentityAssertion | StagedRetraction
    ).assertion;
    const conflict: IdentityAssertionConflict = {
      reason: "retract-reassert",
      semanticKey,
      a: entityRefOf(anchorAssertion.a),
      b: entityRefOf(anchorAssertion.b),
      relation: anchorAssertion.relation,
      base: [],
      asserted: race.asserted,
      retracted: race.retracted,
    };
    const refuseRace = (): never => {
      const retraction = requireDefined(race.retracted[0]);
      const reassertion = requireDefined(race.asserted[0]);
      throw new IdentityMergeConflictError(
        "Branches contain a retract/reassert race for one identity pair.",
        {
          details: {
            retractedAssertion: retraction.assertion,
            retractedBy: retraction.branchId,
            reassertedAssertion: reassertion.assertion,
            reassertedBy: reassertion.branchId,
          },
        },
      );
    };
    const decision = resolveConflict(conflict, policy, refuseRace);
    if (decision.kind === "unresolved") {
      unresolved.push({
        kind: "assertion",
        reason: "retract-reassert",
        semanticKey,
        a: conflict.a,
        b: conflict.b,
        relation: conflict.relation,
        assertionIds: [
          ...race.retracted.map((staged) => staged.assertion.id),
          ...race.asserted.map((staged) => staged.assertion.id),
        ],
        branches: [
          ...new Set([
            ...race.retracted.map((staged) => staged.branchId),
            ...race.asserted.map((staged) => staged.branchId),
          ]),
        ].toSorted(compareStrings),
      });
      continue;
    }
    if (decision.kind === "retract") {
      const retraction = reduceIdentityRetraction(race.retracted);
      retractions.push(retraction.assertion);
      for (const staged of race.asserted) {
        dropped.push(
          droppedIdentityAssertion(
            staged.assertion,
            REASSERT_OVERRULED_DROP_REASON,
          ),
        );
      }
      continue;
    }
    const winner = requireDefined(
      race.asserted.find(
        (staged) => staged.assertion.id === decision.assertionId,
      ),
    );
    assertions.push(winner.assertion);
    for (const staged of race.asserted) {
      if (staged.assertion.id === winner.assertion.id) continue;
      dropped.push(
        droppedIdentityAssertion(
          staged.assertion,
          REASSERT_OVERRULED_DROP_REASON,
        ),
      );
    }
    for (const staged of race.retracted) {
      dropped.push(
        droppedIdentityAssertion(
          staged.assertion,
          RETRACT_OVERRULED_DROP_REASON,
        ),
      );
    }
    retractions.push({
      ...requireDefined(race.retracted[0]).assertion,
      validTo: winner.assertion.validFrom,
    });
  }

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
    const semanticKey = identitySemanticKey(staged.assertion);
    if (handledOpposingKeys.has(semanticKey)) continue;
    if (handledRaceKeys.has(semanticKey)) continue;
    const key = identityDedupeKey(staged.assertion);
    const group = assertedByDedupe.get(key) ?? [];
    group.push(staged);
    assertedByDedupe.set(key, group);
  }
  const retractedByDedupe = new Map<string, StagedRetraction[]>();
  for (const staged of staging.retractedIdentityAssertions) {
    if (handledRaceKeys.has(identitySemanticKey(staged.assertion))) continue;
    const key = baseIdToDedupeKey.get(staged.assertion.id);
    if (key === undefined) continue; // orphan: `planIdentityChanges` re-validates by id.
    const group = retractedByDedupe.get(key) ?? [];
    group.push(staged);
    retractedByDedupe.set(key, group);
  }

  const groupKeys = new Set<string>([
    ...baseByDedupe.keys(),
    ...assertedByDedupe.keys(),
  ]);
  for (const groupKey of groupKeys) {
    const base = baseByDedupe.get(groupKey) ?? [];
    const asserted = assertedByDedupe.get(groupKey) ?? [];
    const retracted = retractedByDedupe.get(groupKey) ?? [];
    const anchor = base[0] ?? asserted[0]?.assertion;
    if (anchor === undefined) continue;
    const semanticKey = identitySemanticKey(anchor);
    const outcome = classifyIdentityPair(
      semanticKey,
      base,
      asserted,
      retracted,
      policy,
      committedIds,
    );
    if (outcome.kind === "unchanged") continue;
    if (outcome.kind === "asserted") {
      assertions.push(outcome.survivor);
      dropped.push(...outcome.superseded);
      if (outcome.reconciliation !== undefined) {
        reconciliations.push(outcome.reconciliation);
      }
      // CONVERGENT case: base is present and SOME branch retracted it (not a
      // race — races are excluded from this loop above) while a reassertion
      // also survived. The base row must still end, at its own honestly
      // staged instant — nothing here is a policy question, unlike the
      // race's overruled ending.
      if (retracted.length > 0) {
        retractions.push(reduceIdentityRetraction(retracted).assertion);
      }
      continue;
    }
    if (outcome.kind === "retracted") {
      retractions.push(outcome.retraction);
      continue;
    }
    // Unreachable today: `classifyIdentityPair` only returns `"unresolved"`
    // for a conflict, and both conflict-producing shapes (opposing-relations,
    // retract-reassert) are detected and resolved BEFORE this loop runs, so
    // no group reaching here can still be conflicted. Converted defensively
    // rather than asserted away, so a future arm that DOES return one here
    // degrades to a typed report entry instead of a silent drop.
    const { conflict } = outcome;
    unresolved.push({
      kind: "assertion",
      reason: conflict.reason,
      semanticKey: conflict.semanticKey,
      a: conflict.a,
      b: conflict.b,
      relation: conflict.relation,
      assertionIds: [
        ...conflict.asserted.map((staged) => staged.assertion.id),
        ...conflict.retracted.map((staged) => staged.assertion.id),
      ],
      branches: [
        ...new Set([
          ...conflict.asserted.map((staged) => staged.branchId),
          ...conflict.retracted.map((staged) => staged.branchId),
        ]),
      ].toSorted(compareStrings),
    });
  }

  return {
    assertions,
    retractions,
    dropped,
    reconciliations,
    unresolved,
  };
}
