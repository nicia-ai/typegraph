/**
 * Identity semantics of graph merge, in one module: the plan-time derivation
 * of identity changes (dedupe, retraction truth validation, endpoint remap),
 * the plan-time contradiction simulation, and the commit-transaction guards
 * that prove the validated identity state still holds when the plan applies.
 *
 * The dependency is one-directional: `merge.ts` (the orchestrator) imports
 * from here, never the reverse. Functions that need plan data take
 * {@link IdentityPlanSlice} — a structural subset of `MergePlan` — so this
 * module never names the full plan type.
 *
 * COMMIT-GUARD LAYERING. The in-transaction guard is deliberately redundant.
 * Correctness needs only two layers: the by-id freshness check
 * ({@link assertPlannedIdentityIdsFresh} — ended rows included, which no
 * ledger slice or class fingerprint can see) and the FULL simulation re-run
 * on transaction reads (re-deriving legality is the only complete window
 * guard), with the identity applier's own refusals — translated typed at the
 * apply boundary by {@link translateIdentityCommitError} — as the final
 * backstop. The earlier layers (direct-peer arrivals, per-seed
 * class/liveness fingerprints, the negative-ledger fingerprint) exist to
 * refuse EARLY with a message naming exactly what drifted; removing them
 * would lose diagnosability, not soundness. Never add a NEW invariant as a
 * fingerprint alone: make the simulation or the applier enforce it, then
 * fingerprint it for the error message if useful.
 */
import { requireDefined } from "../utils/presence";
import type { CanonicalEntity } from "./canonicalize";
import {
  BaseVersionMismatchError,
  describeCause,
  IdentityMergeConflictError,
  MergeError,
} from "./errors";
import {
  compareMergeKeys,
  compareStrings,
  idOf,
  kindOf,
  type MergeKey,
  mergeKey,
  mergeKeyOf,
} from "./node-key";
import type { StagedIdentityAssertion, StagingSet } from "./staging";
import {
  compareCodePoints,
  type GraphBackend,
  type GraphDef,
  IdentityContradictionError,
  type IdentityTransferAssertion,
  NodeNotFoundError,
  type Store,
  storeBackend,
  storeRuntime,
  type TransactionBackend,
  TypeGraphError,
} from "./typegraph-internal";
import type { DroppedItem } from "./types";
import { UnionFind } from "./union-find";

/**
 * The identity-relevant slice of a resolved merge plan: a STRUCTURAL subset of
 * `MergePlan` (which `merge.ts` defines), so the orchestrator can hand its
 * plan to every function here without this module importing the plan type.
 */
export type IdentityPlanSlice = Readonly<{
  canonicalEntities: readonly CanonicalEntity[];
  identityAssertions: readonly IdentityTransferAssertion[];
  identityRetractions: readonly IdentityTransferAssertion[];
  nodeDeletions: ReadonlyMap<MergeKey, string>;
  retypeMap: ReadonlyMap<MergeKey, string>;
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>;
}>;

/**
 * The `(a.kind, a.id, b.kind, b.id)` endpoint tuple every identity key encoder
 * below is built from. One definition keeps their FIELD ORDER identical — the
 * keys are compared against each other's encodings, so a drifted order in one
 * encoder would silently stop matching rows the others key the same way.
 */
function endpointTuple(
  assertion: Readonly<{ a: IdentityEndpoint; b: IdentityEndpoint }>,
): readonly string[] {
  return [assertion.a.kind, assertion.a.id, assertion.b.kind, assertion.b.id];
}

function identityEndpointKey(assertion: IdentityTransferAssertion): string {
  return JSON.stringify(endpointTuple(assertion));
}

function identitySemanticKey(assertion: IdentityTransferAssertion): string {
  return JSON.stringify([assertion.relation, ...endpointTuple(assertion)]);
}

function compareIdentitySurvivors(
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
 * Reason recorded when node reconciliation collapsed both endpoints of a `same`
 * assertion onto one survivor, making the assertion vacuous.
 */
export const REDUNDANT_IDENTITY_ASSERTION_DROP_REASON =
  "identity:endpoints-collapsed";

/** The report entry for an identity assertion the merge did not apply. */
function droppedIdentityAssertion(
  assertion: IdentityTransferAssertion,
  reason: string,
): DroppedItem {
  return { kind: "identity", id: assertion.id, reason };
}

/**
 * Keeps ONE assertion per semantic pair and reports every loser as a
 * {@link DroppedItem}, so a duplicate assertion silently discarded from a
 * losing branch is still enumerable in the merge report. Survivors come back
 * in semantic-key order.
 *
 * An id in `committedIds` (already committed on the target with the exact
 * staged truth) ALWAYS wins over an uncommitted challenger, regardless of the
 * {@link compareIdentitySurvivors} order: the applier is idempotent per
 * semantic pair, so the challenger would never be written — picking it would
 * report an id as applied that never lands while listing the target's own row
 * as dropped. Between two ids of equal committed status the comparator
 * decides.
 */
function dedupeIdentityAssertions(
  assertions: readonly IdentityTransferAssertion[],
  committedIds: ReadonlySet<string>,
): Readonly<{
  survivors: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
}> {
  const survivorBySemantic = new Map<string, IdentityTransferAssertion>();
  const dropped: DroppedItem[] = [];
  for (const assertion of assertions) {
    const key = identitySemanticKey(assertion);
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
    // Two branches staging the IDENTICAL row (same id, same complete truth —
    // e.g. both imported one interchange document) is ONE assertion, not a
    // survivor and a loser: reporting the id as dropped while it is applied
    // would make the report self-contradictory.
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
      compareCodePoints(identitySemanticKey(left), identitySemanticKey(right)),
    ),
    dropped,
  };
}

function assertNoOpposingIdentityRelations(
  assertions: readonly IdentityTransferAssertion[],
): void {
  const byEndpoint = new Map<string, IdentityTransferAssertion[]>();
  for (const assertion of assertions) {
    const key = identityEndpointKey(assertion);
    const group = byEndpoint.get(key) ?? [];
    group.push(assertion);
    byEndpoint.set(key, group);
  }
  for (const [endpoint, group] of byEndpoint) {
    if (new Set(group.map((assertion) => assertion.relation)).size < 2) {
      continue;
    }
    throw new IdentityMergeConflictError(
      "Branches asserted opposing identity relations for one endpoint pair.",
      { details: { endpoint, assertions: group } },
    );
  }
}

/**
 * Refuses the retract/reassert RACE: one branch retracts the assertion for a
 * semantic pair while a DIFFERENT branch re-asserts that pair under a new id
 * WITHOUT retracting it — the branches disagree about whether the old truth still
 * holds, and no rule can pick between "the pair is not asserted" and "the pair is
 * asserted under a new id".
 *
 * Two nearby shapes are NOT races and must merge cleanly:
 *
 *   - A single fork that retracts then re-asserts the same pair (a normal linear
 *     edit): its final state is simply "old id retracted, new id asserted".
 *   - CONVERGENT edits, where the re-asserting branch ALSO retracted the pair:
 *     every branch agrees the old assertion dies, and one went further by
 *     re-asserting. The merge applies both effects.
 *
 * Both hinge on which branch produced which change, so this consults the staged
 * (branch-tagged) retractions — grouping by semantic key alone would drop exactly
 * the provenance that separates a race from agreement.
 */
function assertNoRetractReassertRace(staging: StagingSet): void {
  const retractedBySemantic = new Map<string, StagedIdentityAssertion[]>();
  for (const staged of staging.retractedIdentityAssertions) {
    const key = identitySemanticKey(staged.assertion);
    const retractions = retractedBySemantic.get(key) ?? [];
    retractions.push(staged);
    retractedBySemantic.set(key, retractions);
  }
  for (const staged of staging.newIdentityAssertions) {
    const retractions =
      retractedBySemantic.get(identitySemanticKey(staged.assertion)) ?? [];
    const selfRetracted = retractions.some(
      (retraction) => retraction.branchId === staged.branchId,
    );
    if (selfRetracted) {
      continue;
    }
    const crossBranchRetraction = retractions.find(
      (retraction) => retraction.assertion.id !== staged.assertion.id,
    );
    if (crossBranchRetraction !== undefined) {
      throw new IdentityMergeConflictError(
        "Branches contain a retract/reassert race for one identity pair.",
        {
          details: {
            retractedAssertion: crossBranchRetraction.assertion,
            retractedBy: crossBranchRetraction.branchId,
            reassertedAssertion: staged.assertion,
            reassertedBy: staged.branchId,
          },
        },
      );
    }
  }
}

/**
 * Reason recorded when a branch retracted an assertion whose id identifies a
 * DIFFERENT complete truth on the target's current ledger. Ending that row
 * would delete truth the branch never saw, while the branch's actual intent —
 * "the assertion I retracted no longer holds" — is already satisfied by that
 * assertion's absence, so the retraction is skipped and reported instead.
 */
export const RETRACTION_TARGET_MISMATCH_DROP_REASON =
  "identity:retraction-target-mismatch";

/**
 * Reason recorded when a staged retraction touched a node whose deletion the
 * delete/modify resolution OVERRULED. A node soft-delete cascades — it ends
 * every open assertion touching the node — so the deleting branch's diff
 * stages those endings as retractions indistinguishable from intent. When the
 * modification wins and the node survives, applying the cascaded retraction
 * would end the resurrected node's assertions anyway; dropping it (visibly)
 * keeps the node's identity truth alongside the node.
 */
export const RETRACTION_DELETION_OVERRULED_DROP_REASON =
  "identity:deletion-overruled";

/** The empty stored-row map, for validating staged assertions intra-plan only. */
export const NO_STORED_ASSERTIONS: ReadonlyMap<string, LedgerAssertion> =
  new Map();

/** The empty committed-id set, for dedupe passes with no target knowledge. */
const NO_COMMITTED_IDS: ReadonlySet<string> = new Set();

/** @internal Exported for deterministic phase-level verification. */
export function planIdentityChanges(
  staging: StagingSet,
  storedIdentityRowsById: ReadonlyMap<string, LedgerAssertion>,
): Readonly<{
  assertions: readonly IdentityTransferAssertion[];
  retractions: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
}> {
  assertNoOpposingIdentityRelations(
    staging.newIdentityAssertions.map((staged) => staged.assertion),
  );
  assertNoRetractReassertRace(staging);
  // One id, one truth — over the RAW staged assertions, BEFORE the semantic
  // survivor dedupe: two branches staging one id for the same pair with
  // different validFrom values collapse into one survivor under the semantic
  // key (which excludes validity), so a later check would never see the
  // collision — while the report would list the id as both applied and
  // dropped.
  assertOneIdOneTruth(
    staging.newIdentityAssertions.map((staged) => staged.assertion),
    NO_STORED_ASSERTIONS,
  );

  // Staged ids the target ALREADY holds with the exact staged truth. The
  // survivor dedupe must prefer these: the applier is idempotent per semantic
  // pair, so a freshly minted branch id can never displace the target's
  // committed row — choosing it would report an id as applied that is never
  // written while listing the target's own row as dropped.
  const committedIds = new Set<string>(
    staging.newIdentityAssertions
      .map((staged) => staged.assertion)
      .filter((assertion) => {
        const stored = storedIdentityRowsById.get(assertion.id);
        return (
          stored !== undefined &&
          assertionTruthKey(stored) === assertionTruthKey(assertion)
        );
      })
      .map((assertion) => assertion.id),
  );
  const deduped = dedupeIdentityAssertions(
    staging.newIdentityAssertions.map((staged) => staged.assertion),
    committedIds,
  );
  const retractionById = new Map<string, IdentityTransferAssertion>();
  for (const staged of staging.retractedIdentityAssertions) {
    const previous = retractionById.get(staged.assertion.id);
    if (
      previous !== undefined &&
      assertionIdentityKey(previous) !== assertionIdentityKey(staged.assertion)
    ) {
      throw new IdentityMergeConflictError(
        "One assertion id was staged for retraction with two different identity truths.",
        {
          details: {
            assertionId: staged.assertion.id,
            first: previous,
            second: staged.assertion,
          },
        },
      );
    }
    retractionById.set(staged.assertion.id, staged.assertion);
  }
  const retractions: IdentityTransferAssertion[] = [];
  const retractionDropped: DroppedItem[] = [];
  for (const [assertionId, retraction] of retractionById) {
    const stored = storedIdentityRowsById.get(assertionId);
    if (
      stored !== undefined &&
      stored.validTo === undefined &&
      assertionIdentityKey(stored) !== assertionIdentityKey(retraction)
    ) {
      retractionDropped.push({
        kind: "identity",
        id: assertionId,
        reason: RETRACTION_TARGET_MISMATCH_DROP_REASON,
      });
      continue;
    }
    retractions.push(retraction);
  }
  // Defensive: one id planned as BOTH a new assertion and a retraction would
  // reach the applier as retract-then-import of one id, which the import
  // refuses generically (the freshly ended row fails its exact-match test).
  // Unreachable through the supported staging paths today — the truth-aware
  // diff and the retraction truth filter each break every construction we
  // know — so refuse typed if a future path assembles it.
  const survivingIds = new Set(
    deduped.survivors.map((survivor) => survivor.id),
  );
  for (const retraction of retractions) {
    if (survivingIds.has(retraction.id)) {
      throw new IdentityMergeConflictError(
        "One assertion id was staged as both a new assertion and a retraction.",
        { details: { assertionId: retraction.id } },
      );
    }
  }
  return {
    assertions: deduped.survivors,
    retractions: retractions.toSorted((left, right) =>
      compareCodePoints(left.id, right.id),
    ),
    dropped: [...deduped.dropped, ...retractionDropped],
  };
}

/** A plain `(kind, id)` node reference — an identity assertion endpoint. */
type IdentityEndpoint = Readonly<{ kind: string; id: string }>;

/**
 * Code-point order over `(kind, id)` endpoints, matching the identity service's
 * pair normalization (kind first, id as the tie-break). A stored identity pair MUST
 * satisfy `a <= b` under this order or the import path the merge commit reuses
 * rejects it as non-normalized.
 */
function compareIdentityEndpoints(
  left: IdentityEndpoint,
  right: IdentityEndpoint,
): number {
  const byKind = compareCodePoints(left.kind, right.kind);
  return byKind === 0 ? compareCodePoints(left.id, right.id) : byKind;
}

/**
 * Maps an endpoint onto the `(kind, id)` it will actually carry in the committed
 * target: first through the cluster canonical map (the SAME map edge repoint
 * uses), then through the ontology retype cascade, keyed EXACTLY as
 * {@link applyMergePlan} keys an edge endpoint — `mergeKey(kind, id)` of the
 * post-canonical endpoint, whose retype value is the survivor's reconciled kind.
 *
 * Both hops are required. Under `reconcileTypes: "ontology"` a cluster survivor
 * is written under its most-specific kind, so an assertion that still named the
 * pre-retype kind would reference a `(kind, id)` no live row carries and the
 * commit-time endpoint guard would reject it (or, worse, bind to a stale row of
 * the old kind).
 */
function resolveIdentityEndpoint(
  endpoint: IdentityEndpoint,
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>,
  retypeMap: ReadonlyMap<MergeKey, string>,
): IdentityEndpoint {
  const key = mergeKeyOf(endpoint);
  const canonical = canonicalOf.get(key) ?? key;
  return {
    kind: retypeMap.get(canonical) ?? kindOf(canonical),
    id: idOf(canonical),
  };
}

/**
 * Repoints every planned identity assertion's endpoints onto the identity they
 * will hold after the commit ({@link resolveIdentityEndpoint}), so an assertion
 * naming a branch node that reconciliation folded away — or retyped — references
 * the surviving row instead of a dangling `(kind, id)` (which the commit-time
 * `requireLiveEndpoints` guard would reject with a NodeNotFoundError, rolling back
 * the whole merge). After remapping it re-establishes the identity-pair invariants:
 * a `same` assertion whose endpoints collapse onto one survivor is redundant
 * and dropped (reported), while a collapsed `different` assertion is a typed
 * conflict; surviving endpoints are re-normalized into code-point order (the
 * import path rejects a non-normalized pair), and assertions that now share a
 * semantic key are re-deduped by the same survivor rule
 * ({@link compareIdentitySurvivors}) that {@link planIdentityChanges} applied
 * before the remap.
 */
export function remapIdentityAssertionEndpoints(
  assertions: readonly IdentityTransferAssertion[],
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>,
  retypeMap: ReadonlyMap<MergeKey, string>,
): Readonly<{
  assertions: readonly IdentityTransferAssertion[];
  dropped: readonly DroppedItem[];
}> {
  const remapped: IdentityTransferAssertion[] = [];
  const dropped: DroppedItem[] = [];
  for (const assertion of assertions) {
    const remappedA = resolveIdentityEndpoint(
      assertion.a,
      canonicalOf,
      retypeMap,
    );
    const remappedB = resolveIdentityEndpoint(
      assertion.b,
      canonicalOf,
      retypeMap,
    );
    if (mergeKeyOf(remappedA) === mergeKeyOf(remappedB)) {
      if (assertion.relation === "different") {
        throw new IdentityMergeConflictError(
          "Node reconciliation collapsed a different-identity assertion onto one survivor.",
          { details: { assertion, survivor: remappedA } },
        );
      }
      dropped.push(
        droppedIdentityAssertion(
          assertion,
          REDUNDANT_IDENTITY_ASSERTION_DROP_REASON,
        ),
      );
      continue;
    }
    const [a, b] =
      compareIdentityEndpoints(remappedA, remappedB) <= 0 ?
        [remappedA, remappedB]
      : [remappedB, remappedA];
    remapped.push({ ...assertion, a, b });
  }
  // No committed-id precedence here: this second pass dedupes pairs that
  // node reconciliation COLLAPSED, and remapped endpoints no longer compare
  // equal to any stored row — the post-plan one-id-one-truth check still
  // validates the surviving ids against the target.
  const deduped = dedupeIdentityAssertions(remapped, NO_COMMITTED_IDS);
  // Node reconciliation can collapse previously distinct endpoint pairs onto
  // the same canonical pair, so the pre-reconciliation check above is not
  // sufficient on its own.
  assertNoOpposingIdentityRelations(deduped.survivors);
  return {
    assertions: deduped.survivors,
    dropped: [...dropped, ...deduped.dropped],
  };
}

/**
 * Refuses an assertion that names a node the merge is about to DELETE.
 *
 * The commit soft-deletes nodes before applying the identity changes, which
 * detaches every assertion touching them, so an assertion naming a deleted
 * endpoint could only ever fail at commit time — rolling the whole merge back
 * behind a generic error. Detecting it here turns it into a deterministic,
 * plan-time {@link IdentityMergeConflictError}: one branch says the entity exists
 * and is (not) the same as another, a second says it is gone, and unlike the
 * delete/modify case there is no policy the caller can set to arbitrate.
 *
 * `nodeDeletions` is keyed by the deleted node's own kind, while the assertions
 * arrive post-retype, so a retyped identity is checked in BOTH forms.
 */
export function assertIdentityEndpointsNotDeleted(
  assertions: readonly IdentityTransferAssertion[],
  nodeDeletions: ReadonlyMap<MergeKey, string>,
  retypeMap: ReadonlyMap<MergeKey, string>,
): void {
  const deletedIdentities = new Set<MergeKey>();
  for (const key of nodeDeletions.keys()) {
    deletedIdentities.add(key);
    const retyped = retypeMap.get(key);
    if (retyped !== undefined) {
      deletedIdentities.add(mergeKey(retyped, idOf(key)));
    }
  }
  for (const assertion of assertions) {
    for (const endpoint of [assertion.a, assertion.b]) {
      if (!deletedIdentities.has(mergeKeyOf(endpoint))) {
        continue;
      }
      throw new IdentityMergeConflictError(
        "A branch asserted an identity relation over a node another branch deleted.",
        { details: { assertion, deletedEndpoint: endpoint } },
      );
    }
  }
}

/**
 * Refuses a merge whose committed ledger would claim two nodes are BOTH the same
 * and different — including through a chain of `same` assertions no single branch
 * ever wrote.
 *
 * {@link assertNoOpposingIdentityRelations} only sees a DIRECT collision (one
 * endpoint pair carrying both relations). The common shape is transitive: base
 * holds `same(p2, p3)`, one branch asserts `same(p1, p2)` and another asserts
 * `different(p1, p3)`. Nothing collides pairwise, so planning used to pass and the
 * identity import raised its own contradiction error inside the commit
 * transaction, where the orchestrator's catch-all rewrote it as a generic
 * `MergeError` — the documented `GRAPH_MERGE_IDENTITY_CONFLICT` code never fired.
 *
 * The check evaluates the ledger the merge would actually leave behind: the base's
 * CURRENT assertions minus the staged retractions, plus the already remapped and
 * deduped staged assertions. Base endpoints are put through the same
 * {@link resolveIdentityEndpoint} mapping, so an inherited assertion whose node
 * was folded or retyped is judged at its post-merge identity. The `same`
 * assertions are folded into equivalence classes and every `different` pair —
 * staged or inherited — is rejected when both of its endpoints land in one class.
 *
 * Two DERIVED relations join the explicit ledger in the simulation, because
 * canonicalization and retyping can manufacture contradictions no branch wrote:
 * under `sameIdAcrossKinds: "fold"` endpoints sharing an id across kinds are
 * implicitly the same (a remapped cross-kind `different` pair can land on one
 * id), and a retyped endpoint can pull a kind into a class that the ontology
 * declares disjoint with another member's kind. Both used to surface only at
 * commit time as a generic merge error.
 *
 * @internal Exported for deterministic phase-level verification.
 */
export function assertNoContradictoryIdentityClosure(
  plannedAssertions: readonly IdentityTransferAssertion[],
  retractions: readonly string[],
  baseAssertions: readonly IdentityTransferAssertion[],
  deletedNodes: ReadonlySet<MergeKey>,
  canonicalOf: ReadonlyMap<MergeKey, MergeKey>,
  retypeMap: ReadonlyMap<MergeKey, string>,
  identityContext: PlanIdentityContext,
  nodeUniverse: readonly Readonly<{ kind: string; id: string }>[],
): void {
  const retracted = new Set(retractions);
  // Deleting a node ends its assertions, so a base assertion touching a
  // plan-deleted endpoint must not conduct in the simulated post-merge
  // ledger. The commit-guard re-runs filter their fresh ledger the same way
  // BEFORE calling here; applying the rule inside the checker keeps all
  // three call sites on one rule even when a retraction was dropped (e.g.
  // target-truth mismatch) and the cascade id never reaches `retractions`.
  const survivesDeletion = (
    assertion: Readonly<{
      a: Readonly<{ kind: string; id: string }>;
      b: Readonly<{ kind: string; id: string }>;
    }>,
  ): boolean =>
    !deletedNodes.has(mergeKey(assertion.a.kind, assertion.a.id)) &&
    !deletedNodes.has(mergeKey(assertion.b.kind, assertion.b.id));
  const mergedLedger = [
    ...plannedAssertions,
    ...baseAssertions
      .filter(
        (assertion) =>
          !retracted.has(assertion.id) && survivesDeletion(assertion),
      )
      .map((assertion) => ({
        ...assertion,
        a: resolveIdentityEndpoint(assertion.a, canonicalOf, retypeMap),
        b: resolveIdentityEndpoint(assertion.b, canonicalOf, retypeMap),
      })),
  ];

  const sameClasses = new UnionFind<MergeKey>((left, right) =>
    compareMergeKeys(left, right),
  );
  // Assertion-free nodes participate too: a new or retyped canonical node —
  // or a live target peer sharing its id — can fold into a class without any
  // ledger edge naming it, so the simulation seeds the full node universe as
  // singletons before the explicit assertions union anything.
  for (const node of nodeUniverse) {
    sameClasses.add(mergeKey(node.kind, node.id));
  }
  for (const assertion of mergedLedger) {
    if (assertion.relation === "same") {
      sameClasses.union(mergeKeyOf(assertion.a), mergeKeyOf(assertion.b));
    }
  }
  // The class a root identifies, as sorted public `(kind, id)` refs — the shape
  // both contradiction reports carry in their details.
  const membersOfClass = (
    root: MergeKey,
  ): readonly Readonly<{ kind: string; id: string }>[] =>
    sameClasses
      .members()
      .filter((member) => sameClasses.find(member) === root)
      .map((member) => ({ kind: kindOf(member), id: idOf(member) }))
      .toSorted((left, right) =>
        compareMergeKeys(mergeKeyOf(left), mergeKeyOf(right)),
      );
  // The first ontology-disjoint pair among `kinds`, or `undefined` when every
  // pair may coexist. Each caller raises its own error for the pair it finds.
  const firstDisjointPair = (
    kinds: readonly string[],
  ): readonly [string, string] | undefined => {
    for (const [index, left] of kinds.entries()) {
      for (const right of kinds.slice(index + 1)) {
        if (identityContext.areDisjoint(left, right)) return [left, right];
      }
    }
    return undefined;
  };

  const refsById = new Map<string, MergeKey[]>();
  const addRef = (kind: string, id: string): void => {
    const keys = refsById.get(id) ?? [];
    keys.push(mergeKey(kind, id));
    refsById.set(id, keys);
  };
  for (const node of nodeUniverse) addRef(node.kind, node.id);
  for (const assertion of mergedLedger) {
    addRef(assertion.a.kind, assertion.a.id);
    addRef(assertion.b.kind, assertion.b.id);
  }
  // Sharing an id across DISJOINT kinds is a create-time constraint under
  // BOTH profiles — under "ignore" the rows do not fold, but the id is still
  // refused. Scan every same-id group regardless of profile.
  for (const keys of refsById.values()) {
    const disjointKinds = firstDisjointPair([
      ...new Set(keys.map((key) => kindOf(key))),
    ]);
    if (disjointKinds === undefined) continue;
    throw new IdentityMergeConflictError(
      "The merged graph would give one id to two ontology-disjoint kinds.",
      {
        details: {
          disjointKinds,
          sharedId: idOf(requireDefined(keys[0])),
        },
      },
    );
  }
  if (identityContext.sameIdAcrossKinds === "fold") {
    for (const keys of refsById.values()) {
      const [first, ...rest] = keys;
      if (first === undefined) continue;
      for (const other of rest) sameClasses.union(first, other);
    }
  }
  for (const assertion of mergedLedger) {
    if (assertion.relation !== "different") {
      continue;
    }
    const root = sameClasses.find(mergeKeyOf(assertion.a));
    if (root !== sameClasses.find(mergeKeyOf(assertion.b))) {
      continue;
    }
    throw new IdentityMergeConflictError(
      "The merged identity ledger would assert one pair of nodes is both the same and different.",
      { details: { assertion, sameClass: membersOfClass(root) } },
    );
  }

  // A class whose member kinds the ontology declares disjoint is the same
  // contradiction in another coat: retyping (or a fold) pulled two mutually
  // exclusive kinds into one identity class.
  const kindsByRoot = new Map<MergeKey, Set<string>>();
  for (const member of sameClasses.members()) {
    const root = sameClasses.find(member);
    const kinds = kindsByRoot.get(root) ?? new Set<string>();
    kinds.add(kindOf(member));
    kindsByRoot.set(root, kinds);
  }
  for (const [root, kinds] of kindsByRoot) {
    const disjointKinds = firstDisjointPair([...kinds]);
    if (disjointKinds === undefined) continue;
    throw new IdentityMergeConflictError(
      "The merged identity ledger would join two ontology-disjoint kinds into one class.",
      { details: { disjointKinds, sameClass: membersOfClass(root) } },
    );
  }
}

/**
 * The identity semantics the plan-time contradiction simulation needs from the
 * target: whether same-id folding is on, and which kind pairs the ontology
 * declares disjoint.
 */
export type PlanIdentityContext = Readonly<{
  sameIdAcrossKinds: "fold" | "ignore" | undefined;
  areDisjoint: (left: string, right: string) => boolean;
}>;

/**
 * The plan-time same-id fold probe the incremental commit guard revalidates
 * inside the transaction (`IncrementalCommitGuard.identityPeerProbe`).
 */
export type IdentityPeerProbe = Readonly<{
  /**
   * The target's identity profile. The direct-peer window check below only
   * applies under `"fold"` — a same-id row appearing under `"ignore"` never
   * changes plan legality, so refusing on it would reject an unrelated
   * target advance.
   */
  profile: "fold" | "ignore";
  ids: readonly string[];
  observed: ReadonlySet<MergeKey>;
  /**
   * The plan's node deletions, by composite key. Rows the plan removes are
   * excluded from BOTH sides of every comparison — they are gone in the
   * committed state, so treating them as present would falsely reject a
   * legal delete-and-replace (and a still-live-at-tx-time row the plan
   * deletes must not read as an "appeared" peer either).
   */
  plannedDeletions: ReadonlySet<MergeKey>;
  /**
   * Every `(kind, id)` the guarded universe contains — the seeds plus all
   * snapshot class members. The negative-truth fingerprint below ranges
   * over `different` assertions touching this set.
   */
  memberKeys: ReadonlySet<MergeKey>;
  /**
   * Deterministic fingerprint of the CURRENT `different` assertions
   * touching the guarded universe at snapshot time. Negative truth changes
   * plan legality without moving peers, liveness, or equivalence classes,
   * so it needs its own drift signal.
   */
  differentFingerprint: string;
  /**
   * The plan-time structural identity class of every final fold seed,
   * serialized to a comparable fingerprint per seed. The direct-peer set
   * above covers planned ids that do not exist yet; this covers
   * class-TRANSITIVE drift — a window row or assertion joining a seed's
   * class through another member changes the class without changing the
   * seed's direct same-id peers.
   */
  classFingerprints: ReadonlyMap<string, string>;
  seeds: readonly Readonly<{ kind: string; id: string }>[];
}>;

/**
 * Narrows the plan-time fold probe to the ids the FINAL plan folds on: the
 * commit-ready canonical node identities (minus planned deletions) and the
 * remapped assertion endpoints. The observed peer set is filtered the same
 * way so the in-transaction comparison ranges over one universe.
 */
export async function buildIdentityPeerProbe<G extends GraphDef>(
  target: Store<G>,
  probedIds: readonly string[],
  targetPeers: readonly Readonly<{ kind: string; id: string }>[],
  plan: IdentityPlanSlice,
  profile: "fold" | "ignore",
): Promise<
  Readonly<{
    probe: IdentityPeerProbe;
    snapshot: IdentityClassSnapshot;
    ledger: readonly LedgerAssertion[];
  }>
> {
  const finalIds = new Set([
    ...plan.canonicalEntities
      .filter(
        (entity) =>
          !plan.nodeDeletions.has(mergeKey(entity.kind, entity.canonicalId)),
      )
      .map((entity) => entity.canonicalId),
    ...plan.identityAssertions.flatMap((assertion) => [
      assertion.a.id,
      assertion.b.id,
    ]),
  ]);
  const plannedDeletions = new Set<MergeKey>(plan.nodeDeletions.keys());
  const relevantPeers = targetPeers.filter(
    (peer) =>
      finalIds.has(peer.id) &&
      !plannedDeletions.has(mergeKey(peer.kind, peer.id)),
  );
  // The fold seeds whose classes plan legality depends on: the commit-ready
  // canonical nodes (final retyped kinds), the remapped assertion endpoints,
  // and the live target peers anchoring them into existing classes.
  const seedsByKey = new Map<string, Readonly<{ kind: string; id: string }>>();
  const addSeed = (kind: string, id: string): void => {
    seedsByKey.set(mergeKey(kind, id), { kind, id });
  };
  for (const entity of plan.canonicalEntities) {
    const sourceKey = mergeKey(entity.kind, entity.canonicalId);
    if (plan.nodeDeletions.has(sourceKey)) continue;
    addSeed(plan.retypeMap.get(sourceKey) ?? entity.kind, entity.canonicalId);
  }
  for (const assertion of plan.identityAssertions) {
    addSeed(assertion.a.kind, assertion.a.id);
    addSeed(assertion.b.kind, assertion.b.id);
  }
  for (const peer of relevantPeers) addSeed(peer.kind, peer.id);
  const seeds = [...seedsByKey.values()];
  const liveKeys = new Set(
    targetPeers
      .map((peer) => mergeKey(peer.kind, peer.id))
      .filter((key) => !plannedDeletions.has(key)),
  );
  const snapshot = await snapshotIdentityClasses(
    target,
    seeds,
    liveKeys,
    plannedDeletions,
  );
  const memberKeys = new Set<MergeKey>([
    ...seeds.map((seed) => mergeKey(seed.kind, seed.id)),
    ...snapshot.groups.flatMap((group) =>
      group.map((member) => mergeKey(member.kind, member.id)),
    ),
  ]);
  // Negative truth is invisible to peers, liveness, and class structure, so
  // the CURRENT ledger touching the universe is read fresh here: the recheck
  // validates the plan against it, and its `different` slice is fingerprinted
  // for the in-transaction comparison.
  const ledger = (
    await relevantLedgerAssertions(target, memberKeys, storeBackend(target))
  ).filter(
    (assertion) =>
      !plannedDeletions.has(mergeKey(assertion.a.kind, assertion.a.id)) &&
      !plannedDeletions.has(mergeKey(assertion.b.kind, assertion.b.id)),
  );
  return {
    probe: {
      profile,
      plannedDeletions,
      ids: probedIds.filter((id) => finalIds.has(id)),
      observed: new Set(
        relevantPeers.map((peer) => mergeKey(peer.kind, peer.id)),
      ),
      memberKeys,
      differentFingerprint: differentLedgerFingerprint(ledger),
      classFingerprints: snapshot.fingerprints,
      seeds,
    },
    snapshot,
    ledger,
  };
}

type IdentityClassSnapshot = Readonly<{
  /**
   * One comparable fingerprint per seed: the seed's LIVENESS plus its sorted
   * class member tuples, JSON-encoded — structural encoding because caller
   * ids may contain any character, so a joined string is not injective, and
   * the liveness bit because a live singleton and a deleted or missing one
   * have identical (self-coalesced) classes.
   */
  fingerprints: ReadonlyMap<string, string>;
  /** The raw class member groups, for revalidating the plan against them. */
  groups: readonly (readonly Readonly<{ kind: string; id: string }>[])[];
}>;

async function snapshotIdentityClasses<G extends GraphDef>(
  target: Store<G>,
  seeds: readonly Readonly<{ kind: string; id: string }>[],
  liveKeys: ReadonlySet<MergeKey>,
  plannedDeletions: ReadonlySet<MergeKey>,
  txBackend?: TransactionBackend,
): Promise<IdentityClassSnapshot> {
  const classes = await storeRuntime(target).structuralIdentityClasses(
    seeds,
    txBackend,
  );
  const fingerprints = new Map<string, string>();
  const groups: (readonly Readonly<{ kind: string; id: string }>[])[] = [];
  for (const seed of seeds) {
    const key = mergeKey(seed.kind, seed.id);
    // The service keys classes by `JSON.stringify([kind, id])`. Members the
    // plan DELETES are excluded on both sides of the comparison — the
    // committed state no longer contains them, so keeping them would reject
    // a legal delete-and-replace.
    const members = (
      classes.get(JSON.stringify([seed.kind, seed.id])) ?? [seed]
    ).filter(
      (member) => !plannedDeletions.has(mergeKey(member.kind, member.id)),
    );
    groups.push(members);
    fingerprints.set(key, encodeClassFingerprint(liveKeys.has(key), members));
  }
  return { fingerprints, groups };
}

export type LedgerAssertion = Readonly<{
  id: string;
  relation: "same" | "different";
  a: Readonly<{ kind: string; id: string }>;
  b: Readonly<{ kind: string; id: string }>;
  validFrom: string;
  validTo?: string | undefined;
}>;

/**
 * The target's CURRENT assertions touching the guarded universe, read fresh
 * from `backend` (the tx backend inside the commit transaction).
 */
async function relevantLedgerAssertions<G extends GraphDef>(
  target: Store<G>,
  memberKeys: ReadonlySet<MergeKey>,
  backend: GraphBackend | TransactionBackend,
): Promise<readonly LedgerAssertion[]> {
  const current = await storeRuntime(target).identityAssertionsAtTarget(
    backend,
    "state",
  );
  return current.filter(
    (assertion) =>
      memberKeys.has(mergeKey(assertion.a.kind, assertion.a.id)) ||
      memberKeys.has(mergeKey(assertion.b.kind, assertion.b.id)),
  );
}

/** Deterministic fingerprint of the `different` assertions in a ledger slice. */
function differentLedgerFingerprint(
  assertions: readonly LedgerAssertion[],
): string {
  return JSON.stringify(
    assertions
      .filter((assertion) => assertion.relation === "different")
      .map((assertion) => [assertion.id, ...endpointTuple(assertion)])
      .toSorted((left, right) =>
        compareStrings(left.join("\u0000"), right.join("\u0000")),
      ),
  );
}

/**
 * @internal Exported for deterministic verification. Structural (JSON)
 * encoding of a seed's liveness plus its sorted class member tuples —
 * injective even when ids contain the separator characters a joined string
 * would collide on.
 */
export function encodeClassFingerprint(
  live: boolean,
  members: readonly Readonly<{ kind: string; id: string }>[],
): string {
  return JSON.stringify([
    live,
    members
      .map((member) => [member.kind, member.id] as const)
      .toSorted(([leftKind, leftId], [rightKind, rightId]) =>
        compareMergeKeys(
          mergeKey(leftKind, leftId),
          mergeKey(rightKind, rightId),
        ),
      ),
  ]);
}

/** The complete truth an assertion id identifies, as a comparable string. */
export function assertionTruthKey(assertion: LedgerAssertion): string {
  return JSON.stringify([
    assertion.relation,
    ...endpointTuple(assertion),
    assertion.validFrom,
    assertion.validTo ?? null,
  ]);
}

/**
 * The immutable identity of a ledger row — everything but `validTo`. Two
 * captures of ONE row always agree on this key (retraction only sets
 * `validTo`), so it is the right comparator for "is the target's row the same
 * assertion the branch retracted": the branch's staged copy carries its own end
 * timestamp while the target's current row carries none, which makes the
 * complete {@link assertionTruthKey} unusable for that question.
 */
function assertionIdentityKey(assertion: LedgerAssertion): string {
  return JSON.stringify([
    assertion.relation,
    ...endpointTuple(assertion),
    assertion.validFrom,
  ]);
}

/**
 * One assertion id identifies ONE complete truth — the invariant the import
 * coordinator enforces with `IDENTITY_IMPORT_ID_CONFLICT` inside the commit.
 * Validated here at plan time instead: intra-plan (two branches staging one
 * id for different truths) and against every stored row for those ids —
 * ended rows included, exactly the set the importer compares. An exact match
 * is fine (the importer skips it as already applied).
 */
export function assertOneIdOneTruth(
  planned: readonly IdentityTransferAssertion[],
  storedById: ReadonlyMap<string, LedgerAssertion>,
): void {
  const plannedById = new Map<string, IdentityTransferAssertion>();
  for (const assertion of planned) {
    const previous = plannedById.get(assertion.id);
    if (
      previous !== undefined &&
      assertionTruthKey(previous) !== assertionTruthKey(assertion)
    ) {
      throw new IdentityMergeConflictError(
        "One assertion id was staged for two different identity truths.",
        {
          details: {
            assertionId: assertion.id,
            first: previous,
            second: assertion,
          },
        },
      );
    }
    plannedById.set(assertion.id, assertion);
    const stored = storedById.get(assertion.id);
    if (
      stored !== undefined &&
      assertionTruthKey(stored) !== assertionTruthKey(assertion)
    ) {
      throw new IdentityMergeConflictError(
        "A staged assertion id already identifies different truth in the target ledger.",
        { details: { assertionId: assertion.id, staged: assertion, stored } },
      );
    }
  }
}

/**
 * In-transaction freshness of every planned assertion and retraction id,
 * shared by BOTH commit modes. The plan validated each id against the target's
 * ledger as of planning; a row committed (or ended) in the plan→commit window
 * can claim a planned id — with endpoints entirely outside the guarded member
 * universe — without moving the legacy base@V token, which fingerprints
 * CURRENT assertions only. A planned NEW assertion refuses when its id
 * identifies any different complete truth (ended rows included, exactly the
 * set the applier compares); a planned RETRACTION refuses when the CURRENT row
 * its id ends is no longer the truth the branch retracted.
 */
export async function assertPlannedIdentityIdsFresh<G extends GraphDef>(
  target: Store<G>,
  txBackend: TransactionBackend,
  plan: IdentityPlanSlice,
): Promise<void> {
  const plannedIds = [
    ...plan.identityAssertions.map((assertion) => assertion.id),
    ...plan.identityRetractions.map((retraction) => retraction.id),
  ];
  if (plannedIds.length === 0) return;
  const storedById = await storeRuntime(target).identityAssertionRowsByIds(
    plannedIds,
    txBackend,
  );
  for (const assertion of plan.identityAssertions) {
    const stored = storedById.get(assertion.id);
    if (
      stored !== undefined &&
      assertionTruthKey(stored) !== assertionTruthKey(assertion)
    ) {
      throw new BaseVersionMismatchError(
        "The merge validated its assertion ids as of planning, but a row identifying different truth under a planned id was committed before the commit transaction. Re-plan against the current target.",
        { details: { assertionId: assertion.id } },
      );
    }
  }
  for (const retraction of plan.identityRetractions) {
    const stored = storedById.get(retraction.id);
    if (
      stored !== undefined &&
      stored.validTo === undefined &&
      assertionIdentityKey(stored) !== assertionIdentityKey(retraction)
    ) {
      throw new BaseVersionMismatchError(
        "The merge validated each planned retraction against the target row its id identified at planning, but that row's truth changed before the commit transaction. Re-plan against the current target.",
        { details: { assertionId: retraction.id } },
      );
    }
  }
}

/**
 * Codes the identity service raises for ENVIRONMENT problems — a missing
 * profile, a non-atomic backend, an undersized bind budget. These are not
 * statements about identity truth, so they pass through untranslated; every
 * other identity refusal escaping the commit IS a truth conflict.
 */
const IDENTITY_ENVIRONMENT_CODES: ReadonlySet<string> = new Set([
  "IDENTITY_MERGE_REQUIRES_PROFILE",
  "IDENTITY_REQUIRES_ATOMIC_BACKEND",
  "IDENTITY_REQUIRES_STATEMENT_EXECUTION",
  "IDENTITY_BIND_BUDGET_TOO_SMALL",
  // Unreachable from the applier today, but environment/corruption
  // statements all the same — translating one into "re-plan against the
  // current target" would be advice that can never succeed.
  "IDENTITY_NOT_ENABLED",
  "IDENTITY_STORAGE_MISSING",
  "IDENTITY_SCHEMA_CONTRADICTION",
  "IDENTITY_IMPORT_REQUIRES_PROFILE",
]);

/**
 * The identity code carried by an applier refusal, wherever the applier put
 * it: the top-level error code, a `details.code` field (the coordinator's
 * `ConfigurationError`s), or a per-assertion `details.issues[].code` (the
 * transfer validator's `ValidationError`s report per-row issues, so the code
 * never reaches the top level).
 */
function identityRefusalCode(error: TypeGraphError): string | undefined {
  const detailCode = error.details["code"];
  if (typeof detailCode === "string" && detailCode.startsWith("IDENTITY_")) {
    return detailCode;
  }
  if (error.code.startsWith("IDENTITY_")) return error.code;
  const issues = error.details["issues"];
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      const code = (issue as Readonly<Record<string, unknown>>)["code"];
      if (typeof code === "string" && code.startsWith("IDENTITY_")) {
        return code;
      }
    }
  }
  return undefined;
}

/**
 * The commit-phase completeness backstop for identity invariants. The planner
 * SIMULATES the identity applier's rules to refuse illegal plans early and
 * typed — but a simulation can lag the applier, and an invariant it does not
 * (yet) mirror would surface as the generic merge wrapper around the applier's
 * refusal. Translating every refusal that escapes the IDENTITY-APPLIER
 * boundary (the `applyIdentityMergeAtTarget` call inside the commit) into the
 * typed conflict error (cause preserved) gives NEW applier invariants a typed
 * surface by construction instead of by hand-built plan-time twins.
 *
 * Because this wraps ONLY the identity apply, a {@link NodeNotFoundError}
 * here can mean just one thing — an assertion endpoint the plan validated
 * vanished — so it translates too; the same error from a node or edge write
 * never reaches this function. Typed {@link MergeError}s (the guards' own
 * refusals) and non-identity failures pass through unchanged.
 *
 * @internal Exported for isolated verification of the translation contract.
 */
export function translateIdentityCommitError(error: unknown): unknown {
  if (error instanceof MergeError) return error;
  if (!(error instanceof TypeGraphError)) return error;
  const identityCode = identityRefusalCode(error);
  const identityRefusal =
    error instanceof IdentityContradictionError ||
    error instanceof NodeNotFoundError ||
    (identityCode !== undefined &&
      !IDENTITY_ENVIRONMENT_CODES.has(identityCode));
  if (!identityRefusal) return error;
  return new IdentityMergeConflictError(
    `The identity applier refused the resolved plan inside the commit transaction — identity truth on the target is incompatible with the plan. Re-plan against the current target. Cause: ${describeCause(error)}`,
    {
      cause: error,
      details: { ...(identityCode === undefined ? {} : { identityCode }) },
    },
  );
}

/**
 * Fold-peer TOCTOU guard: proves the identity state the plan-time simulation
 * validated still holds inside the commit transaction — direct peers,
 * per-seed class/liveness fingerprints, the negative ledger, and finally the
 * FULL simulation re-run on transaction reads (drift that leaves every
 * fingerprint unchanged, like a redundant `same(a, b)` that becomes decisive
 * once the plan removes the pair's bridge, can only be caught by
 * re-deriving legality itself). Drift is refused as the same typed replan
 * error the other window guards raise.
 */
export async function assertIdentityPeersStable<G extends GraphDef>(
  target: Store<G>,
  txBackend: TransactionBackend,
  probe: IdentityPeerProbe | undefined,
  plan: IdentityPlanSlice,
): Promise<void> {
  if (probe === undefined) return;
  const live = (
    await storeRuntime(target).liveNodesSharingIds(probe.ids, txBackend)
  ).filter((peer) => !probe.plannedDeletions.has(mergeKey(peer.kind, peer.id)));
  // Under "fold" ANY new same-id peer changes the classes the plan folded
  // on; under "ignore" only a peer of a kind DISJOINT with a seed sharing
  // its id changes legality (the create-time disjoint-id constraint) — a
  // benign same-id row is an unrelated target advance.
  const seedKindsById = new Map<string, Set<string>>();
  for (const seed of probe.seeds) {
    const kinds = seedKindsById.get(seed.id) ?? new Set<string>();
    kinds.add(seed.kind);
    seedKindsById.set(seed.id, kinds);
  }
  const appeared = live
    .filter(
      (peer) =>
        probe.profile === "fold" ||
        [...(seedKindsById.get(peer.id) ?? [])].some((kind) =>
          target.registry.areDisjoint(peer.kind, kind),
        ),
    )
    .map((peer) => mergeKey(peer.kind, peer.id))
    .filter((key) => !probe.observed.has(key))
    .sort((left, right) => compareMergeKeys(left, right));
  if (appeared.length > 0) {
    throw new BaseVersionMismatchError(
      `mergeIncremental() simulated identity folding against the target's live same-id peers as of planning, but ${appeared.length} committed row(s) sharing a planned node's id appeared before the commit transaction. Committing the plan could fold nodes into classes the plan never validated.`,
      { details: { appeared } },
    );
  }
  // Class-transitive drift: a window row or assertion can change a seed's
  // identity class through ANOTHER member without touching the seed's direct
  // same-id peers — and a seed can DISAPPEAR without changing its
  // self-coalesced class, so liveness is part of the fingerprint.
  const { fingerprints: liveFingerprints, groups: liveGroups } =
    await snapshotIdentityClasses(
      target,
      probe.seeds,
      new Set(live.map((peer) => mergeKey(peer.kind, peer.id))),
      probe.plannedDeletions,
      txBackend,
    );
  const drifted = [...probe.classFingerprints]
    .filter(([key, fingerprint]) => liveFingerprints.get(key) !== fingerprint)
    .map(([key]) => key)
    .sort((left, right) => compareStrings(left, right));
  if (drifted.length > 0) {
    throw new BaseVersionMismatchError(
      `mergeIncremental() validated identity against the classes visible at planning, but the identity class of ${drifted.length} node(s) the plan folds on changed before the commit transaction. Committing the plan could contradict identity truth it never validated.`,
      { details: { drifted } },
    );
  }
  // Negative truth: a `different` assertion committed (or retracted) in the
  // window changes plan legality without moving any class or peer.
  const ledger = (
    await relevantLedgerAssertions(target, probe.memberKeys, txBackend)
  ).filter(
    (assertion) =>
      !probe.plannedDeletions.has(mergeKey(assertion.a.kind, assertion.a.id)) &&
      !probe.plannedDeletions.has(mergeKey(assertion.b.kind, assertion.b.id)),
  );
  if (differentLedgerFingerprint(ledger) !== probe.differentFingerprint) {
    throw new BaseVersionMismatchError(
      "mergeIncremental() validated identity against the `different` assertions visible at planning, but that ledger changed before the commit transaction. Committing the plan could contradict identity truth it never validated.",
      { details: {} },
    );
  }

  // The decisive backstop: re-run the identity simulation on TRANSACTION
  // reads. Every fingerprint above can survive a window write that still
  // changes post-plan legality — the canonical example is a `same(a, b)`
  // added while a and b are already transitively connected (no class or
  // ledger-slice fingerprint moves) that becomes the surviving link once the
  // plan removes their bridge and asserts them different.
  try {
    assertNoContradictoryIdentityClosure(
      plan.identityAssertions,
      plan.identityRetractions.map((retraction) => retraction.id),
      ledger,
      probe.plannedDeletions,
      plan.canonicalOf,
      plan.retypeMap,
      {
        sameIdAcrossKinds: probe.profile,
        areDisjoint: (left, right) => target.registry.areDisjoint(left, right),
      },
      [...probe.seeds, ...liveGroups.flat()],
    );
  } catch (error) {
    if (!(error instanceof IdentityMergeConflictError)) throw error;
    throw new BaseVersionMismatchError(
      "mergeIncremental() validated identity as of planning, but identity truth committed before the commit transaction invalidates the plan. Re-plan against the current target.",
      { details: { conflict: error.message } },
    );
  }
}
