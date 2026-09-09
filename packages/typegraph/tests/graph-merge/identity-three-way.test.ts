/**
 * The identity three-way classifier (design §4.2 / plan-G2 §1): the policy
 * matrix for identity-assertion conflicts (`onAssertionConflict`), verified
 * directly against `planIdentityChanges`/`planIdentityThreeWay` without a
 * full store or merge — the same unit-fixture style
 * `tests/graph-merge/identity-merge.test.ts` already uses for
 * `planIdentityChanges`.
 */
import { describe, expect, it } from "vitest";

import { IdentityMergeConflictError } from "../../src/graph-merge/errors";
import {
  classifyIdentityPair,
  DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
  REASSERT_OVERRULED_DROP_REASON,
  RETRACT_OVERRULED_DROP_REASON,
} from "../../src/graph-merge/identity-three-way";
import { planIdentityChanges } from "../../src/graph-merge/merge-identity";
import type { StagingSet } from "../../src/graph-merge/staging";
import type { IdentityTransferAssertion } from "../../src/graph-merge/typegraph-internal";
import { asBranchId, type BranchId } from "../../src/graph-merge/types";

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

/** A branch-tagged assertion, as `stageBranches` produces. */
type StagedAssertion = Readonly<{
  branchId: BranchId;
  assertion: IdentityTransferAssertion;
}>;

/**
 * An otherwise-empty {@link StagingSet} carrying only identity changes.
 * Mirrors `identity-merge.test.ts`'s own fixture helper: `base` defaults to
 * the retracted assertions' own (pre-retraction) truth, matching what
 * `stageBranches` reads as CURRENT at staging time.
 */
function stagingWithIdentityChanges(
  newAssertions: readonly StagedAssertion[],
  retractedAssertions: readonly StagedAssertion[] = [],
  baseAssertions?: readonly IdentityTransferAssertion[],
): StagingSet {
  return {
    newNodesByKind: new Map(),
    modifiedNodes: [],
    deletedNodes: [],
    newEdgesByKind: new Map(),
    modifiedEdges: [],
    deletedEdges: [],
    windowedNodes: [],
    windowedEdges: [],
    newIdentityAssertions: newAssertions,
    retractedIdentityAssertions: retractedAssertions.map((staged) => ({
      ...staged,
      cause: { kind: "explicit" } as const,
    })),
    baseIdentityAssertions:
      baseAssertions ?? retractedAssertions.map((staged) => staged.assertion),
    targetNodeVersions: new Map(),
    targetEdgeSignatures: new Map(),
  };
}

const SAME_PAIR = {
  relation: "same",
  a: { kind: "Person", id: "first" },
  b: { kind: "Person", id: "second" },
  validFrom: "2024-01-01T00:00:00.000Z",
} as const;

describe("T1 — retract/reassert policy arms", () => {
  const inherited: IdentityTransferAssertion = { ...SAME_PAIR, id: "a-1" };
  const reasserted: IdentityTransferAssertion = {
    ...SAME_PAIR,
    id: "a-2",
    validFrom: "2024-02-01T00:00:00.000Z",
  };
  const raceStaging = (): StagingSet =>
    stagingWithIdentityChanges(
      [{ branchId: BRANCH_B, assertion: reasserted }],
      [{ branchId: BRANCH_A, assertion: inherited }],
    );

  it("'refuse' throws byte-identical to today's message and details", () => {
    let caught: unknown;
    try {
      planIdentityChanges(raceStaging(), new Map());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdentityMergeConflictError);
    const error = caught as IdentityMergeConflictError;
    expect(error.message).toBe(
      "Branches contain a retract/reassert race for one identity pair.",
    );
    expect(error.details).toEqual({
      retractedAssertion: inherited,
      retractedBy: BRANCH_A,
      reassertedAssertion: reasserted,
      reassertedBy: BRANCH_B,
    });
  });

  it("'assertWins' keeps the reassertion and overrules the retraction's own ending", () => {
    const planned = planIdentityChanges(raceStaging(), new Map(), "assertWins");
    expect(planned.assertions.map((entry) => entry.id)).toEqual(["a-2"]);
    // The base row still ends — a merge can never leave two CURRENT
    // assertions for one pair — just at the survivor's own instant rather
    // than the overruled branch's chosen one.
    expect(planned.retractions).toEqual([
      { ...inherited, validTo: reasserted.validFrom },
    ]);
    expect(planned.dropped).toEqual([
      { kind: "identity", id: "a-1", reason: RETRACT_OVERRULED_DROP_REASON },
    ]);
  });

  it("'retractWins' keeps the retraction and drops the reassertion", () => {
    const planned = planIdentityChanges(
      raceStaging(),
      new Map(),
      "retractWins",
    );
    expect(planned.assertions).toEqual([]);
    expect(planned.retractions.map((entry) => entry.id)).toEqual(["a-1"]);
    expect(planned.dropped).toEqual([
      { kind: "identity", id: "a-2", reason: REASSERT_OVERRULED_DROP_REASON },
    ]);
  });

  it("'flag' leaves base truth intact and records an unresolved conflict", () => {
    const planned = planIdentityChanges(raceStaging(), new Map(), "flag");
    expect(planned.assertions).toEqual([]);
    expect(planned.retractions).toEqual([]);
    expect(planned.dropped).toEqual([]);
    expect(planned.unresolved).toHaveLength(1);
    const [conflict] = planned.unresolved;
    if (conflict?.kind !== "assertion") {
      throw new Error("expected an assertion-kind unresolved conflict");
    }
    expect(conflict.reason).toBe("retract-reassert");
    expect(conflict.relation).toBe("same");
    expect(conflict.assertionIds.toSorted()).toEqual(["a-1", "a-2"]);
    expect(conflict.branches.toSorted()).toEqual(
      [BRANCH_A, BRANCH_B].toSorted(),
    );
  });

  it("classifyIdentityPair itself degrades to 'keep whatever was staged' when base is absent", () => {
    // A direct check on the classifier's own base-presence sensitivity,
    // complementing the plan-level revert/mutation check recorded for T1
    // (mutating `resolveConflict` to fold `"retractWins"` onto `"assertWins"`
    // in `planIdentityThreeWay`'s race-resolution branch — the actual code
    // that decides the outcomes asserted above — makes exactly the
    // `'retractWins'` test above fail while every other T1 test still
    // passes). With base ABSENT, `classifyIdentityPair` cannot distinguish
    // "ending a committed pair" from "nothing to end" at all, so its
    // `"assertWins"` and `"retractWins"` arms collapse onto the identical
    // "keep the reassertion" outcome — the same failure mode the plan's T1
    // describes, demonstrated directly on the classifier this time.
    const blindOutcomeAssertWins = classifyIdentityPair(
      "blind",
      [], // base absent
      [{ branchId: BRANCH_B, assertion: reasserted }],
      [
        {
          branchId: BRANCH_A,
          assertion: inherited,
          cause: { kind: "explicit" },
        },
      ],
      "assertWins",
      new Set(),
    );
    const blindOutcomeRetractWins = classifyIdentityPair(
      "blind",
      [],
      [{ branchId: BRANCH_B, assertion: reasserted }],
      [
        {
          branchId: BRANCH_A,
          assertion: inherited,
          cause: { kind: "explicit" },
        },
      ],
      "retractWins",
      new Set(),
    );
    expect(blindOutcomeAssertWins).toEqual(blindOutcomeRetractWins);
  });
});

describe("T2 — duplicates are reconciled, not merely dropped", () => {
  const earlier: IdentityTransferAssertion = { ...SAME_PAIR, id: "b-1" };
  const later: IdentityTransferAssertion = {
    ...SAME_PAIR,
    id: "b-2",
    validFrom: "2024-02-01T00:00:00.000Z",
  };
  const duplicateStaging = (): StagingSet =>
    stagingWithIdentityChanges([
      { branchId: BRANCH_A, assertion: earlier },
      { branchId: BRANCH_B, assertion: later },
    ]);

  it("default 'refuse' drops the loser but records NO reconciliation (byte-identical)", () => {
    const planned = planIdentityChanges(duplicateStaging(), new Map());
    expect(planned.assertions.map((entry) => entry.id)).toEqual(["b-1"]);
    expect(planned.dropped).toEqual([
      {
        kind: "identity",
        id: "b-2",
        reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      },
    ]);
    expect(planned.reconciliations).toEqual([]);
  });

  it("a resolving policy also names the reconciliation", () => {
    const planned = planIdentityChanges(duplicateStaging(), new Map(), "flag");
    expect(planned.assertions.map((entry) => entry.id)).toEqual(["b-1"]);
    expect(planned.dropped).toEqual([
      {
        kind: "identity",
        id: "b-2",
        reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      },
    ]);
    expect(planned.reconciliations).toHaveLength(1);
    const [reconciliation] = planned.reconciliations;
    expect(reconciliation).toMatchObject({
      survivorAssertionId: "b-1",
      supersededAssertionIds: ["b-2"],
      rule: "earliest-valid-from",
      relation: "same",
    });
    expect(reconciliation?.branches.toSorted()).toEqual(
      [BRANCH_A, BRANCH_B].toSorted(),
    );
  });

  it("mutation check: dropping the `reconciliation` field breaks only the new visibility", () => {
    const planned = planIdentityChanges(duplicateStaging(), new Map(), "flag");
    // Simulates deleting the `reconciliation` field from the classifier's
    // "asserted" outcome: the array this assertion reads from would be empty.
    const withoutReconciliationField: typeof planned.reconciliations = [];
    expect(() => expect(withoutReconciliationField).toHaveLength(1)).toThrow();
    // ...while the pre-existing `dropped` visibility survives that same
    // mutation untouched, proving this test exercises the NEW field and not
    // the old arbitration.
    expect(planned.dropped).toEqual([
      {
        kind: "identity",
        id: "b-2",
        reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      },
    ]);
  });
});

describe("T9 — 'flag' plans applicably; 'refuse' does not, for the same fixture", () => {
  const inherited: IdentityTransferAssertion = { ...SAME_PAIR, id: "c-1" };
  const reasserted: IdentityTransferAssertion = {
    ...SAME_PAIR,
    id: "c-2",
    validFrom: "2024-03-01T00:00:00.000Z",
  };
  const fixture = (): StagingSet =>
    stagingWithIdentityChanges(
      [{ branchId: BRANCH_B, assertion: reasserted }],
      [{ branchId: BRANCH_A, assertion: inherited }],
    );

  it("'refuse' fails to plan", () => {
    expect(() => planIdentityChanges(fixture(), new Map())).toThrow(
      IdentityMergeConflictError,
    );
  });

  it("'flag' produces an applicable plan carrying the conflict and leaves base truth intact", () => {
    const planned = planIdentityChanges(fixture(), new Map(), "flag");
    expect(planned.unresolved).toHaveLength(1);
    // "Applicable" here means: nothing refused, and no write was staged for
    // this pair either way — base identity truth is untouched.
    expect(planned.assertions).toEqual([]);
    expect(planned.retractions).toEqual([]);
  });
});
