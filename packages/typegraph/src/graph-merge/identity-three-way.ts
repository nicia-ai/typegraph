/**
 * The identity survivor rule, the semantic and window-aware dedupe keys, and
 * the THREE-WAY classifier built on them: ONE classifier for duplicate
 * assertions, opposing relations and retract/reassert races, keyed by the
 * caller's {@link IdentityAssertionConflictPolicy}. The default `"refuse"`
 * throws {@link IdentityMergeConflictError}; a resolving policy
 * (`"assertWins"` / `"retractWins"` / `"flag"` / a function) turns a subset of
 * those refusals into a recorded resolution instead.
 *
 * The plan-time dedupe and the post-remap re-dedupe that runs after endpoint
 * canonicalization call the SAME comparator — a second copy of the survivor
 * rule is exactly the kind of decision this repository's contract discipline
 * forbids re-spelling.
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
  BranchId,
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
function compareIdentitySurvivors(
  left: IdentityTransferAssertion,
  right: IdentityTransferAssertion,
): number {
  const byValidity = compareCodePoints(left.validFrom, right.validFrom);
  return byValidity === 0 ? compareCodePoints(left.id, right.id) : byValidity;
}

/** Why one identity assertion beat the one it displaced. */
type IdentitySurvivorRule = IdentityReconciliation["rule"];

/**
 * THE survivor decision for two identity assertions describing one semantic
 * pair, and the only place the committed-id override, the comparator and the
 * rule label are spelled. Every path that must choose between two colliding
 * assertions — the staged classifier, the post-remap re-dedupe, and a
 * resolving policy's `assertWins` arm — reduces through this one function, so
 * no caller can spell a survivor rule of its own and drift from the rest.
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
): Readonly<{ winner: T; loser: T; rule: IdentitySurvivorRule }> {
  const candidateCommitted = committedIds.has(candidate.assertion.id);
  const incumbentCommitted = committedIds.has(incumbent.assertion.id);
  if (candidateCommitted !== incumbentCommitted) {
    const [winner, loser] =
      candidateCommitted ?
        ([candidate, incumbent] as const)
      : ([incumbent, candidate] as const);
    return { winner, loser, rule: "committed-id" };
  }
  const rule: IdentitySurvivorRule =
    (
      compareCodePoints(
        candidate.assertion.validFrom,
        incumbent.assertion.validFrom,
      ) === 0
    ) ?
      "code-point-id"
    : "earliest-valid-from";
  const [winner, loser] =
    compareIdentitySurvivors(candidate.assertion, incumbent.assertion) < 0 ?
      ([candidate, incumbent] as const)
    : ([incumbent, candidate] as const);
  return { winner, loser, rule };
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

/**
 * Reason recorded when a `"retractWins"`/function resolution overruled a
 * branch's re-assertion of a pair another branch retracted.
 */
export const REASSERT_OVERRULED_DROP_REASON = "identity:reassert-overruled";

/**
 * Reason recorded when a resolving policy overruled one side of an
 * `"opposing-relations"` conflict (branches asserted BOTH `same` and
 * `different` for one pair with overlapping windows) — a distinct shape from
 * `REASSERT_OVERRULED_DROP_REASON`'s retract/reassert race, since nothing here
 * was reasserted: the policy chose one relation over the other.
 */
export const OPPOSING_RELATIONS_OVERRULED_DROP_REASON =
  "identity:opposing-relations-overruled";

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
 * the groups where the two sides overlap in valid time. Both dispositions — the
 * policy-keyed classifier and the unconditional post-remap re-validation —
 * read their groups from here, so neither can spell its own overlap rule or
 * group the endpoints its own way.
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

/** The one refusal every opposing-relations disposition throws. */
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
  rule: IdentitySurvivorRule;
}> {
  const [first, ...rest] = candidates;
  let survivor = requireDefined(first);
  let rule: IdentitySurvivorRule = "code-point-id";
  const superseded: DroppedItem[] = [];
  for (const candidate of rest) {
    const picked = pickIdentitySurvivor(candidate, survivor, committedIds);
    survivor = picked.winner;
    rule = picked.rule;
    if (isIdenticalIdentityRow(picked.loser.assertion, picked.winner.assertion))
      continue;
    superseded.push(
      droppedIdentityAssertion(
        picked.loser.assertion,
        DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      ),
    );
  }
  return { survivor, superseded, rule };
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
 * Builds an {@link IdentityReconciliation} for a duplicate-assertion survivor
 * pick, when the merge is configured to make one visible
 * (`policy !== "refuse"`; the default policy records none).
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
 * The label a resolved conflict records for the arm that decided it. A
 * function policy is recorded as `"callback"` — its source is never part of
 * the plan artifact, exactly as `reviewOptionEvidence` encodes it.
 */
function identityPolicyLabel(policy: IdentityAssertionConflictPolicy): string {
  return typeof policy === "function" ? "callback" : policy;
}

/**
 * The {@link IdentityReconciliation} a RESOLVING POLICY produced for one
 * conflict — the only path that sets `rule: "policy"`, and therefore the only
 * source of `IdentityDecisionProvenance.policy`. A merge whose conflicts were
 * all resolved by rule (or refused) records no policy string it did not
 * exercise.
 */
function policyReconciliation(
  conflict: IdentityAssertionConflict,
  policy: IdentityAssertionConflictPolicy,
  survivorAssertionId: string | undefined,
  supersededAssertionIds: readonly string[],
): IdentityReconciliation {
  return {
    semanticKey: conflict.semanticKey,
    a: conflict.a,
    b: conflict.b,
    relation: conflict.relation,
    ...(survivorAssertionId === undefined ? {} : { survivorAssertionId }),
    supersededAssertionIds: [...supersededAssertionIds].toSorted(
      compareStrings,
    ),
    rule: "policy",
    policy: identityPolicyLabel(policy),
    branches: conflictBranches(conflict),
  };
}

/** Every branch that staged any side of one conflict, in code-point order. */
function conflictBranches(
  conflict: IdentityAssertionConflict,
): readonly BranchId[] {
  return [
    ...new Set([
      ...conflict.asserted.map((staged) => staged.branchId),
      ...conflict.retracted.map((staged) => staged.branchId),
    ]),
  ].toSorted(compareStrings);
}

/**
 * THE report projection of a conflict a policy KEPT rather than refused — one
 * owner, so the arms that can produce one cannot describe the same conflict
 * differently. Retracted ids lead, then the assertions.
 */
function unresolvedFromConflict(
  conflict: IdentityAssertionConflict,
): IdentityUnresolvedConflict {
  return {
    kind: "assertion",
    reason: conflict.reason,
    semanticKey: conflict.semanticKey,
    a: conflict.a,
    b: conflict.b,
    relation: conflict.relation,
    assertionIds: [
      ...conflict.retracted.map((staged) => staged.assertion.id),
      ...conflict.asserted.map((staged) => staged.assertion.id),
    ],
    branches: conflictBranches(conflict),
  };
}

/**
 * Applies an `"assert"` decision: the named reassertion survives and every
 * OTHER staged assertion for the conflict is dropped under `reason`. The
 * caller plans the winner and names the displaced ids in its reconciliation.
 */
function resolveAssertWinner(
  conflict: IdentityAssertionConflict,
  assertionId: string,
  reason: string,
): Readonly<{
  winner: StagedIdentityAssertion;
  dropped: readonly DroppedItem[];
  supersededAssertionIds: readonly string[];
}> {
  const winner = requireDefined(
    conflict.asserted.find((staged) => staged.assertion.id === assertionId),
  );
  const displaced = conflict.asserted.filter(
    (staged) => staged.assertion.id !== winner.assertion.id,
  );
  return {
    winner,
    dropped: displaced.map((staged) =>
      droppedIdentityAssertion(staged.assertion, reason),
    ),
    supersededAssertionIds: displaced.map((staged) => staged.assertion.id),
  };
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
  const [group] = opposingRelationGroups(assertions, (assertion) => assertion);
  if (group === undefined) return;
  throw opposingRelationsConflictError(
    group.overlap.same,
    group.overlap.different,
    group.endpoint,
  );
}

/**
 * The `"asserted"` outcome for a pair with at least one surviving assertion:
 * reduces to one survivor and attaches whatever reconciliation the survivor
 * pick earns. The one place `classifyIdentityPair`'s three
 * asserted-outcome arms (base absent, retracted-empty, convergent) reduce
 * through, so they cannot drift on how a survivor is picked or reported.
 */
function assertedOutcome(
  semanticKey: string,
  asserted: readonly StagedIdentityAssertion[],
  committedIds: ReadonlySet<string>,
  policy: IdentityAssertionConflictPolicy,
): IdentityPairOutcome {
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

/**
 * Classifies one identity pair — one semantic key, one validity window —
 * against the staged base slice. `base` is the target's CURRENT truth for
 * this pair at staging time (empty when the pair has none); `asserted` /
 * `retracted` are every branch's staged claims for it.
 *
 * The four arms, arm-for-arm:
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
    return assertedOutcome(semanticKey, asserted, committedIds, policy);
  }

  if (retracted.length === 0) {
    if (asserted.length === 0) return { kind: "unchanged" };
    // Today's existing gap (documented, not introduced here): a fresh
    // assertion for an already-present pair with NO accompanying retraction
    // is not detected as a race at plan time — see `planIdentityThreeWay`'s
    // race detector, which only fires when a retraction is staged. Preserved
    // verbatim so the default policy stays byte-identical.
    return assertedOutcome(semanticKey, asserted, committedIds, policy);
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
  return assertedOutcome(semanticKey, asserted, committedIds, policy);
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
  committedIds: ReadonlySet<string>,
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
      if (conflict.asserted.length === 0) return { kind: "retract" };
      // Through the ONE survivor rule, never staging order: a race whose
      // reassertions arrived under two ids must pick the same winner every
      // other path would.
      const { survivor } = reduceIdentitySurvivor(
        conflict.asserted,
        committedIds,
      );
      return { kind: "assert", assertionId: survivor.assertion.id };
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
  endpoint: string;
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
  return opposingRelationGroups(
    staging.newIdentityAssertions,
    (staged) => staged.assertion,
  ).map((group) => {
    const anchor = requireDefined(group.items[0]).assertion;
    return {
      endpoint: group.endpoint,
      sameKey: identitySemanticKey({ ...anchor, relation: "same" }),
      differentKey: identitySemanticKey({ ...anchor, relation: "different" }),
      a: entityRefOf(anchor.a),
      b: entityRefOf(anchor.b),
      same: group.same,
      different: group.different,
    };
  });
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
 * slice: duplicate assertions, opposing relations and retract/reassert races
 * are arms of this one classifier, each decided by the supplied
 * {@link IdentityAssertionConflictPolicy}.
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

  // Base truth for every semantic pair, so a conflict can hand a resolving
  // policy the ROW ONE BRANCH RACED AGAINST — a race by definition has a base
  // row, and `IdentityAssertionConflict.base` is public callback input
  // documented as exactly that. Built once here (rather than left to the
  // later `baseByDedupe` grouping, which splits a bounded assertion further
  // by window and would under-populate a conflict that spans several windows).
  const baseBySemanticKey = new Map<string, IdentityTransferAssertion[]>();
  for (const assertion of staging.baseIdentityAssertions) {
    const key = identitySemanticKey(assertion);
    const group = baseBySemanticKey.get(key) ?? [];
    group.push(assertion);
    baseBySemanticKey.set(key, group);
  }

  const opposing = detectOpposingRelationsConflicts(staging);
  const handledOpposingKeys = new Set<string>();
  for (const group of opposing) {
    const semanticKey = group.sameKey;
    handledOpposingKeys.add(group.sameKey);
    handledOpposingKeys.add(group.differentKey);
    const anchorSame = group.same[0];
    const anchorDifferent = group.different[0];
    const conflict: IdentityAssertionConflict = {
      reason: "opposing-relations",
      semanticKey,
      a: group.a,
      b: group.b,
      relation: "same",
      base: [
        ...(baseBySemanticKey.get(group.sameKey) ?? []),
        ...(baseBySemanticKey.get(group.differentKey) ?? []),
      ],
      asserted: [...group.same, ...group.different],
      retracted: [],
    };
    const decision = resolveConflict(conflict, policy, committedIds, () => {
      throw opposingRelationsConflictError(
        requireDefined(anchorSame).assertion,
        requireDefined(anchorDifferent).assertion,
        group.endpoint,
      );
    });
    if (decision.kind === "unresolved") {
      unresolved.push(unresolvedFromConflict(conflict));
      continue;
    }
    if (decision.kind === "retract") {
      for (const staged of conflict.asserted) {
        dropped.push(
          droppedIdentityAssertion(
            staged.assertion,
            OPPOSING_RELATIONS_OVERRULED_DROP_REASON,
          ),
        );
      }
      // Nothing survives an opposing-relations conflict resolved by retraction
      // — no reassertion is kept and no base row was staged for ending — so
      // the reconciliation names the superseded ids alone.
      reconciliations.push(
        policyReconciliation(
          conflict,
          policy,
          undefined,
          conflict.asserted.map((staged) => staged.assertion.id),
        ),
      );
      continue;
    }
    const resolved = resolveAssertWinner(
      conflict,
      decision.assertionId,
      OPPOSING_RELATIONS_OVERRULED_DROP_REASON,
    );
    assertions.push(resolved.winner.assertion);
    dropped.push(...resolved.dropped);
    reconciliations.push(
      policyReconciliation(
        conflict,
        policy,
        resolved.winner.assertion.id,
        resolved.supersededAssertionIds,
      ),
    );
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
      base: baseBySemanticKey.get(semanticKey) ?? [],
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
    const decision = resolveConflict(
      conflict,
      policy,
      committedIds,
      refuseRace,
    );
    if (decision.kind === "unresolved") {
      unresolved.push(unresolvedFromConflict(conflict));
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
      // The ended base row is the last id that spoke for the pair, so it is
      // what governs after the merge.
      reconciliations.push(
        policyReconciliation(
          conflict,
          policy,
          retraction.assertion.id,
          race.asserted.map((staged) => staged.assertion.id),
        ),
      );
      continue;
    }
    const resolved = resolveAssertWinner(
      conflict,
      decision.assertionId,
      REASSERT_OVERRULED_DROP_REASON,
    );
    const winner = resolved.winner;
    assertions.push(winner.assertion);
    dropped.push(...resolved.dropped);
    for (const staged of race.retracted) {
      dropped.push(
        droppedIdentityAssertion(
          staged.assertion,
          RETRACT_OVERRULED_DROP_REASON,
        ),
      );
    }
    // The same survivor rule the `retract` decision above uses for its base
    // row, not raw staging order: a race whose base row two branches
    // retracted must pick the SAME base row here, under `assertWins`, that
    // `retractWins`/the plain-retraction path would pick for the identical
    // fixture — only the ending instant differs (the winner's own start).
    retractions.push({
      ...reduceIdentityRetraction(race.retracted).assertion,
      validTo: winner.assertion.validFrom,
    });
    reconciliations.push(
      policyReconciliation(conflict, policy, winner.assertion.id, [
        ...resolved.supersededAssertionIds,
        ...race.retracted.map((staged) => staged.assertion.id),
      ]),
    );
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
  // Retractions with NO base group to classify against. The base slice is the
  // target's CURRENT truth (`readCurrentIdentityAssertions("state")`, open rows
  // only) while a retraction is derived from an archival read, so a branch that
  // retracts a row the target has ALREADY ended stages a retraction whose base
  // row is absent here. That is still a stated retraction: it is planned, and
  // `planIdentityChanges`' stored-truth filter is the one owner that decides
  // whether it applies or is dropped with `identity:retraction-target-mismatch`.
  // Dropping it here would make it vanish from the plan with no reported reason.
  const orphanRetractions: StagedRetraction[] = [];
  for (const staged of staging.retractedIdentityAssertions) {
    if (handledRaceKeys.has(identitySemanticKey(staged.assertion))) continue;
    const key = baseIdToDedupeKey.get(staged.assertion.id);
    if (key === undefined) {
      orphanRetractions.push(staged);
      continue;
    }
    const group = retractedByDedupe.get(key) ?? [];
    group.push(staged);
    retractedByDedupe.set(key, group);
  }
  for (const staged of orphanRetractions) retractions.push(staged.assertion);

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
    unresolved.push(unresolvedFromConflict(outcome.conflict));
  }

  return {
    assertions,
    retractions,
    dropped,
    reconciliations,
    unresolved,
  };
}
