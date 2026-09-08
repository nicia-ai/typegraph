/**
 * Target-side edge cardinality during a graph merge (issue #610, acceptance
 * criterion 5, merge half).
 *
 * Two distinct target nodes, each already holding one incoming edge of a
 * `targetCardinality: "one"` kind, are reconciled into ONE canonical node by
 * `planMerge`'s dedup resolution. `applyMergePlan` repoints both edges'
 * target endpoint to the canonical node (`repoint()` in
 * `src/graph-merge/edge-repoint.ts`, T9) — after which the SAME target node
 * holds two live incoming edges, which the target-cardinality axis refuses
 * exactly as it would for two ordinary writes to that node.
 *
 * Every case states, in its own comment, the mutation/revert that must make
 * it fail; the checks actually performed are recorded in the scratchpad
 * `lane-D1-load-bearing.md` note.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, type Store } from "../../../src";
import {
  isErr,
  type MergeConstraintConflictError,
  unwrap,
} from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import { applyMergePlan, planMerge } from "../../../src/graph-merge/merge";
import { asBranchId, type GraphBranch } from "../../../src/graph-merge/types";
import { type IntegrationTestContext } from "./test-context";

const Assignee = defineNode("GmtAssignee", { schema: z.object({}) });
const Target = defineNode("GmtTarget", {
  schema: z.object({ name: z.string(), externalId: z.string() }),
});
const assignedTo = defineEdge("gmtAssignedTo", { schema: z.object({}) });

const graph = defineGraph({
  id: "graph_merge_target_cardinality",
  nodes: {
    GmtAssignee: { type: Assignee },
    GmtTarget: {
      type: Target,
      unique: [
        {
          name: "gmt_target_external_id",
          fields: ["externalId"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    gmtAssignedTo: {
      type: assignedTo,
      from: [Assignee],
      to: [Target],
      targetCardinality: "one",
    },
  },
});

type TestStore = Store<typeof graph>;

async function makeBranch(
  context: IntegrationTestContext,
  base: TestStore,
  id: string,
): Promise<GraphBranch<typeof graph>> {
  return unwrap(
    await branch(base, () => context.createIsolatedBackend(), {
      id: asBranchId(id),
    }),
  );
}

export function registerGraphMergeTargetCardinalityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("target-side edge cardinality during graph merge", () => {
    it("refuses a merge that would collapse two independently-assigned targets into one", async () => {
      const base = await context.createStore(graph, {
        revisionTracking: true,
      });
      const left = await makeBranch(context, base, "left");
      const right = await makeBranch(context, base, "right");

      await left.store.nodes.GmtTarget.create(
        { name: "Same Target", externalId: "shared-external-id" },
        { id: "target-left" },
      );
      await left.store.nodes.GmtAssignee.create({}, { id: "assignee-left" });
      await left.store.edges.gmtAssignedTo.create(
        { kind: "GmtAssignee", id: "assignee-left" },
        { kind: "GmtTarget", id: "target-left" },
        {},
      );

      await right.store.nodes.GmtTarget.create(
        { name: "Same Target", externalId: "shared-external-id" },
        { id: "target-right" },
      );
      await right.store.nodes.GmtAssignee.create({}, { id: "assignee-right" });
      await right.store.edges.gmtAssignedTo.create(
        { kind: "GmtAssignee", id: "assignee-right" },
        { kind: "GmtTarget", id: "target-right" },
        {},
      );

      const artifact = unwrap(
        await planMerge(base, [left, right], {
          resolve: {
            GmtTarget: {
              block: (node) => node.externalId,
              similarity: { kind: "fulltext", fields: ["name"] },
              threshold: 1,
            },
          },
        }),
      );
      // Sanity: the plan really did resolve the two targets into one
      // canonical row — otherwise this test would trivially pass for the
      // wrong reason (no collapse, so no conflict to refuse).
      expect(artifact.review.resolutions.length).toBeGreaterThanOrEqual(1);

      const result = await applyMergePlan(base, artifact);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected the merge to be refused");
      const error = result.error as MergeConstraintConflictError;
      expect(error.name).toBe("MergeConstraintConflictError");
      expect(error.details.constraintErrorName).toBe("CardinalityError");
      expect(error.details.constraintDetails["direction"]).toBe("target");

      // Nothing committed: the whole node+edge+provenance transaction rolled
      // back, not just the write that tripped the fence.
      expect(await base.nodes.GmtTarget.count()).toBe(0);
      expect(await base.nodes.GmtAssignee.count()).toBe(0);
      expect(await base.edges.gmtAssignedTo.count()).toBe(0);
    });
    // MUTATION CHECK (verified): the actual repoint owner is `repoint()` in
    // `src/graph-merge/edge-repoint.ts` (T9, `repointEdges`), not
    // `finalEdgeEndpoint` in `merge.ts` (that one resolves an edge's
    // endpoint through the retype map for a narrower, identity-driven
    // cross-KIND case; ordinary duplicate-node collapse is a T9 concern).
    // Reverting `const toKey = repoint(sourceToKey, canonicalOf);` to
    // `const toKey = sourceToKey;` (leave the target endpoint
    // uncanonicalized) makes the two edges keep their own, never-merged-away
    // target ids — no target-cardinality conflict is possible — and this
    // case fails. The observed failure is not the guessed "apply succeeds"
    // (`isErr` false): the artifact becomes internally inconsistent (a
    // dropped node with a live inbound edge still naming it) and
    // `applyMergePlan` instead returns a DIFFERENT typed refusal,
    // `InvalidMergePlanError`, so `error.name` reads that instead of
    // `MergeConstraintConflictError` and the assertion on `error.name`
    // fails. Either way, this pins that the conflict here is a genuine
    // POST-repoint one, not a plan-time coincidence the setup already
    // ensured some other way.
  });
}
