/**
 * The identity three-way classifier, verified directly against
 * `planIdentityChanges` / `classifyIdentityPair` without a full store or
 * merge — the same unit-fixture style
 * `tests/graph-merge/identity-merge.test.ts` uses for `planIdentityChanges`.
 *
 * The invariant under test: every staged identity assertion and retraction
 * ends as a planned write, an explicit `dropped` entry, or a refusal that
 * names it. None silently disappears.
 */
import { describe, expect, it } from "vitest";

import { IdentityMergeConflictError } from "../../src/graph-merge/errors";
import {
  classifyIdentityPair,
  DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
} from "../../src/graph-merge/identity-three-way";
import {
  planIdentityChanges,
  RETRACTION_TARGET_MISMATCH_DROP_REASON,
} from "../../src/graph-merge/merge-identity";
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

function caughtFrom(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("a retract/reassert race", () => {
  const inherited: IdentityTransferAssertion = { ...SAME_PAIR, id: "a-1" };
  const reasserted: IdentityTransferAssertion = {
    ...SAME_PAIR,
    id: "a-2",
    validFrom: "2024-02-01T00:00:00.000Z",
  };

  it("is refused, naming the retraction, the reassertion and both branches", () => {
    const caught = caughtFrom(() =>
      planIdentityChanges(
        stagingWithIdentityChanges(
          [{ branchId: BRANCH_B, assertion: reasserted }],
          [{ branchId: BRANCH_A, assertion: inherited }],
        ),
        new Map(),
      ),
    );
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

  it("is not a race when the reasserting branch retracted the pair itself: both writes are planned", () => {
    const ended: IdentityTransferAssertion = {
      ...inherited,
      validTo: reasserted.validFrom,
    };
    const planned = planIdentityChanges(
      stagingWithIdentityChanges(
        [{ branchId: BRANCH_A, assertion: reasserted }],
        [{ branchId: BRANCH_A, assertion: ended }],
        [inherited],
      ),
      new Map(),
    );
    console.info("convergent plan", planned);
    expect(planned.assertions).toEqual([reasserted]);
    // The base row ends at the instant the branch itself staged.
    expect(planned.retractions).toEqual([ended]);
    expect(planned.dropped).toEqual([]);
  });
});

describe("duplicate assertions of one pair", () => {
  const earlier: IdentityTransferAssertion = { ...SAME_PAIR, id: "b-1" };
  const later: IdentityTransferAssertion = {
    ...SAME_PAIR,
    id: "b-2",
    validFrom: "2024-02-01T00:00:00.000Z",
  };
  const duplicateStaging = (): StagingSet =>
    stagingWithIdentityChanges([
      { branchId: BRANCH_B, assertion: later },
      { branchId: BRANCH_A, assertion: earlier },
    ]);

  it("keep the earliest and report every other id as dropped", () => {
    const planned = planIdentityChanges(duplicateStaging(), new Map());
    expect(planned.assertions.map((entry) => entry.id)).toEqual(["b-1"]);
    expect(planned.dropped).toEqual([
      {
        kind: "identity",
        id: "b-2",
        reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      },
    ]);
  });

  it("keep the id the target already holds, whatever its validFrom", () => {
    const planned = planIdentityChanges(
      duplicateStaging(),
      new Map([["b-2", later]]),
    );
    expect(planned.assertions.map((entry) => entry.id)).toEqual(["b-2"]);
    expect(planned.dropped).toEqual([
      {
        kind: "identity",
        id: "b-1",
        reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
      },
    ]);
  });

  it("collapse silently when two branches staged the identical row", () => {
    const planned = planIdentityChanges(
      stagingWithIdentityChanges([
        { branchId: BRANCH_A, assertion: earlier },
        { branchId: BRANCH_B, assertion: earlier },
      ]),
      new Map(),
    );
    // The one row is written; reporting it as dropped too would contradict
    // the write.
    expect(planned.assertions).toEqual([earlier]);
    expect(planned.dropped).toEqual([]);
  });
});

/**
 * ORDER IS BEHAVIOR: a staging set that trips more than one check reports the
 * classifier's cross-cutting refusals first, then the structural
 * one-id-one-truth checks — moving either past the other changes which error a
 * caller sees for the same input.
 */
describe("validation order across the classifier and the structural checks", () => {
  it("reports the opposing-relations refusal, not the id collision it also carries", () => {
    const opposing: IdentityTransferAssertion = {
      ...SAME_PAIR,
      relation: "different",
      id: "d-1",
    };
    const staging = stagingWithIdentityChanges([
      { branchId: BRANCH_A, assertion: { ...SAME_PAIR, id: "dup" } },
      {
        branchId: BRANCH_B,
        assertion: {
          ...SAME_PAIR,
          id: "dup",
          validFrom: "2024-05-01T00:00:00.000Z",
        },
      },
      { branchId: BRANCH_B, assertion: opposing },
    ]);
    const caught = caughtFrom(() => planIdentityChanges(staging, new Map()));
    expect(caught).toBeInstanceOf(IdentityMergeConflictError);
    const error = caught as IdentityMergeConflictError;
    expect(error.message).toBe(
      "Branches asserted opposing identity relations for one endpoint pair.",
    );
    expect(
      (error.details["assertions"] as readonly IdentityTransferAssertion[]).map(
        (assertion) => assertion.relation,
      ),
    ).toEqual(["same", "different"]);
  });
});

/**
 * The base slice is the target's CURRENT truth (open rows only); a retraction
 * is derived from an ARCHIVAL read, so a branch retracting a row the target
 * has already ended stages a retraction with no base group to classify
 * against. It must still reach the plan — or be dropped with a typed reason —
 * never vanish.
 */
describe("a staged retraction whose base row is already ended", () => {
  const alreadyEnded: IdentityTransferAssertion = { ...SAME_PAIR, id: "a-1" };
  const orphanStaging = (): StagingSet =>
    stagingWithIdentityChanges(
      [],
      [{ branchId: BRANCH_A, assertion: alreadyEnded }],
      // The target's CURRENT truth holds nothing for this pair: the row the
      // branch retracts was ended before the merge.
      [],
    );

  it("is planned, not silently dropped", () => {
    const planned = planIdentityChanges(orphanStaging(), new Map());
    expect(planned.retractions.map((entry) => entry.id)).toEqual(["a-1"]);
    expect(planned.dropped).toEqual([]);
    expect(planned.assertions).toEqual([]);
  });

  it("is dropped with a typed reason when the target's OPEN row is a different truth", () => {
    const planned = planIdentityChanges(
      orphanStaging(),
      new Map([
        [
          "a-1",
          {
            id: "a-1",
            relation: "same" as const,
            a: { kind: "Person", id: "first" },
            b: { kind: "Person", id: "third" },
            validFrom: SAME_PAIR.validFrom,
          },
        ],
      ]),
    );
    expect(planned.retractions).toEqual([]);
    expect(planned.dropped).toEqual([
      {
        kind: "identity",
        id: "a-1",
        reason: RETRACTION_TARGET_MISMATCH_DROP_REASON,
      },
    ]);
  });
});

/**
 * Two branches ending the SAME base identity assertion at DIFFERENT
 * valid-time instants reduce to one retraction: the EARLIEST staged `validTo`
 * wins, order-independent — never "the last one staged".
 */
describe("ending a doubly-retracted base row picks the EARLIEST end, not the last staged", () => {
  const basePair: IdentityTransferAssertion = { ...SAME_PAIR, id: "base-1" };
  const earlyEnd: IdentityTransferAssertion = {
    ...basePair,
    validTo: "2024-03-01T00:00:00.000Z",
  };
  const lateEnd: IdentityTransferAssertion = {
    ...basePair,
    validTo: "2024-09-01T00:00:00.000Z",
  };
  const earlyRetraction = {
    branchId: BRANCH_A,
    assertion: earlyEnd,
    cause: { kind: "explicit" } as const,
  };
  const lateRetraction = {
    branchId: BRANCH_B,
    assertion: lateEnd,
    cause: { kind: "explicit" } as const,
  };

  it("picks the earlier end whichever order the retractions are staged in", () => {
    const forward = classifyIdentityPair(
      [basePair],
      [],
      [earlyRetraction, lateRetraction],
      new Set(),
    );
    const backward = classifyIdentityPair(
      [basePair],
      [],
      [lateRetraction, earlyRetraction],
      new Set(),
    );
    expect(forward).toEqual({ kind: "retracted", retraction: earlyEnd });
    expect(backward).toEqual({ kind: "retracted", retraction: earlyEnd });
  });

  it("agrees end to end through planIdentityChanges", () => {
    const staging = stagingWithIdentityChanges(
      [],
      [lateRetraction, earlyRetraction],
      [basePair],
    );
    const planned = planIdentityChanges(staging, new Map());
    expect(planned.retractions).toEqual([earlyEnd]);
  });
});

describe("every staged identity change is accounted for", () => {
  it("names each staged id as a planned write or an explicit drop", () => {
    const pair = (
      id: string,
      second: string,
      validFrom: string = SAME_PAIR.validFrom,
    ): IdentityTransferAssertion => ({
      ...SAME_PAIR,
      b: { kind: "Person", id: second },
      id,
      validFrom,
    });
    const retractedBase = pair("base-retracted", "retracted");
    const replacedBase = pair("base-replaced", "replaced");
    const newAssertions: StagedAssertion[] = [
      // A lone assertion.
      { branchId: BRANCH_A, assertion: pair("lone", "lone") },
      // Three ids for one pair: one survives, two are dropped.
      { branchId: BRANCH_A, assertion: pair("dup-1", "dup") },
      {
        branchId: BRANCH_B,
        assertion: pair("dup-2", "dup", "2024-02-01T00:00:00.000Z"),
      },
      {
        branchId: BRANCH_B,
        assertion: pair("dup-3", "dup", "2024-03-01T00:00:00.000Z"),
      },
      // A replacement its own branch retracted the base row for.
      {
        branchId: BRANCH_A,
        assertion: pair("replacement", "replaced", "2024-04-01T00:00:00.000Z"),
      },
    ];
    const retractedAssertions: StagedAssertion[] = [
      {
        branchId: BRANCH_B,
        assertion: { ...retractedBase, validTo: "2024-05-01T00:00:00.000Z" },
      },
      {
        branchId: BRANCH_A,
        assertion: { ...replacedBase, validTo: "2024-04-01T00:00:00.000Z" },
      },
      // The target already ended this row.
      {
        branchId: BRANCH_A,
        assertion: {
          ...pair("already-ended", "ended"),
          validTo: "2024-06-01T00:00:00.000Z",
        },
      },
    ];
    const planned = planIdentityChanges(
      stagingWithIdentityChanges(newAssertions, retractedAssertions, [
        retractedBase,
        replacedBase,
      ]),
      new Map(),
    );
    console.info("accounted plan", planned);

    const idsOf = (entries: readonly Readonly<{ id: string }>[]) =>
      entries.map((entry) => entry.id).toSorted();
    expect(idsOf(planned.assertions)).toEqual(["dup-1", "lone", "replacement"]);
    expect(idsOf(planned.dropped)).toEqual(["dup-2", "dup-3"]);
    expect(idsOf(planned.retractions)).toEqual([
      "already-ended",
      "base-replaced",
      "base-retracted",
    ]);
    const accounted = new Set([
      ...idsOf(planned.assertions),
      ...idsOf(planned.dropped),
      ...idsOf(planned.retractions),
    ]);
    const staged = [...newAssertions, ...retractedAssertions].map(
      (entry) => entry.assertion.id,
    );
    expect(staged.filter((id) => !accounted.has(id))).toEqual([]);
  });
});
