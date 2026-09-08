/**
 * Composition navigation (item E, lane E-d): `parts()` / `wholes()` and
 * `subgraph({ composition: true })`, on every backend.
 *
 * Fixture shape:
 *
 *   CnPodcast --(cnEpisodeOf, partOf, part->whole)-- CnEpisode
 *   CnEpisode --(cnSegmentOf, partOf, part->whole)-- CnSegment
 *
 *   CnBook --(cnBookHasChapter, hasPart, whole->part)-- CnChapter
 *   CnChapter --(cnParagraphOf, partOf, part->whole)-- CnParagraph
 *
 *   CnSection --(cnParentSection, partOf, part->whole, reflexive)-- CnSection
 *
 * The Podcast chain crosses two edge KINDS under one, uniform orientation
 * (partOf both times). The Book chain crosses two edge kinds under MIXED
 * orientation — `hasPart` (whole names the part) at the first level,
 * `partOf` (part names the whole) at the second — exercising the
 * `inverseEdgeKinds` union this lane's `parts()`/`wholes()` are built on.
 *
 * Every case states the mutation/revert check that must make it fail; the
 * checks actually performed are recorded in the scratchpad
 * `lane-Ed-load-bearing.md` note.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  partOf,
} from "../../../src";
import { matchingObject } from "../../test-utils";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const CnPodcast = defineNode("CnPodcast", {
  schema: z.object({ title: z.string() }),
});
const CnEpisode = defineNode("CnEpisode", {
  schema: z.object({ title: z.string() }),
});
const CnSegment = defineNode("CnSegment", {
  schema: z.object({ title: z.string() }),
});
const CnBook = defineNode("CnBook", {
  schema: z.object({ title: z.string() }),
});
const CnChapter = defineNode("CnChapter", {
  schema: z.object({ title: z.string() }),
});
const CnParagraph = defineNode("CnParagraph", {
  schema: z.object({ title: z.string() }),
});
const CnSection = defineNode("CnSection", {
  schema: z.object({ title: z.string() }),
});

const cnEpisodeOf = defineEdge("cnEpisodeOf", { schema: z.object({}) });
const cnSegmentOf = defineEdge("cnSegmentOf", { schema: z.object({}) });
const cnBookHasChapter = defineEdge("cnBookHasChapter", {
  schema: z.object({}),
});
const cnParagraphOf = defineEdge("cnParagraphOf", { schema: z.object({}) });
const cnParentSection = defineEdge("cnParentSection", {
  schema: z.object({}),
});

const compositionNavigationGraph = defineGraph({
  id: "composition_navigation",
  nodes: {
    CnPodcast: { type: CnPodcast },
    CnEpisode: { type: CnEpisode },
    CnSegment: { type: CnSegment },
    CnBook: { type: CnBook },
    CnChapter: { type: CnChapter },
    CnParagraph: { type: CnParagraph },
    CnSection: { type: CnSection },
  },
  edges: {
    cnEpisodeOf: {
      type: cnEpisodeOf,
      from: [CnEpisode],
      to: [CnPodcast],
      cardinality: "one",
    },
    cnSegmentOf: {
      type: cnSegmentOf,
      from: [CnSegment],
      to: [CnEpisode],
      cardinality: "one",
    },
    cnBookHasChapter: {
      type: cnBookHasChapter,
      from: [CnBook],
      to: [CnChapter],
      targetCardinality: "one",
    },
    cnParagraphOf: {
      type: cnParagraphOf,
      from: [CnParagraph],
      to: [CnChapter],
      cardinality: "one",
    },
    cnParentSection: {
      type: cnParentSection,
      from: [CnSection],
      to: [CnSection],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(CnEpisode, CnPodcast, { via: cnEpisodeOf }),
    partOf(CnSegment, CnEpisode, { via: cnSegmentOf }),
    hasPart(CnBook, CnChapter, { via: cnBookHasChapter }),
    partOf(CnParagraph, CnChapter, { via: cnParagraphOf }),
    partOf(CnSection, CnSection, { via: cnParentSection, partSide: "from" }),
  ],
});

/** No `partOf`/`hasPart` declared anywhere — the set-level subgraph refusal. */
const noCompositionGraph = defineGraph({
  id: "composition_navigation_none",
  nodes: { CnPodcast: { type: CnPodcast } },
  edges: {},
});

type CompositionStore = InspectableStore<typeof compositionNavigationGraph>;

async function seedCompositionFixtures(store: CompositionStore) {
  const podcast = await store.nodes.CnPodcast.create({ title: "The Pod" });
  const episode1 = await store.nodes.CnEpisode.create({ title: "Episode 1" });
  const episode2 = await store.nodes.CnEpisode.create({ title: "Episode 2" });
  await store.edges.cnEpisodeOf.create(episode1, podcast, {});
  await store.edges.cnEpisodeOf.create(episode2, podcast, {});
  const segment1 = await store.nodes.CnSegment.create({ title: "Segment 1" });
  await store.edges.cnSegmentOf.create(segment1, episode1, {});

  const book = await store.nodes.CnBook.create({ title: "The Book" });
  const chapter1 = await store.nodes.CnChapter.create({ title: "Chapter 1" });
  await store.edges.cnBookHasChapter.create(book, chapter1, {});
  const paragraph1 = await store.nodes.CnParagraph.create({
    title: "Paragraph 1",
  });
  await store.edges.cnParagraphOf.create(paragraph1, chapter1, {});

  const sectionRoot = await store.nodes.CnSection.create({
    title: "Root Section",
  });
  const sectionChild = await store.nodes.CnSection.create({
    title: "Child Section",
  });
  const sectionGrandchild = await store.nodes.CnSection.create({
    title: "Grandchild Section",
  });
  await store.edges.cnParentSection.create(sectionChild, sectionRoot, {});
  await store.edges.cnParentSection.create(sectionGrandchild, sectionChild, {});

  return {
    podcast,
    episode1,
    episode2,
    segment1,
    book,
    chapter1,
    paragraph1,
    sectionRoot,
    sectionChild,
    sectionGrandchild,
  };
}

export function registerCompositionNavigationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Composition navigation (parts/wholes/subgraph)", () => {
    it("parts() crosses heterogeneous edge kinds (episodeOf + segmentOf)", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { podcast } = await seedCompositionFixtures(store);

      // MUTATION CHECK: narrowing `compositionEdgeKindsUnder` to direct
      // pairs only (dropping the transitive-part-of-a-part union) makes
      // CnSegment disappear from this result — verified and reverted.
      const rows = await store
        .query()
        .from("CnPodcast", "p")
        .whereNode("p", (p) => p.id.eq(podcast.id))
        .parts("x")
        .select((ctx) => ctx.x)
        .execute();

      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((row) => row.kind))).toEqual(
        new Set(["CnEpisode", "CnSegment"]),
      );
    });

    it("parts() unions mixed orientation across levels (hasPart then partOf)", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { book } = await seedCompositionFixtures(store);

      // MUTATION CHECK: forcing a single direction (dropping the
      // `inverseEdgeKinds` branch so only the primary direction's edge
      // kinds are followed) makes CnParagraph disappear — verified and
      // reverted.
      const rows = await store
        .query()
        .from("CnBook", "b")
        .whereNode("b", (b) => b.id.eq(book.id))
        .parts("x")
        .select((ctx) => ctx.x)
        .execute();

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.kind))).toEqual(
        new Set(["CnChapter", "CnParagraph"]),
      );
    });

    it("wholes() returns the ancestor chain from a Segment", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { segment1 } = await seedCompositionFixtures(store);

      const rows = await store
        .query()
        .from("CnSegment", "s")
        .whereNode("s", (s) => s.id.eq(segment1.id))
        .wholes("x")
        .select((ctx) => ctx.x)
        .execute();

      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.kind))).toEqual(
        new Set(["CnEpisode", "CnPodcast"]),
      );
    });

    it("parts() recurses over a reflexive composition kind, honoring maxHops", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { sectionRoot, sectionChild, sectionGrandchild } =
        await seedCompositionFixtures(store);

      const allRows = await store
        .query()
        .from("CnSection", "s")
        .whereNode("s", (s) => s.id.eq(sectionRoot.id))
        .parts("x")
        .select((ctx) => ctx.x)
        .execute();
      expect(new Set(allRows.map((row) => row.id))).toEqual(
        new Set([sectionChild.id, sectionGrandchild.id]),
      );

      // MUTATION CHECK: dropping the `maxHops: 1` clamp (always recursing to
      // full depth) makes this assertion fail by including the grandchild —
      // verified and reverted.
      const directRows = await store
        .query()
        .from("CnSection", "s")
        .whereNode("s", (s) => s.id.eq(sectionRoot.id))
        .parts("x", { maxHops: 1 })
        .select((ctx) => ctx.x)
        .execute();
      expect(directRows.map((row) => row.id)).toEqual([sectionChild.id]);
    });

    it("parts() on a kind declaring no composition parts refuses", async () => {
      const store = await context.createStore(compositionNavigationGraph);

      // MUTATION CHECK: replacing the `edgeKinds.size === 0` guard with a
      // silent empty-array return makes this refusal disappear (the query
      // executes and returns zero rows instead of throwing) — verified and
      // reverted.
      expect(() => store.query().from("CnSegment", "s").parts("x")).toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          details: matchingObject({ code: "COMPOSITION_NO_PARTS_DECLARED" }),
        }),
      );
    });

    it("wholes() on a kind declaring no composition wholes refuses", async () => {
      const store = await context.createStore(compositionNavigationGraph);

      expect(() => store.query().from("CnPodcast", "p").wholes("x")).toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          details: matchingObject({ code: "COMPOSITION_NO_WHOLES_DECLARED" }),
        }),
      );
    });

    it("subgraph({ composition: true }) exports the whole plus its parts", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { podcast, episode1, episode2, segment1 } =
        await seedCompositionFixtures(store);

      const result = await store.subgraph(podcast.id, {
        edges: [],
        composition: true,
      });

      expect(result.root?.kind).toBe("CnPodcast");
      expect(new Set(result.nodes.keys())).toEqual(
        new Set([podcast.id, episode1.id, episode2.id, segment1.id]),
      );
    });

    it("subgraph({ composition: true }) refuses on a graph declaring no composition relation", async () => {
      const store = await context.createStore(noCompositionGraph);
      const node = await store.nodes.CnPodcast.create({ title: "Solo" });

      await expect(
        store.subgraph(node.id, { edges: [], composition: true }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          details: matchingObject({ code: "COMPOSITION_NO_PARTS_DECLARED" }),
        }),
      );
    });
  });
}
