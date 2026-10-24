/**
 * `nodes.<Kind>.planDelete(id)`: the read half of a node delete, on every
 * backend.
 *
 * Fixture shape:
 *
 *   DpPodcast <-(dpEpisodeOf, partOf, population "one")-- DpEpisode
 *   DpEpisode <-(dpSegmentOf, partOf, population "oneActive")-- DpSegment
 *   DpPodcast / DpEpisode / DpSegment --(dpTagged, ordinary)--> DpTag
 *
 * The two levels differ in population on purpose: a `one` row counts against
 * its whole for its whole life, ended or not, while an ended `oneActive` row
 * is the history a reparent leaves behind. A preview that read the closure
 * in one temporal mode would get one of the two levels wrong; the plan the
 * delete runs gets both right, and these cases pin that the preview IS that
 * plan.
 *
 * Each case states, in a comment, the mutation that must make it fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type CompositionCascadedPart,
  defineEdge,
  defineGraph,
  defineNode,
  type NodeDeletePlan,
  partOf,
  RestrictedDeleteError,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { matchingObject } from "../../test-utils";
import { type IntegrationTestContext } from "./test-context";

const DpPodcast = defineNode("DpPodcast", {
  schema: z.object({ title: z.string() }),
});
const DpEpisode = defineNode("DpEpisode", {
  schema: z.object({ title: z.string() }),
});
const DpSegment = defineNode("DpSegment", {
  schema: z.object({ title: z.string() }),
});
const DpTag = defineNode("DpTag", { schema: z.object({ name: z.string() }) });

const dpEpisodeOf = defineEdge("dpEpisodeOf", { schema: z.object({}) });
const dpSegmentOf = defineEdge("dpSegmentOf", { schema: z.object({}) });
const dpTagged = defineEdge("dpTagged", { schema: z.object({}) });

type DeleteBehavior = "restrict" | "cascade" | "disconnect";

function buildGraph(
  id: string,
  onDelete: Readonly<{
    podcast?: DeleteBehavior;
    episode?: DeleteBehavior;
    segment?: DeleteBehavior;
  }> = {},
) {
  return defineGraph({
    id,
    nodes: {
      DpPodcast: { type: DpPodcast, onDelete: onDelete.podcast ?? "restrict" },
      DpEpisode: { type: DpEpisode, onDelete: onDelete.episode ?? "restrict" },
      DpSegment: { type: DpSegment, onDelete: onDelete.segment ?? "restrict" },
      DpTag: { type: DpTag },
    },
    edges: {
      dpEpisodeOf: {
        type: dpEpisodeOf,
        from: [DpEpisode],
        to: [DpPodcast],
        cardinality: "one",
      },
      dpSegmentOf: {
        type: dpSegmentOf,
        from: [DpSegment],
        to: [DpEpisode],
        cardinality: "oneActive",
      },
      dpTagged: {
        type: dpTagged,
        from: [DpPodcast, DpEpisode, DpSegment],
        to: [DpTag],
      },
    },
    ontology: [
      partOf(DpEpisode, DpPodcast, { via: dpEpisodeOf }),
      partOf(DpSegment, DpEpisode, { via: dpSegmentOf }),
    ],
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `composition_delete_plan_${graphIdCounter}`;
}

function cascadedPart(
  part: Readonly<{ kind: string; id: string }>,
  whole: Readonly<{ kind: string; id: string }>,
  viaEdgeKind: string,
): CompositionCascadedPart {
  return {
    kind: part.kind,
    id: part.id,
    whole: { kind: whole.kind, id: whole.id },
    viaEdgeKind,
  };
}

function endedNow(): Readonly<{ validTo: string }> {
  return { validTo: new Date().toISOString() };
}

export function registerCompositionDeletePlanIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Composition delete plan (planDelete)", () => {
    it("names a part bound by an ended population 'one' row, exactly as the delete then cascades", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const podcast = await store.nodes.DpPodcast.create({ title: "show" });
      const liveEpisode = await store.nodes.DpEpisode.create(
        { title: "live" },
        { partOf: { whole: podcast } },
      );
      const endedEpisode = await store.nodes.DpEpisode.create({
        title: "ended",
      });
      const endedEdge = await store.edges.dpEpisodeOf.create(
        endedEpisode,
        podcast,
        {},
      );
      await store.edges.dpEpisodeOf.update(endedEdge.id, {}, endedNow());

      // MUTATION CHECK: make `compositionEdgeCounts`
      // (src/store/operations/composition-cascade.ts) count only open-ended
      // rows, as a current-mode read would, and the ended episode drops out
      // of both the plan and the delete's cascade — verified and reverted.
      const expected = [liveEpisode, endedEpisode]
        .toSorted((left, right) => (left.id < right.id ? -1 : 1))
        .map((episode) => cascadedPart(episode, podcast, "dpEpisodeOf"));
      const plan = requireDefined(
        await store.nodes.DpPodcast.planDelete(podcast.id),
      );
      expect(plan.cascadedParts).toEqual(expected);

      const { receipt } = await store.transactionWithReceipt(async (tx) => {
        await tx.nodes.DpPodcast.delete(podcast.id);
      });
      expect(receipt.cascadedParts).toEqual(plan.cascadedParts);
      expect(
        await store.nodes.DpEpisode.getById(endedEpisode.id),
      ).toBeUndefined();
    });

    it("leaves out a part reparented away under population 'oneActive', exactly as the delete leaves it", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const podcast = await store.nodes.DpPodcast.create({ title: "show" });
      const otherPodcast = await store.nodes.DpPodcast.create({
        title: "other",
      });
      const episode = await store.nodes.DpEpisode.create(
        { title: "a" },
        { partOf: { whole: podcast } },
      );
      const otherEpisode = await store.nodes.DpEpisode.create(
        { title: "b" },
        { partOf: { whole: otherPodcast } },
      );
      const stayed = await store.nodes.DpSegment.create(
        { title: "stayed" },
        { partOf: { whole: episode } },
      );
      const moved = await store.nodes.DpSegment.create(
        { title: "moved" },
        { partOf: { whole: episode } },
      );
      await store.nodes.DpSegment.reparent(moved.id, {
        whole: otherEpisode,
      });

      // MUTATION CHECK: make `compositionEdgeCounts` count every
      // non-deleted row, as an `includeEnded` read would, and the moved
      // segment's reparent history pulls it into both the plan and the
      // delete — verified and reverted.
      const plan = requireDefined(
        await store.nodes.DpPodcast.planDelete(podcast.id),
      );
      expect(plan.cascadedParts).toEqual([
        cascadedPart(stayed, episode, "dpSegmentOf"),
        cascadedPart(episode, podcast, "dpEpisodeOf"),
      ]);

      const { receipt } = await store.transactionWithReceipt(async (tx) => {
        await tx.nodes.DpPodcast.delete(podcast.id);
      });
      expect(receipt.cascadedParts).toEqual(plan.cascadedParts);
      expect(await store.nodes.DpSegment.getById(moved.id)).toBeDefined();
    });

    it("lists every edge the delete removes, and only those", async () => {
      const store = await context.createStore(
        buildGraph(nextGraphId(), {
          podcast: "disconnect",
          episode: "cascade",
        }),
      );
      const tag = await store.nodes.DpTag.create({ name: "t" });
      const podcast = await store.nodes.DpPodcast.create({ title: "show" });
      const episode = await store.nodes.DpEpisode.create(
        { title: "e" },
        { partOf: { whole: podcast } },
      );
      const segment = await store.nodes.DpSegment.create(
        { title: "s" },
        { partOf: { whole: episode } },
      );
      const podcastTag = await store.edges.dpTagged.create(podcast, tag, {});
      const episodeTag = await store.edges.dpTagged.create(episode, tag, {});
      const unrelated = await store.nodes.DpPodcast.create({ title: "other" });
      const unrelatedTag = await store.edges.dpTagged.create(
        unrelated,
        tag,
        {},
      );
      const [episodeOf] = await store.edges.dpEpisodeOf.findFrom(episode);
      const [segmentOf] = await store.edges.dpSegmentOf.findFrom(segment);

      // MUTATION CHECK: return `cascadePlan.consumedEdgeIds` alone from
      // `planLiveNodeDelete` (src/store/operations/node-operations.ts) and
      // the two `dpTagged` edges the deletes' own `onDelete` removes go
      // missing — verified and reverted.
      const plan = requireDefined(
        await store.nodes.DpPodcast.planDelete(podcast.id),
      );
      expect(plan.removedEdgeIds).toEqual(
        [
          requireDefined(episodeOf).id,
          requireDefined(segmentOf).id,
          podcastTag.id,
          episodeTag.id,
        ].toSorted(),
      );

      await store.nodes.DpPodcast.delete(podcast.id);
      for (const edgeId of plan.removedEdgeIds) {
        expect(
          (await store.edges.dpTagged.getById(edgeId as never)) ??
            (await store.edges.dpEpisodeOf.getById(edgeId as never)) ??
            (await store.edges.dpSegmentOf.getById(edgeId as never)),
        ).toBeUndefined();
      }
      expect(await store.edges.dpTagged.getById(unrelatedTag.id)).toBeDefined();
    });

    it("refuses with the delete's own RestrictedDeleteError, for the whole and for a cascaded part", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const tag = await store.nodes.DpTag.create({ name: "t" });
      const taggedPodcast = await store.nodes.DpPodcast.create({
        title: "tagged",
      });
      await store.edges.dpTagged.create(taggedPodcast, tag, {});

      const podcast = await store.nodes.DpPodcast.create({ title: "show" });
      const episode = await store.nodes.DpEpisode.create(
        { title: "e" },
        { partOf: { whole: podcast } },
      );
      const segment = await store.nodes.DpSegment.create(
        { title: "s" },
        { partOf: { whole: episode } },
      );
      await store.edges.dpTagged.create(segment, tag, {});

      // MUTATION CHECK: pass `judgeRoot: false` to `planCascadingNodeDelete`
      // from `planLiveNodeDelete` and the part-less tagged podcast plans
      // cleanly, since only its delete's own statement would judge it —
      // verified and reverted.
      const cases = [
        {
          root: taggedPodcast,
          refusedKind: "DpPodcast",
          refused: taggedPodcast,
        },
        { root: podcast, refusedKind: "DpSegment", refused: segment },
      ];
      for (const { root, refusedKind, refused } of cases) {
        const refusal = matchingObject({
          name: "RestrictedDeleteError",
          details: matchingObject({
            nodeKind: refusedKind,
            nodeId: refused.id,
            edgeKinds: ["dpTagged"],
          }),
        });
        await expect(store.nodes.DpPodcast.planDelete(root.id)).rejects.toThrow(
          refusal,
        );
        await expect(
          store.transaction((tx) => tx.nodes.DpPodcast.planDelete(root.id)),
        ).rejects.toBeInstanceOf(RestrictedDeleteError);
        await expect(store.nodes.DpPodcast.delete(root.id)).rejects.toThrow(
          refusal,
        );
      }
      expect(await store.nodes.DpSegment.getById(segment.id)).toBeDefined();
    });

    it("answers undefined for an absent or already-deleted node, where delete is a no-op", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const podcast = await store.nodes.DpPodcast.create({ title: "show" });
      await store.nodes.DpPodcast.delete(podcast.id);

      // MUTATION CHECK: drop the live-row gate from `planLiveNodeDelete` and
      // the tombstoned podcast answers an empty plan instead — verified and
      // reverted.
      expect(
        await store.nodes.DpPodcast.planDelete(podcast.id),
      ).toBeUndefined();
      expect(
        await store.nodes.DpPodcast.planDelete("missing" as never),
      ).toBeUndefined();
      expect(
        await store.transaction((tx) =>
          tx.nodes.DpPodcast.planDelete(podcast.id),
        ),
      ).toBeUndefined();
    });

    it("agrees with a delete later in the same transaction, including a part attached earlier in it", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const podcast = await store.nodes.DpPodcast.create({ title: "show" });
      const committed = await store.nodes.DpEpisode.create(
        { title: "committed" },
        { partOf: { whole: podcast } },
      );

      const { receipt, result } = await store.transactionWithReceipt(
        async (tx) => {
          const pending = await tx.nodes.DpEpisode.create(
            { title: "pending" },
            { partOf: { whole: podcast } },
          );
          const segment = await tx.nodes.DpSegment.create(
            { title: "s" },
            { partOf: { whole: pending } },
          );
          const plan = await tx.nodes.DpPodcast.planDelete(podcast.id);
          await tx.nodes.DpPodcast.delete(podcast.id);
          return { plan: requireDefined(plan), pending, segment };
        },
      );

      expect(result.plan.cascadedParts).toEqual([
        cascadedPart(result.segment, result.pending, "dpSegmentOf"),
        ...[committed, result.pending]
          .toSorted((left, right) => (left.id < right.id ? -1 : 1))
          .map((episode) => cascadedPart(episode, podcast, "dpEpisodeOf")),
      ]);
      expect(receipt.cascadedParts).toEqual(result.plan.cascadedParts);
      // A plan is a read: it is not a write intent on the receipt.
      expect(receipt.writes.nodes).toEqual({
        DpEpisode: 1,
        DpSegment: 1,
        DpPodcast: 1,
      });
    });

    it("writes nothing on either form: a revision-tracked store's revision does not move", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()), {
        revisionTracking: true,
      });
      const podcast = await store.nodes.DpPodcast.create({ title: "show" });
      await store.nodes.DpEpisode.create(
        { title: "e" },
        { partOf: { whole: podcast } },
      );
      const before = await store.revisionNow();

      // MUTATION CHECK: drop `{ didWrite: () => false }` from the
      // transactional branch of `executeNodeDeletePlan`
      // (src/store/operations/node-operations.ts) and the transaction below
      // is counted as a write, advancing the revision at commit — verified
      // and reverted.
      const plans: (NodeDeletePlan | undefined)[] = [
        await store.nodes.DpPodcast.planDelete(podcast.id),
        await store.transaction((tx) =>
          tx.nodes.DpPodcast.planDelete(podcast.id),
        ),
      ];
      const { receipt } = await store.transactionWithReceipt((tx) =>
        tx.nodes.DpPodcast.planDelete(podcast.id),
      );

      expect(plans.map((plan) => plan?.cascadedParts.length)).toEqual([1, 1]);
      expect(receipt.writes.total).toBe(0);
      expect(await store.revisionNow()).toEqual(before);
      expect(await store.nodes.DpPodcast.getById(podcast.id)).toBeDefined();
    });
  });
}
