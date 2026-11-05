/**
 * The "Undoing a cascading delete" recipe in the composition docs
 * (apps/docs/src/content/docs/ontology.md), run step for step against a real
 * store so the documented workaround cannot drift from the API. Keep the two
 * `snapshot`/`restore` blocks below identical to the documented ones.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type CompositionCascadedPart,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Node,
  partOf,
} from "../src";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string() }),
});
const Episode = defineNode("Episode", {
  schema: z.object({ title: z.string() }),
});
const Segment = defineNode("Segment", {
  schema: z.object({ title: z.string() }),
});
const Topic = defineNode("Topic", { schema: z.object({ name: z.string() }) });

const episodeOf = defineEdge("episodeOf");
const segmentOf = defineEdge("segmentOf");
const covers = defineEdge("covers");

const graph = defineGraph({
  id: "composition_restore_recipe",
  nodes: {
    Podcast: { type: Podcast },
    Episode: { type: Episode, onDelete: "disconnect" },
    Segment: { type: Segment },
    Topic: { type: Topic },
  },
  edges: {
    episodeOf: {
      type: episodeOf,
      from: [Episode],
      to: [Podcast],
      cardinality: "one",
    },
    segmentOf: {
      type: segmentOf,
      from: [Segment],
      to: [Episode],
      cardinality: "one",
    },
    covers: { type: covers, from: [Episode], to: [Topic] },
  },
  ontology: [
    partOf(Episode, Podcast, { via: episodeOf }),
    partOf(Segment, Episode, { via: segmentOf, existence: "required" }),
  ],
});

/** The node's own properties, without its `kind`, `id` and `meta`. */
function propsOf<N extends Node>(node: N): Omit<N, "kind" | "id" | "meta"> {
  const { kind: _kind, id: _id, meta: _meta, ...props } = node;
  return props;
}

describe("composition restore recipe", () => {
  it("brings back the whole and every cascaded part with its props and attachment, and nothing else", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());
    const topic = await store.nodes.Topic.create({ name: "chess" });
    const podcast = await store.nodes.Podcast.create({ title: "Show" });
    const episodes = await Promise.all(
      ["Openings", "Endgames"].map((title) =>
        store.nodes.Episode.create({ title }, { partOf: { whole: podcast } }),
      ),
    );
    for (const episode of episodes) {
      await store.nodes.Segment.create(
        { title: `${episode.title} intro` },
        { partOf: { whole: episode } },
      );
    }
    await store.edges.covers.create(requireDefined(episodes[0]), topic, {});
    const originalPlan = requireDefined(
      await store.nodes.Podcast.planDelete(podcast.id),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    // --- documented: capture, then delete -------------------------------
    const snapshot = await store.transaction(async (tx) => {
      const plan = await tx.nodes.Podcast.planDelete(podcast.id);
      const whole = await tx.nodes.Podcast.getById(podcast.id);
      if (plan === undefined || whole === undefined) return;
      const parts: {
        part: CompositionCascadedPart;
        props: Record<string, unknown>;
      }[] = [];
      for (const part of plan.cascadedParts) {
        const node = await tx.getNodeByRef(part);
        if (node !== undefined) parts.push({ part, props: propsOf(node) });
      }
      await tx.nodes.Podcast.delete(podcast.id, { expect: plan });
      return { whole: propsOf(whole), parts };
    });

    // --- documented: undo -------------------------------------------------
    if (snapshot !== undefined) {
      await store.transaction(async (tx) => {
        await tx.nodes.Podcast.create(snapshot.whole, { id: podcast.id });
        for (const { part, props } of snapshot.parts.toReversed()) {
          const collection = tx.getNodeCollection(part.kind);
          if (collection === undefined) throw new Error(part.kind);
          await collection.create(props, {
            id: part.id,
            partOf: { whole: part.whole, via: part.viaEdgeKind },
          });
        }
      });
    }
    // ---------------------------------------------------------------------

    const captured = requireDefined(snapshot);
    expect(captured.parts).toHaveLength(4);
    const restoredWhole = requireDefined(
      await store.nodes.Podcast.getById(podcast.id),
    );
    expect(propsOf(restoredWhole)).toEqual({ title: "Show" });
    for (const { part, props } of captured.parts) {
      const restored = requireDefined(await store.getNodeByRef(part));
      expect(propsOf(restored), `${part.kind}/${part.id}`).toEqual(props);
    }
    // Every part is attached where it was: the restored whole's delete would
    // cascade through exactly the parts the original delete removed.
    const replanned = requireDefined(
      await store.nodes.Podcast.planDelete(podcast.id),
    );
    expect(replanned.cascadedParts).toEqual(
      captured.parts.map(({ part }) => part),
    );

    // The composition edges come back as new edges, not the deleted ones.
    expect(
      replanned.removedEdgeIds.filter((edgeId) =>
        originalPlan.removedEdgeIds.includes(edgeId),
      ),
    ).toEqual([]);
    expect(restoredWhole.meta.validFrom).not.toBe(podcast.meta.validFrom);

    // What the recipe does not bring back: the ordinary edge the episode's
    // `onDelete: "disconnect"` removed.
    expect(await store.edges.covers.find()).toEqual([]);
  });
});
