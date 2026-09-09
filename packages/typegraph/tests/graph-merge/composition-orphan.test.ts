/**
 * The composition orphan conflict (E-c §4.5): a part attached on the target
 * AFTER the branch point, whose whole the branch deletes, is a typed
 * conflict — reported on the plan's review payload at plan time, and refused
 * at apply time under the write lock.
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
 *    `planMergeIncremental` reports it as a `compositionOrphans` entry;
 *    `applyMergePlan` refuses with `MergeCompositionOrphanError` (code
 *    `MERGE_COMPOSITION_ORPHAN`), and NOTHING changes on the target.
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
 * `runCompositionCascade` itself fails six other tests there), and this
 * file's own first scenario proves the orphan refusal fires with zero rows
 * changed regardless of `cascadeComposition`.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
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
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { isErr, isOk } from "../../src/graph-merge/result";
import { asBranchId, type GraphBranch } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Whole = defineNode("Whole", { schema: z.object({}) });
const Part = defineNode("Part", { schema: z.object({}) });
const holds = defineEdge("holds", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition-orphan-test",
  nodes: {
    Whole: { type: Whole },
    // `disconnect`, not the default `restrict`: merge apply deletes nodes
    // BEFORE edges (`applyNodeRows` runs, then `applyEdgeRows`), so when a
    // plan deletes BOTH endpoints of one edge in the same apply, each
    // endpoint's own delete-behavior enforcement still sees that edge as
    // live and unconsumed (merge apply's per-delete policy carries no
    // `consumedEdgeIds` — it is not itself a cascade). A `restrict` Part
    // would refuse to delete under that ordering regardless of composition;
    // this fixture is about the orphan conflict, not that separate,
    // pre-existing node/edge apply-ordering characteristic.
    Part: { type: Part, onDelete: "disconnect" },
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

    it("reports and refuses a part attached to the target after the branch point", async () => {
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

      // The TARGET: independently at the same fork-point state, but with a
      // SECOND part attached after the branch was forked — something the
      // branch's diff has no way to know about.
      const target = await makeStore();
      const targetWhole = await target.nodes.Whole.create({}, { id: "w1" });
      const targetOriginalPart = await target.nodes.Part.create(
        {},
        { id: "p1" },
      );
      await target.edges.holds.create(targetOriginalPart, targetWhole, {});
      const lateAttachedPart = await target.nodes.Part.create({}, { id: "p2" });
      await target.edges.holds.create(lateAttachedPart, targetWhole, {});

      const planResult = await planMergeIncremental<G>({
        forkPoint,
        target,
        branches: [branchA],
      });
      expect(isOk(planResult)).toBe(true);
      if (!isOk(planResult)) throw planResult.error;
      const artifact = planResult.data;

      expect(artifact.review.compositionOrphans).toEqual([
        {
          part: { kind: "Part", id: "p2" },
          whole: { kind: "Whole", id: "w1" },
          viaEdgeKind: "holds",
        },
      ]);

      const applyResult = await applyMergePlan(target, artifact);
      expect(isErr(applyResult)).toBe(true);
      if (!isErr(applyResult)) throw new Error("expected apply to be refused");
      expect(applyResult.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(applyResult.error.code).toBe("MERGE_COMPOSITION_ORPHAN");

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
      // is still live — the state EC-R2-1 fixed a direct `restrict` delete
      // from ever leaving behind, reachable today only from a legacy row or
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
      // `planCompositionCascade` (return `discoveryOrder` unfiltered) and
      // this reports `p2` as an orphan instead of an empty array — a dead
      // node is not a live composition part for a caller to act on.
      expect(artifact.review.compositionOrphans).toEqual([]);

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

      expect(artifact.review.compositionOrphans).toEqual([]);
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
// `registry.getCompositionEdge(member.kind, root.whole.kind)` instead of
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
      // instead of returning a plan, because `getCompositionEdge("Leaf",
      // "Whole")` is undefined — no pair declares Leaf directly under
      // Whole.
      const planResult = await planMergeIncremental<NestedG>({
        forkPoint,
        target,
        branches: [branchA],
      });
      expect(isOk(planResult)).toBe(true);
      if (!isOk(planResult)) throw planResult.error;
      const artifact = planResult.data;

      // MUTATION (verified): reverting `compositionOrphansAmong` to its
      // pre-fix shape — a plain `orphans.push` (no dedupe) that re-derives
      // the pair via `registry.getCompositionEdge(member.kind, whole.kind)`
      // (the ROOT `whole` of the OUTER loop, not `member.whole`) — makes
      // `isOk(planResult)` false above (the TypeError, wrapped as
      // `GRAPH_MERGE_ERROR`). Reverting ONLY the pair-derivation while
      // LEAVING the dedupe-by-part-key in place does not reliably reproduce
      // the crash: `Part` "p1" is itself in `wholes` (it declares its own
      // composition parts, via `holdsLeaf`), and `Part`'s OWN walk resolves
      // Leaf's pair correctly (`whole.kind` IS `member`'s immediate whole at
      // that call site) — if `wholes` happens to order `p1` before `w1`, the
      // dedupe skips `w1`'s walk over the same member before it reaches the
      // buggy line. The revert/restore check above is against the FULL
      // pre-fix function, which is the reliable, order-independent
      // reproduction.
      expect(artifact.review.compositionOrphans).toEqual([
        {
          part: { kind: "Leaf", id: "l1" },
          whole: { kind: "Part", id: "p1" },
          viaEdgeKind: "holdsLeaf",
        },
      ]);

      const applyResult = await applyMergePlan(target, artifact);
      expect(isErr(applyResult)).toBe(true);
      if (!isErr(applyResult)) throw new Error("expected apply to be refused");
      expect(applyResult.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(applyResult.error.code).toBe("MERGE_COMPOSITION_ORPHAN");

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
