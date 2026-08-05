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
 *      branch can also stop a NODE from being true by ending its validity
 *      rather than deleting it (issue #369): an end exactly one side
 *      claimed is applied; a window nobody ended is left alone; and a row
 *      the merge ended is not readable as of its own end instant.
 *
 * Scenarios are identity histories (assert same/different, retract, delete a
 * node, END A NODE'S VALIDITY, hard-delete + recreate a node, import an
 * assertion under a CHOSEN id) over a fixed four-node universe, applied through
 * the public store API with only the expected semantic refusals skipped.
 * Chosen-id imports matter: they
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
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  IdentityContradictionError,
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
import type { MergeReport } from "../../../src/graph-merge/types";
import { asBranchId } from "../../../src/graph-merge/types";
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

function defineLawGraph(id: string, profile: "fold" | "ignore") {
  return defineGraph({
    id,
    nodes: { Agent: { type: Agent }, Robot: { type: Robot } },
    edges: {},
    identity: { sameIdAcrossKinds: profile },
  });
}

type LawGraph = ReturnType<typeof defineLawGraph>;

const NODE_IDS = ["n1", "n2", "n3", "n4"] as const;
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
 * End instants for `endValidity`, both in the FUTURE: a row's `validFrom`
 * defaults to its creation instant and the store refuses an inverted window, so
 * a past end is not authorable at all. Two distinct values so branches can
 * disagree and exercise the least-claim tie-break.
 */
const VALIDITY_ENDS = [
  "2100-01-01T00:00:00.000Z",
  "2100-06-01T00:00:00.000Z",
] as const;
const IMPORT_VALID_FROMS = [
  "2024-01-01T00:00:00.000Z",
  "2024-02-01T00:00:00.000Z",
] as const;

const nodeIndexArb = fc.integer({ min: 0, max: NODE_IDS.length - 1 });
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
      .tuple(nodeIndexArb, fc.nat({ max: VALIDITY_ENDS.length - 1 }))
      .map(
        ([node, endPick]) => ({ op: "endValidity", node, endPick }) as const,
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

type SnapshotScenario = Readonly<{
  baseOps: readonly IdentityOp[];
  branchAOps: readonly IdentityOp[];
  branchBOps: readonly IdentityOp[];
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
  baseOps: fc.array(opArb([]), { maxLength: 2 }),
  targetOps: fc.array(opArb([HARD_DELETE_OP]), { maxLength: 2 }),
  branchAOps: fc.array(opArb([]), { minLength: 1, maxLength: 3 }),
  branchBOps: fc.array(opArb([]), { minLength: 1, maxLength: 3 }),
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
      case "hardDeleteRecreate": {
        const id = requireDefined(NODE_IDS[op.node]);
        // The physical delete kills exactly the rows CURRENTLY touching the
        // node on THIS store — record those truths rather than exempting the
        // (recreated, live) node wholesale, which would excuse over half the
        // ledger from laws 3 and 5 for the rest of the run.
        const killed = (
          await currentLedger(store, history.assertionIds)
        ).filter((row) => row.a.id === id || row.b.id === id);
        await store.nodes.Agent.delete(id as never);
        await store.nodes.Agent.hardDelete(id as never);
        await store.nodes.Agent.create({ name: id }, { id });
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
      error instanceof NodeNotFoundError;
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
 * A node's END-OF-VALIDITY as a canonical instant, for every node the store
 * holds LIVE. An id ABSENT from the map has no live row (deleted or gone); an id
 * present with `undefined` has a live row with an open window — the two cases
 * are distinguished by `.has()`, and the laws depend on the difference.
 *
 * Read straight off the row: the window is exactly what the collection API's
 * temporal filter reads, and only `validTo` is decided by the merge (a live
 * row's lower bound is immutable outside resurrection).
 */
type NodeEnds = ReadonlyMap<string, string | undefined>;

async function nodeWindows(store: Store<LawGraph>): Promise<NodeEnds> {
  const ends = new Map<string, string | undefined>();
  for (const id of NODE_IDS) {
    const row = await storeBackend(store).getNode(store.graphId, "Agent", id);
    if (row === undefined || row.deleted_at !== undefined) continue;
    ends.set(id, canonicalizeDatabaseTimestamp(row.valid_to));
  }
  return ends;
}

/**
 * Law 6, in three parts, over the INHERITED node population.
 *
 * A branch can stop a node from being true by ending its validity instead of
 * deleting it, and the merge used to discard that statement silently — so the
 * valid-time analogues of laws 3 and 5 are stated here:
 *
 *   - NO SILENT LOSS: when exactly ONE end is claimed for a row that every
 *     side still holds live, that end is what the merge commits. (Several
 *     differing claims are arbitrated by a least-claim rule, so they are not a
 *     single expected value and are excluded.)
 *   - NO UNASKED SHORTENING: when NO side claimed an end, the target's window
 *     is exactly the one it already held.
 *   - NO RESURRECTION: a row the merge ended is not readable AS OF its own end
 *     instant — an ending that does not end anything is not an ending.
 *
 * @param baseWindows The FORK POINT's windows, read before the merge — the
 *   shared ancestor every claim is measured against.
 * @param preMergeWindows The TARGET's windows, read before the merge. Identical
 *   to `baseWindows` on the snapshot lane, where the target IS the fork point.
 */
async function expectLawfulWindows(args: {
  target: Store<LawGraph>;
  branchStores: readonly Store<LawGraph>[];
  baseWindows: NodeEnds;
  preMergeWindows: NodeEnds;
}): Promise<void> {
  const { target, branchStores, baseWindows, preMergeWindows } = args;
  const postWindows = await nodeWindows(target);
  const contributors = [
    ...(await Promise.all(branchStores.map((store) => nodeWindows(store)))),
    preMergeWindows,
  ];

  for (const id of NODE_IDS) {
    if (!postWindows.has(id)) continue; // finally deleted — no window to judge
    const postEnd = postWindows.get(id);
    const baseEnd = baseWindows.get(id);
    const heldLiveEverywhere = contributors.every((ends) => ends.has(id));
    // A CLAIM is an end that differs from the ancestor's. A side that cleared
    // the end (only reachable by delete + resurrect) claims nothing: the update
    // SQL cannot clear `valid_to` on a live row, so that delta is unapplicable.
    const claims = new Set(
      contributors
        .map((ends) => ends.get(id))
        .filter(
          (validTo): validTo is string =>
            validTo !== undefined && validTo !== baseEnd,
        ),
    );

    if (heldLiveEverywhere && claims.size === 1) {
      expect(
        postEnd,
        `node ${id}: the single claimed end was not committed`,
      ).toBe(requireDefined([...claims][0]));
    }
    if (claims.size === 0) {
      expect(
        postEnd,
        `node ${id}: the merge moved a window no side ended`,
      ).toBe(preMergeWindows.get(id));
    }
    if (postEnd !== undefined) {
      expect(
        await target.nodes.Agent.getById(id as never, {
          temporalMode: "asOf",
          asOf: postEnd,
        }),
        `node ${id}: readable as current as of its own end instant`,
      ).toBeUndefined();
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
    for (const id of NODE_IDS) {
      await forkPoint.nodes.Agent.create({ name: id }, { id });
    }
    const baseHistory = emptyHistory();
    for (const op of scenario.baseOps) {
      await applyOp(forkPoint, op, baseHistory);
    }
    const { branchA, branchB } = await makeBranches(forkPoint, makeBackend);
    const histories = new Map<Store<LawGraph>, AppliedHistory>([
      [branchA.store, copyHistory(baseHistory)],
      [branchB.store, copyHistory(baseHistory)],
    ]);
    for (const op of scenario.branchAOps) {
      await applyOp(
        branchA.store,
        op,
        requireDefined(histories.get(branchA.store)),
      );
    }
    for (const op of scenario.branchBOps) {
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
      ops: opArb([HARD_DELETE_OP]),
    },
    {
      name: "fold",
      graph: defineLawGraph("identity-law-fold", "fold"),
      ops: opArb([HARD_DELETE_OP, ...ROBOT_OPS]),
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
            const baseWindows = await nodeWindows(fixture.forkPoint);
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
              branchStores: [fixture.branchA.store, fixture.branchB.store],
              baseWindows,
              preMergeWindows: baseWindows,
            });
          } finally {
            for (const cleanup of cleanups.reverse()) await cleanup();
          }
        }),
        {
          examples: [[VALIDITY_COLLISION_EXAMPLE], [TRUTH_REPLACEMENT_EXAMPLE]],
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
          for (const id of NODE_IDS) {
            await forkPoint.nodes.Agent.create({ name: id }, { id });
          }
          const baseHistory = emptyHistory();
          for (const op of scenario.baseOps) {
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
          for (const op of scenario.targetOps) {
            await applyOp(target, op, targetHistory);
          }
          const { branchA, branchB } = await makeBranches(
            forkPoint,
            makeBackend,
          );
          const branchAHistory = copyHistory(baseHistory);
          const branchBHistory = copyHistory(baseHistory);
          for (const op of scenario.branchAOps) {
            await applyOp(branchA.store, op, branchAHistory);
          }
          for (const op of scenario.branchBOps) {
            await applyOp(branchB.store, op, branchBHistory);
          }
          const histories = [branchAHistory, branchBHistory, targetHistory];
          const trackedIds = [
            ...new Set(histories.flatMap((history) => history.assertionIds)),
          ];
          const preMerge = await currentLedger(target, trackedIds);
          const baseWindows = await nodeWindows(forkPoint);
          const preMergeWindows = await nodeWindows(target);

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
            branchStores: [branchA.store, branchB.store],
            baseWindows,
            preMergeWindows,
          });
        } finally {
          for (const cleanup of cleanups.reverse()) await cleanup();
        }
      }),
      { examples: [[RETRACTION_MISMATCH_EXAMPLE]], numRuns: LAW_RUNS },
    );
  }, 300_000);
});
