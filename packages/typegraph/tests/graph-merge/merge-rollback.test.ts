/**
 * Atomicity contract for the SNAPSHOT `merge()` commit (the mergeIncremental
 * counterpart lives in `merge-incremental.test.ts` "TRANSACTION: …").
 *
 * The merged plan commits inside a single `target.transaction(…)`: when a
 * write fails mid-commit, EVERYTHING already applied in that transaction must
 * roll back — a partially-merged graph (some branch nodes committed, their
 * edges missing) is the failure mode the transaction-capability requirement
 * exists to prevent. The forcing failure is a store hook that refuses the
 * second branch encounter's write, after the first one (and the inherited
 * patient's rename) has been applied.
 *
 * `primaryEncounter` carries cardinality "oneActive". Each branch adding one
 * primary encounter for the SAME inherited patient is valid in isolation and
 * a violation in union: the plan's revision fence makes that refusal certain,
 * so it is refused while the plan is built and nothing is written at all.
 */

import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  asNodeId,
  CardinalityError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  UniquenessError,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import {
  CardinalityMergeConflictError,
  MergeError,
} from "../../src/graph-merge/errors";
import { applyMergePlan, merge, planMerge } from "../../src/graph-merge/merge";
import {
  openProvenanceStore,
  readProvenance,
} from "../../src/graph-merge/provenance-store";
import { isErr, type Result, unwrap } from "../../src/graph-merge/result";
import {
  enumerateAllEdges,
  enumerateAllNodes,
} from "../../src/graph-merge/state-diff";
import type { BranchId, GraphBranch } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix, getStoreBackend } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string() }),
});

const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});

const primaryEncounter = defineEdge("primaryEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

const rollbackGraph = defineGraph({
  id: "merge-rollback-graph",
  nodes: {
    Patient: {
      type: Patient,
      unique: [
        {
          name: "patient_name_unique",
          fields: ["name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Encounter: { type: Encounter },
  },
  edges: {
    primaryEncounter: {
      type: primaryEncounter,
      from: [Patient],
      to: [Encounter],
      cardinality: "oneActive",
    },
  },
});

type RollbackGraph = typeof rollbackGraph;

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

/** Live row ids of `kind`, sorted, for asserting the post-rollback graph. */
async function liveNodeIds(
  store: Store<RollbackGraph>,
  kind: string,
): Promise<readonly string[]> {
  const rows = await enumerateAllNodes(
    getStoreBackend(store),
    store.graphId,
    kind,
  );
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => row.id)
    .sort();
}

async function liveEdgeIds(
  store: Store<RollbackGraph>,
  kind: string,
): Promise<readonly string[]> {
  const rows = await enumerateAllEdges(
    getStoreBackend(store),
    store.graphId,
    kind,
  );
  return rows
    .filter((row) => row.deleted_at === undefined)
    .map((row) => row.id)
    .sort();
}

describe.each(backendMatrix())(
  "merge — mid-commit failure atomicity [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups) {
        await cleanup();
      }
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeBranch(
      baseStore: Store<RollbackGraph>,
      id: BranchId,
    ): Promise<GraphBranch<RollbackGraph>> {
      return unwrap(
        await branch<RollbackGraph>(baseStore, () => makeBackend(), { id }),
      );
    }

    async function addPrimaryEncounters(
      branchA: GraphBranch<RollbackGraph>,
      branchB: GraphBranch<RollbackGraph>,
    ): Promise<void> {
      for (const [source, suffix, on] of [
        [branchA, "a", "2026-06-01"],
        [branchB, "b", "2026-06-02"],
      ] as const) {
        await source.store.nodes.Encounter.create(
          { reason: `branch ${suffix}` },
          { id: `enc-${suffix}` },
        );
        await source.store.edges.primaryEncounter.create(
          { kind: "Patient", id: "pat-1" },
          { kind: "Encounter", id: `enc-${suffix}` },
          { on },
          { id: `pe-${suffix}` },
        );
      }
    }

    async function expectNothingMerged(
      baseStore: Store<RollbackGraph>,
    ): Promise<void> {
      expect(await liveNodeIds(baseStore, "Patient")).toEqual(["pat-1"]);
      expect(await liveNodeIds(baseStore, "Encounter")).toEqual([]);
      expect(await liveEdgeIds(baseStore, "primaryEncounter")).toEqual([]);
      expect(
        await readProvenance(await openProvenanceStore(baseStore)),
      ).toEqual([]);
    }

    it("refuses a cardinality violation in the union at plan time, writing nothing", async () => {
      const [baseStore] = await createStoreWithSchema(
        rollbackGraph,
        await makeBackend(),
        { revisionTracking: true },
      );
      await baseStore.nodes.Patient.create(
        { name: "Robert Smith" },
        { id: "pat-1" },
      );
      const branchA = await makeBranch(baseStore, BRANCH_A);
      const branchB = await makeBranch(baseStore, BRANCH_B);
      await addPrimaryEncounters(branchA, branchB);

      const merged = await merge<RollbackGraph>(baseStore, [branchA, branchB], {
        branchOrder: [BRANCH_A, BRANCH_B],
        persistProvenance: true,
      });
      const planned = await planMerge(baseStore, [branchA, branchB], {
        persistProvenance: true,
      });
      const results: readonly Result<unknown, MergeError>[] = [merged, planned];
      for (const result of results) {
        if (!isErr(result)) throw new Error("expected a plan-time refusal");
        expect(result.error).toBeInstanceOf(CardinalityMergeConflictError);
        expect(result.error.category).toBe("constraint");
        expect(result.error.cause).toBeInstanceOf(CardinalityError);
        expect(result.error.details).toMatchObject({
          constraintCode: "CARDINALITY_ERROR",
          edgeKind: "primaryEncounter",
          fromId: "pat-1",
          cardinality: "oneActive",
        });
      }
      await expectNothingMerged(baseStore);
    });

    it("TRANSACTION: a write failing mid-commit rolls back every committed row", async () => {
      let encounterWrites = 0;
      let refuseSecondEncounter = false;
      const [baseStore] = await createStoreWithSchema(
        rollbackGraph,
        await makeBackend(),
        {
          revisionTracking: true,
          hooks: {
            onOperationStart: (operation) => {
              if (operation.entity !== "node" || operation.kind !== "Encounter")
                return;
              encounterWrites += 1;
              if (refuseSecondEncounter && encounterWrites === 2) {
                throw new Error("the second encounter write is refused");
              }
            },
          },
        },
      );
      await baseStore.nodes.Patient.create(
        { name: "Robert Smith" },
        { id: "pat-1" },
      );
      const branchA = await makeBranch(baseStore, BRANCH_A);
      const branchB = await makeBranch(baseStore, BRANCH_B);
      await branchA.store.nodes.Patient.update(asNodeId("pat-1"), {
        name: "Robert Updated",
      });
      for (const [source, suffix] of [
        [branchA, "a"],
        [branchB, "b"],
      ] as const) {
        await source.store.nodes.Encounter.create(
          { reason: `branch ${suffix}` },
          { id: `enc-${suffix}` },
        );
      }
      const artifact = unwrap(
        await planMerge(baseStore, [branchA, branchB], {
          branchOrder: [BRANCH_A, BRANCH_B],
          persistProvenance: true,
        }),
      );
      refuseSecondEncounter = true;

      for (const commit of [
        () =>
          merge<RollbackGraph>(baseStore, [branchA, branchB], {
            branchOrder: [BRANCH_A, BRANCH_B],
            persistProvenance: true,
          }),
        () => applyMergePlan(baseStore, artifact),
      ]) {
        encounterWrites = 0;
        const result = await commit();
        if (!isErr(result)) throw new Error("expected the commit to fail");
        expect(result.error).toBeInstanceOf(MergeError);
        expect(encounterWrites).toBe(2);
      }

      // The commit had already renamed the patient and written the first
      // encounter before the second one failed — the rollback must take them
      // down with it.
      await expectNothingMerged(baseStore);
      await expect(
        baseStore.nodes.Patient.create({ name: "Robert Smith" }),
      ).rejects.toThrow(UniquenessError);
      refuseSecondEncounter = false;
      await expect(
        baseStore.nodes.Patient.create(
          { name: "Robert Updated" },
          { id: "pat-2" },
        ),
      ).resolves.toMatchObject({ id: "pat-2" });
    });
  },
);
