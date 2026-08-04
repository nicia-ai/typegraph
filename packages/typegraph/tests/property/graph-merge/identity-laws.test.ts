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
 *      no branch retracted: every pre-merge current row survives unless a
 *      branch retracted that id or deleted one of its endpoint nodes.
 *
 * Scenarios are identity-only histories (assert same/different, retract,
 * delete a node) over a fixed four-node universe on both branches, applied
 * through the public store API with refused operations skipped — exactly the
 * histories a real fork accumulates.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  TypeGraphError,
} from "@nicia-ai/typegraph";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../../src/graph-merge/branch";
import {
  BaseVersionMismatchError,
  IdentityMergeConflictError,
} from "../../../src/graph-merge/errors";
import {
  DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
  merge,
} from "../../../src/graph-merge/merge";
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

const identityLawGraph = defineGraph({
  id: "identity-law-graph",
  nodes: { Agent: { type: Agent } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

type IdentityLawGraph = typeof identityLawGraph;

const NODE_IDS = ["n1", "n2", "n3", "n4"] as const;
const BRANCH_A = asBranchId("identity-law-a");
const BRANCH_B = asBranchId("identity-law-b");

/**
 * fast-check iterations. Each iteration builds a fork point plus two branch
 * stores and runs one merge; CI keeps a smaller budget, mirroring the other
 * merge property files.
 */
const LAW_RUNS = process.env["CI"] ? 6 : 12;

type IdentityOp =
  | Readonly<{ op: "same"; left: number; right: number }>
  | Readonly<{ op: "different"; left: number; right: number }>
  | Readonly<{ op: "retract"; pick: number }>
  | Readonly<{ op: "deleteNode"; node: number }>
  // Interchange import with a CHOSEN id from a small pool: the only way two
  // independent lineages mint the SAME assertion id — the collision class
  // (one id, two truths) every hand-built review repro lived in.
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
const opArb: fc.Arbitrary<IdentityOp> = fc.oneof(
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
);

/**
 * The validity-only collision as a pinned example: both branches import ONE id
 * for the SAME pair with different validFrom values. The semantic survivor
 * dedupe used to collapse the two silently — merge succeeded while the report
 * listed the surviving id as dropped (the report-coherence law below).
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
const identityLawScenarioArb: fc.Arbitrary<IdentityLawScenario> = fc.record({
  baseOps: fc.array(opArb, { maxLength: 2 }),
  branchAOps: fc.array(opArb, { minLength: 1, maxLength: 3 }),
  branchBOps: fc.array(opArb, { minLength: 1, maxLength: 3 }),
});

/** What a history actually did — refused operations are skipped, not recorded. */
interface AppliedHistory {
  /** Every assertion id this store can see (inherited + created), in order. */
  assertionIds: string[];
  retractedIds: Set<string>;
  deletedNodes: Set<string>;
}

function nodeRef(index: number): Readonly<{ kind: "Agent"; id: string }> {
  return { kind: "Agent", id: requireDefined(NODE_IDS[index]) };
}

/**
 * Applies one op through the public API, skipping refusals (contradictions,
 * missing rows, missing nodes) exactly as an interactive caller would. Only
 * typed refusals are skippable — an unexpected error class fails the run.
 */
async function applyOp(
  store: Store<IdentityLawGraph>,
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
    if (!(error instanceof TypeGraphError)) throw error;
  }
}

type LedgerRow = Readonly<{
  id: string;
  relation: "same" | "different";
  a: Readonly<{ kind: string; id: string }>;
  b: Readonly<{ kind: string; id: string }>;
  validTo?: string | undefined;
}>;

async function currentLedger(
  store: Store<IdentityLawGraph>,
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
  it("merges random identity histories typed, consistent, and truth-preserving", async () => {
    await fc.assert(
      fc.asyncProperty(identityLawScenarioArb, async (scenario) => {
        const cleanups: (() => Promise<void>)[] = [];
        async function makeBackend(): Promise<GraphBackend> {
          const fixture = await entry.make();
          cleanups.push(fixture.cleanup);
          return fixture.backend;
        }
        try {
          const [forkPoint] = await createStoreWithSchema(
            identityLawGraph,
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
          const histories = new Map<Store<IdentityLawGraph>, AppliedHistory>([
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
          // Law 4 (report coherence): an id reported dropped as a DUPLICATE
          // was not applied — it must not have BECOME current in this merge.
          const preMergeIds = new Set(preMerge.map((row) => row.id));
          const postMergeIds = new Set(postMerge.map((row) => row.id));
          for (const droppedItem of result.data.dropped) {
            if (
              droppedItem.kind !== "identity" ||
              droppedItem.reason !== DUPLICATE_IDENTITY_ASSERTION_DROP_REASON
            ) {
              continue;
            }
            expect(
              postMergeIds.has(droppedItem.id) &&
                !preMergeIds.has(droppedItem.id),
              `id ${droppedItem.id} reported dropped as duplicate yet newly current`,
            ).toBe(false);
          }
          // Law 3: no pre-merge truth ended without a matching branch action.
          const survivors = new Set(postMerge.map((row) => row.id));
          const branchHistories = [...histories.values()];
          for (const row of preMerge) {
            const retracted = branchHistories.some((history) =>
              history.retractedIds.has(row.id),
            );
            const endpointDeleted = branchHistories.some(
              (history) =>
                history.deletedNodes.has(row.a.id) ||
                history.deletedNodes.has(row.b.id),
            );
            if (retracted || endpointDeleted) continue;
            expect(
              survivors.has(row.id),
              `pre-merge assertion ${row.id} (${row.relation}(${row.a.id}, ${row.b.id})) ended without a branch retraction or endpoint deletion`,
            ).toBe(true);
          }
        } finally {
          for (const cleanup of cleanups.reverse()) await cleanup();
        }
      }),
      { examples: [[VALIDITY_COLLISION_EXAMPLE]], numRuns: LAW_RUNS },
    );
  });
});

/** A branch's starting history: the base's, copied (histories then diverge). */
function structuredHistory(base: AppliedHistory): AppliedHistory {
  return {
    assertionIds: [...base.assertionIds],
    retractedIds: new Set(base.retractedIds),
    deletedNodes: new Set(base.deletedNodes),
  };
}
