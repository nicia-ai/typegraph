/**
 * Edge acyclicity in the merge planner: a cycle that would only exist once a merge combines edges
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
 * lock-free preview built on the SAME `buildEdgeAcyclicityProbe` SQL and the
 * same in-memory cycle search a batch write's own pre-write check uses, so a
 * plan-time verdict and an eventual write verdict can never disagree. The
 * edges the plan itself deletes are left out of the walk.
 *
 * `resolveMerge` is shared by every entry point (`merge`, `mergeAgainstBase`,
 * `planMerge`, `planMergeIncremental`, `mergeIncremental`), so the check
 * runs identically whether a caller reviews a `MergePlanArtifact` before
 * deciding to apply it, or calls the one-shot `merge()`.
 *
 * Apply-time re-verification is UNCHANGED (a plan-time
 * conflict, an apply-time drift is still a refusal). The plan-time preview
 * takes no per-graph write lock (see `assertResolvedPlanEdgesAcyclic`'s
 * docblock) and is inherently racy against a concurrent writer, so a cycle
 * that only appears from a write landing between planning and commit is
 * still caught by the ordinary write-path fence and
 * surfaces as `MergeConstraintConflictError` wrapping `EdgeAcyclicityError`,
 * exactly as before this change. The write path's own in-batch-cycle
 * refusal (`bulkCreate`) is pinned unchanged in
 * `tests/backends/integration/edge-acyclicity.ts` ("refuses an in-batch
 * cycle in bulkCreate with zero rows committed").
 *
 * Mutation check: making `readProposedEdgeAcyclicityViolations`
 * (src/store/acyclicity.ts) report only rows whose own `to` already reaches
 * their own `from` over stored edges makes `planMerge()` resolve `ok` for the
 * purely-proposed cycle in case (a) below instead of refusing — the plan
 * "passes" — and a subsequent `applyMergePlan()`-equivalent write then
 * refuses via the unchanged apply-time path (`MergeConstraintConflictError`
 * / `EdgeAcyclicityError`), never committing the cycle.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { AcyclicityMergeConflictError } from "../../src/graph-merge/errors";
import { merge, planMerge } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { withBindBudget } from "../backends/integration/bind-budget";
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

    // The plan removes an edge and adds its reverse. Apply deletes before it
    // writes, so the result is a DAG; the preview must judge that result, not
    // the new edge layered onto the row the same plan removes.
    //
    // MUTATION CHECK (both cases): not passing the plan's edge deletions to
    // `readProposedEdgeAcyclicityViolations` in
    // `assertResolvedPlanEdgesAcyclic` refuses each with
    // AcyclicityMergeConflictError — verified and reverted.
    it("(d) previews more proposed edges than one acyclicity statement can carry", async () => {
      const bindBudget = 100;
      const edgeCount = 30;
      const [target] = await createStoreWithSchema(
        graph,
        withBindBudget(await makeBackend(), bindBudget),
        { revisionTracking: true },
      );
      const ids = Array.from(
        { length: edgeCount + 1 },
        (_unused, index) => `t${String(index)}`,
      );
      for (const id of ids) {
        await target.nodes.Task.create({ key: id }, { id });
      }

      const chained = await makeBranch(target, "chained");
      for (const [index, id] of ids.slice(0, -1).entries()) {
        await chained.store.edges.dependsOn.create(
          { kind: "Task", id },
          { kind: "Task", id: requireDefined(ids[index + 1]) },
          {},
        );
      }

      // MUTATION CHECK: sending every proposed edge in one statement
      // (`readUnwrittenEdgeReaches` never slicing) binds more than the budget
      // for these 30 edges, and the budgeted backend refuses the plan's
      // preview — verified and reverted.
      expect(isErr(await planMerge(target, [chained]))).toBe(false);
    });

    it("(c) merges a branch that reverses an edge of an acyclic relation", async () => {
      const target = await makeTarget();
      await target.nodes.Task.create({ key: "a" }, { id: "a" });
      await target.nodes.Task.create({ key: "b" }, { id: "b" });
      const forward = await target.edges.dependsOn.create(
        { kind: "Task", id: "a" },
        { kind: "Task", id: "b" },
        {},
        { id: "ab" },
      );

      const reversal = await makeBranch(target, "reversal");
      await reversal.store.edges.dependsOn.delete(forward.id);
      await reversal.store.edges.dependsOn.create(
        { kind: "Task", id: "b" },
        { kind: "Task", id: "a" },
        {},
        { id: "ba" },
      );

      expect(isErr(await planMerge(target, [reversal]))).toBe(false);
      expect(isErr(await merge(target, [reversal]))).toBe(false);

      const stored = await target.edges.dependsOn.find({});
      expect(stored.map((edge) => edge.id)).toEqual(["ba"]);
      expect(await target.verifyConstraintFences()).toEqual([]);
    });

    it("(c) merges a branch that re-roots a chain of an acyclic relation", async () => {
      const target = await makeTarget();
      for (const id of ["a", "b", "c"]) {
        await target.nodes.Task.create({ key: id }, { id });
      }
      await target.edges.dependsOn.create(
        { kind: "Task", id: "a" },
        { kind: "Task", id: "b" },
        {},
        { id: "ab" },
      );
      const tail = await target.edges.dependsOn.create(
        { kind: "Task", id: "b" },
        { kind: "Task", id: "c" },
        {},
        { id: "bc" },
      );

      const reroot = await makeBranch(target, "reroot");
      await reroot.store.edges.dependsOn.delete(tail.id);
      await reroot.store.edges.dependsOn.create(
        { kind: "Task", id: "c" },
        { kind: "Task", id: "a" },
        {},
        { id: "ca" },
      );

      expect(isErr(await merge(target, [reroot]))).toBe(false);

      const stored = await target.edges.dependsOn.find({});
      expect(stored.map((edge) => edge.id).toSorted()).toEqual(["ab", "ca"]);
    });
  },
);

/**
 * A reflexive `oneActive` composition: a move ENDS the incumbent's window,
 * and the ended row is history, outside the composition relation. A branch,
 * a clone and a merge must all judge it that way, or the documented "former
 * ancestor under former descendant" move becomes unmergeable.
 */
const Folder = defineNode("Folder", { schema: z.object({}) });
const inFolder = defineEdge("inFolder", {
  schema: z.object({ note: z.string().optional() }),
});
const folderGraph = defineGraph({
  id: "merge_composition_history_test",
  nodes: { Folder: { type: Folder } },
  edges: {
    inFolder: {
      type: inFolder,
      from: [Folder],
      to: [Folder],
      cardinality: "oneActive",
    },
  },
  ontology: [partOf(Folder, Folder, { via: inFolder, partSide: "from" })],
});

const folder = (id: string) => ({ kind: "Folder" as const, id });

describe.each(backendMatrix())(
  "merge planner: composition history is outside the composition relation [$name]",
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

    /** `B` moved out of `A` (that row ended) and `A` then placed under `B`. */
    async function storeWithHistory(): Promise<Store<typeof folderGraph>> {
      const [store] = await createStoreWithSchema(
        folderGraph,
        await makeBackend(),
        { revisionTracking: true },
      );
      await store.nodes.Folder.create({}, { id: "A" });
      await store.nodes.Folder.create({}, { id: "C" });
      await store.nodes.Folder.create(
        {},
        { id: "B", partOf: { whole: folder("A") } },
      );
      await store.nodes.Folder.reparent(asNodeId<typeof Folder>("B"), {
        whole: folder("C"),
      });
      await store.edges.inFolder.create(folder("A"), folder("B"), {});
      expect(await store.verifyConstraintFences()).toEqual([]);
      return store;
    }

    async function liveLinks(
      store: Store<typeof folderGraph>,
    ): Promise<readonly string[]> {
      return (await store.edges.inFolder.find({}))
        .map((edge) => `${edge.fromId}->${edge.toId}`)
        .toSorted();
    }

    it("(e) branches a store whose history placed a former whole under its part", async () => {
      const source = await storeWithHistory();

      // MUTATION CHECK: drop the `acyclicRelationCountsRow` filter from
      // `groupProposedByAcyclicRelation` (src/store/acyclicity.ts) — the
      // clone's import then refuses the ended `B -> A` row as closing a
      // cycle, and `branch()` fails with a `BranchError`.
      const cloned = unwrap(
        await branch(source, () => makeBackend(), { id: asBranchId("copy") }),
      );

      expect(
        await cloned.store.edges.inFolder.find(
          {},
          { temporalMode: "includeEnded" },
        ),
      ).toHaveLength(3);
      expect(await liveLinks(cloned.store)).toEqual(await liveLinks(source));
    });

    it("(f) merges a branch that moves a part out and then places its former whole under it", async () => {
      const [target] = await createStoreWithSchema(
        folderGraph,
        await makeBackend(),
        { revisionTracking: true },
      );
      await target.nodes.Folder.create({}, { id: "A" });
      await target.nodes.Folder.create({}, { id: "C" });
      await target.nodes.Folder.create(
        {},
        { id: "B", partOf: { whole: folder("A") } },
      );
      const moves = unwrap(
        await branch(target, () => makeBackend(), { id: asBranchId("moves") }),
      );
      await moves.store.nodes.Folder.reparent(asNodeId<typeof Folder>("B"), {
        whole: folder("C"),
      });
      await moves.store.edges.inFolder.create(folder("A"), folder("B"), {});

      // MUTATION CHECK: project `validTo: undefined` for every merged edge in
      // `resolvedPlanAcyclicityCandidates` (src/graph-merge/merge.ts) — the
      // preview then counts the ended `B -> A` as a member and refuses the
      // plan with `AcyclicityMergeConflictError`.
      const result = await merge(target, [moves]);
      expect(isErr(result)).toBe(false);
      expect(await liveLinks(target)).toEqual(["A->B", "B->C"]);
      expect(await target.verifyConstraintFences()).toEqual([]);
    });

    it("(g) merges a branch that edits an ended history row without restating its window", async () => {
      const target = await storeWithHistory();
      const ended = requireDefined(
        (
          await target.edges.inFolder.find({}, { temporalMode: "includeEnded" })
        ).find((edge) => edge.meta.validTo !== undefined),
      );
      const edits = unwrap(
        await branch(target, () => makeBackend(), { id: asBranchId("edits") }),
      );
      await edits.store.edges.inFolder.update(ended.id, { note: "moved" });

      // MUTATION CHECK: read no stored row in
      // `resolvedPlanAcyclicityCandidates` (src/graph-merge/merge.ts),
      // treating a write that states no window end as open — the preview then
      // proposes the ended row as a live member and refuses the plan.
      const result = await merge(target, [edits]);
      expect(isErr(result)).toBe(false);
      const edited = requireDefined(
        await target.edges.inFolder.getById(ended.id, {
          temporalMode: "includeEnded",
        }),
      );
      expect(edited.note).toBe("moved");
      expect(edited.meta.validTo).toBe(ended.meta.validTo);
      expect(await target.verifyConstraintFences()).toEqual([]);
    });
  },
);
