/**
 * Target-side edge cardinality during a graph merge (issue #610, merge half).
 *
 * A plan that would leave one target node holding two live incoming edges of
 * a `targetCardinality: "one"` kind is refused while it is built, with
 * `CardinalityMergeConflictError` naming the `CardinalityError` the apply
 * would raise: the plan's revision fence makes that refusal certain, so a
 * `planMerge()` review must never see such a plan as applicable. The two
 * edges can come from a dedup collapse (both repointed onto one canonical
 * node by `repoint()` in `src/graph-merge/edge-repoint.ts`), from two
 * branches, or from a branch and the incremental target.
 *
 * Every case states, in its own comment, the mutation/revert that must make
 * it fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  defineNodeIndex,
  type Store,
} from "../../../src";
import {
  CardinalityMergeConflictError,
  isErr,
  type MergeError,
  unwrap,
} from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import {
  merge,
  mergeAgainstBase,
  planMerge,
  planMergeIncremental,
} from "../../../src/graph-merge/merge";
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

/**
 * A desk a branch may stage a near-duplicate of: the code index is declared
 * and NOT unique, so the branch store accepts the duplicate, and the merge
 * resolves it onto the committed desk through that index.
 */
const Desk = defineNode("GmtDesk", {
  schema: z.object({ name: z.string(), code: z.string() }),
});
const deskCode = defineNodeIndex(Desk, {
  name: "gmt_desk_code_idx",
  fields: ["code"],
});
const sitsAt = defineEdge("gmtSitsAt", { schema: z.object({}) });
const deskGraph = defineGraph({
  id: "graph_merge_target_cardinality_desks",
  nodes: { GmtAssignee: { type: Assignee }, GmtDesk: { type: Desk } },
  edges: {
    gmtSitsAt: {
      type: sitsAt,
      from: [Assignee],
      to: [Desk],
      targetCardinality: "one",
    },
  },
  indexes: [deskCode],
});

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

function expectTargetCardinalityConflict(
  error: MergeError,
  targetId: string,
): void {
  expect(error).toBeInstanceOf(CardinalityMergeConflictError);
  expect(error.details).toMatchObject({
    constraintCode: "CARDINALITY_ERROR",
    constraintErrorName: "CardinalityError",
    constraintDetails: { direction: "target", toId: targetId },
  });
  const { edges } = error.details as Readonly<{
    edges: readonly Readonly<{ toId: string }>[];
  }>;
  expect(edges.map((edge) => edge.toId)).toEqual([targetId, targetId]);
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

      const planned = await planMerge(base, [left, right], {
        resolve: {
          GmtTarget: {
            block: (node) => node.externalId,
            similarity: { kind: "fulltext", fields: ["name"] },
            threshold: 1,
          },
        },
      });

      if (!isErr(planned)) throw new Error("Expected a plan-time refusal");
      expectTargetCardinalityConflict(planned.error, "target-left");
      expect(await base.nodes.GmtTarget.count()).toBe(0);
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

    it("refuses two branches that each add an incoming edge at plan time", async () => {
      const base = await context.createStore(graph, {
        revisionTracking: true,
      });
      await base.nodes.GmtAssignee.create({}, { id: "alice" });
      await base.nodes.GmtAssignee.create({}, { id: "bob" });
      await base.nodes.GmtTarget.create(
        { name: "Desk", externalId: "desk" },
        { id: "desk" },
      );
      const left = await makeBranch(context, base, "left");
      const right = await makeBranch(context, base, "right");
      await left.store.edges.gmtAssignedTo.create(
        { kind: "GmtAssignee", id: "alice" },
        { kind: "GmtTarget", id: "desk" },
        {},
      );
      await right.store.edges.gmtAssignedTo.create(
        { kind: "GmtAssignee", id: "bob" },
        { kind: "GmtTarget", id: "desk" },
        {},
      );

      const planned = await planMerge(base, [left, right]);
      if (!isErr(planned)) throw new Error("Expected a plan-time refusal");
      expectTargetCardinalityConflict(planned.error, "desk");

      const merged = await merge(base, [right, left]);
      if (!isErr(merged)) throw new Error("Expected a merge refusal");
      expectTargetCardinalityConflict(merged.error, "desk");
      expect(await base.edges.gmtAssignedTo.count()).toBe(0);
    });
    // MUTATION CHECK (verified): dropping `edgeClaimConflict` from
    // `PLAN_STRUCTURAL_CHECKS` (`src/graph-merge/merge.ts`) returns an `ok`
    // plan here, and `merge()` refuses only inside the commit, with
    // `MergeConstraintConflictError`.

    it("refuses a branch edge that collides with an edge the target added after the fork", async () => {
      const forkPoint = await context.createStore(graph, {
        revisionTracking: true,
      });
      await forkPoint.nodes.GmtAssignee.create({}, { id: "alice" });
      await forkPoint.nodes.GmtAssignee.create({}, { id: "bob" });
      await forkPoint.nodes.GmtTarget.create(
        { name: "Desk", externalId: "desk" },
        { id: "desk" },
      );
      const source = await makeBranch(context, forkPoint, "branch-a");
      const { store: target } = await makeBranch(
        context,
        forkPoint,
        "target-clone",
      );
      await target.edges.gmtAssignedTo.create(
        { kind: "GmtAssignee", id: "alice" },
        { kind: "GmtTarget", id: "desk" },
        {},
      );
      await source.store.edges.gmtAssignedTo.create(
        { kind: "GmtAssignee", id: "bob" },
        { kind: "GmtTarget", id: "desk" },
        {},
      );

      const planned = await planMergeIncremental({
        forkPoint,
        target,
        branches: [source],
      });
      if (!isErr(planned)) throw new Error("Expected a plan-time refusal");
      expectTargetCardinalityConflict(planned.error, "desk");
      expect(await target.edges.gmtAssignedTo.count()).toBe(1);
    });
    // MUTATION CHECK (verified): dropping `edgeClaimConflict` from
    // `PLAN_STRUCTURAL_CHECKS` returns an `ok` plan here. The target's own
    // post-fork edge is staged into the plan, so this case is the in-plan
    // collision between the target's row and the branch's.

    it("refuses an edge repointed onto a committed node whose incoming slot the target already holds", async () => {
      const base = await context.createStore(deskGraph, {
        revisionTracking: true,
      });
      await base.nodes.GmtAssignee.create({}, { id: "alice" });
      await base.nodes.GmtAssignee.create({}, { id: "bob" });
      await base.nodes.GmtDesk.create(
        { name: "corner desk by the window", code: "D-1" },
        { id: "desk" },
      );
      await base.edges.gmtSitsAt.create(
        { kind: "GmtAssignee", id: "alice" },
        { kind: "GmtDesk", id: "desk" },
        {},
      );
      const source = unwrap(
        await branch(base, () => context.createIsolatedBackend(), {
          id: asBranchId("branch-a"),
        }),
      );
      await source.store.nodes.GmtDesk.create(
        { name: "corner desk by the window", code: "D-1" },
        { id: "desk-copy" },
      );
      await source.store.edges.gmtSitsAt.create(
        { kind: "GmtAssignee", id: "bob" },
        { kind: "GmtDesk", id: "desk-copy" },
        {},
      );

      const merged = await mergeAgainstBase(base, [source], {
        resolve: {
          GmtDesk: {
            blockIndex: "gmt_desk_code_idx",
            similarity: { kind: "fulltext", fields: ["name"] },
            threshold: 0.9,
          },
        },
      });

      if (!isErr(merged)) throw new Error("Expected a plan-time refusal");
      expectTargetCardinalityConflict(merged.error, "desk");
      expect(await base.edges.gmtSitsAt.count()).toBe(1);
    });
    // MUTATION CHECK (verified): with the target's stored holders left out of
    // `edgeClaimConflict` (`storedClaimHolder` answering `undefined`), the
    // plan passes and the commit refuses with `MergeConstraintConflictError`:
    // the alice edge the target already holds is in no branch's diff.
  });
}
