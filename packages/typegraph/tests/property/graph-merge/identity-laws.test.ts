/**
 * Identity merge LAW properties (complements `merge-laws.test.ts`).
 *
 * Eighteen sequential review rounds on the operational-identity merge each
 * found ONE missing case in the planner's simulation of the identity applier
 * — every one a hand-built repro. This file states the laws that whole class
 * of defects violates and quantifies over randomized branch histories, so the
 * NEXT missing case fails a law here instead of waiting for a reviewer:
 *
 *   1. TYPED-FAILURE   A merge of identity-only branch histories never fails
 *      with the generic merge wrapper: any refusal is a typed
 *      `IdentityMergeConflictError` (the plan is illegal) or
 *      `BaseVersionMismatchError` (the target moved) with an actionable
 *      message.
 *   2. LEDGER-CONSISTENCY   A merge that SUCCEEDS commits a non-contradictory
 *      ledger: no `different(a, b)` whose endpoints the current `same`
 *      assertions transitively connect.
 *   3. TRUTH-PRESERVATION   A successful merge never ends a target assertion
 *      no history invalidated: every pre-merge current row survives unless
 *      some history retracted THAT COMPLETE TRUTH (a retraction of the same
 *      id over different truth does not excuse the row's death) or
 *      deleted/replaced one of its endpoints.
 *   4. REPORT-COHERENCE    An id the report lists as dropped-as-duplicate was
 *      not applied — it never BECOMES current in the same merge.
 *   5. BRANCH-EFFECT       Every truth a branch holds at merge time is
 *      accounted for on a successful merge: applied with equal complete
 *      truth, enumerated as dropped, retracted by some history, or
 *      invalidated by an endpoint deletion/replacement. Silent loss of a
 *      branch's belief is a law violation, not a quiet no-op.
 *   6. WINDOW-PRESERVATION  The valid-time analogues of 3 and 5, since a
 *      branch can also stop a row from being true by ending its validity
 *      rather than deleting it (issue #369). Stated as the FULL least-claim
 *      rule over both populations — nodes AND edges: an end nobody claimed
 *      leaves the target's window alone; a set of branch claims resolves to
 *      the EARLIEST; a committed incremental target that moved the end itself
 *      takes precedence over any branch claim; every committed end is
 *      reported (and only committed ends are); and a row the merge ended is
 *      not readable as of its own end instant.
 *
 * Scenarios are identity histories (assert same/different, retract, delete a
 * node, END A NODE'S OR EDGE'S VALIDITY, create an edge, hard-delete + recreate
 * a node, import an assertion under a CHOSEN id) over a fixed four-node,
 * three-edge universe, applied through the public store API with only the
 * expected semantic refusals skipped, plus a WINDOW FOCUS stage that lets every
 * side claim an end on one shared row so arbitration is generated on purpose
 * rather than by coincidence. Chosen-id imports matter: they
 * are the only way two independent lineages mint the SAME assertion id — the
 * collision class every hand-built review repro lived in. Hard-delete /
 * recreate matters for the same reason within ONE lineage: it physically
 * removes assertion rows, making same-id truth replacement legal on a branch.
 *
 * Three lanes: snapshot `merge()` under the `"ignore"` and `"fold"` profiles
 * (fold adds same-id Robot peers joining and leaving Agent fold classes), and
 * `mergeIncremental()` against a target that ADVANCED after the fork — the
 * regime where branch truth meets independently-moved target truth (id
 * collisions, truth-mismatched retractions, endpoint deletions on one side
 * only).
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { asEdgeId, asNodeId } from "../../../src/core/types";
import {
  EdgeNotFoundError,
  EndpointNotFoundError,
  IdentityContradictionError,
  IdentityEndpointValidityError,
  NodeNotFoundError,
} from "../../../src/errors";
import { branch } from "../../../src/graph-merge/branch";
import {
  BaseVersionMismatchError,
  IdentityMergeConflictError,
} from "../../../src/graph-merge/errors";
import { merge, mergeIncremental } from "../../../src/graph-merge/merge";
import {
  assertionTruthKey,
  DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
} from "../../../src/graph-merge/merge-identity";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import type { BranchId, MergeReport } from "../../../src/graph-merge/types";
import {
  asBranchId,
  VALIDITY_END_TARGET_PRECEDENCE,
} from "../../../src/graph-merge/types";
import { asIdentityAssertionId } from "../../../src/identity/types";
import { importGraph } from "../../../src/interchange";
import { storeBackend, storeRuntime } from "../../../src/store/runtime-port";
import { canonicalizeDatabaseTimestamp } from "../../../src/utils/date";
import { requireDefined } from "../../../src/utils/presence";
import { backendMatrix } from "../../graph-merge/test-utils";

const Agent = defineNode("Agent", {
  schema: z.object({ name: z.string() }),
});
const Robot = defineNode("Robot", {
  schema: z.object({ name: z.string() }),
});
/**
 * An Agent→Agent edge, so the merge's EDGE population is not empty. Declared
 * `edges: {}`, this suite could never reach the edge half of anything the merge
 * decides — window reconciliation, the report's `entity: "edge"` channel, edge
 * staging under an identity merge — no matter how the scenarios were widened.
 */
const relatesTo = defineEdge("relatesTo", {
  schema: z.object({ label: z.string() }),
  from: [Agent],
  to: [Agent],
});

function defineLawGraph(id: string, profile: "fold" | "ignore") {
  return defineGraph({
    id,
    // `cascade`, not the default `restrict`: the alphabet deletes and
    // hard-deletes Agents that now carry seeded edges, and a delete refused for
    // having live edges would quietly take the endpoint-invalidation half of
    // laws 3 and 5 out of the suite.
    nodes: {
      Agent: { type: Agent, onDelete: "cascade" },
      Robot: { type: Robot },
    },
    edges: { relatesTo: { type: relatesTo, from: [Agent], to: [Agent] } },
    identity: { sameIdAcrossKinds: profile },
  });
}

type LawGraph = ReturnType<typeof defineLawGraph>;

const NODE_IDS = ["n1", "n2", "n3", "n4"] as const;

/**
 * The INHERITED edge population, seeded at every fork point. Window
 * reconciliation only ever sees a row live in BOTH the base and the fork, so the
 * edges the window laws quantify over must exist before the branches are cut.
 *
 * Three distinct pairs, which {@link EDGE_CREATE_OP} is free to create edges onto:
 * a branch edge sharing a seeded pair is a parallel row, not a fold partner.
 */
const SEED_EDGES = [
  { id: "seed-e1", from: 0, to: 1 },
  { id: "seed-e2", from: 1, to: 2 },
  { id: "seed-e3", from: 2, to: 3 },
] as const;
const SEED_EDGE_IDS: readonly string[] = SEED_EDGES.map((edge) => edge.id);
const SEED_EDGE_LABEL = "seed";
const BRANCH_EDGE_LABEL = "branch";
const BRANCH_A = asBranchId("identity-law-a");
const BRANCH_B = asBranchId("identity-law-b");
const TARGET_CLONE = asBranchId("identity-law-target");

/**
 * fast-check iterations PER LANE. Each iteration builds a fork point plus two
 * branch stores (the incremental lane adds a target clone) and runs one
 * merge. NOTE: fast-check consumes pinned `examples` OUT OF this budget, so
 * the randomized count is `LAW_RUNS - examples.length`; the budget is sized
 * with that in mind (the full SQLite matrix runs in a few seconds).
 */
const LAW_RUNS = process.env["CI"] ? 12 : 24;

type IdentityOp =
  | Readonly<{ op: "same"; left: number; right: number }>
  | Readonly<{ op: "different"; left: number; right: number }>
  | Readonly<{ op: "retract"; pick: number }>
  | Readonly<{ op: "deleteNode"; node: number }>
  // Ends a node's validity WITHOUT deleting it — the weaker sibling of
  // deletion, and the only window delta a branch can author on a live row.
  | Readonly<{ op: "endValidity"; node: number; endPick: number }>
  // The same statement on the EDGE population, which the merge resolves through
  // the same least-claim rule and reports on its own channel.
  | Readonly<{ op: "endEdgeValidity"; edge: number; endPick: number }>
  // Creates an Agent→Agent edge under a DERIVED id, so two branches authoring
  // the same edge collide on one identity instead of minting two.
  | Readonly<{ op: "createEdge"; from: number; to: number }>
  // Physically removes the node's assertion rows, then recreates the node —
  // the one legal path to same-id truth replacement inside one lineage.
  | Readonly<{ op: "hardDeleteRecreate"; node: number }>
  // Fold lane only: a Robot sharing an Agent's id joins (or leaves) that
  // Agent's fold class without any assertion naming it.
  | Readonly<{ op: "robotPeer"; node: number }>
  | Readonly<{ op: "dropRobotPeer"; node: number }>
  // Interchange import with a CHOSEN id from a small pool: the only way two
  // independent lineages mint the SAME assertion id.
  | Readonly<{
      op: "importAssertion";
      idPick: number;
      left: number;
      right: number;
      validFromPick: number;
    }>;

const IMPORT_ID_POOL = ["shared-x1", "shared-x2"] as const;
/**
 * End instants for `endValidity` / `endEdgeValidity`, all in the FUTURE: a row's
 * `validFrom` defaults to its creation instant and the store refuses an inverted
 * window, so a past end is not authorable at all. THREE distinct values so a
 * tie-break between two disagreeing branches is a real choice among several
 * instants rather than a coin flip between the only two available.
 */
const VALIDITY_ENDS = [
  "2100-01-01T00:00:00.000Z",
  "2100-06-01T00:00:00.000Z",
  "2100-09-01T00:00:00.000Z",
] as const;
const IMPORT_VALID_FROMS = [
  "2024-01-01T00:00:00.000Z",
  "2024-02-01T00:00:00.000Z",
] as const;

const nodeIndexArb = fc.integer({ min: 0, max: NODE_IDS.length - 1 });
const edgeIndexArb = fc.integer({ min: 0, max: SEED_EDGES.length - 1 });
const endPickArb = fc.nat({ max: VALIDITY_ENDS.length - 1 });
const pairArb = fc
  .tuple(nodeIndexArb, nodeIndexArb)
  .filter(([left, right]) => left !== right);

interface WeightedOp {
  weight: number;
  arbitrary: fc.Arbitrary<IdentityOp>;
}

const ASSERTION_OPS: readonly WeightedOp[] = [
  {
    weight: 3,
    arbitrary: pairArb.map(
      ([left, right]) => ({ op: "same", left, right }) as const,
    ),
  },
  {
    weight: 3,
    arbitrary: pairArb.map(
      ([left, right]) => ({ op: "different", left, right }) as const,
    ),
  },
  {
    weight: 2,
    arbitrary: fc
      .nat({ max: 7 })
      .map((pick) => ({ op: "retract", pick }) as const),
  },
  {
    weight: 1,
    arbitrary: nodeIndexArb.map(
      (node) => ({ op: "deleteNode", node }) as const,
    ),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(nodeIndexArb, endPickArb)
      .map(
        ([node, endPick]) => ({ op: "endValidity", node, endPick }) as const,
      ),
  },
  {
    weight: 2,
    arbitrary: fc
      .tuple(edgeIndexArb, endPickArb)
      .map(
        ([edge, endPick]) =>
          ({ op: "endEdgeValidity", edge, endPick }) as const,
      ),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.nat({ max: IMPORT_ID_POOL.length - 1 }),
        pairArb,
        fc.nat({ max: IMPORT_VALID_FROMS.length - 1 }),
      )
      .map(
        ([idPick, [left, right], validFromPick]) =>
          ({
            op: "importAssertion",
            idPick,
            left,
            right,
            validFromPick,
          }) as const,
      ),
  },
];

const HARD_DELETE_OP: WeightedOp = {
  weight: 1,
  arbitrary: nodeIndexArb.map(
    (node) => ({ op: "hardDeleteRecreate", node }) as const,
  ),
};

/**
 * Edge creation, held OUT of the incremental lane's BRANCH alphabet for exactly
 * the reason {@link HARD_DELETE_OP} is: a branch row staged onto an id the target
 * already committed is refused by the incremental existing-id write guard — a
 * legitimate but non-identity refusal that would only add noise to these laws.
 *
 * The endpoint pair is unconstrained, INCLUDING the pairs the seeded edges occupy.
 * That is the regression marker for #393: the store is a multigraph, so a branch
 * edge onto a seeded pair is a parallel row rather than a member of the seeded
 * row's dedupe group, and the window laws below — which judge the row a claim was
 * MADE on — hold without keeping the two apart. While the fold grouped every
 * staged edge by `(from, kind, to)`, such an edge folded with the seeded row and
 * the min-id survivor absorbed its claimed end.
 */
const EDGE_CREATE_OP: WeightedOp = {
  weight: 2,
  arbitrary: pairArb.map(
    ([from, to]) => ({ op: "createEdge", from, to }) as const,
  ),
};

const ROBOT_OPS: readonly WeightedOp[] = [
  {
    weight: 1,
    arbitrary: nodeIndexArb.map((node) => ({ op: "robotPeer", node }) as const),
  },
  {
    weight: 1,
    arbitrary: nodeIndexArb.map(
      (node) => ({ op: "dropRobotPeer", node }) as const,
    ),
  },
];

function opArb(extra: readonly WeightedOp[]): fc.Arbitrary<IdentityOp> {
  return fc.oneof(...ASSERTION_OPS, ...extra);
}

/**
 * ONE row every side may independently end, drawn as its own scenario stage.
 *
 * Left to the random alphabet alone, two branches essentially never end the SAME
 * row at DIFFERENT instants: with four nodes, three edges, three instants and a
 * couple of operations per branch, the collision probability is a fraction of a
 * percent, so the multi-claim half of the least-claim rule — the earliest-end
 * tie-break and the committed target's precedence over a branch — was generated
 * with probability near zero and law 6 only ever exercised its single-claim arm.
 * The focus names one row up front and lets each side claim on it independently,
 * which makes arbitration the common case rather than a coincidence.
 */
type WindowFocus = Readonly<{
  entity: "edge" | "node";
  /** Index into {@link NODE_IDS} or {@link SEED_EDGES}, per `entity` (modulo). */
  index: number;
  /**
   * An end the FORK POINT already holds, so re-statement of the ancestor's own
   * end (which is NOT a claim) and extension to a later instant are reachable.
   */
  fork: number | undefined;
  /**
   * The incremental target's own claim — rule 3's committed-target precedence.
   * Ignored on the snapshot lanes, where the target IS the fork point.
   */
  target: number | undefined;
  branchA: number | undefined;
  branchB: number | undefined;
}>;

/**
 * A focus claim, USUALLY made: the arms this stage exists for need several sides
 * claiming at once, so abstaining is the minority draw.
 */
const focusEndArb: fc.Arbitrary<number | undefined> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 3, arbitrary: endPickArb },
);

const windowFocusArb: fc.Arbitrary<WindowFocus> = fc.record({
  entity: fc.constantFrom<"edge" | "node">("node", "edge"),
  index: nodeIndexArb,
  fork: focusEndArb,
  target: focusEndArb,
  branchA: focusEndArb,
  branchB: focusEndArb,
});

/** A focus that claims nothing, for examples whose subject is not the window. */
const NO_WINDOW_FOCUS: WindowFocus = {
  entity: "node",
  index: 0,
  fork: undefined,
  target: undefined,
  branchA: undefined,
  branchB: undefined,
};

/**
 * One side's focus claim, expressed as an operation the alphabet already knows
 * how to apply — so a claim goes through the same refusal handling as every
 * other write and a focus row an earlier operation deleted simply claims nothing.
 */
function focusOps(
  focus: WindowFocus,
  endPick: number | undefined,
): readonly IdentityOp[] {
  if (endPick === undefined) return [];
  return focus.entity === "node" ?
      [{ op: "endValidity", node: focus.index % NODE_IDS.length, endPick }]
    : [
        {
          op: "endEdgeValidity",
          edge: focus.index % SEED_EDGES.length,
          endPick,
        },
      ];
}

type SnapshotScenario = Readonly<{
  baseOps: readonly IdentityOp[];
  branchAOps: readonly IdentityOp[];
  branchBOps: readonly IdentityOp[];
  focus: WindowFocus;
}>;

type IncrementalScenario = SnapshotScenario &
  Readonly<{ targetOps: readonly IdentityOp[] }>;

function snapshotScenarioArb(
  ops: fc.Arbitrary<IdentityOp>,
): fc.Arbitrary<SnapshotScenario> {
  return fc.record({
    baseOps: fc.array(ops, { maxLength: 2 }),
    branchAOps: fc.array(ops, { minLength: 1, maxLength: 3 }),
    branchBOps: fc.array(ops, { minLength: 1, maxLength: 3 }),
    focus: windowFocusArb,
  });
}

/**
 * The incremental lane restricts BRANCH ops to non-node-creating ones: a
 * branch node staged onto a `(kind, id)` the target already committed is
 * refused by the incremental existing-id write guard — a legitimate but
 * non-identity refusal that would only add noise to the identity laws. The
 * TARGET side keeps hard-delete/recreate (that is where truth-mismatched id
 * reuse comes from), branches keep the full assertion alphabet.
 */
const incrementalScenarioArb: fc.Arbitrary<IncrementalScenario> = fc.record({
  baseOps: fc.array(opArb([EDGE_CREATE_OP]), { maxLength: 2 }),
  targetOps: fc.array(opArb([HARD_DELETE_OP, EDGE_CREATE_OP]), {
    maxLength: 2,
  }),
  branchAOps: fc.array(opArb([]), { minLength: 1, maxLength: 3 }),
  branchBOps: fc.array(opArb([]), { minLength: 1, maxLength: 3 }),
  focus: windowFocusArb,
});

/**
 * The validity-only collision as a pinned example: both branches import ONE id
 * for the SAME pair with different validFrom values. The semantic survivor
 * dedupe used to collapse the two silently — merge succeeded while the report
 * listed the surviving id as dropped (law 4).
 */
const VALIDITY_COLLISION_EXAMPLE: SnapshotScenario = {
  baseOps: [],
  branchAOps: [
    { op: "importAssertion", idPick: 0, left: 0, right: 1, validFromPick: 0 },
  ],
  branchBOps: [
    { op: "importAssertion", idPick: 0, left: 0, right: 1, validFromPick: 1 },
  ],
  focus: NO_WINDOW_FOCUS,
};

/**
 * Same-id truth replacement as a pinned example: the base asserts an imported
 * id, one branch hard-deletes an endpoint (physically removing the row),
 * recreates it, and imports the SAME id for a different pair. A presence-only
 * identity diff staged nothing here — the merge silently kept the base truth
 * while the branch believed the replacement (law 5).
 */
const TRUTH_REPLACEMENT_EXAMPLE: SnapshotScenario = {
  baseOps: [
    { op: "importAssertion", idPick: 0, left: 0, right: 1, validFromPick: 0 },
  ],
  branchAOps: [
    { op: "hardDeleteRecreate", node: 0 },
    { op: "importAssertion", idPick: 0, left: 2, right: 3, validFromPick: 0 },
  ],
  branchBOps: [{ op: "same", left: 2, right: 3 }],
  focus: NO_WINDOW_FOCUS,
};

/**
 * Repeating a resurrection after the fork point has already resurrected the
 * same row must still move the lower bound. If the fixture reused one constant
 * lower bound, the branch artifact was indistinguishable from an authored
 * `clearValidTo` and the window oracle judged the merge against the wrong
 * operation.
 */
const REPEATED_RESURRECTION_WINDOW_EXAMPLE: SnapshotScenario = {
  baseOps: [{ op: "hardDeleteRecreate", node: 1 }],
  branchAOps: [{ op: "hardDeleteRecreate", node: 1 }],
  branchBOps: [{ op: "different", left: 0, right: 1 }],
  focus: {
    entity: "node",
    index: 1,
    fork: 0,
    target: 0,
    branchA: undefined,
    branchB: 0,
  },
};

/**
 * The earliest-end tie-break on a NODE as a pinned example: two branches end the
 * same inherited row at different instants, with the LATER claim on the branch
 * `branchOrder` prefers — so a branch-rank tie-break would commit the later end
 * and only a least-claim rule yields the earlier one. The fork already holds a
 * MIDDLE end, so neither claim can pass by matching the ancestor.
 */
const NODE_END_TIE_BREAK_EXAMPLE: SnapshotScenario = {
  baseOps: [],
  branchAOps: [{ op: "same", left: 0, right: 1 }],
  branchBOps: [{ op: "different", left: 2, right: 3 }],
  focus: {
    entity: "node",
    index: 0,
    fork: 1,
    target: undefined,
    branchA: 2,
    branchB: 0,
  },
};

/**
 * The same tie-break on an EDGE — the population the law suite could not reach
 * at all before this file declared an edge kind.
 */
const EDGE_END_TIE_BREAK_EXAMPLE: SnapshotScenario = {
  baseOps: [],
  branchAOps: [{ op: "same", left: 0, right: 1 }],
  branchBOps: [{ op: "different", left: 2, right: 3 }],
  focus: {
    entity: "edge",
    index: 0,
    fork: 1,
    target: undefined,
    branchA: 2,
    branchB: 0,
  },
};

/**
 * Truth-mismatched retraction as a pinned example: the branch retracts the
 * fork's imported id while the ADVANCED target has replaced that id with
 * different truth (hard-delete/recreate + reimport). Two layers make this
 * lawful — the truth-aware identity diff stages the target's replacement, and
 * the retraction truth filter skips the mismatched retraction — and law 3's
 * truth-aware retraction exclusion fails any combined regression that reaches
 * silent deletion again. (Removing only the retraction filter degrades to a
 * TYPED false refusal, which law 1 tolerates; the deterministic guard test
 * "keeps unrelated target truth when a retraction's id was reused" pins that
 * success direction.)
 */
const RETRACTION_MISMATCH_EXAMPLE: IncrementalScenario = {
  baseOps: [
    { op: "importAssertion", idPick: 0, left: 0, right: 1, validFromPick: 0 },
  ],
  targetOps: [
    { op: "hardDeleteRecreate", node: 0 },
    { op: "importAssertion", idPick: 0, left: 2, right: 3, validFromPick: 0 },
  ],
  branchAOps: [{ op: "retract", pick: 0 }],
  branchBOps: [{ op: "same", left: 1, right: 2 }],
  focus: NO_WINDOW_FOCUS,
};

/**
 * Committed-target precedence as a pinned incremental example: the TARGET ends
 * the row itself while a branch claims an EARLIER end, which would otherwise win
 * the least-claim tie-break. The target's own end must stand and the merge must
 * report no end at all — it decided nothing, and writing the row back at itself
 * would bump a version no branch touched.
 */
const TARGET_WINDOW_PRECEDENCE_EXAMPLE: IncrementalScenario = {
  baseOps: [],
  targetOps: [],
  branchAOps: [{ op: "same", left: 2, right: 3 }],
  branchBOps: [{ op: "different", left: 0, right: 1 }],
  focus: {
    entity: "node",
    index: 1,
    fork: undefined,
    target: 2,
    branchA: 0,
    branchB: undefined,
  },
};

/** The same committed-target precedence on the EDGE population. */
const TARGET_EDGE_WINDOW_PRECEDENCE_EXAMPLE: IncrementalScenario = {
  baseOps: [],
  targetOps: [],
  branchAOps: [{ op: "same", left: 2, right: 3 }],
  branchBOps: [{ op: "different", left: 0, right: 1 }],
  focus: {
    entity: "edge",
    index: 1,
    fork: undefined,
    target: 2,
    branchA: 0,
    branchB: 1,
  },
};

/**
 * What a history actually did — refused operations are skipped, not recorded.
 * Retractions record the COMPLETE truth they ended (from the returned row),
 * so the laws can tell "this row died because its truth was retracted" from
 * "an unrelated row sharing the id died".
 */
interface AppliedHistory {
  /** Every assertion id this store can see (inherited + created), in order. */
  assertionIds: string[];
  retractedIds: Set<string>;
  retractedTruths: Set<string>;
  /** Nodes deleted OR hard-delete-replaced — either invalidates assertions
   * using them as endpoints. */
  deletedNodes: Set<string>;
}

function emptyHistory(): AppliedHistory {
  return {
    assertionIds: [],
    retractedIds: new Set(),
    retractedTruths: new Set(),
    deletedNodes: new Set(),
  };
}

/** A branch's starting history: the base's, copied (histories then diverge). */
function copyHistory(base: AppliedHistory): AppliedHistory {
  return {
    assertionIds: [...base.assertionIds],
    retractedIds: new Set(base.retractedIds),
    retractedTruths: new Set(base.retractedTruths),
    deletedNodes: new Set(base.deletedNodes),
  };
}

/**
 * A row's identity WITHOUT `validTo`: the immutable part of its truth. The
 * key a retraction records (from the ended copy, whose `validTo` is set) and
 * the key of the live row it ended must agree, so `validTo` cannot be part of
 * the comparison.
 */
function rowIdentityKey(
  row: Readonly<{
    id: string;
    relation: string;
    a: Readonly<{ kind: string; id: string }>;
    b: Readonly<{ kind: string; id: string }>;
    validFrom: string;
  }>,
): string {
  return JSON.stringify([
    row.id,
    row.relation,
    row.a.kind,
    row.a.id,
    row.b.kind,
    row.b.id,
    row.validFrom,
  ]);
}

function nodeRef(index: number): Readonly<{ kind: "Agent"; id: string }> {
  return { kind: "Agent", id: requireDefined(NODE_IDS[index]) };
}

/** {@link nodeRef}'s branded form, for the edge collection's endpoints. */
function agentRef(index: number) {
  return {
    kind: "Agent",
    id: asNodeId<typeof Agent>(requireDefined(NODE_IDS[index])),
  } as const;
}

/**
 * The id a branch-authored edge between two nodes gets. DERIVED from the
 * endpoints rather than minted, so two branches authoring the same edge stage ONE
 * identity — the collision that matters — instead of two unrelated rows.
 */
function branchEdgeId(from: number, to: number): string {
  return `branch-e${from}${to}`;
}

/**
 * The fixed universe every fork point starts from: four Agents and the three
 * inherited edges among them.
 */
async function seedUniverse(store: Store<LawGraph>): Promise<void> {
  for (const id of NODE_IDS) {
    await store.nodes.Agent.create(
      { name: id },
      { id, validFrom: "2020-01-01T00:00:00.000Z" },
    );
  }
  for (const edge of SEED_EDGES) {
    await store.edges.relatesTo.create(
      agentRef(edge.from),
      agentRef(edge.to),
      { label: SEED_EDGE_LABEL },
      { id: edge.id },
    );
  }
}

/**
 * Applies one op through the public API, skipping ONLY the expected semantic
 * refusals (a contradiction, a missing node/row) exactly as an interactive
 * caller would. Any other error class fails the run — a regression that made
 * every identity operation fail must not silently empty the histories and
 * leave the laws vacuously green.
 */
async function applyOp(
  store: Store<LawGraph>,
  op: IdentityOp,
  history: AppliedHistory,
): Promise<void> {
  try {
    switch (op.op) {
      case "same":
      case "different": {
        const endpointRows = await Promise.all(
          [op.left, op.right].map((index) => {
            const ref = nodeRef(index);
            return storeBackend(store).getNode(store.graphId, ref.kind, ref.id);
          }),
        );
        // Default operational assertions intentionally require endpoint
        // liveness at the write event, not an unbounded future-validity
        // promise. A state export cannot distinguish that legacy default from
        // an explicitly open temporal window, so keep this merge law's random
        // histories within the portable subset when an endpoint is pre-ended.
        if (endpointRows.some((row) => row?.valid_to !== undefined)) break;
        const outcome =
          op.op === "same" ?
            await store.identity.assertSame(nodeRef(op.left), nodeRef(op.right))
          : await store.identity.assertDifferent(
              nodeRef(op.left),
              nodeRef(op.right),
            );
        history.assertionIds.push(outcome.assertion.id);
        break;
      }
      case "retract": {
        if (history.assertionIds.length === 0) break;
        const id = requireDefined(
          history.assertionIds[op.pick % history.assertionIds.length],
        );
        const ended = await store.identity.retractAssertion(
          asIdentityAssertionId(id),
        );
        if (ended !== undefined) {
          history.retractedIds.add(id);
          history.retractedTruths.add(rowIdentityKey(ended));
        }
        break;
      }
      case "deleteNode": {
        const id = requireDefined(NODE_IDS[op.node]);
        await store.nodes.Agent.delete(id as never);
        history.deletedNodes.add(id);
        break;
      }
      case "endValidity": {
        const id = requireDefined(NODE_IDS[op.node]);
        await store.nodes.Agent.update(
          id as never,
          {},
          { validTo: requireDefined(VALIDITY_ENDS[op.endPick]) },
        );
        break;
      }
      case "endEdgeValidity": {
        const id = requireDefined(SEED_EDGE_IDS[op.edge]);
        await store.edges.relatesTo.update(
          asEdgeId<typeof relatesTo>(id),
          {},
          { validTo: requireDefined(VALIDITY_ENDS[op.endPick]) },
        );
        break;
      }
      case "createEdge": {
        const id = branchEdgeId(op.from, op.to);
        // A row under this id — live OR soft-deleted — makes `create` a duplicate
        // -id failure rather than an authoring act, so the op is a no-op instead
        // (the same shape as `robotPeer`'s existence check).
        if (
          (await storeBackend(store).getEdge(store.graphId, id)) !== undefined
        ) {
          break;
        }
        await store.edges.relatesTo.create(
          agentRef(op.from),
          agentRef(op.to),
          { label: BRANCH_EDGE_LABEL },
          { id },
        );
        break;
      }
      case "hardDeleteRecreate": {
        const id = requireDefined(NODE_IDS[op.node]);
        const current = await storeBackend(store).getNode(
          store.graphId,
          "Agent",
          id,
        );
        const nextValidFrom =
          current?.valid_from === undefined ?
            "2021-01-01T00:00:00.000Z"
          : new Date(
              Date.parse(current.valid_from) + 24 * 60 * 60 * 1000,
            ).toISOString();
        // The physical delete kills exactly the rows CURRENTLY touching the
        // node on THIS store — record those truths rather than exempting the
        // (recreated, live) node wholesale, which would excuse over half the
        // ledger from laws 3 and 5 for the rest of the run.
        const killed = (
          await currentLedger(store, history.assertionIds)
        ).filter((row) => row.a.id === id || row.b.id === id);
        await store.nodes.Agent.delete(id as never);
        await store.nodes.Agent.hardDelete(id as never);
        await store.nodes.Agent.create(
          { name: id },
          {
            id,
            // A distinct lower bound makes the resurrection observable from
            // snapshots; otherwise it is indistinguishable from an authored
            // validTo clear and the law would classify the wrong operation.
            validFrom: nextValidFrom,
          },
        );
        for (const row of killed) {
          history.retractedTruths.add(rowIdentityKey(row));
        }
        break;
      }
      case "robotPeer": {
        const id = requireDefined(NODE_IDS[op.node]);
        if ((await store.nodes.Robot.getById(id as never)) !== undefined) {
          break;
        }
        await store.nodes.Robot.create({ name: `${id}-peer` }, { id });
        break;
      }
      case "dropRobotPeer": {
        const id = requireDefined(NODE_IDS[op.node]);
        await store.nodes.Robot.delete(id as never);
        break;
      }
      case "importAssertion": {
        const id = requireDefined(IMPORT_ID_POOL[op.idPick]);
        const refA = nodeRef(op.left);
        const refB = nodeRef(op.right);
        const [left, right] = refA.id < refB.id ? [refA, refB] : [refB, refA];
        const outcome = await importGraph(
          store,
          {
            formatVersion: "2.0",
            exportedAt: "2024-01-01T00:00:00.000Z",
            source: { type: "external" },
            nodes: [],
            edges: [],
            identity: {
              profile: "typegraph-identity-v1",
              mode: "state",
              assertions: [
                {
                  id,
                  relation: "same",
                  a: left,
                  b: right,
                  validFrom: requireDefined(
                    IMPORT_VALID_FROMS[op.validFromPick],
                  ),
                },
              ],
            },
          },
          { onConflict: "skip" },
        );
        if (outcome.success && !history.assertionIds.includes(id)) {
          // "success" also covers silent skips (the pair already current
          // under a different id) — track the id only if the store actually
          // holds it now, or the laws would demand accounting for a belief
          // the branch never acquired.
          const written = await storeRuntime(store).identityAssertionRowsByIds([
            id,
          ]);
          if (written.has(id)) history.assertionIds.push(id);
        }
        break;
      }
    }
  } catch (error) {
    const expectedRefusal =
      error instanceof IdentityContradictionError ||
      error instanceof IdentityEndpointValidityError ||
      error instanceof NodeNotFoundError ||
      // A missing row on the edge side: the target of an ending is gone
      // (`EdgeNotFoundError`), or an endpoint an earlier op deleted
      // (`EndpointNotFoundError`) — the edge analogues of the missing-node
      // refusal an interactive caller already absorbs.
      error instanceof EdgeNotFoundError ||
      error instanceof EndpointNotFoundError;
    if (!expectedRefusal) throw error;
  }
}

type LedgerRow = Readonly<{
  id: string;
  relation: "same" | "different";
  a: Readonly<{ kind: string; id: string }>;
  b: Readonly<{ kind: string; id: string }>;
  validFrom: string;
  validTo?: string | undefined;
}>;

async function currentLedger(
  store: Store<LawGraph>,
  trackedIds: readonly string[],
): Promise<readonly LedgerRow[]> {
  if (trackedIds.length === 0) return [];
  const rows = await storeRuntime(store).identityAssertionRowsByIds(trackedIds);
  return [...rows.values()].filter((row) => row.validTo === undefined);
}

/**
 * A row's END-OF-VALIDITY as a canonical instant, for every row of one population
 * the store holds LIVE. An id ABSENT from the map has no live row (deleted or
 * gone); an id present with `undefined` has a live row with an open window — the
 * two cases are distinguished by `.has()`, and the laws depend on the difference.
 *
 * Read straight off the row: the window is exactly what the collection API's
 * temporal filter reads, and only `validTo` is decided by the merge (a live
 * row's lower bound is immutable outside resurrection).
 */
type WindowEnds = ReadonlyMap<string, string | undefined>;

async function nodeWindows(store: Store<LawGraph>): Promise<WindowEnds> {
  const ends = new Map<string, string | undefined>();
  for (const id of NODE_IDS) {
    const row = await storeBackend(store).getNode(store.graphId, "Agent", id);
    if (row === undefined || row.deleted_at !== undefined) continue;
    ends.set(id, canonicalizeDatabaseTimestamp(row.valid_to));
  }
  return ends;
}

async function edgeWindows(store: Store<LawGraph>): Promise<WindowEnds> {
  const ends = new Map<string, string | undefined>();
  for (const id of SEED_EDGE_IDS) {
    const row = await storeBackend(store).getEdge(store.graphId, id);
    if (row === undefined || row.deleted_at !== undefined) continue;
    ends.set(id, canonicalizeDatabaseTimestamp(row.valid_to));
  }
  return ends;
}

/** Both populations' windows for one store, read together. */
type EntityWindows = Readonly<{ node: WindowEnds; edge: WindowEnds }>;

async function entityWindows(store: Store<LawGraph>): Promise<EntityWindows> {
  return { node: await nodeWindows(store), edge: await edgeWindows(store) };
}

/**
 * Canonical ISO 8601 UTC is fixed-width, so lexicographic order IS chronological
 * order — the same property the merge's own `earliestEnd` relies on, which is
 * what keeps the expected choice identical on SQLite and PostgreSQL despite
 * their different raw timestamp text. Also orders branch ids for `claimedBy`.
 */
function compareStrings(left: string, right: string): number {
  return (
    left < right ? -1
    : left > right ? 1
    : 0
  );
}

/** One entity population the window laws quantify over. */
type WindowPopulation = Readonly<{
  entity: "edge" | "node";
  kind: string;
  /** The INHERITED ids of this population — the rows a window claim can reach. */
  ids: readonly string[];
  read: (store: Store<LawGraph>) => Promise<WindowEnds>;
  /** Is the row readable as CURRENT as of an instant? */
  readableAsOf: (
    store: Store<LawGraph>,
    id: string,
    asOf: string,
  ) => Promise<boolean>;
}>;

const WINDOW_POPULATIONS: readonly WindowPopulation[] = [
  {
    entity: "node",
    kind: "Agent",
    ids: NODE_IDS,
    read: (store) => nodeWindows(store),
    readableAsOf: async (store, id, asOf) =>
      (await store.nodes.Agent.getById(asNodeId<typeof Agent>(id), {
        temporalMode: "asOf",
        asOf,
      })) !== undefined,
  },
  {
    entity: "edge",
    kind: "relatesTo",
    ids: SEED_EDGE_IDS,
    read: (store) => edgeWindows(store),
    readableAsOf: async (store, id, asOf) =>
      (await store.edges.relatesTo.getById(asEdgeId<typeof relatesTo>(id), {
        temporalMode: "asOf",
        asOf,
      })) !== undefined,
  },
];

/**
 * Law 6 over BOTH inherited populations: the full least-claim rule, stated as a
 * property rather than as the single-claim slice the deterministic suite's cases
 * happen to enumerate.
 *
 * A branch can stop a row from being true by ending its validity instead of
 * deleting it, and the merge used to discard that statement silently — so the
 * valid-time analogues of laws 3 and 5 are:
 *
 *   - NO UNASKED SHORTENING: when NO branch claimed an end, the target's window
 *     is exactly the one it already held, and the report names no end.
 *   - COMMITTED-TARGET PRECEDENCE: when the incremental target moved the end
 *     ITSELF, its own end stands over every branch claim — and the discarded
 *     claims are reported against the target's own instant, marked
 *     `precedence: "target"` so nothing reads as an end the merge decided.
 *   - LEAST CLAIM, NO SILENT LOSS: otherwise the EARLIEST branch claim is what
 *     the merge commits — including a lone claim that EXTENDS the ancestor's end
 *     to a later instant — and it is reported with every claiming branch named.
 *   - NO RESURRECTION: a row the merge ended is not readable AS OF its own end
 *     instant — an ending that does not end anything is not an ending.
 *
 * @param baseWindows The FORK POINT's windows, read before the merge — the
 *   shared ancestor every claim is measured against.
 * @param preMergeWindows The TARGET's windows, read before the merge. Identical
 *   to `baseWindows` on the snapshot lane, where the target IS the fork point,
 *   so the committed-target arm is unreachable there by construction.
 */
async function expectLawfulWindows(args: {
  target: Store<LawGraph>;
  report: MergeReport<LawGraph>;
  branches: readonly Readonly<{ id: BranchId; store: Store<LawGraph> }>[];
  baseWindows: EntityWindows;
  preMergeWindows: EntityWindows;
}): Promise<void> {
  const { target, report, branches, baseWindows, preMergeWindows } = args;

  for (const population of WINDOW_POPULATIONS) {
    const postWindows = await population.read(target);
    const baseEnds = baseWindows[population.entity];
    const targetEnds = preMergeWindows[population.entity];
    const branchEnds = await Promise.all(
      branches.map(async (entry) => ({
        id: entry.id,
        ends: await population.read(entry.store),
      })),
    );

    for (const id of population.ids) {
      if (!postWindows.has(id)) continue; // finally deleted — no window to judge
      const label = `${population.entity} ${id}`;
      const postEnd = postWindows.get(id);
      const baseEnd = baseEnds.get(id);
      const targetEnd = targetEnds.get(id);
      // A CLAIM is an end that differs from the ancestor's. A side that cleared
      // the end (only reachable by delete + resurrect) claims nothing: the update
      // SQL cannot clear `valid_to` on a live row, so that delta is unapplicable.
      const claimants = branchEnds.filter((entry) => {
        const end = entry.ends.get(id);
        return end !== undefined && end !== baseEnd;
      });
      const claims = [
        ...new Set(
          claimants.map((entry) => requireDefined(entry.ends.get(id))),
        ),
      ].sort((left, right) => compareStrings(left, right));
      // The COMMITTED TARGET's own end is not a claim staged against it: its row
      // IS the destination, so a target that moved this end takes the row out of
      // the resolution entirely rather than being resolved to.
      const targetMovedEnd = targetEnd !== undefined && targetEnd !== baseEnd;
      const heldLiveEverywhere = [
        ...branchEnds.map((entry) => entry.ends),
        targetEnds,
      ].every((ends) => ends.has(id));
      const reported = report.validityEnds.find(
        (entry) =>
          entry.entity === population.entity &&
          entry.kind === population.kind &&
          entry.id === id,
      );

      if (claims.length === 0) {
        expect(
          postEnd,
          `${label}: the merge moved a window no branch ended`,
        ).toBe(targetEnd);
        expect(
          reported,
          `${label}: reported an end no branch claimed`,
        ).toBeUndefined();
      } else if (heldLiveEverywhere && targetMovedEnd) {
        expect(
          postEnd,
          `${label}: a branch re-windowed an end the committed target itself moved`,
        ).toBe(targetEnd);
        // Target precedence DISCARDS every claim, and a discarded claim is still
        // reported (issue #409): the least-claim loser is visible in `claimedBy`, so
        // a claim thrown away wholesale must not be less visible than one that was
        // merely out-arbitrated. The entry names the TARGET's own instant and carries
        // the discriminator, so it can never be read as an end the merge wrote.
        expect(
          reported,
          `${label}: the discarded claims were not reported faithfully`,
        ).toEqual({
          entity: population.entity,
          kind: population.kind,
          id,
          validTo: targetEnd,
          claimedBy: claimants
            .map((entry) => entry.id as string)
            .toSorted((left, right) => compareStrings(left, right)),
          precedence: VALIDITY_END_TARGET_PRECEDENCE,
        });
      } else if (heldLiveEverywhere) {
        const earliest = requireDefined(claims[0]);
        expect(
          postEnd,
          `${label}: the least claimed end of ${claims.join(", ")} was not committed`,
        ).toBe(earliest);
        expect(
          reported,
          `${label}: the committed end was not reported faithfully`,
        ).toEqual({
          entity: population.entity,
          kind: population.kind,
          id,
          validTo: earliest,
          claimedBy: claimants
            .map((entry) => entry.id as string)
            .toSorted((left, right) => compareStrings(left, right)),
        });
      }
      if (postEnd !== undefined) {
        expect(
          await population.readableAsOf(target, id, postEnd),
          `${label}: readable as current as of its own end instant`,
        ).toBe(false);
      }
    }
  }
}

/** Law 2: no `different` whose endpoints the `same` rows transitively join. */
function expectConsistentLedger(rows: readonly LedgerRow[]): void {
  const parent = new Map<string, string>();
  function find(key: string): string {
    const up = parent.get(key) ?? key;
    if (up === key) return key;
    const root = find(up);
    parent.set(key, root);
    return root;
  }
  for (const row of rows) {
    if (row.relation !== "same") continue;
    parent.set(
      find(`${row.a.kind}|${row.a.id}`),
      find(`${row.b.kind}|${row.b.id}`),
    );
  }
  for (const row of rows) {
    if (row.relation !== "different") continue;
    expect(
      find(`${row.a.kind}|${row.a.id}`),
      `different(${row.a.id}, ${row.b.id}) inside one same-class`,
    ).not.toBe(find(`${row.b.kind}|${row.b.id}`));
  }
}

/** Law 1: refusals are TYPED — never the generic wrapper. */
function expectTypedRefusal(error: Error): void {
  expect(
    error instanceof IdentityMergeConflictError ||
      error instanceof BaseVersionMismatchError,
    `expected a typed identity refusal, got ${error.constructor.name}: ${error.message}`,
  ).toBe(true);
}

/** Laws 2–5 over a SUCCESSFUL merge's outcome. */
async function expectLawfulOutcome(args: {
  target: Store<LawGraph>;
  report: MergeReport<LawGraph>;
  preMerge: readonly LedgerRow[];
  branchStores: readonly Store<LawGraph>[];
  histories: readonly AppliedHistory[];
  trackedIds: readonly string[];
}): Promise<void> {
  const { target, report, preMerge, branchStores, histories, trackedIds } =
    args;
  const postMerge = await currentLedger(target, trackedIds);
  // Law 2: the committed ledger is internally consistent.
  expectConsistentLedger(postMerge);

  const postMergeIds = new Set(postMerge.map((row) => row.id));
  // Law 4 (report coherence): an id reported dropped as a DUPLICATE was not
  // applied and must not be current post-merge at all — committed target
  // rows always win the survivor pick, so a "dropped" id that remains
  // current is a self-contradictory report.
  for (const droppedItem of report.dropped) {
    if (
      droppedItem.kind !== "identity" ||
      droppedItem.reason !== DUPLICATE_IDENTITY_ASSERTION_DROP_REASON
    ) {
      continue;
    }
    expect(
      postMergeIds.has(droppedItem.id),
      `id ${droppedItem.id} reported dropped as duplicate yet current post-merge`,
    ).toBe(false);
  }

  // "This row's death is excused": some history retracted THAT COMPLETE
  // truth (id-level matches over different truth do NOT excuse it), or some
  // history deleted/replaced one of its endpoints.
  const invalidated = (row: LedgerRow): boolean =>
    histories.some(
      (history) =>
        history.retractedTruths.has(rowIdentityKey(row)) ||
        history.deletedNodes.has(row.a.id) ||
        history.deletedNodes.has(row.b.id),
    );

  // Law 3: no pre-merge target truth ended without a matching invalidation.
  for (const row of preMerge) {
    if (invalidated(row)) continue;
    expect(
      postMergeIds.has(row.id),
      `pre-merge assertion ${row.id} (${row.relation}(${row.a.id}, ${row.b.id})) ended without a truth-matching retraction or endpoint invalidation`,
    ).toBe(true);
  }

  // Law 5: every truth a branch holds is accounted for — applied with equal
  // complete truth, enumerated as dropped, retracted, or invalidated.
  const droppedIds = new Set(report.dropped.map((item) => item.id));
  const postById = new Map(postMerge.map((row) => [row.id, row] as const));
  for (const branchStore of branchStores) {
    const branchLedger = await currentLedger(branchStore, trackedIds);
    for (const row of branchLedger) {
      const applied =
        postById.get(row.id) !== undefined &&
        assertionTruthKey(requireDefined(postById.get(row.id))) ===
          assertionTruthKey(row);
      expect(
        applied ||
          droppedIds.has(row.id) ||
          histories.some((history) => history.retractedIds.has(row.id)) ||
          invalidated(row),
        `branch truth ${row.id} (${row.relation}(${row.a.id}, ${row.b.id})) vanished: not applied, not dropped, not retracted, endpoints intact`,
      ).toBe(true);
    }
  }
}

// Per-fixture backends (no shared PGlite engine): the shared engine renames
// only the CORE table set, so an identity-enabled graph would provision its
// assertion/closure tables under the default names once per engine — leaking
// ledger rows across property iterations.
describe.each(backendMatrix())("identity merge laws [$name]", (entry) => {
  type Fixture = Readonly<{
    forkPoint: Store<LawGraph>;
    branchA: Awaited<ReturnType<typeof makeBranches>>["branchA"];
    branchB: Awaited<ReturnType<typeof makeBranches>>["branchB"];
    histories: Map<Store<LawGraph>, AppliedHistory>;
    trackedIds: readonly string[];
  }>;

  async function makeBranches(
    forkPoint: Store<LawGraph>,
    makeBackend: () => Promise<GraphBackend>,
  ) {
    const branchA = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
    );
    return { branchA, branchB };
  }

  async function materialize(
    graph: LawGraph,
    scenario: SnapshotScenario,
    makeBackend: () => Promise<GraphBackend>,
  ): Promise<Fixture> {
    const [forkPoint] = await createStoreWithSchema(graph, await makeBackend());
    await seedUniverse(forkPoint);
    const baseHistory = emptyHistory();
    for (const op of [
      ...scenario.baseOps,
      ...focusOps(scenario.focus, scenario.focus.fork),
    ]) {
      await applyOp(forkPoint, op, baseHistory);
    }
    const { branchA, branchB } = await makeBranches(forkPoint, makeBackend);
    const histories = new Map<Store<LawGraph>, AppliedHistory>([
      [branchA.store, copyHistory(baseHistory)],
      [branchB.store, copyHistory(baseHistory)],
    ]);
    for (const op of [
      ...scenario.branchAOps,
      ...focusOps(scenario.focus, scenario.focus.branchA),
    ]) {
      await applyOp(
        branchA.store,
        op,
        requireDefined(histories.get(branchA.store)),
      );
    }
    for (const op of [
      ...scenario.branchBOps,
      ...focusOps(scenario.focus, scenario.focus.branchB),
    ]) {
      await applyOp(
        branchB.store,
        op,
        requireDefined(histories.get(branchB.store)),
      );
    }
    const trackedIds = [
      ...new Set(
        [...histories.values()].flatMap((history) => history.assertionIds),
      ),
    ];
    return { forkPoint, branchA, branchB, histories, trackedIds };
  }

  const SNAPSHOT_LANES = [
    {
      name: "ignore",
      graph: defineLawGraph("identity-law-ignore", "ignore"),
      ops: opArb([HARD_DELETE_OP, EDGE_CREATE_OP]),
    },
    {
      name: "fold",
      graph: defineLawGraph("identity-law-fold", "fold"),
      ops: opArb([HARD_DELETE_OP, EDGE_CREATE_OP, ...ROBOT_OPS]),
    },
  ] as const;

  for (const lane of SNAPSHOT_LANES) {
    it(`merges random ${lane.name}-profile histories lawfully`, async () => {
      await fc.assert(
        fc.asyncProperty(snapshotScenarioArb(lane.ops), async (scenario) => {
          const cleanups: (() => Promise<void>)[] = [];
          async function makeBackend(): Promise<GraphBackend> {
            const fixture = await entry.make();
            cleanups.push(fixture.cleanup);
            return fixture.backend;
          }
          try {
            const fixture = await materialize(
              lane.graph,
              scenario,
              makeBackend,
            );
            const preMerge = await currentLedger(
              fixture.forkPoint,
              fixture.trackedIds,
            );
            // The snapshot target IS the fork point, so one read serves as both
            // the ancestor and the pre-merge target state.
            const baseWindows = await entityWindows(fixture.forkPoint);
            const result = await merge(
              fixture.forkPoint,
              [fixture.branchA, fixture.branchB],
              { branchOrder: [BRANCH_A, BRANCH_B] },
            );
            if (isErr(result)) {
              expectTypedRefusal(result.error);
              return;
            }
            await expectLawfulOutcome({
              target: fixture.forkPoint,
              report: result.data,
              preMerge,
              branchStores: [fixture.branchA.store, fixture.branchB.store],
              histories: [...fixture.histories.values()],
              trackedIds: fixture.trackedIds,
            });
            await expectLawfulWindows({
              target: fixture.forkPoint,
              report: result.data,
              branches: [
                { id: BRANCH_A, store: fixture.branchA.store },
                { id: BRANCH_B, store: fixture.branchB.store },
              ],
              baseWindows,
              preMergeWindows: baseWindows,
            });
          } finally {
            for (const cleanup of cleanups.reverse()) await cleanup();
          }
        }),
        {
          examples: [
            [VALIDITY_COLLISION_EXAMPLE],
            [TRUTH_REPLACEMENT_EXAMPLE],
            [REPEATED_RESURRECTION_WINDOW_EXAMPLE],
            [NODE_END_TIE_BREAK_EXAMPLE],
            [EDGE_END_TIE_BREAK_EXAMPLE],
          ],
          numRuns: LAW_RUNS,
        },
      );
      // Coverage-instrumented CI shards run each PGlite boot several times
      // slower than a bare run; the default 60s test timeout is not sized
      // for LAW_RUNS × per-iteration store fixtures (same allowance as
      // merge-laws.test.ts).
    }, 300_000);
  }

  it("merges random target-advanced incremental histories lawfully", async () => {
    const graph = defineLawGraph("identity-law-incremental", "ignore");
    await fc.assert(
      fc.asyncProperty(incrementalScenarioArb, async (scenario) => {
        const cleanups: (() => Promise<void>)[] = [];
        async function makeBackend(): Promise<GraphBackend> {
          const fixture = await entry.make();
          cleanups.push(fixture.cleanup);
          return fixture.backend;
        }
        try {
          const [forkPoint] = await createStoreWithSchema(
            graph,
            await makeBackend(),
          );
          await seedUniverse(forkPoint);
          const baseHistory = emptyHistory();
          for (const op of [
            ...scenario.baseOps,
            ...focusOps(scenario.focus, scenario.focus.fork),
          ]) {
            await applyOp(forkPoint, op, baseHistory);
          }
          // The target CLONES the fork point, then advances independently —
          // the regime where a branch's ids and retractions meet target
          // truth the branch never saw.
          const target = unwrap(
            await branch(forkPoint, () => makeBackend(), {
              id: TARGET_CLONE,
            }),
          ).store;
          const targetHistory = copyHistory(baseHistory);
          for (const op of [
            ...scenario.targetOps,
            ...focusOps(scenario.focus, scenario.focus.target),
          ]) {
            await applyOp(target, op, targetHistory);
          }
          const { branchA, branchB } = await makeBranches(
            forkPoint,
            makeBackend,
          );
          const branchAHistory = copyHistory(baseHistory);
          const branchBHistory = copyHistory(baseHistory);
          for (const op of [
            ...scenario.branchAOps,
            ...focusOps(scenario.focus, scenario.focus.branchA),
          ]) {
            await applyOp(branchA.store, op, branchAHistory);
          }
          for (const op of [
            ...scenario.branchBOps,
            ...focusOps(scenario.focus, scenario.focus.branchB),
          ]) {
            await applyOp(branchB.store, op, branchBHistory);
          }
          const histories = [branchAHistory, branchBHistory, targetHistory];
          const trackedIds = [
            ...new Set(histories.flatMap((history) => history.assertionIds)),
          ];
          const preMerge = await currentLedger(target, trackedIds);
          const baseWindows = await entityWindows(forkPoint);
          const preMergeWindows = await entityWindows(target);

          const result = await mergeIncremental({
            forkPoint,
            target,
            branches: [branchA, branchB],
            options: { branchOrder: [BRANCH_A, BRANCH_B] },
          });
          if (isErr(result)) {
            expectTypedRefusal(result.error);
            return;
          }
          await expectLawfulOutcome({
            target,
            report: result.data,
            preMerge,
            branchStores: [branchA.store, branchB.store],
            histories,
            trackedIds,
          });
          await expectLawfulWindows({
            target,
            report: result.data,
            branches: [
              { id: BRANCH_A, store: branchA.store },
              { id: BRANCH_B, store: branchB.store },
            ],
            baseWindows,
            preMergeWindows,
          });
        } finally {
          for (const cleanup of cleanups.reverse()) await cleanup();
        }
      }),
      {
        examples: [
          [RETRACTION_MISMATCH_EXAMPLE],
          [TARGET_WINDOW_PRECEDENCE_EXAMPLE],
          [TARGET_EDGE_WINDOW_PRECEDENCE_EXAMPLE],
        ],
        numRuns: LAW_RUNS,
      },
    );
  }, 300_000);
});
