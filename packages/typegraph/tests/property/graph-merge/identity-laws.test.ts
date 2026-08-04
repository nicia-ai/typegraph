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
 *      `BaseVersionMismatchError` (the target moved — impossible here, but
 *      permitted by the law) with an actionable message.
 *   2. LEDGER-CONSISTENCY   A merge that SUCCEEDS commits a non-contradictory
 *      ledger: no `different(a, b)` whose endpoints the current `same`
 *      assertions transitively connect.
 *   3. TRUTH-PRESERVATION   A successful merge never ends a target assertion
 *      no branch invalidated: every pre-merge current row survives unless a
 *      branch retracted that id or deleted/replaced one of its endpoints.
 *   4. REPORT-COHERENCE    An id the report lists as dropped-as-duplicate was
 *      not applied — it never BECOMES current in the same merge.
 *   5. BRANCH-EFFECT       Every truth a branch holds at merge time is
 *      accounted for on a successful merge: applied with equal complete
 *      truth, enumerated as dropped, retracted by some branch, or
 *      invalidated by an endpoint deletion/replacement. Silent loss of a
 *      branch's belief is a law violation, not a quiet no-op.
 *
 * Scenarios are identity histories (assert same/different, retract, delete a
 * node, hard-delete + recreate a node, import an assertion under a CHOSEN id)
 * over a fixed four-node universe on both branches, applied through the
 * public store API with only the expected semantic refusals skipped. Chosen-id
 * imports matter: they are the only way two independent lineages mint the
 * SAME assertion id — the collision class every hand-built review repro lived
 * in. Hard-delete/recreate matters for the same reason within ONE lineage: it
 * physically removes assertion rows, making same-id truth replacement legal
 * on a branch. Both profiles run: `"ignore"` (assertion-only) and `"fold"`
 * (with same-id Robot peers joining and leaving Agent fold classes).
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
import { merge } from "../../../src/graph-merge/merge";
import {
  assertionTruthKey,
  DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
} from "../../../src/graph-merge/merge-identity";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { asIdentityAssertionId } from "../../../src/identity/types";
import { importGraph } from "../../../src/interchange";
import { storeRuntime } from "../../../src/store/runtime-port";
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

const LAW_LANES = [
  {
    name: "ignore",
    graph: defineLawGraph("identity-law-ignore", "ignore"),
    includeRobotOps: false,
  },
  {
    name: "fold",
    graph: defineLawGraph("identity-law-fold", "fold"),
    includeRobotOps: true,
  },
] as const;

const NODE_IDS = ["n1", "n2", "n3", "n4"] as const;
const BRANCH_A = asBranchId("identity-law-a");
const BRANCH_B = asBranchId("identity-law-b");

/**
 * fast-check iterations PER LANE. Each iteration builds a fork point plus two
 * branch stores and runs one merge; CI keeps a smaller budget, mirroring the
 * other merge property files.
 */
const LAW_RUNS = process.env["CI"] ? 5 : 10;

type IdentityOp =
  | Readonly<{ op: "same"; left: number; right: number }>
  | Readonly<{ op: "different"; left: number; right: number }>
  | Readonly<{ op: "retract"; pick: number }>
  | Readonly<{ op: "deleteNode"; node: number }>
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
const IMPORT_VALID_FROMS = [
  "2024-01-01T00:00:00.000Z",
  "2024-02-01T00:00:00.000Z",
] as const;

type IdentityLawScenario = Readonly<{
  baseOps: readonly IdentityOp[];
  branchAOps: readonly IdentityOp[];
  branchBOps: readonly IdentityOp[];
}>;

const nodeIndexArb = fc.integer({ min: 0, max: NODE_IDS.length - 1 });
const pairArb = fc
  .tuple(nodeIndexArb, nodeIndexArb)
  .filter(([left, right]) => left !== right);

function opArbFor(includeRobotOps: boolean): fc.Arbitrary<IdentityOp> {
  const weighted: { weight: number; arbitrary: fc.Arbitrary<IdentityOp> }[] = [
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
      weight: 1,
      arbitrary: nodeIndexArb.map(
        (node) => ({ op: "hardDeleteRecreate", node }) as const,
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
  if (includeRobotOps) {
    weighted.push(
      {
        weight: 1,
        arbitrary: nodeIndexArb.map(
          (node) => ({ op: "robotPeer", node }) as const,
        ),
      },
      {
        weight: 1,
        arbitrary: nodeIndexArb.map(
          (node) => ({ op: "dropRobotPeer", node }) as const,
        ),
      },
    );
  }
  return fc.oneof(...weighted);
}

/**
 * The validity-only collision as a pinned example: both branches import ONE id
 * for the SAME pair with different validFrom values. The semantic survivor
 * dedupe used to collapse the two silently — merge succeeded while the report
 * listed the surviving id as dropped (law 4).
 */
const VALIDITY_COLLISION_EXAMPLE: IdentityLawScenario = {
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
const TRUTH_REPLACEMENT_EXAMPLE: IdentityLawScenario = {
  baseOps: [
    { op: "importAssertion", idPick: 0, left: 0, right: 1, validFromPick: 0 },
  ],
  branchAOps: [
    { op: "hardDeleteRecreate", node: 0 },
    { op: "importAssertion", idPick: 0, left: 2, right: 3, validFromPick: 0 },
  ],
  branchBOps: [{ op: "same", left: 2, right: 3 }],
};

function scenarioArbFor(
  includeRobotOps: boolean,
): fc.Arbitrary<IdentityLawScenario> {
  const opArb = opArbFor(includeRobotOps);
  return fc.record({
    baseOps: fc.array(opArb, { maxLength: 2 }),
    branchAOps: fc.array(opArb, { minLength: 1, maxLength: 3 }),
    branchBOps: fc.array(opArb, { minLength: 1, maxLength: 3 }),
  });
}

/** What a history actually did — refused operations are skipped, not recorded. */
interface AppliedHistory {
  /** Every assertion id this store can see (inherited + created), in order. */
  assertionIds: string[];
  retractedIds: Set<string>;
  /** Nodes a branch deleted OR hard-delete-replaced — either invalidates
   * assertions using them as endpoints. */
  deletedNodes: Set<string>;
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
        await store.identity.retractAssertion(asIdentityAssertionId(id));
        history.retractedIds.add(id);
        break;
      }
      case "deleteNode": {
        const id = requireDefined(NODE_IDS[op.node]);
        await store.nodes.Agent.delete(id as never);
        history.deletedNodes.add(id);
        break;
      }
      case "hardDeleteRecreate": {
        const id = requireDefined(NODE_IDS[op.node]);
        await store.nodes.Agent.delete(id as never);
        await store.nodes.Agent.hardDelete(id as never);
        await store.nodes.Agent.create({ name: id }, { id });
        history.deletedNodes.add(id);
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
          history.assertionIds.push(id);
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

// Per-fixture backends (no shared PGlite engine): the shared engine renames
// only the CORE table set, so an identity-enabled graph would provision its
// assertion/closure tables under the default names once per engine — leaking
// ledger rows across property iterations.
describe.each(backendMatrix())("identity merge laws [$name]", (entry) => {
  for (const lane of LAW_LANES) {
    it(`merges random ${lane.name}-profile histories lawfully`, async () => {
      await fc.assert(
        fc.asyncProperty(
          scenarioArbFor(lane.includeRobotOps),
          async (scenario) => {
            const cleanups: (() => Promise<void>)[] = [];
            async function makeBackend(): Promise<GraphBackend> {
              const fixture = await entry.make();
              cleanups.push(fixture.cleanup);
              return fixture.backend;
            }
            try {
              const [forkPoint] = await createStoreWithSchema(
                lane.graph,
                await makeBackend(),
              );
              for (const id of NODE_IDS) {
                await forkPoint.nodes.Agent.create({ name: id }, { id });
              }
              const baseHistory: AppliedHistory = {
                assertionIds: [],
                retractedIds: new Set(),
                deletedNodes: new Set(),
              };
              for (const op of scenario.baseOps) {
                await applyOp(forkPoint, op, baseHistory);
              }

              const branchA = unwrap(
                await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
              );
              const branchB = unwrap(
                await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
              );
              const histories = new Map<Store<LawGraph>, AppliedHistory>([
                [branchA.store, structuredHistory(baseHistory)],
                [branchB.store, structuredHistory(baseHistory)],
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
                  [...histories.values()].flatMap(
                    (history) => history.assertionIds,
                  ),
                ),
              ];
              const preMerge = await currentLedger(forkPoint, trackedIds);

              const result = await merge(forkPoint, [branchA, branchB], {
                branchOrder: [BRANCH_A, BRANCH_B],
              });

              if (isErr(result)) {
                // Law 1: refusals are TYPED — never the generic wrapper.
                expect(
                  result.error instanceof IdentityMergeConflictError ||
                    result.error instanceof BaseVersionMismatchError,
                  `expected a typed identity refusal, got ${result.error.constructor.name}: ${result.error.message}`,
                ).toBe(true);
                return;
              }

              const postMerge = await currentLedger(forkPoint, trackedIds);
              // Law 2: the committed ledger is internally consistent.
              expectConsistentLedger(postMerge);

              const preMergeIds = new Set(preMerge.map((row) => row.id));
              const postMergeIds = new Set(postMerge.map((row) => row.id));
              // Law 4 (report coherence): an id reported dropped as a
              // DUPLICATE was not applied — it must not have BECOME current.
              for (const droppedItem of result.data.dropped) {
                if (
                  droppedItem.kind !== "identity" ||
                  droppedItem.reason !==
                    DUPLICATE_IDENTITY_ASSERTION_DROP_REASON
                ) {
                  continue;
                }
                expect(
                  postMergeIds.has(droppedItem.id) &&
                    !preMergeIds.has(droppedItem.id),
                  `id ${droppedItem.id} reported dropped as duplicate yet newly current`,
                ).toBe(false);
              }

              const branchHistories = [...histories.values()];
              const invalidatedEndpoint = (row: LedgerRow): boolean =>
                branchHistories.some(
                  (history) =>
                    history.deletedNodes.has(row.a.id) ||
                    history.deletedNodes.has(row.b.id),
                );
              const retractedByAnyBranch = (row: LedgerRow): boolean =>
                branchHistories.some((history) =>
                  history.retractedIds.has(row.id),
                );

              // Law 3: no pre-merge truth ended without a matching branch
              // action.
              for (const row of preMerge) {
                if (retractedByAnyBranch(row) || invalidatedEndpoint(row)) {
                  continue;
                }
                expect(
                  postMergeIds.has(row.id),
                  `pre-merge assertion ${row.id} (${row.relation}(${row.a.id}, ${row.b.id})) ended without a branch retraction or endpoint invalidation`,
                ).toBe(true);
              }

              // Law 5: every truth a branch holds is accounted for — applied
              // with equal complete truth, enumerated as dropped, retracted
              // by some branch, or invalidated by an endpoint deletion.
              const droppedIds = new Set(
                result.data.dropped.map((item) => item.id),
              );
              const postById = new Map(
                postMerge.map((row) => [row.id, row] as const),
              );
              for (const branchStore of [branchA.store, branchB.store]) {
                const branchLedger = await currentLedger(
                  branchStore,
                  trackedIds,
                );
                for (const row of branchLedger) {
                  const applied =
                    postById.get(row.id) !== undefined &&
                    assertionTruthKey(requireDefined(postById.get(row.id))) ===
                      assertionTruthKey(row);
                  expect(
                    applied ||
                      droppedIds.has(row.id) ||
                      retractedByAnyBranch(row) ||
                      invalidatedEndpoint(row),
                    `branch truth ${row.id} (${row.relation}(${row.a.id}, ${row.b.id})) vanished: not applied, not dropped, not retracted, endpoints intact`,
                  ).toBe(true);
                }
              }
            } finally {
              for (const cleanup of cleanups.reverse()) await cleanup();
            }
          },
        ),
        {
          examples: [[VALIDITY_COLLISION_EXAMPLE], [TRUTH_REPLACEMENT_EXAMPLE]],
          numRuns: LAW_RUNS,
        },
      );
    });
  }
});

/** A branch's starting history: the base's, copied (histories then diverge). */
function structuredHistory(base: AppliedHistory): AppliedHistory {
  return {
    assertionIds: [...base.assertionIds],
    retractedIds: new Set(base.retractedIds),
    deletedNodes: new Set(base.deletedNodes),
  };
}
