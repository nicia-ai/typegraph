/**
 * Recursive walks over nodes of different kinds that share an id.
 *
 * Node rows are keyed by (kind, id), so `Show:shared` and `Clip:shared` are two
 * distinct nodes. A recursive walk that can visit more than one kind must not
 * mistake reaching one of them after the other for a revisit, while a walk
 * that genuinely returns to a node it already passed through must still stop.
 *
 * Graph:
 *
 *   Show:shared --linked--> Clip:shared --linked--> Clip:leaf --linked--> Show:shared
 *
 * The last edge closes a real cycle, so every unbounded walk below also proves
 * that cycle prevention still fires on a true revisit.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, subClassOf } from "../../../src";
import type { InspectableStore, IntegrationTestContext } from "./test-context";

const SHARED_ID = "shared";
const LEAF_ID = "leaf";
// U+001F is the separator inside kind-qualified path tokens. An id carrying
// it must still come back verbatim, whichever token shape the walk used.
const SEPARATOR_BEARING_ID = "clip\u001Fpart";

const Media = defineNode("Media", {
  schema: z.object({}),
});
const Show = defineNode("Show", {
  schema: z.object({}),
});
const Clip = defineNode("Clip", {
  schema: z.object({}),
});
const linked = defineEdge("linked", {
  schema: z.object({}),
});

const sharedIdGraph = defineGraph({
  id: "recursive_shared_id_kinds",
  nodes: {
    Media: { type: Media },
    Show: { type: Show },
    Clip: { type: Clip },
  },
  edges: {
    linked: {
      type: linked,
      from: [Media, Show, Clip],
      to: [Media, Show, Clip],
    },
  },
  ontology: [subClassOf(Show, Media), subClassOf(Clip, Media)],
});

type SharedIdStore = InspectableStore<typeof sharedIdGraph>;

type SeededGraph = Readonly<{
  leaf: Awaited<ReturnType<SharedIdStore["nodes"]["Clip"]["create"]>>;
  showToClip: string;
  clipToLeaf: string;
  leafToShow: string;
}>;

async function seedSharedIdGraph(store: SharedIdStore): Promise<SeededGraph> {
  const show = await store.nodes.Show.create({}, { id: SHARED_ID });
  const clip = await store.nodes.Clip.create({}, { id: SHARED_ID });
  const leaf = await store.nodes.Clip.create({}, { id: LEAF_ID });
  const showToClip = await store.edges.linked.create(show, clip, {});
  const clipToLeaf = await store.edges.linked.create(clip, leaf, {});
  const leafToShow = await store.edges.linked.create(leaf, show, {});
  return {
    leaf,
    showToClip: showToClip.id,
    clipToLeaf: clipToLeaf.id,
    leafToShow: leafToShow.id,
  };
}

function byDepthThenKind<T extends Readonly<{ depth: number; kind: string }>>(
  rows: readonly T[],
): readonly T[] {
  return rows.toSorted(
    (left, right) =>
      left.depth - right.depth || left.kind.localeCompare(right.kind),
  );
}

export function registerRecursiveSharedIdIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Recursive walks across kinds that share an id", () => {
    let store: SharedIdStore;
    let seeded: SeededGraph;

    beforeEach(async () => {
      store = await context.createStore(sharedIdGraph);
      seeded = await seedSharedIdGraph(store);
    });

    it("reaches a node whose id matches the start node of another kind, and its descendants", async () => {
      const rows = await store
        .query()
        .from("Show", "show")
        .whereNode("show", (show) => show.id.eq(SHARED_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ depth: true })
        .to("Clip", "clip")
        .select((row) => ({
          kind: row.clip.kind,
          id: row.clip.id,
          depth: row.clip_depth,
        }))
        .execute();

      expect(byDepthThenKind(rows)).toEqual([
        { kind: Clip.kind, id: SHARED_ID, depth: 1 },
        { kind: Clip.kind, id: LEAF_ID, depth: 2 },
      ]);
    });

    it("walks outward through both same-id nodes and stops at the true revisit", async () => {
      const rows = await store
        .query()
        .from("Show", "show")
        .whereNode("show", (show) => show.id.eq(SHARED_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ maxHops: 6, depth: true })
        .to("Media", "media", { includeSubClasses: true })
        .select((row) => ({
          kind: row.media.kind,
          id: row.media.id,
          depth: row.media_depth,
        }))
        .execute();

      expect(byDepthThenKind(rows)).toEqual([
        { kind: Clip.kind, id: SHARED_ID, depth: 1 },
        { kind: Clip.kind, id: LEAF_ID, depth: 2 },
      ]);
    });

    it("walks inward through both same-id nodes and stops at the true revisit", async () => {
      const rows = await store
        .query()
        .from("Clip", "clip")
        .whereNode("clip", (clip) => clip.id.eq(LEAF_ID))
        .traverse("linked", "link", { direction: "in", expand: "none" })
        .recursive({ maxHops: 6, depth: true })
        .to("Media", "media", { includeSubClasses: true })
        .select((row) => ({
          kind: row.media.kind,
          id: row.media.id,
          depth: row.media_depth,
        }))
        .execute();

      expect(byDepthThenKind(rows)).toEqual([
        { kind: Clip.kind, id: SHARED_ID, depth: 1 },
        { kind: Show.kind, id: SHARED_ID, depth: 2 },
      ]);
    });

    it("reaches a same-id node of another kind walking inward from the start", async () => {
      const rows = await store
        .query()
        .from("Clip", "clip")
        .whereNode("clip", (clip) => clip.id.eq(SHARED_ID))
        .traverse("linked", "link", { direction: "in", expand: "none" })
        .recursive({ maxHops: 3 })
        .to("Show", "show")
        .select((row) => ({ kind: row.show.kind, id: row.show.id }))
        .execute();

      expect(rows).toEqual([{ kind: Show.kind, id: SHARED_ID }]);
    });

    it("returns bare-id and qualified paths through a same-id pair", async () => {
      const query = store
        .query()
        .from("Show", "show")
        .whereNode("show", (show) => show.id.eq(SHARED_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ maxHops: 6, depth: true, path: true })
        .to("Media", "media", { includeSubClasses: true })
        .select((row) => ({
          kind: row.media.kind,
          depth: row.media_depth,
          path: row.media_path,
        }));

      const expected = [
        { kind: Clip.kind, depth: 1, path: [SHARED_ID, SHARED_ID] },
        { kind: Clip.kind, depth: 2, path: [SHARED_ID, SHARED_ID, LEAF_ID] },
      ];
      const direct = byDepthThenKind(await query.execute());
      expect(direct).toEqual(expected);
      expect(byDepthThenKind(await query.prepare().execute({}))).toEqual(
        expected,
      );

      const qualifiedRows = await store
        .query()
        .from("Show", "show")
        .whereNode("show", (show) => show.id.eq(SHARED_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({
          maxHops: 6,
          depth: true,
          path: { format: "qualified", alias: "route" },
        })
        .to("Media", "media", { includeSubClasses: true })
        .select((row) => ({
          kind: row.media.kind,
          depth: row.media_depth,
          route: row.route,
        }))
        .execute();

      const showNode = { type: "node", kind: Show.kind, id: SHARED_ID };
      const clipNode = { type: "node", kind: Clip.kind, id: SHARED_ID };
      const leafNode = { type: "node", kind: Clip.kind, id: LEAF_ID };
      const showToClip = {
        type: "edge",
        kind: linked.kind,
        id: seeded.showToClip,
        direction: "out",
      };
      const clipToLeaf = {
        type: "edge",
        kind: linked.kind,
        id: seeded.clipToLeaf,
        direction: "out",
      };
      expect(byDepthThenKind(qualifiedRows)).toEqual([
        { kind: Clip.kind, depth: 1, route: [showNode, showToClip, clipNode] },
        {
          kind: Clip.kind,
          depth: 2,
          route: [showNode, showToClip, clipNode, clipToLeaf, leafNode],
        },
      ]);
    });

    it("reaches a same-id node in a later composed recursive stage", async () => {
      const rows = await store
        .query()
        .from("Show", "show")
        .whereNode("show", (show) => show.id.eq(SHARED_ID))
        .traverse("linked", "firstLink", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Clip", "clip")
        .traverse("linked", "secondLink", { expand: "none" })
        .recursive({ maxHops: 6, depth: "stageDepth", path: "stagePath" })
        .to("Media", "media", { includeSubClasses: true })
        .select((row) => ({
          from: row.clip.id,
          kind: row.media.kind,
          id: row.media.id,
          depth: row.stageDepth,
          path: row.stagePath,
        }))
        .execute();

      expect(byDepthThenKind(rows)).toEqual([
        {
          from: SHARED_ID,
          kind: Clip.kind,
          id: LEAF_ID,
          depth: 1,
          path: [SHARED_ID, LEAF_ID],
        },
        {
          from: SHARED_ID,
          kind: Show.kind,
          id: SHARED_ID,
          depth: 2,
          path: [SHARED_ID, LEAF_ID, SHARED_ID],
        },
      ]);
    });

    it("returns separator-bearing ids verbatim in single-kind and multi-kind paths", async () => {
      const tail = await store.nodes.Clip.create(
        {},
        { id: SEPARATOR_BEARING_ID },
      );
      await store.edges.linked.create(seeded.leaf, tail, {});

      const singleKind = await store
        .query()
        .from("Clip", "start")
        .whereNode("start", (clip) => clip.id.eq(LEAF_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ maxHops: 2, path: true })
        .to("Clip", "clip")
        .select((row) => row.clip_path)
        .execute();
      expect(singleKind).toEqual([[LEAF_ID, SEPARATOR_BEARING_ID]]);

      const multiKind = await store
        .query()
        .from("Clip", "start")
        .whereNode("start", (clip) => clip.id.eq(LEAF_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ maxHops: 2, path: true })
        .to("Media", "media", { includeSubClasses: true })
        .select((row) => row.media_path)
        .execute();
      expect(multiKind.toSorted()).toEqual([
        [LEAF_ID, SEPARATOR_BEARING_ID],
        [LEAF_ID, SHARED_ID],
        [LEAF_ID, SHARED_ID, SHARED_ID],
      ]);
    });
  });
}
