/**
 * Item D.2, merge apply (§10, ruling D-4): a cycle that only exists after a
 * merge combines edges from more than one branch is refused, and the target
 * is byte-unchanged.
 *
 * No merge-specific acyclicity code exists in `src/graph-merge/`: merge
 * apply writes every edge exclusively through the store's own collection
 * API (`applyEdgeRows` calls `edgeCollection(edgesApi, kind).bulkUpsertById`,
 * never a raw backend insert), and `bulkUpsertById`'s create/update legs are
 * exactly the `executeEdgeCreateBatch` / `executeEdgeCreateInternal` /
 * `executeEdgeUpsertUpdateBatch` paths item D.2 already fences — including
 * the fused-eligibility gates (`isAtomicResolvedEdgeKindEligible` and
 * friends) declining acyclic kinds. This test is the verified proof of that
 * claim: a dedicated `assertMergedEdgesAcyclic` post-apply check was
 * written and then deliberately reverted here to confirm this test still
 * refuses the cycle with the SAME error shape — see the mutation note in
 * the lane's status report. The refusal surfaces as the generic
 * declared-constraint translation cardinality/disjointness/uniqueness
 * already take (`MergeConstraintConflictError`, wrapping the thrown
 * `EdgeAcyclicityError` — `translateMergeCommitError` promotes any
 * `category: "constraint"` error this way).
 *
 * Plan-time conflict surfacing (making a would-be cycle visible for review
 * before apply, the way item E's orphan rule does) is not implemented; a
 * cycle is only ever caught here, at apply, which is D-4's ruling for the
 * apply-time case.
 */
import { defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { isErr } from "../../src/graph-merge/result";
import { createStoreWithSchema } from "../../src/store/store";
import { createTestBackend } from "../test-utils";

const Task = defineNode("Task", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "merge_acyclicity_test",
  nodes: { Task: { type: Task } },
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      acyclic: true,
    },
  },
});

describe("merge apply: edge acyclicity", () => {
  it("refuses a plan whose combined writes from two branches would close a cycle", async () => {
    // Nodes exist at the fork point, before either branch adds edges, so
    // both branches resolve "a" / "b" / "c" to the SAME node by shared id
    // — no identity/candidate resolution needed to see the cycle. Neither
    // branch alone has one: branch A's chain a -> b -> c never returns to
    // "a", and branch B's lone c -> a never reaches "b".
    const [target] = await createStoreWithSchema(graph, createTestBackend());
    await target.nodes.Task.create({}, { id: "a" });
    await target.nodes.Task.create({}, { id: "b" });
    await target.nodes.Task.create({}, { id: "c" });

    const branchAResult = await branch(target, async () => createTestBackend());
    const branchBResult = await branch(target, async () => createTestBackend());
    if (isErr(branchAResult)) throw branchAResult.error;
    if (isErr(branchBResult)) throw branchBResult.error;
    const branchA = branchAResult.data;
    const branchB = branchBResult.data;

    await branchA.store.edges.dependsOn.create(
      { kind: "Task", id: "a" },
      { kind: "Task", id: "b" },
      {},
      { id: "ab" },
    );
    await branchA.store.edges.dependsOn.create(
      { kind: "Task", id: "b" },
      { kind: "Task", id: "c" },
      {},
      { id: "bc" },
    );
    await branchB.store.edges.dependsOn.create(
      { kind: "Task", id: "c" },
      { kind: "Task", id: "a" },
      {},
      { id: "ca" },
    );

    const mergeResult = await merge(target, [branchA, branchB]);
    expect(isErr(mergeResult)).toBe(true);
    if (!isErr(mergeResult)) throw new Error("expected merge to refuse");
    // The same generic translation cardinality/disjointness/uniqueness
    // violations take: any declared-constraint error (`category:
    // "constraint"`) the resolved merge would violate becomes a
    // MergeConstraintConflictError — see translateMergeCommitError.
    expect(mergeResult.error.name).toBe("MergeConstraintConflictError");
    expect(mergeResult.error.cause).toMatchObject({
      name: "EdgeAcyclicityError",
    });

    // Byte-unchanged: neither branch's edges landed on the target.
    const remaining = await target.edges.dependsOn.find({});
    expect(remaining).toEqual([]);
  });
});
