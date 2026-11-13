/**
 * Composition writes replayed by a graph merge.
 *
 * A branch realizes composition through the store's own composition-aware
 * entries (`create` with `partOf`, `reparent`, a whole's cascading delete). A
 * merge replays the resulting rows one write at a time, so every case here is
 * a branch edit that is valid as a whole and whose individual rows are not:
 * a required part exists before its edge does, a moved part is detached
 * before it is attached again, a deleted whole still shows the part the same
 * plan moves away.
 *
 * Each case runs over the full existence x cardinality matrix where the
 * dimension matters, and plans before it applies: the planner must refuse a
 * plan the apply would refuse, and must accept every plan the apply accepts.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  CompositionError,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  type Store,
  type StoreHooks,
} from "../../../src";
import {
  CardinalityMergeConflictError,
  CompositionWindowMergeConflictError,
  isErr,
  MergeConstraintConflictError,
  MergeError,
  unwrap,
} from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  merge,
  mergeIncremental,
  planMerge,
  planMergeIncremental,
} from "../../../src/graph-merge/merge";
import { asBranchId, type GraphBranch } from "../../../src/graph-merge/types";
import { refenceMergePlan } from "../../graph-merge/test-utils";
import { type IntegrationTestContext } from "./test-context";

const Whole = defineNode("GmcWhole", {
  schema: z.object({ label: z.string() }),
});
const Part = defineNode("GmcPart", { schema: z.object({ label: z.string() }) });
const holds = defineEdge("gmcHolds", { schema: z.object({}) });

const EXISTENCES = ["required", "optional"] as const;
const CARDINALITIES = ["one", "oneActive"] as const;

type Existence = (typeof EXISTENCES)[number];
type Cardinality = (typeof CARDINALITIES)[number];

function compositionGraph(existence: Existence, cardinality: Cardinality) {
  return defineGraph({
    id: `graph_merge_composition_${existence}_${cardinality}`,
    nodes: { GmcWhole: { type: Whole }, GmcPart: { type: Part } },
    edges: {
      gmcHolds: { type: holds, from: [Part], to: [Whole], cardinality },
    },
    ontology: [partOf(Part, Whole, { via: holds, existence })],
  });
}

type CompositionGraph = ReturnType<typeof compositionGraph>;
type TestStore = Store<CompositionGraph>;

const MATRIX = EXISTENCES.flatMap((existence) =>
  CARDINALITIES.map((cardinality) => ({ existence, cardinality })),
);

function wholeRef(id: string) {
  return { kind: "GmcWhole", id } as const;
}

async function seededTarget(
  context: IntegrationTestContext,
  existence: Existence,
  cardinality: Cardinality,
  hooks?: StoreHooks,
): Promise<TestStore> {
  const target = await context.createStore(
    compositionGraph(existence, cardinality),
    { revisionTracking: true, ...(hooks === undefined ? {} : { hooks }) },
  );
  await target.nodes.GmcWhole.create({ label: "w1" }, { id: "w1" });
  await target.nodes.GmcWhole.create({ label: "w2" }, { id: "w2" });
  await target.nodes.GmcPart.create(
    { label: "p1" },
    { id: "p1", partOf: { whole: wholeRef("w1") } },
  );
  return target;
}

async function fork(
  context: IntegrationTestContext,
  target: TestStore,
  id = "branch-a",
): Promise<GraphBranch<CompositionGraph>> {
  return unwrap(
    await branch(target, () => context.createIsolatedBackend(), {
      id: asBranchId(id),
    }),
  );
}

/** Asserts a plan was refused because two edges would hold one part's whole. */
function expectOccupiedWholeConflict(error: MergeError): void {
  expect(error).toBeInstanceOf(CardinalityMergeConflictError);
  expect(error.cause).toBeInstanceOf(CompositionError);
  expect(error.details).toMatchObject({
    constraintCode: "COMPOSITION_WHOLE_OCCUPIED",
    situation: "occupied",
    partId: "p1",
  });
  const { edges } = error.details as Readonly<{
    edges: readonly Readonly<{ fromId: string; toId: string }>[];
  }>;
  expect(edges.map((edge) => edge.fromId)).toEqual(["p1", "p1"]);
}

/** The whole each live part hangs from, by part id. */
async function attachments(
  store: TestStore,
): Promise<Readonly<Record<string, string>>> {
  const edges = await store.edges.gmcHolds.find();
  return Object.fromEntries(edges.map((edge) => [edge.fromId, edge.toId]));
}

async function livePartIds(store: TestStore): Promise<readonly string[]> {
  const parts = await store.nodes.GmcPart.find();
  return parts.map((part) => part.id).toSorted();
}

/** Plans the merge, applies it, and returns nothing. */
async function planThenApply(
  target: TestStore,
  source: GraphBranch<CompositionGraph>,
): Promise<void> {
  const plan = unwrap(await planMerge(target, [source]));
  const applied = await applyMergePlan(target, plan);
  if (isErr(applied)) throw applied.error;
}

const NODE_SINCE = "2018-01-01T00:00:00.000Z";
const Y2019 = "2019-01-01T00:00:00.000Z";
const Y2020 = "2020-01-01T00:00:00.000Z";
const Y2021 = "2021-01-01T00:00:00.000Z";
const Y2022 = "2022-01-01T00:00:00.000Z";
const Y2023 = "2023-01-01T00:00:00.000Z";

/** Ends p1's membership of w1 at 2020 and adds a history row under `whole`. */
async function moveThroughHistory(
  store: TestStore,
  edgeId: string,
  whole: string,
  window: Readonly<{ validFrom: string; validTo: string }>,
): Promise<void> {
  await store.edges.gmcHolds.update(
    asEdgeId<typeof holds>("e0"),
    {},
    { validTo: Y2020 },
  );
  await store.edges.gmcHolds.create(
    { kind: "GmcPart", id: "p1" },
    wholeRef(whole),
    {},
    { id: edgeId, ...window },
  );
}

async function windows(store: TestStore): Promise<readonly string[]> {
  const rows = await store.edges.gmcHolds.find(
    {},
    { temporalMode: "includeEnded" },
  );
  return rows
    .map(
      (edge) =>
        `${edge.id}:${edge.toId} [${edge.meta.validFrom ?? "-"},${edge.meta.validTo ?? "-"})`,
    )
    .toSorted();
}

function expectWindowConflict(
  error: MergeError,
  proposed: string,
  incumbent: string,
): void {
  expect(error).toBeInstanceOf(CompositionWindowMergeConflictError);
  expect(error.cause).toBeInstanceOf(CompositionError);
  expect(error.details).toMatchObject({
    constraintCode: "COMPOSITION_WINDOW_OVERLAP",
    situation: "windowOverlap",
    partKind: "GmcPart",
    partId: "p1",
    edgeId: proposed,
    incumbentEdgeId: incumbent,
  });
  const { edges } = error.details as Readonly<{
    edges: readonly Readonly<{ edgeId: string }>[];
  }>;
  expect(edges.map((edge) => edge.edgeId)).toEqual([incumbent, proposed]);
}

/** p1 under w1 from 2019, on an optional `oneActive` pair that keeps history. */
async function historyTarget(
  context: IntegrationTestContext,
): Promise<TestStore> {
  const target = await context.createStore(
    compositionGraph("optional", "oneActive"),
    { revisionTracking: true },
  );
  for (const id of ["w1", "w2", "w3"]) {
    await target.nodes.GmcWhole.create(
      { label: id },
      { id, validFrom: NODE_SINCE },
    );
  }
  await target.nodes.GmcPart.create(
    { label: "p1" },
    { id: "p1", validFrom: NODE_SINCE },
  );
  await target.edges.gmcHolds.create(
    { kind: "GmcPart", id: "p1" },
    wholeRef("w1"),
    {},
    { id: "e0", validFrom: Y2019 },
  );
  return target;
}

export function registerGraphMergeCompositionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("composition writes replayed by graph merge", () => {
    describe.each(MATRIX)(
      "existence $existence, cardinality $cardinality",
      ({ existence, cardinality }) => {
        it("merges a part created under an existing whole", async () => {
          const target = await seededTarget(context, existence, cardinality);
          const source = await fork(context, target);
          await source.store.nodes.GmcPart.create(
            { label: "p2" },
            { id: "p2", partOf: { whole: wholeRef("w2") } },
          );

          await planThenApply(target, source);

          expect(await livePartIds(target)).toEqual(["p1", "p2"]);
          expect(await attachments(target)).toEqual({ p1: "w1", p2: "w2" });
          expect(await target.verifyConstraintFences()).toEqual([]);
        });

        it("merges a part created together with its whole", async () => {
          const target = await seededTarget(context, existence, cardinality);
          const source = await fork(context, target);
          await source.store.nodes.GmcWhole.create(
            { label: "w3" },
            { id: "w3" },
          );
          await source.store.nodes.GmcPart.create(
            { label: "p3" },
            { id: "p3", partOf: { whole: wholeRef("w3") } },
          );

          const merged = await merge(target, [source]);
          if (isErr(merged)) throw merged.error;

          expect(await attachments(target)).toEqual({ p1: "w1", p3: "w3" });
          expect(await target.verifyConstraintFences()).toEqual([]);
        });

        it("merges a created part through every apply entry", async () => {
          const forkPoint = await seededTarget(context, existence, cardinality);
          const source = await fork(context, forkPoint);
          await source.store.nodes.GmcPart.create(
            { label: "p2" },
            { id: "p2", partOf: { whole: wholeRef("w1") } },
          );
          const expected = { p1: "w1", p2: "w1" };

          // A second clone of the fork point stands in for a live target that
          // is a different store from the immutable fork point.
          const directFork = await fork(context, forkPoint);
          const directTarget = directFork.store;
          const direct = await mergeIncremental({
            forkPoint,
            target: directTarget,
            branches: [source],
          });
          if (isErr(direct)) throw direct.error;
          expect(await attachments(directTarget)).toEqual(expected);
          expect(await directTarget.verifyConstraintFences()).toEqual([]);

          const plannedFork = await fork(context, forkPoint);
          const plannedTarget = plannedFork.store;
          const plan = unwrap(
            await planMergeIncremental({
              forkPoint,
              target: plannedTarget,
              branches: [source],
            }),
          );
          await plannedTarget.transaction((tx) =>
            applyMergePlanInTransaction(plannedTarget, tx, plan),
          );
          expect(await attachments(plannedTarget)).toEqual(expected);
          expect(await plannedTarget.verifyConstraintFences()).toEqual([]);
        });

        it("merges a reparent as one move", async () => {
          const target = await seededTarget(context, existence, cardinality);
          const source = await fork(context, target);
          await source.store.nodes.GmcPart.reparent(
            asNodeId<typeof Part>("p1"),
            {
              whole: wholeRef("w2"),
            },
          );

          await planThenApply(target, source);

          expect(await attachments(target)).toEqual({ p1: "w2" });
          expect(await livePartIds(target)).toEqual(["p1"]);
          expect(await target.verifyConstraintFences()).toEqual([]);
        });

        it("merges a reparent followed by the old whole's delete", async () => {
          const target = await seededTarget(context, existence, cardinality);
          const source = await fork(context, target);
          await source.store.nodes.GmcPart.reparent(
            asNodeId<typeof Part>("p1"),
            {
              whole: wholeRef("w2"),
            },
          );
          await source.store.nodes.GmcWhole.delete(
            asNodeId<typeof Whole>("w1"),
          );

          await planThenApply(target, source);

          expect(await attachments(target)).toEqual({ p1: "w2" });
          expect(await livePartIds(target)).toEqual(["p1"]);
          expect(
            await target.nodes.GmcWhole.getById(asNodeId<typeof Whole>("w1")),
          ).toBeUndefined();
          expect(await target.verifyConstraintFences()).toEqual([]);
        });

        it("merges a create and a reparent into a history-capturing target", async () => {
          // History capture records every replayed row; the plan's
          // composition rows must still land as one unit there.
          const target = await context.createHistoryStore(
            compositionGraph(existence, cardinality),
          );
          await target.nodes.GmcWhole.create({ label: "w1" }, { id: "w1" });
          await target.nodes.GmcWhole.create({ label: "w2" }, { id: "w2" });
          await target.nodes.GmcPart.create(
            { label: "p1" },
            { id: "p1", partOf: { whole: wholeRef("w1") } },
          );
          const source = unwrap(
            await branch(target, () => context.createIsolatedBackend(), {
              id: asBranchId("branch-a"),
            }),
          );
          await source.store.nodes.GmcPart.reparent(
            asNodeId<typeof Part>("p1"),
            { whole: wholeRef("w2") },
          );
          await source.store.nodes.GmcPart.create(
            { label: "p2" },
            { id: "p2", partOf: { whole: wholeRef("w1") } },
          );

          const merged = await merge(target, [source]);
          if (isErr(merged)) throw merged.error;

          const edges = await target.edges.gmcHolds.find();
          expect(
            Object.fromEntries(edges.map((edge) => [edge.fromId, edge.toId])),
          ).toEqual({ p1: "w2", p2: "w1" });
          expect(await target.verifyConstraintFences()).toEqual([]);
        });

        it("refuses two branches reparenting one part to different wholes at plan time", async () => {
          const target = await seededTarget(context, existence, cardinality);
          await target.nodes.GmcWhole.create({ label: "w3" }, { id: "w3" });
          const toW2 = await fork(context, target, "branch-a");
          const toW3 = await fork(context, target, "branch-b");
          await toW2.store.nodes.GmcPart.reparent(asNodeId<typeof Part>("p1"), {
            whole: wholeRef("w2"),
          });
          await toW3.store.nodes.GmcPart.reparent(asNodeId<typeof Part>("p1"), {
            whole: wholeRef("w3"),
          });

          const planned = await planMerge(target, [toW2, toW3]);
          if (!isErr(planned)) throw new Error("expected a plan-time refusal");
          expectOccupiedWholeConflict(planned.error);

          const merged = await merge(target, [toW3, toW2]);
          if (!isErr(merged)) throw new Error("expected a merge refusal");
          expectOccupiedWholeConflict(merged.error);
          expect(await attachments(target)).toEqual({ p1: "w1" });
        });

        it("refuses a branch reparent that disagrees with the target's own reparent at plan time", async () => {
          const forkPoint = await seededTarget(context, existence, cardinality);
          await forkPoint.nodes.GmcWhole.create({ label: "w3" }, { id: "w3" });
          const source = await fork(context, forkPoint, "branch-a");
          const { store: target } = await fork(
            context,
            forkPoint,
            "target-clone",
          );
          await target.nodes.GmcPart.reparent(asNodeId<typeof Part>("p1"), {
            whole: wholeRef("w2"),
          });
          await source.store.nodes.GmcPart.reparent(
            asNodeId<typeof Part>("p1"),
            { whole: wholeRef("w3") },
          );

          const planned = await planMergeIncremental({
            forkPoint,
            target,
            branches: [source],
          });
          if (!isErr(planned)) throw new Error("expected a plan-time refusal");
          expectOccupiedWholeConflict(planned.error);
          expect(await attachments(target)).toEqual({ p1: "w2" });
        });

        it("leaves nothing of an in-transaction apply that failed after writing, even when the caller commits", async () => {
          let refuseWholeWrites = false;
          const target = await seededTarget(context, existence, cardinality, {
            onOperationStart: (operation) => {
              if (
                refuseWholeWrites &&
                operation.entity === "node" &&
                operation.kind === "GmcWhole"
              ) {
                throw new Error("whole writes are refused by this test");
              }
            },
          });
          const source = await fork(context, target);
          // The apply deletes or ends the old attachment, then writes nodes,
          // then the new attachment: the new whole's write fails in between.
          await source.store.nodes.GmcWhole.create(
            { label: "w4" },
            { id: "w4" },
          );
          await source.store.nodes.GmcPart.reparent(
            asNodeId<typeof Part>("p1"),
            { whole: wholeRef("w2") },
          );
          const plan = unwrap(await planMerge(target, [source]));

          refuseWholeWrites = true;
          let refusal: unknown;
          await target.transaction(async (tx) => {
            try {
              await applyMergePlanInTransaction(target, tx, plan);
            } catch (error) {
              refusal = error;
            }
          });
          refuseWholeWrites = false;

          expect(refusal).toBeInstanceOf(MergeError);
          expect(await attachments(target)).toEqual({ p1: "w1" });
          expect(
            await target.nodes.GmcWhole.getById(asNodeId<typeof Whole>("w4")),
          ).toBeUndefined();
          expect(await target.verifyConstraintFences()).toEqual([]);
        });

        it("reports no hook outcome or receipt count for an in-transaction apply rolled back after writing", async () => {
          let refuseWholeWrites = false;
          let observing = false;
          const ended: string[] = [];
          const target = await seededTarget(context, existence, cardinality, {
            onOperationStart: (operation) => {
              if (
                refuseWholeWrites &&
                operation.entity === "node" &&
                operation.kind === "GmcWhole"
              ) {
                throw new Error("whole writes are refused by this test");
              }
            },
            onOperationEnd: (operation) => {
              if (observing) {
                ended.push(
                  `${operation.operation}:${operation.entity}:${operation.kind}`,
                );
              }
            },
          });
          const source = await fork(context, target);
          await source.store.nodes.GmcWhole.create(
            { label: "w4" },
            { id: "w4" },
          );
          await source.store.nodes.GmcPart.reparent(
            asNodeId<typeof Part>("p1"),
            { whole: wholeRef("w2") },
          );
          const plan = unwrap(await planMerge(target, [source]));

          observing = true;
          refuseWholeWrites = true;
          const { receipt } = await target.transactionWithReceipt(
            async (tx) => {
              await expect(
                applyMergePlanInTransaction(target, tx, plan),
              ).rejects.toBeInstanceOf(MergeError);
              refuseWholeWrites = false;
              await tx.nodes.GmcWhole.create({ label: "w5" }, { id: "w5" });
            },
          );
          observing = false;

          // Only the caller's own write committed, so only it is reported.
          expect(ended).toEqual(["create:node:GmcWhole"]);
          expect(receipt.writes.total).toBe(1);
          expect({ ...receipt.writes.nodes }).toEqual({ GmcWhole: 1 });
          expect({ ...receipt.writes.edges }).toEqual({});
          expect(await attachments(target)).toEqual({ p1: "w1" });
        });
        // MUTATION CHECK (verified): with `effects.discard(error)` removed from
        // `withAdoptedMergeApplySavepoint` (src/graph-merge/adopted-transaction.ts),
        // the old attachment's rolled-back delete under `cardinality: "one"`
        // is still reported by `onOperationEnd` and counted in the receipt.

        it("reports no orphan for a part the plan itself deletes", async () => {
          const target = await seededTarget(context, existence, cardinality);
          const source = await fork(context, target);
          await source.store.nodes.GmcPart.delete(asNodeId<typeof Part>("p1"));

          await planThenApply(target, source);

          expect(await livePartIds(target)).toEqual([]);
          expect(await target.verifyConstraintFences()).toEqual([]);
        });

        it("reports no orphan for a part a whole's delete cascades to", async () => {
          const target = await seededTarget(context, existence, cardinality);
          const source = await fork(context, target);
          await source.store.nodes.GmcWhole.delete(
            asNodeId<typeof Whole>("w1"),
          );

          await planThenApply(target, source);

          expect(await livePartIds(target)).toEqual([]);
          expect(await target.verifyConstraintFences()).toEqual([]);
        });
      },
    );
  });

  describe("composition windows replayed by graph merge", () => {
    it("refuses at plan time two branches whose history windows for one part overlap", async () => {
      const target = await historyTarget(context);
      const left = await fork(context, target, "branch-a");
      const right = await fork(context, target, "branch-b");
      await moveThroughHistory(left.store, "e1", "w2", {
        validFrom: Y2020,
        validTo: Y2022,
      });
      await moveThroughHistory(right.store, "e2", "w3", {
        validFrom: Y2021,
        validTo: Y2023,
      });
      const before = await windows(target);

      const planned = await planMerge(target, [left, right]);
      if (!isErr(planned)) throw new Error("expected a plan-time refusal");
      expectWindowConflict(planned.error, "e2", "e1");
      expect(planned.error.details).toMatchObject({
        validFrom: Y2021,
        validTo: Y2023,
        incumbentValidFrom: Y2020,
        incumbentValidTo: Y2022,
      });

      const merged = await merge(target, [right, left]);
      if (!isErr(merged)) throw new Error("expected a merge refusal");
      expect(merged.error).toBeInstanceOf(CompositionWindowMergeConflictError);
      expect(await windows(target)).toEqual(before);
    });

    it("refuses at plan time a branch history window overlapping the target's", async () => {
      const forkPoint = await historyTarget(context);
      const source = await fork(context, forkPoint, "branch-a");
      const { store: target } = await fork(context, forkPoint, "target-clone");
      await moveThroughHistory(target, "e2", "w3", {
        validFrom: Y2021,
        validTo: Y2023,
      });
      await moveThroughHistory(source.store, "e1", "w2", {
        validFrom: Y2020,
        validTo: Y2022,
      });

      const planned = await planMergeIncremental({
        forkPoint,
        target,
        branches: [source],
      });
      if (!isErr(planned)) throw new Error("expected a plan-time refusal");
      expect(planned.error).toBeInstanceOf(CompositionWindowMergeConflictError);
      expect(planned.error.details).toMatchObject({ partId: "p1" });
      const { edges } = planned.error.details as Readonly<{
        edges: readonly Readonly<{ edgeId: string }>[];
      }>;
      expect(edges.map((edge) => edge.edgeId).toSorted()).toEqual(["e1", "e2"]);
    });

    it("plans and applies history windows that only touch", async () => {
      const target = await historyTarget(context);
      const left = await fork(context, target, "branch-a");
      const right = await fork(context, target, "branch-b");
      await moveThroughHistory(left.store, "e1", "w2", {
        validFrom: Y2020,
        validTo: Y2022,
      });
      await moveThroughHistory(right.store, "e2", "w3", {
        validFrom: Y2022,
        validTo: Y2023,
      });

      const plan = unwrap(await planMerge(target, [left, right]));
      unwrap(await applyMergePlan(target, plan));

      expect(await windows(target)).toEqual(
        [
          `e0:w1 [${Y2019},${Y2020})`,
          `e1:w2 [${Y2020},${Y2022})`,
          `e2:w3 [${Y2022},${Y2023})`,
        ].toSorted(),
      );
      expect(await target.verifyConstraintFences()).toEqual([]);
    });

    it("refuses at apply time, through the store's write path, a re-fenced plan whose window the target has since overlapped", async () => {
      const target = await historyTarget(context);
      const source = await fork(context, target, "branch-a");
      await moveThroughHistory(source.store, "e1", "w2", {
        validFrom: Y2020,
        validTo: Y2022,
      });
      const cleanPlan = unwrap(await planMerge(target, [source]));
      await moveThroughHistory(target, "e2", "w3", {
        validFrom: Y2021,
        validTo: Y2023,
      });
      const before = await windows(target);

      const applied = await applyMergePlan(
        target,
        await refenceMergePlan(target, cleanPlan),
      );

      if (!isErr(applied)) throw new Error("expected apply to be refused");
      expect(applied.error).toBeInstanceOf(MergeConstraintConflictError);
      expect(applied.error.cause).toBeInstanceOf(CompositionError);
      expect(applied.error.details).toMatchObject({
        constraintCode: "COMPOSITION_WINDOW_OVERLAP",
        situation: "windowOverlap",
        partId: "p1",
      });
      expect(await windows(target)).toEqual(before);
    });
  });
}
