/**
 * The composition orphan conflict: a part attached on the target
 * AFTER the branch point, whose whole the branch deletes, is a typed
 * conflict — refused at plan time, and again at apply time under the write
 * lock for an artifact fenced to a target that has since gained the part.
 *
 * Modeled through `planMergeIncremental`/`applyMergePlan`, whose whole
 * purpose is a target that moved on independently of the fork point — the
 * EXACT shape this conflict needs and the snapshot `base@V` contract
 * (`planMerge`) refuses outright (a target write after the fork point is
 * precisely what it exists to reject).
 *
 * Fixture: `Whole` --holds(cardinality "one")-- `Part`,
 * `partOf(Part, Whole, { via: holds })`. Two scenarios:
 *
 *  - The target gains a NEW part after the fork point. The branch's own diff
 *    (against the fork point) knows nothing of it, so it is absent from the
 *    plan's `nodeDeletions` even though the branch deletes the whole.
 *    `planMergeIncremental` refuses with `MergeCompositionOrphanError` (code
 *    `GRAPH_MERGE_COMPOSITION_ORPHAN`); `applyMergePlan` refuses the same
 *    finding, and NOTHING changes on the target.
 *  - The mirror: the target MOVES a part to another whole after the fork
 *    point, and the branch deletes the part's old whole, cascading its own
 *    copy of the part. The plan deletes the part, which the target now holds
 *    under a whole the plan leaves standing; it is refused with
 *    `cause: "moved"`, through the live merge too.
 *  - The branch deletes the whole AND its part (the ordinary case: the
 *    branch's own runtime cascade already recorded the part's deletion in
 *    its local diff against the fork point, so the plan's `nodeDeletions`
 *    already carries both, and the target evolved no differently). Apply
 *    succeeds with `cascadeComposition: false` — trusting the plan rather
 *    than re-cascading — and a delete-count hook proves EXACTLY the planned
 *    two nodes were deleted, not more.
 *
 * MUTATION CHECK, with a caveat: flipping merge apply's policy to
 * `cascadeComposition: true` does NOT change either scenario's outcome in
 * THIS minimal two-node fixture — `executeNodeDelete`'s own "already
 * tombstoned" gate absorbs the resulting redundant delete attempt as a
 * silent no-op regardless of which of the two co-planned rows the deletion
 * loop reaches first. The runtime-cascade DISABLE mutation is instead
 * verified directly in `composition-cascade.test.ts` (disabling
 * `applyCompositionCascade` itself fails six other tests there), and this
 * file's own first scenario proves the orphan refusal fires with zero rows
 * changed regardless of `cascadeComposition`.
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
import { MergeCompositionOrphanError } from "../../src/graph-merge/errors";
import {
  applyMergePlan,
  mergeIncremental,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { asBranchId, type GraphBranch } from "../../src/graph-merge/types";
import { backendMatrix, refenceMergePlan } from "./test-utils";

const Whole = defineNode("Whole", { schema: z.object({}) });
const Part = defineNode("Part", { schema: z.object({}) });
const holds = defineEdge("holds", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition-orphan-test",
  nodes: {
    Whole: { type: Whole },
    Part: { type: Part },
  },
  edges: {
    holds: {
      type: holds,
      from: [Part],
      to: [Whole],
      cardinality: "one",
    },
  },
  ontology: [partOf(Part, Whole, { via: holds })],
});
type G = typeof graph;

const BRANCH_A = asBranchId("branch-a");
const TARGET_CLONE = asBranchId("target-clone");

describe.each(backendMatrix())(
  "composition orphan conflict [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    afterEach(async () => {
      for (const cleanup of cleanups ?? []) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeStore(
      onOperationEnd?: (
        ctx: Readonly<{ operation: string; id: string }>,
      ) => void,
    ): Promise<Store<G>> {
      const [store] = await createStoreWithSchema(graph, await makeBackend(), {
        revisionTracking: true,
        ...(onOperationEnd === undefined ? {} : { hooks: { onOperationEnd } }),
      });
      return store;
    }

    async function makeBranchOf(
      forkPoint: Store<G>,
      id: ReturnType<typeof asBranchId>,
    ): Promise<GraphBranch<G>> {
      const result = await branch<G>(forkPoint, () => makeBackend(), { id });
      if (isErr(result)) throw result.error;
      return result.data;
    }

    it("refuses at plan time a part attached to the target after the branch point, and apply re-verifies it", async () => {
      cleanups = [];
      // The fork point: the state the branch saw.
      const forkPoint = await makeStore();
      const whole = await forkPoint.nodes.Whole.create({}, { id: "w1" });
      const originalPart = await forkPoint.nodes.Part.create({}, { id: "p1" });
      await forkPoint.edges.holds.create(originalPart, whole, {});

      const branchA = await makeBranchOf(forkPoint, BRANCH_A);
      // The branch deletes the whole, cascading its OWN copy of the
      // original part (recorded in the branch's diff against the fork
      // point).
      await branchA.store.nodes.Whole.delete(whole.id);

      // The TARGET: independently at the same fork-point state.
      const target = await makeStore();
      const targetWhole = await target.nodes.Whole.create({}, { id: "w1" });
      const targetOriginalPart = await target.nodes.Part.create(
        {},
        { id: "p1" },
      );
      await target.edges.holds.create(targetOriginalPart, targetWhole, {});
      // Planned before the target gains its late part: a clean plan.
      const cleanPlan = unwrap(
        await planMergeIncremental<G>({
          forkPoint,
          target,
          branches: [branchA],
        }),
      );

      // A SECOND part attached after the branch was forked — something the
      // branch's diff has no way to know about.
      const lateAttachedPart = await target.nodes.Part.create({}, { id: "p2" });
      await target.edges.holds.create(lateAttachedPart, targetWhole, {});
      const orphan = {
        part: { kind: "Part", id: "p2" },
        whole: { kind: "Whole", id: "w1" },
        viaEdgeKind: "holds",
        cause: "deleted",
      };

      // The plan's revision fence makes this a certain apply refusal, so the
      // planner refuses it instead of returning a plan that cannot apply.
      const planResult = await planMergeIncremental<G>({
        forkPoint,
        target,
        branches: [branchA],
      });
      if (!isErr(planResult)) throw new Error("expected a plan-time refusal");
      expect(planResult.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(planResult.error.code).toBe("GRAPH_MERGE_COMPOSITION_ORPHAN");
      expect(planResult.error.details).toEqual(orphan);

      // Apply's own re-verification, reached by an artifact fenced to the
      // target's current state, refuses the same finding under the lock.
      const applyResult = await applyMergePlan(
        target,
        await refenceMergePlan(target, cleanPlan),
      );
      if (!isErr(applyResult)) throw new Error("expected apply to be refused");
      expect(applyResult.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(applyResult.error.details).toEqual(orphan);

      // Nothing changed: the refusal fires before any row work in this apply.
      await expect(
        target.nodes.Whole.getById(targetWhole.id),
      ).resolves.toBeDefined();
      await expect(
        target.nodes.Part.getById(targetOriginalPart.id),
      ).resolves.toBeDefined();
      await expect(
        target.nodes.Part.getById(lateAttachedPart.id),
      ).resolves.toBeDefined();
    });

    it("refuses at plan time deleting a part the target moved to a whole the plan keeps, and apply re-verifies it", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await forkPoint.nodes.Whole.create({}, { id: "w1" });
      await forkPoint.nodes.Whole.create({}, { id: "w2" });
      await forkPoint.nodes.Part.create(
        {},
        { id: "p1", partOf: { whole: { kind: "Whole", id: "w1" } } },
      );

      const branchA = await makeBranchOf(forkPoint, BRANCH_A);
      // The branch deletes the whole; its cascade deletes the branch's own
      // copy of the part.
      await branchA.store.nodes.Whole.delete(asNodeId("w1"));
      await expect(
        branchA.store.nodes.Part.getById(asNodeId("p1")),
      ).resolves.toBe(undefined);

      // The target is a clone of the fork point that moves the part to the
      // second whole — an edge the branch never saw. Planned before that
      // move, the plan is clean.
      const target = (await makeBranchOf(forkPoint, TARGET_CLONE)).store;
      const cleanPlan = unwrap(
        await planMergeIncremental<G>({
          forkPoint,
          target,
          branches: [branchA],
        }),
      );
      await target.nodes.Part.reparent(asNodeId("p1"), {
        whole: { kind: "Whole", id: "w2" },
      });
      const orphan = {
        part: { kind: "Part", id: "p1" },
        whole: { kind: "Whole", id: "w2" },
        viaEdgeKind: "holds",
        cause: "moved",
      };

      // Apply's own re-verification refuses the clean plan fenced to the
      // target's current state, through the same predicate.
      const applyResult = await applyMergePlan(
        target,
        await refenceMergePlan(target, cleanPlan),
      );
      if (!isErr(applyResult)) throw new Error("expected apply to be refused");
      expect(applyResult.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(applyResult.error.details).toEqual(orphan);

      const planned = await planMergeIncremental<G>({
        forkPoint,
        target,
        branches: [branchA],
      });
      if (!isErr(planned)) throw new Error("expected a plan-time refusal");
      expect(planned.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(planned.error.details).toEqual(orphan);

      const merged = await mergeIncremental<G>({
        forkPoint,
        target,
        branches: [branchA],
      });
      if (!isErr(merged)) throw new Error("expected the merge to be refused");
      expect(merged.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(merged.error.details).toEqual(orphan);

      // Nothing changed: both wholes, the part and its new edge survive.
      await expect(
        target.nodes.Whole.getById(asNodeId("w1")),
      ).resolves.toBeDefined();
      await expect(
        target.nodes.Part.getById(asNodeId("p1")),
      ).resolves.toBeDefined();
      const edges = await target.edges.holds.find();
      expect(edges.map((edge) => edge.toId)).toEqual(["w2"]);
    });

    it("applies a branch that deletes a part the target left under its whole", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await forkPoint.nodes.Whole.create({}, { id: "w1" });
      await forkPoint.nodes.Part.create(
        {},
        { id: "p1", partOf: { whole: { kind: "Whole", id: "w1" } } },
      );

      const branchA = await makeBranchOf(forkPoint, BRANCH_A);
      await branchA.store.nodes.Part.delete(asNodeId("p1"));

      const target = (await makeBranchOf(forkPoint, TARGET_CLONE)).store;

      const artifact = unwrap(
        await planMergeIncremental<G>({
          forkPoint,
          target,
          branches: [branchA],
        }),
      );
      unwrap(await applyMergePlan(target, artifact));
      await expect(target.nodes.Part.getById(asNodeId("p1"))).resolves.toBe(
        undefined,
      );
      await expect(
        target.nodes.Whole.getById(asNodeId("w1")),
      ).resolves.toBeDefined();
      expect(await target.edges.holds.find()).toEqual([]);
    });

    it("does not report an already-dead part (its composition edge survives its endpoint) as an orphan", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      const whole = await forkPoint.nodes.Whole.create({}, { id: "w1" });
      const originalPart = await forkPoint.nodes.Part.create({}, { id: "p1" });
      await forkPoint.edges.holds.create(originalPart, whole, {});

      const branchA = await makeBranchOf(forkPoint, BRANCH_A);
      await branchA.store.nodes.Whole.delete(whole.id);

      // The target: independently at the same fork-point state, but with a
      // SECOND part whose node row is already dead while its `holds` edge
      // is still live — the state a direct `restrict` delete can no longer
      // leave behind, reachable today only from a legacy row or
      // a write that bypasses the ordinary delete pipeline. Written directly
      // through the backend seam (never through `store.nodes.Part.delete`,
      // which cleans up its own composition edges) to construct that state
      // deliberately.
      const targetBackend = await makeBackend();
      const [target] = await createStoreWithSchema(graph, targetBackend, {
        revisionTracking: true,
      });
      const targetWhole = await target.nodes.Whole.create({}, { id: "w1" });
      const targetOriginalPart = await target.nodes.Part.create(
        {},
        { id: "p1" },
      );
      await target.edges.holds.create(targetOriginalPart, targetWhole, {});
      const deadPart = await target.nodes.Part.create({}, { id: "p2" });
      await target.edges.holds.create(deadPart, targetWhole, {});
      await targetBackend.deleteNode({
        graphId: graph.id,
        kind: "Part",
        id: deadPart.id,
      });

      const planResult = await planMergeIncremental<G>({
        forkPoint,
        target,
        branches: [branchA],
      });
      expect(isOk(planResult)).toBe(true);
      if (!isOk(planResult)) throw planResult.error;
      const artifact = planResult.data;

      // MUTATION: drop `liveDiscoveredMembers`'s filter from
      // `planCompositionCascade` (keep every discovered member, live or not) and
      // this reports `p2` as an orphan instead of an empty array — a dead
      // node is not a live composition part for a caller to act on.

      const applyResult = await applyMergePlan(target, artifact);
      expect(isOk(applyResult)).toBe(true);

      await expect(
        target.nodes.Whole.getById(targetWhole.id),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.Part.getById(targetOriginalPart.id),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.Part.getById(deadPart.id),
      ).resolves.toBeUndefined();
    });

    it("applies a plan that already carries the whole AND its part, deleting exactly those two — no extra cascade", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      const whole = await forkPoint.nodes.Whole.create({}, { id: "w1" });
      const part = await forkPoint.nodes.Part.create({}, { id: "p1" });
      await forkPoint.edges.holds.create(part, whole, {});

      const branchA = await makeBranchOf(forkPoint, BRANCH_A);
      // The branch's own cascade deletes both the whole and its part; both
      // land in the branch's diff against the fork point.
      await branchA.store.nodes.Whole.delete(whole.id);

      // The target evolved no differently from the fork point.
      const deletedIds: string[] = [];
      const target = await makeStore((ctx) => {
        if (ctx.operation === "delete") deletedIds.push(ctx.id);
      });
      const targetWhole = await target.nodes.Whole.create({}, { id: "w1" });
      const targetPart = await target.nodes.Part.create({}, { id: "p1" });
      await target.edges.holds.create(targetPart, targetWhole, {});

      const planResult = await planMergeIncremental<G>({
        forkPoint,
        target,
        branches: [branchA],
      });
      expect(isOk(planResult)).toBe(true);
      if (!isOk(planResult)) throw planResult.error;
      const artifact = planResult.data;

      expect(
        [...artifact.writes.nodeDeletes].map((entity) => entity.id).toSorted(),
      ).toEqual(["p1", "w1"]);

      deletedIds.length = 0;
      const applyResult = await applyMergePlan(target, artifact);
      expect(isOk(applyResult)).toBe(true);

      await expect(
        target.nodes.Whole.getById(targetWhole.id),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.Part.getById(targetPart.id),
      ).resolves.toBeUndefined();

      // Exactly the planned two deletes — `cascadeComposition: false` means
      // apply trusted the plan rather than re-walking the closure and
      // attempting a redundant delete of the already-deleted part.
      expect(deletedIds.toSorted()).toEqual(["p1", "w1"]);
    });
  },
);

// ============================================================
// Depth-2 fixture: Whole -[holds]- Part -[holdsLeaf]- Leaf
//
// `compositionOrphansAmong` walks the closure from the ROOT whole
// (`Whole`), so a depth-2 member (`Leaf`) never has a directly declared
// composition pair against the root. Its own immediate whole is `Part`,
// realized by a DIFFERENT edge kind (`holdsLeaf`) than the one that binds
// `Part` to `Whole` (`holds`). This is what regresses a fix that re-derives
// "which pair realizes this membership" via
// `registry.compositionPairsBetween(member.kind, root.whole.kind)` instead of
// reading the pair `planCompositionCascade` already resolved per member.
// ============================================================

const Leaf = defineNode("Leaf", { schema: z.object({}) });
const holdsLeaf = defineEdge("holdsLeaf", { schema: z.object({}) });

const nestedGraph = defineGraph({
  id: "composition-orphan-nested-test",
  nodes: {
    Whole: { type: Whole },
    Part: { type: Part, onDelete: "disconnect" },
    Leaf: { type: Leaf, onDelete: "disconnect" },
  },
  edges: {
    holds: { type: holds, from: [Part], to: [Whole], cardinality: "one" },
    holdsLeaf: {
      type: holdsLeaf,
      from: [Leaf],
      to: [Part],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(Part, Whole, { via: holds }),
    partOf(Leaf, Part, { via: holdsLeaf }),
  ],
});
type NestedG = typeof nestedGraph;

describe.each(backendMatrix())(
  "composition orphan conflict — depth 2 [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    afterEach(async () => {
      for (const cleanup of cleanups ?? []) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeStore(): Promise<Store<NestedG>> {
      const [store] = await createStoreWithSchema(
        nestedGraph,
        await makeBackend(),
        { revisionTracking: true },
      );
      return store;
    }

    async function makeBranchOf(
      forkPoint: Store<NestedG>,
      id: ReturnType<typeof asBranchId>,
    ): Promise<GraphBranch<NestedG>> {
      const result = await branch<NestedG>(forkPoint, () => makeBackend(), {
        id,
      });
      if (isErr(result)) throw result.error;
      return result.data;
    }

    it("carries a deeper part away with the intermediate part a branch moves off the whole it deletes", async () => {
      cleanups = [];
      // Fork point: w1 <- p1 <- l1, and a second whole w2.
      const forkPoint = await makeStore();
      const oldWhole = await forkPoint.nodes.Whole.create({}, { id: "w1" });
      const newWhole = await forkPoint.nodes.Whole.create({}, { id: "w2" });
      const part = await forkPoint.nodes.Part.create({}, { id: "p1" });
      const leaf = await forkPoint.nodes.Leaf.create({}, { id: "l1" });
      const binding = await forkPoint.edges.holds.create(part, oldWhole, {});
      await forkPoint.edges.holdsLeaf.create(leaf, part, {});
      const target = (await makeBranchOf(forkPoint, TARGET_CLONE)).store;

      // The branch moves p1 (and so l1 beneath it) to w2, then deletes w1.
      const branchA = await makeBranchOf(forkPoint, BRANCH_A);
      await branchA.store.edges.holds.delete(binding.id);
      await branchA.store.edges.holds.create(part, newWhole, {});
      await branchA.store.nodes.Whole.delete(oldWhole.id);

      const planResult = await planMergeIncremental<NestedG>({
        forkPoint,
        target,
        branches: [branchA],
      });
      if (!isOk(planResult)) throw planResult.error;

      const applyResult = await applyMergePlan(target, planResult.data);
      if (isErr(applyResult)) throw applyResult.error;
      await expect(target.nodes.Whole.getById(oldWhole.id)).resolves.toBe(
        undefined,
      );
      await expect(target.nodes.Leaf.getById(leaf.id)).resolves.toBeDefined();
      const heldBy = await target.edges.holds.findFrom(part);
      expect(heldBy.map((edge) => edge.toId)).toEqual([newWhole.id]);
    });

    it("reports the orphan against its OWN immediate whole (Part), not the cascade root (Whole), for a part attached two levels deep", async () => {
      cleanups = [];
      // Fork point: Whole w1 with Part p1, no Leaf yet.
      const forkPoint = await makeStore();
      const whole = await forkPoint.nodes.Whole.create({}, { id: "w1" });
      const part = await forkPoint.nodes.Part.create({}, { id: "p1" });
      await forkPoint.edges.holds.create(part, whole, {});

      const branchA = await makeBranchOf(forkPoint, BRANCH_A);
      // The branch deletes the whole, cascading its own copy of Part.
      await branchA.store.nodes.Whole.delete(whole.id);

      // The TARGET: same fork-point state, but a Leaf was attached under
      // Part AFTER the fork — two levels below the whole the branch deletes.
      const target = await makeStore();
      const targetWhole = await target.nodes.Whole.create({}, { id: "w1" });
      const targetPart = await target.nodes.Part.create({}, { id: "p1" });
      await target.edges.holds.create(targetPart, targetWhole, {});
      const lateLeaf = await target.nodes.Leaf.create({}, { id: "l1" });
      await target.edges.holdsLeaf.create(lateLeaf, targetPart, {});

      // Before the fix: this throws a raw `TypeError` out of
      // `requireDefined` (wrapped as `MergeError`/`GRAPH_MERGE_ERROR`)
      // instead of the orphan refusal, because no pair declares "Leaf"
      // directly under "Whole".
      const planResult = await planMergeIncremental<NestedG>({
        forkPoint,
        target,
        branches: [branchA],
      });
      if (!isErr(planResult)) throw new Error("expected a plan-time refusal");

      // MUTATION (verified): reverting `compositionOrphansAmong` to its
      // pre-fix shape — a plain `orphans.push` (no dedupe) that re-derives
      // the pair via a (part, whole)-only pair lookup
      // (the ROOT `whole` of the OUTER loop, not `member.whole`) — turns the
      // refusal above into the TypeError, wrapped as `GRAPH_MERGE_ERROR`.
      // Reverting ONLY the pair-derivation while
      // LEAVING the dedupe-by-part-key in place does not reliably reproduce
      // the crash: `Part` "p1" is itself in `wholes` (it declares its own
      // composition parts, via `holdsLeaf`), and `Part`'s OWN walk resolves
      // Leaf's pair correctly (`whole.kind` IS `member`'s immediate whole at
      // that call site) — if `wholes` happens to order `p1` before `w1`, the
      // dedupe skips `w1`'s walk over the same member before it reaches the
      // buggy line. The revert/restore check above is against the FULL
      // pre-fix function, which is the reliable, order-independent
      // reproduction.
      expect(planResult.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(planResult.error.code).toBe("GRAPH_MERGE_COMPOSITION_ORPHAN");
      expect(planResult.error.details).toEqual({
        part: { kind: "Leaf", id: "l1" },
        whole: { kind: "Part", id: "p1" },
        viaEdgeKind: "holdsLeaf",
        cause: "deleted",
      });

      // Nothing changed.
      await expect(
        target.nodes.Whole.getById(targetWhole.id),
      ).resolves.toBeDefined();
      await expect(
        target.nodes.Part.getById(targetPart.id),
      ).resolves.toBeDefined();
      await expect(
        target.nodes.Leaf.getById(lateLeaf.id),
      ).resolves.toBeDefined();
    });
  },
);
