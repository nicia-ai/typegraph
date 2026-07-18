/**
 * Atomicity contract for the SNAPSHOT `merge()` commit (the mergeIncremental
 * counterpart lives in `merge-incremental.test.ts` "TRANSACTION: …").
 *
 * The merged plan commits inside a single `target.transaction(…)`: when a
 * store-level constraint rejects a write mid-commit, EVERYTHING already applied
 * in that transaction must roll back — a partially-merged graph (some branch
 * nodes committed, their edges missing) is the failure mode the
 * transaction-capability requirement exists to prevent.
 *
 * The forcing scenario: `primaryEncounter` carries cardinality "one". Each
 * branch adds one primary encounter for the SAME inherited patient — valid in
 * isolation, a cardinality violation in union. The commit writes the branch
 * encounters first and only then the edge batch, so the constraint fires after
 * real rows have been applied; the test proves those rows do not survive.
 */

import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { MergeError } from "../../src/graph-merge/errors";
import { merge } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
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
    Patient: { type: Patient },
    Encounter: { type: Encounter },
  },
  edges: {
    primaryEncounter: {
      type: primaryEncounter,
      from: [Patient],
      to: [Encounter],
      cardinality: "one",
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

    it("TRANSACTION: a cardinality violation in the union rolls back every committed row", async () => {
      const [baseStore] = await createStoreWithSchema(
        rollbackGraph,
        await makeBackend(),
      );
      await baseStore.nodes.Patient.bulkCreate([
        { id: "pat-1", props: { name: "Robert Smith" } },
      ]);

      const branchA = await makeBranch(baseStore, BRANCH_A);
      const branchB = await makeBranch(baseStore, BRANCH_B);

      // Each branch adds ONE primary encounter for pat-1 — valid per branch
      // (cardinality "one" holds inside each fork), violated by their union.
      await branchA.store.nodes.Encounter.bulkCreate([
        { id: "enc-a", props: { reason: "branch a" } },
      ]);
      await branchA.store.edges.primaryEncounter.bulkCreate([
        {
          id: "pe-a",
          from: { kind: "Patient", id: "pat-1" },
          to: { kind: "Encounter", id: "enc-a" },
          props: { on: "2026-06-01" },
        },
      ]);
      await branchB.store.nodes.Encounter.bulkCreate([
        { id: "enc-b", props: { reason: "branch b" } },
      ]);
      await branchB.store.edges.primaryEncounter.bulkCreate([
        {
          id: "pe-b",
          from: { kind: "Patient", id: "pat-1" },
          to: { kind: "Encounter", id: "enc-b" },
          props: { on: "2026-06-02" },
        },
      ]);

      const result = await merge<RollbackGraph>(baseStore, [branchA, branchB], {
        branchOrder: [BRANCH_A, BRANCH_B],
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(MergeError);
        expect(result.error.message).toMatch(/cardinality/i);
      }

      // The commit had already upserted the branch encounters before the edge
      // batch hit the constraint — the rollback must take them down with it.
      expect(await liveNodeIds(baseStore, "Patient")).toEqual(["pat-1"]);
      expect(await liveNodeIds(baseStore, "Encounter")).toEqual([]);
      expect(await liveEdgeIds(baseStore, "primaryEncounter")).toEqual([]);
    });
  },
);
