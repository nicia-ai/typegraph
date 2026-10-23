/**
 * Cross-branch composition conflicts: one branch attaches a part to a whole
 * while another branch's deletion removes one end of that attachment. Merging
 * both would silently lose the attachment — the attaching branch's composition
 * edge would only appear as an `edge:endpoint-deleted` drop — so every
 * planning entry point refuses with `MergeCompositionOrphanError`, naming the
 * attaching branch in `details.branchId`:
 *
 *  - `cause: "moved"`: the part is deleted (directly, or by its old whole's
 *    cascade) while the attaching branch moved it under a whole that survives.
 *  - `cause: "deleted"`: the whole is deleted while the attaching branch moved
 *    a surviving part under it.
 *
 * When the plan deletes BOTH ends, or the edge does not realize a composition
 * pair, the edge is an ordinary `edge:endpoint-deleted` drop and the merge
 * proceeds.
 *
 * Fixture: `Whole`, `Part` and a composition edge `attach` realizing either
 * `partOf(Part, Whole)` (edge `Part -> Whole`) or `hasPart(Whole, Part)`
 * (edge `Whole -> Part`), under `population: "one"` or `"oneActive"`, plus a
 * non-composition edge `mentions` (`Part -> Whole`). Fork point: `w1`, `w2`,
 * and `p1` attached under `w1`.
 */
import type { GraphBackend, NodeId, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  partOf,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import {
  MergeCompositionOrphanError,
  type MergeError,
} from "../../src/graph-merge/errors";
import {
  merge,
  mergeIncremental,
  planMerge,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import type { MergePlanCompositionOrphan } from "../../src/graph-merge/plan-schema";
import { isErr, type Result, unwrap } from "../../src/graph-merge/result";
import { asBranchId, type GraphBranch } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Whole = defineNode("Whole", { schema: z.object({}) });
const Part = defineNode("Part", { schema: z.object({}) });
const attach = defineEdge("attach", {
  schema: z.object({ note: z.string().optional() }),
});
const mentions = defineEdge("mentions", { schema: z.object({}) });

type Orientation = "partOf" | "hasPart";
type Population = "one" | "oneActive";
type Existence = "optional" | "required";

function buildGraph(
  orientation: Orientation,
  population: Population,
  existence: Existence = "optional",
) {
  return defineGraph({
    id: "composition-orphan-cross-branch-test",
    nodes: {
      Whole: { type: Whole },
      Part: { type: Part },
    },
    edges: {
      attach: {
        type: attach,
        from: orientation === "partOf" ? [Part] : [Whole],
        to: orientation === "partOf" ? [Whole] : [Part],
        ...(orientation === "partOf" ?
          { cardinality: population }
        : { targetCardinality: population }),
      },
      mentions: { type: mentions, from: [Part], to: [Whole] },
    },
    ontology: [
      orientation === "partOf" ?
        partOf(Part, Whole, { via: attach, existence })
      : hasPart(Whole, Part, { via: attach, existence }),
    ],
  });
}
type G = ReturnType<typeof buildGraph>;

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

const W1 = "w1" as NodeId<typeof Whole>;
const W2 = "w2" as NodeId<typeof Whole>;
const P1 = "p1" as NodeId<typeof Part>;

const FIXTURES = [
  { orientation: "partOf", population: "one" },
  { orientation: "partOf", population: "oneActive" },
  { orientation: "hasPart", population: "one" },
  { orientation: "hasPart", population: "oneActive" },
] as const satisfies readonly Readonly<{
  orientation: Orientation;
  population: Population;
}>[];

const BRANCH_ORDERS = [
  { order: "deleting branch first", deleterFirst: true },
  { order: "attaching branch first", deleterFirst: false },
] as const;

/** A part and the whole a composition edge row of `attach` binds it to. */
function attachmentOf(
  orientation: Orientation,
  edge: Readonly<{ fromId: string; toId: string }>,
): Readonly<{ partId: string; wholeId: string }> {
  return orientation === "partOf" ?
      { partId: edge.fromId, wholeId: edge.toId }
    : { partId: edge.toId, wholeId: edge.fromId };
}

function expectCompositionRefusal(
  result: Result<unknown, MergeError>,
  expected: MergePlanCompositionOrphan,
  label: string,
): void {
  if (!isErr(result)) {
    throw new Error(`${label}: expected a MergeCompositionOrphanError refusal`);
  }
  console.info(`${label} refusal:`, result.error.message);
  expect(result.error).toBeInstanceOf(MergeCompositionOrphanError);
  expect({
    label,
    code: result.error.code,
    details: result.error.details,
  }).toEqual({
    label,
    code: "GRAPH_MERGE_COMPOSITION_ORPHAN",
    details: expected,
  });
}

describe.each(backendMatrix())(
  "cross-branch composition conflict [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeForkPoint(graph: G): Promise<Store<G>> {
      const [store] = await createStoreWithSchema(graph, await makeBackend(), {
        revisionTracking: true,
      });
      await store.nodes.Whole.create({}, { id: W1 });
      await store.nodes.Whole.create({}, { id: W2 });
      await store.nodes.Part.create(
        {},
        { id: P1, partOf: { whole: { kind: "Whole", id: W1 } } },
      );
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

    async function moveUnderW2(attacher: GraphBranch<G>): Promise<void> {
      await attacher.store.nodes.Part.reparent(P1, {
        whole: { kind: "Whole", id: W2 },
      });
    }

    function ordered(
      deleter: GraphBranch<G>,
      attacher: GraphBranch<G>,
      deleterFirst: boolean,
    ): readonly GraphBranch<G>[] {
      return deleterFirst ? [deleter, attacher] : [attacher, deleter];
    }

    /** The fork-point state, untouched: both wholes, the part, and its open `w1` attachment. */
    async function expectForkPointState(
      store: Store<G>,
      orientation: Orientation,
    ): Promise<void> {
      await expect(store.nodes.Whole.getById(W1)).resolves.toBeDefined();
      await expect(store.nodes.Whole.getById(W2)).resolves.toBeDefined();
      await expect(store.nodes.Part.getById(P1)).resolves.toBeDefined();
      const edges = await store.edges.attach.find(
        {},
        { temporalMode: "includeEnded" },
      );
      expect(
        edges.map((edge) => ({
          ...attachmentOf(orientation, edge),
          validTo: edge.meta.validTo,
        })),
      ).toEqual([{ partId: P1, wholeId: W1, validTo: undefined }]);
      await expect(store.edges.mentions.find({})).resolves.toEqual([]);
    }

    describe.each(FIXTURES)(
      "$orientation, population $population",
      ({ orientation, population }) => {
        const graph = buildGraph(orientation, population);

        it.each(BRANCH_ORDERS)(
          "refuses a part moved by one branch whose old whole another branch deletes ($order)",
          async ({ deleterFirst }) => {
            const forkPoint = await makeForkPoint(graph);
            const deleter = await makeBranchOf(forkPoint, BRANCH_A);
            await deleter.store.nodes.Whole.delete(W1);
            await expect(
              deleter.store.nodes.Part.getById(P1),
            ).resolves.toBeUndefined();
            const attacher = await makeBranchOf(forkPoint, BRANCH_B);
            await moveUnderW2(attacher);

            expectCompositionRefusal(
              await merge(forkPoint, ordered(deleter, attacher, deleterFirst)),
              {
                part: { kind: "Part", id: P1 },
                whole: { kind: "Whole", id: W2 },
                viaEdgeKind: "attach",
                cause: "moved",
                branchId: BRANCH_B,
              },
              "merge",
            );
            await expectForkPointState(forkPoint, orientation);
          },
        );

        it.each(BRANCH_ORDERS)(
          "refuses a part moved by one branch that another branch deletes directly ($order)",
          async ({ deleterFirst }) => {
            const forkPoint = await makeForkPoint(graph);
            const deleter = await makeBranchOf(forkPoint, BRANCH_A);
            await deleter.store.nodes.Part.delete(P1);
            const attacher = await makeBranchOf(forkPoint, BRANCH_B);
            await moveUnderW2(attacher);

            expectCompositionRefusal(
              await merge(forkPoint, ordered(deleter, attacher, deleterFirst)),
              {
                part: { kind: "Part", id: P1 },
                whole: { kind: "Whole", id: W2 },
                viaEdgeKind: "attach",
                cause: "moved",
                branchId: BRANCH_B,
              },
              "merge",
            );
            await expectForkPointState(forkPoint, orientation);
          },
        );

        it.each(BRANCH_ORDERS)(
          "refuses a part moved by one branch under a whole another branch deletes ($order)",
          async ({ deleterFirst }) => {
            const forkPoint = await makeForkPoint(graph);
            const deleter = await makeBranchOf(forkPoint, BRANCH_A);
            await deleter.store.nodes.Whole.delete(W2);
            const attacher = await makeBranchOf(forkPoint, BRANCH_B);
            await moveUnderW2(attacher);

            expectCompositionRefusal(
              await merge(forkPoint, ordered(deleter, attacher, deleterFirst)),
              {
                part: { kind: "Part", id: P1 },
                whole: { kind: "Whole", id: W2 },
                viaEdgeKind: "attach",
                cause: "deleted",
                branchId: BRANCH_B,
              },
              "merge",
            );
            await expectForkPointState(forkPoint, orientation);
          },
        );

        it("merges a move whose part and destination whole are both deleted, dropping the edge", async () => {
          const forkPoint = await makeForkPoint(graph);
          const deleter = await makeBranchOf(forkPoint, BRANCH_A);
          await deleter.store.nodes.Whole.delete(W1);
          await deleter.store.nodes.Whole.delete(W2);
          const attacher = await makeBranchOf(forkPoint, BRANCH_B);
          await moveUnderW2(attacher);
          const [movedEdge] = await attacher.store.edges.attach.find({});
          if (movedEdge === undefined) throw new Error("expected the move");

          const report = unwrap(await merge(forkPoint, [deleter, attacher]));
          console.info("both-deleted drops", report.dropped);
          expect(report.dropped).toContainEqual({
            kind: "edge",
            id: movedEdge.id,
            reason: "edge:endpoint-deleted",
          });
          await expect(
            forkPoint.nodes.Whole.getById(W1),
          ).resolves.toBeUndefined();
          await expect(
            forkPoint.nodes.Whole.getById(W2),
          ).resolves.toBeUndefined();
          await expect(
            forkPoint.nodes.Part.getById(P1),
          ).resolves.toBeUndefined();
        });

        it("leaves an edited inherited attachment whose part another branch deletes to the target-side check", async () => {
          const forkPoint = await makeForkPoint(graph);
          const deleter = await makeBranchOf(forkPoint, BRANCH_A);
          await deleter.store.nodes.Part.delete(P1);
          const editor = await makeBranchOf(forkPoint, BRANCH_B);
          const [inherited] = await editor.store.edges.attach.find({});
          if (inherited === undefined) throw new Error("expected the edge");
          await editor.store.edges.attach.update(inherited.id, {
            note: "edited",
          });

          // The edit survives the delete/modify resolution, so the plan keeps
          // the edge the target already holds while deleting its part: the
          // target-side `moved` arm reports it and apply refuses it. No
          // branch created the attachment, so no branch is named.
          const targetSideFinding = {
            part: { kind: "Part", id: P1 },
            whole: { kind: "Whole", id: W1 },
            viaEdgeKind: "attach",
            cause: "moved",
          } as const;
          const artifact = unwrap(
            await planMerge(forkPoint, [deleter, editor]),
          );
          expect(artifact.review.compositionOrphans).toEqual([
            targetSideFinding,
          ]);
          expectCompositionRefusal(
            await merge(forkPoint, [deleter, editor]),
            targetSideFinding,
            "merge",
          );
          await expect(forkPoint.nodes.Part.getById(P1)).resolves.toBeDefined();
        });

        it("merges a non-composition edge to a whole another branch deletes, dropping the edge", async () => {
          const forkPoint = await makeForkPoint(graph);
          const deleter = await makeBranchOf(forkPoint, BRANCH_A);
          await deleter.store.nodes.Whole.delete(W2);
          const mentioner = await makeBranchOf(forkPoint, BRANCH_B);
          const mention = await mentioner.store.edges.mentions.create(
            { kind: "Part", id: P1 },
            { kind: "Whole", id: W2 },
            {},
          );

          const report = unwrap(await merge(forkPoint, [deleter, mentioner]));
          expect(report.dropped).toEqual([
            { kind: "edge", id: mention.id, reason: "edge:endpoint-deleted" },
          ]);
          await expect(
            forkPoint.nodes.Whole.getById(W2),
          ).resolves.toBeUndefined();
          await expect(forkPoint.nodes.Part.getById(P1)).resolves.toBeDefined();
          await expect(forkPoint.edges.mentions.find({})).resolves.toEqual([]);
        });
      },
    );

    describe("an ended attachment", () => {
      const graph = buildGraph("partOf", "oneActive");

      it("merges a branch's ended attachment to a whole another branch deletes, keeping the part's current whole", async () => {
        const forkPoint = await makeForkPoint(graph);
        const deleter = await makeBranchOf(forkPoint, BRANCH_A);
        await deleter.store.nodes.Whole.delete(W2);
        const attacher = await makeBranchOf(forkPoint, BRANCH_B);
        await moveUnderW2(attacher);
        await attacher.store.nodes.Part.reparent(P1, {
          whole: { kind: "Whole", id: W1 },
        });
        const endedUnderW2 = (
          await attacher.store.edges.attach.find(
            {},
            { temporalMode: "includeEnded" },
          )
        ).find((edge) => edge.toId === W2);
        if (endedUnderW2 === undefined) throw new Error("expected the edge");
        expect(endedUnderW2.meta.validTo).toBeDefined();

        const report = unwrap(await merge(forkPoint, [deleter, attacher]));
        console.info("ended-attachment drops", report.dropped);
        expect(report.dropped).toContainEqual({
          kind: "edge",
          id: endedUnderW2.id,
          reason: "edge:endpoint-deleted",
        });
        await expect(
          forkPoint.nodes.Whole.getById(W2),
        ).resolves.toBeUndefined();
        const open = await forkPoint.edges.attach.find({});
        expect(
          open.map((edge) => ({ partId: edge.fromId, wholeId: edge.toId })),
        ).toEqual([{ partId: P1, wholeId: W1 }]);
      });
    });

    describe("every planning entry point", () => {
      const graph = buildGraph("partOf", "oneActive");

      it("refuses both shapes from planMerge, planMergeIncremental and mergeIncremental", async () => {
        const forkPoint = await makeForkPoint(graph);
        const deletesOldWhole = await makeBranchOf(forkPoint, BRANCH_A);
        await deletesOldWhole.store.nodes.Whole.delete(W1);
        const deletesNewWhole = await makeBranchOf(
          forkPoint,
          asBranchId("branch-c"),
        );
        await deletesNewWhole.store.nodes.Whole.delete(W2);
        const attacher = await makeBranchOf(forkPoint, BRANCH_B);
        await moveUnderW2(attacher);

        const cases = [
          {
            deleter: deletesOldWhole,
            expected: {
              part: { kind: "Part", id: P1 },
              whole: { kind: "Whole", id: W2 },
              viaEdgeKind: "attach",
              cause: "moved",
              branchId: BRANCH_B,
            },
          },
          {
            deleter: deletesNewWhole,
            expected: {
              part: { kind: "Part", id: P1 },
              whole: { kind: "Whole", id: W2 },
              viaEdgeKind: "attach",
              cause: "deleted",
              branchId: BRANCH_B,
            },
          },
        ] as const;

        for (const { deleter, expected } of cases) {
          const branches = [deleter, attacher];
          expectCompositionRefusal(
            await planMerge(forkPoint, branches),
            expected,
            `planMerge (${expected.cause})`,
          );
          const incremental = { forkPoint, target: forkPoint, branches };
          expectCompositionRefusal(
            await planMergeIncremental<G>(incremental),
            expected,
            `planMergeIncremental (${expected.cause})`,
          );
          expectCompositionRefusal(
            await mergeIncremental<G>(incremental),
            expected,
            `mergeIncremental (${expected.cause})`,
          );
        }
        await expectForkPointState(forkPoint, "partOf");
      });
    });

    describe('required existence (`existence: "required"`)', () => {
      const graph = buildGraph("partOf", "one", "required");

      it("refuses a move under a deleted whole as a cross-branch deletion, not as an unattached part", async () => {
        const forkPoint = await makeForkPoint(graph);
        const deleter = await makeBranchOf(forkPoint, BRANCH_A);
        await deleter.store.nodes.Whole.delete(W2);
        const attacher = await makeBranchOf(forkPoint, BRANCH_B);
        await moveUnderW2(attacher);

        const expected = {
          part: { kind: "Part", id: P1 },
          whole: { kind: "Whole", id: W2 },
          viaEdgeKind: "attach",
          cause: "deleted",
          branchId: BRANCH_B,
        } as const;
        expectCompositionRefusal(
          await planMerge(forkPoint, [deleter, attacher]),
          expected,
          "planMerge",
        );
        expectCompositionRefusal(
          await merge(forkPoint, [deleter, attacher]),
          expected,
          "merge",
        );
        await expectForkPointState(forkPoint, "partOf");
      });
    });
  },
);
