/**
 * Item D.2, merge planner (design note "Lead rulings", D-4 reaffirmed
 * 2026-09-08): a cycle that would only exist once a merge combines edges
 * from more than one branch — or once canonicalization/repointing collapses
 * two staged nodes onto one survivor — is caught at PLAN TIME, before any
 * write, and surfaced as the typed `AcyclicityMergeConflictError` rather
 * than discovered only when the write is attempted.
 *
 * `resolveMerge` (src/graph-merge/merge.ts) runs
 * `assertResolvedPlanEdgesAcyclic` immediately after the internal plan is
 * built — the same point the one-id-one-truth check already runs its own
 * plan-time validation — over the plan's `mergedEdges` (already POST
 * repoint + dedupe, so a repointed id is already the survivor by the time
 * this reads it), resolved to their FINAL `(kind, id)` via
 * `finalEdgeEndpoint`. It calls `readProposedEdgeAcyclicityViolations`, the
 * lock-free preview built on the SAME `assertEdgeRelationsAcyclic` /
 * `buildEdgeAcyclicityProbe` SQL the write path uses. This is the ONE caller
 * that passes the `"planned"` seed form (the D-4 seed-hop through the
 * plan's own not-yet-committed rows, `src/store/recursive-cte.ts`) — every
 * real write path passes `"proposed"` instead, which has no seed-hop and
 * joins `typegraph_edges` directly (item D.2 perf ruling, 2026-09-08) — so a
 * plan-time verdict and an eventual write verdict can never disagree.
 *
 * `resolveMerge` is shared by every entry point (`merge`, `mergeAgainstBase`,
 * `planMerge`, `planMergeIncremental`, `mergeIncremental`), so the check
 * runs identically whether a caller reviews a `MergePlanArtifact` before
 * deciding to apply it, or calls the one-shot `merge()`.
 *
 * Apply-time re-verification is UNCHANGED (D-4's ruling: a plan-time
 * conflict, an apply-time drift is still a refusal). The plan-time preview
 * takes no per-graph write lock (see `assertResolvedPlanEdgesAcyclic`'s
 * docblock) and is inherently racy against a concurrent writer, so a cycle
 * that only appears from a write landing between planning and commit is
 * still caught by the ordinary insert-then-probe write-path fence and
 * surfaces as `MergeConstraintConflictError` wrapping `EdgeAcyclicityError`,
 * exactly as before this change. The write path's own in-batch-cycle
 * refusal (`bulkCreate`) is pinned unchanged in
 * `tests/backends/integration/edge-acyclicity.ts` ("refuses an in-batch
 * cycle in bulkCreate with zero rows committed").
 *
 * Mutation check (recorded in the lane's load-bearing log): changing
 * `readProposedEdgeAcyclicityViolations`'s probe call (src/store/acyclicity.ts)
 * from `kind: "planned"` back to `kind: "proposed"` — which has no seed-hop
 * — makes `planMerge()` resolve `ok` for the purely-proposed cycle in case
 * (a) below instead of refusing — the plan "passes" — and a subsequent
 * `applyMergePlan()`-equivalent write then refuses via the unchanged
 * apply-time path (`MergeConstraintConflictError` / `EdgeAcyclicityError`),
 * never committing the cycle.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { AcyclicityMergeConflictError } from "../../src/graph-merge/errors";
import { merge, planMerge } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Task = defineNode("Task", { schema: z.object({ key: z.string() }) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "merge_acyclicity_test",
  nodes: {
    Task: {
      type: Task,
      unique: [
        {
          name: "key_unique",
          fields: ["key"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      acyclic: true,
    },
  },
});

describe.each(backendMatrix())(
  "merge planner: edge acyclicity plan-time conflict [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups.reverse()) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeTarget(): Promise<Store<typeof graph>> {
      const [target] = await createStoreWithSchema(graph, await makeBackend(), {
        revisionTracking: true,
      });
      return target;
    }

    async function makeBranch(
      target: Store<typeof graph>,
      id: string,
    ): Promise<GraphBranch<typeof graph>> {
      return unwrap(
        await branch(target, () => makeBackend(), { id: asBranchId(id) }),
      );
    }

    it("(a) refuses, at PLAN time, a cycle formed entirely from two branches' proposed edges — planMerge()", async () => {
      // Nodes exist at the fork point, before either branch adds edges, so
      // both branches resolve "a" / "b" / "c" to the SAME node by shared id
      // — no candidate resolution is needed to see the cycle. Neither
      // branch alone has one: branch A's chain a -> b -> c never returns to
      // "a", and branch B's lone c -> a never reaches "b". Nothing is live
      // on the target either, so this is exactly the case the SQL seed-hop
      // exists for: the probe has no live edge to walk at all.
      const target = await makeTarget();
      await target.nodes.Task.create({ key: "a" }, { id: "a" });
      await target.nodes.Task.create({ key: "b" }, { id: "b" });
      await target.nodes.Task.create({ key: "c" }, { id: "c" });

      const branchA = await makeBranch(target, "branch-a");
      const branchB = await makeBranch(target, "branch-b");
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

      const planResult = await planMerge(target, [branchA, branchB]);
      expect(isErr(planResult)).toBe(true);
      if (!isErr(planResult)) throw new Error("expected planMerge to refuse");
      const { error } = planResult;
      if (!(error instanceof AcyclicityMergeConflictError)) {
        throw new Error(
          `expected AcyclicityMergeConflictError, got ${error.name}`,
        );
      }
      expect(error.details.relation).toBe("dependsOn");
      expect(error.details.edges.map((edge) => edge.edgeId).toSorted()).toEqual(
        ["ab", "bc", "ca"],
      );

      // Byte-unchanged: planning alone never wrote anything.
      const remaining = await target.edges.dependsOn.find({});
      expect(remaining).toEqual([]);
    });

    it("(a) refuses the same cycle for the one-shot merge() surface too", async () => {
      const target = await makeTarget();
      await target.nodes.Task.create({ key: "a" }, { id: "a" });
      await target.nodes.Task.create({ key: "b" }, { id: "b" });
      await target.nodes.Task.create({ key: "c" }, { id: "c" });

      const branchA = await makeBranch(target, "branch-a");
      const branchB = await makeBranch(target, "branch-b");
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
      expect(mergeResult.error).toBeInstanceOf(AcyclicityMergeConflictError);

      const remaining = await target.edges.dependsOn.find({});
      expect(remaining).toEqual([]);
    });

    it("(b) refuses, at PLAN time, a cycle that only exists after canonicalization repoints two branches' duplicate nodes onto one survivor", async () => {
      // `hub` pre-exists. Neither branch creates a cycle on its own: branch
      // A writes hub -> newA (a brand-new node), branch B writes
      // newB -> hub (a DIFFERENT brand-new node). `newA` and `newB` declare
      // the SAME unique `key`, so the staged-vs-staged `uniqueSource`
      // candidate (src/graph-merge/sources.ts, part of the public merge()'s
      // CANDIDATE_SOURCES) folds them into ONE canonical survivor during
      // clustering — only THEN do the two edges become hub -> survivor and
      // survivor -> hub, a 2-cycle neither branch's own edge set contained
      // before repointing.
      const target = await makeTarget();
      await target.nodes.Task.create({ key: "hub" }, { id: "hub" });

      const branchA = await makeBranch(target, "branch-a");
      const branchB = await makeBranch(target, "branch-b");
      await branchA.store.nodes.Task.create(
        { key: "dup-key" },
        { id: "new-a" },
      );
      await branchA.store.edges.dependsOn.create(
        { kind: "Task", id: "hub" },
        { kind: "Task", id: "new-a" },
        {},
        { id: "hub-to-new" },
      );
      await branchB.store.nodes.Task.create(
        { key: "dup-key" },
        { id: "new-b" },
      );
      await branchB.store.edges.dependsOn.create(
        { kind: "Task", id: "new-b" },
        { kind: "Task", id: "hub" },
        {},
        { id: "new-to-hub" },
      );

      // `resolve.Task` must be present (with a `similarity` strategy — the
      // options validator requires one even though `uniqueSource`'s forced
      // edge does not consult it) for candidate generation to run at all for
      // this kind; with no resolve config, a kind merges "by id only" and
      // every new node stays its own singleton cluster (no repointing).
      const planResult = await planMerge(target, [branchA, branchB], {
        resolve: {
          Task: {
            threshold: 1,
            similarity: { kind: "fulltext", fields: ["key"] },
          },
        },
      });
      expect(isErr(planResult)).toBe(true);
      if (!isErr(planResult)) throw new Error("expected planMerge to refuse");
      const { error } = planResult;
      if (!(error instanceof AcyclicityMergeConflictError)) {
        throw new Error(
          `expected AcyclicityMergeConflictError, got ${error.name}`,
        );
      }
      expect(error.details.relation).toBe("dependsOn");

      // Byte-unchanged: the target still holds only "hub".
      const remaining = await target.edges.dependsOn.find({});
      expect(remaining).toEqual([]);
      const remainingNodes = await target.nodes.Task.find({});
      expect(remainingNodes.map((node) => node.id)).toEqual(["hub"]);
    });
  },
);
