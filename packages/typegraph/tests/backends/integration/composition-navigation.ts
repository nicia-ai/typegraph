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
  type NodeRef,
  partOf,
  subClassOf,
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
/** An undeclared subclass of `CnEpisode` for the composition relation — no `partOf`/`hasPart` names it directly. */
const CnBonusEpisode = defineNode("CnBonusEpisode", {
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
    CnBonusEpisode: { type: CnBonusEpisode },
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
    subClassOf(CnBonusEpisode, CnEpisode),
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

    it("parts() includes an undeclared subclass of a declared part kind", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { podcast } = await seedCompositionFixtures(store);
      const bonusEpisode = await store.nodes.CnBonusEpisode.create({
        title: "Bonus Episode",
      });
      // `cnEpisodeOf.create` is typed against the edge's DECLARED `from`
      // kind (CnEpisode); the cast crosses only the compile-time gap — the
      // ontology's `subClassOf(CnBonusEpisode, CnEpisode)` makes the
      // resulting row a legitimate one at runtime, accepted by
      // edge-endpoint validation via `isAssignableToAny`, exactly as the
      // finding describes.
      await store.edges.cnEpisodeOf.create(
        bonusEpisode as unknown as NodeRef<typeof CnEpisode>,
        podcast,
        {},
      );

      // MUTATION CHECK: reverting the subclass-expansion fix (using the bare
      // declared kind list from `compositionPartKindsUnder` instead of
      // expanding each declared kind through `registry.expandSubClasses`)
      // makes CnBonusEpisode disappear from this result even though the
      // edge row exists and passed endpoint validation — verified and
      // reverted.
      const rows = await store
        .query()
        .from("CnPodcast", "p")
        .whereNode("p", (p) => p.id.eq(podcast.id))
        .parts("x")
        .select((ctx) => ctx.x)
        .execute();

      expect(rows.map((row) => row.kind)).toContain("CnBonusEpisode");
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

    it("parts() unions mixed orientation under a recorded-pinned read", async () => {
      const history = await context.createHistoryStore(
        compositionNavigationGraph,
      );
      const book = await history.nodes.CnBook.create({ title: "The Book" });
      const chapter = await history.nodes.CnChapter.create({
        title: "Chapter 1",
      });
      await history.edges.cnBookHasChapter.create(book, chapter, {});
      const paragraph = await history.nodes.CnParagraph.create({
        title: "Paragraph 1",
      });
      await history.edges.cnParagraphOf.create(paragraph, chapter, {});
      const pin = await history.recordedNow();
      if (pin === undefined) throw new Error("recorded clock was not written");

      // MUTATION CHECK (Ed-r2-1): the mixed-orientation shape above forces
      // `parts()` to compile the `inverseEdgeKinds` union branch, whose
      // `_directed_edges` CTE narrows its edge projection. Reverting that
      // narrowing to omit `recorded_from`/`recorded_to` (dropping
      // `temporalFilterPass.recordedColumns` from the column list in
      // `recursive.ts`) makes this throw `no such column: e.recorded_from`
      // on SQLite (an undefined-column error on PostgreSQL/PGlite) as soon
      // as this recorded-pinned read executes, because the edge temporal
      // filter references those columns on every recorded read regardless
      // of projection width — verified and reverted.
      const rows = await history
        .asOfRecorded(pin)
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

      // MUTATION CHECK: the `maxHops === 1` clamp and the `{ maxHops:
      // options.maxHops }` forwarding onto `.recursive(...)` are two
      // separate mechanisms that happen to agree here — dropping the clamp
      // ALONE still passes, because `.recursive({ maxHops: 1 })` bounds
      // depth to 1 on its own. Only mutating BOTH together makes this
      // assertion fail — verified and reverted. The `maxHops: 2` case below
      // is the one only the forwarding mechanism guards.
      const directRows = await store
        .query()
        .from("CnSection", "s")
        .whereNode("s", (s) => s.id.eq(sectionRoot.id))
        .parts("x", { maxHops: 1 })
        .select((ctx) => ctx.x)
        .execute();
      expect(directRows.map((row) => row.id)).toEqual([sectionChild.id]);

      // A great-grandchild, added only here so the unbounded assertion
      // above (which expects exactly {child, grandchild}) is unaffected.
      const sectionGreatGrandchild = await store.nodes.CnSection.create({
        title: "Great-grandchild Section",
      });
      await store.edges.cnParentSection.create(
        sectionGreatGrandchild,
        sectionGrandchild,
        {},
      );

      // MUTATION CHECK: dropping the `{ maxHops: options.maxHops }`
      // forwarding (so the recursive traversal always runs unbounded
      // regardless of the option) makes this include the great-grandchild —
      // verified and reverted. Unlike the `maxHops: 1` case above, the
      // `maxHops === 1` clamp cannot substitute for this: it does not fire
      // for `maxHops: 2`.
      const twoHopRows = await store
        .query()
        .from("CnSection", "s")
        .whereNode("s", (s) => s.id.eq(sectionRoot.id))
        .parts("x", { maxHops: 2 })
        .select((ctx) => ctx.x)
        .execute();
      expect(new Set(twoHopRows.map((row) => row.id))).toEqual(
        new Set([sectionChild.id, sectionGrandchild.id]),
      );
    });

    it("parts() exposes depth and path when requested", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { sectionRoot, sectionChild, sectionGrandchild } =
        await seedCompositionFixtures(store);

      const rows = await store
        .query()
        .from("CnSection", "s")
        .whereNode("s", (s) => s.id.eq(sectionRoot.id))
        .parts("x", { depth: "d", path: "p" })
        .select((ctx) => ({ id: ctx.x.id, depth: ctx.d, path: ctx.p }))
        .execute();

      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(sectionChild.id)?.depth).toBe(1);
      expect(byId.get(sectionChild.id)?.path).toEqual([
        sectionRoot.id,
        sectionChild.id,
      ]);
      expect(byId.get(sectionGrandchild.id)?.depth).toBe(2);
      expect(byId.get(sectionGrandchild.id)?.path).toEqual([
        sectionRoot.id,
        sectionChild.id,
        sectionGrandchild.id,
      ]);
    });

    it("a recursing parts() refuses when the query already has another traversal", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      await seedCompositionFixtures(store);

      // MUTATION CHECK: removing the `willRecurse && traversals.length > 0`
      // guard lets this query build; it then fails deep in the compiler
      // (`runRecursiveTraversalSelectionPass`) with a generic message that
      // names neither `parts()` nor the `maxHops: 1` workaround — verified
      // and reverted.
      expect(() =>
        store
          .query()
          .from("CnSection", "s")
          .traverse("cnParentSection", "s_edge", { direction: "in" })
          .to("CnSection", "y")
          .parts("x", { from: "s" }),
      ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_PREDICATE" }));

      // The identical call with `maxHops: 1` compiles fine: it does not
      // recurse, so the one-recursive-traversal limitation never applies.
      expect(() =>
        store
          .query()
          .from("CnSection", "s")
          .traverse("cnParentSection", "s_edge", { direction: "in" })
          .to("CnSection", "y")
          .parts("x", { from: "s", maxHops: 1 }),
      ).not.toThrow();
    });

    it("parts() refuses when the derived edge alias collides with an existing traversal", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      await seedCompositionFixtures(store);

      // MUTATION CHECK: removing the `#getEdgeKindNamesForAlias` collision
      // guard lets this build; `x_edge` then silently merges into
      // `dynamicEdgeAliases` for two different edge types instead of
      // refusing — verified and reverted.
      expect(() =>
        store
          .query()
          .from("CnPodcast", "p")
          .traverse("cnEpisodeOf", "x_edge", { direction: "in" })
          .to("CnEpisode", "y")
          .parts("x", { from: "p", maxHops: 1 }),
      ).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    });

    it("parts() with an unknown `from` alias refuses naming the alias, not COMPOSITION_NO_PARTS_DECLARED", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      await seedCompositionFixtures(store);

      // MUTATION CHECK (Ed-r2-5): before this fix,
      // `this.#getKindNamesForAlias(fromAlias) ?? []` collapsed "no such
      // alias" into "this kind declares no composition parts" — the query
      // above threw `COMPOSITION_NO_PARTS_DECLARED` naming kinds
      // "(unknown)" instead of naming the actual typo'd alias, misdiagnosing
      // a typo as a composition-declaration problem. Reverting the
      // `#getKindNamesForAlias(fromAlias) === undefined` branch below (back
      // to `?? []`) makes this assertion fail (`details.code` comes back
      // `COMPOSITION_NO_PARTS_DECLARED` instead of
      // `COMPOSITION_UNKNOWN_ALIAS`) — verified and reverted.
      // `from` is typed `keyof Aliases & string`, so only a JS caller (or a
      // cast, as here) can name an alias the query does not have — the
      // typed surface would refuse this at compile time.
      expect(() =>
        store
          .query()
          .from("CnPodcast", "p")
          .parts("x", { from: "pod" as never }),
      ).toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          details: matchingObject({
            code: "COMPOSITION_UNKNOWN_ALIAS",
            alias: "pod",
          }),
        }),
      );
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

    it("subgraph({ composition: true }) rooted mid-tree closes only toward parts, never ancestors or siblings", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { sectionRoot, sectionChild, sectionGrandchild } =
        await seedCompositionFixtures(store);
      const sectionSibling = await store.nodes.CnSection.create({
        title: "Sibling Section",
      });
      await store.edges.cnParentSection.create(sectionSibling, sectionRoot, {});

      // MUTATION CHECK: reverting the oriented-closure fix (walking
      // `compositionEdgeKinds` as a flat `direction: "both"` instead of the
      // per-edge-kind direction `compositionTraversalDirection` derives)
      // makes this include `sectionRoot` and `sectionSibling` alongside the
      // expected two nodes — verified and reverted.
      const result = await store.subgraph(sectionChild.id, {
        edges: [],
        composition: true,
      });

      expect(new Set(result.nodes.keys())).toEqual(
        new Set([sectionChild.id, sectionGrandchild.id]),
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
