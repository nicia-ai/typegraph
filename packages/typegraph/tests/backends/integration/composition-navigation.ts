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
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  type NodeRef,
  partOf,
  type QualifiedRecursivePath,
  subClassOf,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
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

const cnEpisodeOf = defineEdge("cnEpisodeOf", {
  schema: z.object({
    position: z.number().optional(),
    note: z.string().optional(),
  }),
});
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

function adjacencyEdgeIds(
  adjacency: ReadonlyMap<
    string,
    ReadonlyMap<string, readonly Readonly<{ id: string }>[]>
  >,
): ReadonlySet<string> {
  return new Set(
    [...adjacency.values()].flatMap((byKind) =>
      [...byKind.values()].flatMap((edges) => edges.map((edge) => edge.id)),
    ),
  );
}

async function seedCompositionFixtures(store: CompositionStore) {
  const podcast = await store.nodes.CnPodcast.create({ title: "The Pod" });
  const episode1 = await store.nodes.CnEpisode.create({ title: "Episode 1" });
  const episode2 = await store.nodes.CnEpisode.create({ title: "Episode 2" });
  await store.edges.cnEpisodeOf.create(episode1, podcast, {
    position: 1,
    note: "pilot",
  });
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

    it("parts() takes the recursive path and depth option forms, including a qualified path", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { book, chapter1, paragraph1 } =
        await seedCompositionFixtures(store);
      const [chapterEdges, paragraphEdges] = await Promise.all([
        store.edges.cnBookHasChapter.findFrom(book),
        store.edges.cnParagraphOf.findFrom(paragraph1),
      ]);
      const chapterEdge = requireDefined(chapterEdges[0]);
      const paragraphEdge = requireDefined(paragraphEdges[0]);

      const rows = await store
        .query()
        .from("CnBook", "b")
        .whereNode("b", (candidate) => candidate.id.eq(book.id))
        .parts("x", { depth: true, path: { format: "qualified" } })
        .select((ctx) => ({ depth: ctx.x_depth, route: ctx.x_path }))
        .execute();

      expectTypeOf(rows).toEqualTypeOf<
        readonly { depth: number; route: QualifiedRecursivePath }[]
      >();
      const chapterRoute = [
        { type: "node", kind: "CnBook", id: book.id },
        {
          type: "edge",
          kind: "cnBookHasChapter",
          id: chapterEdge.id,
          direction: "out",
        },
        { type: "node", kind: "CnChapter", id: chapter1.id },
      ];
      expect(rows.toSorted((left, right) => left.depth - right.depth)).toEqual([
        { depth: 1, route: chapterRoute },
        {
          depth: 2,
          route: [
            ...chapterRoute,
            {
              type: "edge",
              kind: "cnParagraphOf",
              id: paragraphEdge.id,
              direction: "in",
            },
            { type: "node", kind: "CnParagraph", id: paragraph1.id },
          ],
        },
      ]);

      const aliasedRows = await store
        .query()
        .from("CnParagraph", "p")
        .whereNode("p", (candidate) => candidate.id.eq(paragraph1.id))
        .wholes("w", { maxHops: 1, path: false, depth: "level" })
        .select((ctx) => ({ whole: ctx.w.id, level: ctx.level }))
        .execute();
      expectTypeOf(aliasedRows).toEqualTypeOf<
        readonly { whole: string; level: number }[]
      >();
      expect(aliasedRows).toEqual([{ whole: chapter1.id, level: 1 }]);
    });

    it("a recursing mixed-orientation parts() compiles as a later traversal stage", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { book, chapter1, paragraph1 } =
        await seedCompositionFixtures(store);

      // The mixed orientation (hasPart walked as stored, then partOf walked
      // reversed) makes this stage compile its normalizing directed-edges
      // CTE inside the seeded later stage.
      const rows = await store
        .query()
        .from("CnChapter", "c")
        .whereNode("c", (chapter) => chapter.id.eq(chapter1.id))
        .traverse("cnBookHasChapter", "c_book", { direction: "in" })
        .to("CnBook", "b")
        .parts("x", { from: "b", path: "route" })
        .select((ctx) => ({ book: ctx.b.id, part: ctx.x.id, route: ctx.route }))
        .execute();

      expect(
        rows.toSorted((left, right) => left.route.length - right.route.length),
      ).toEqual([
        { book: book.id, part: chapter1.id, route: [book.id, chapter1.id] },
        {
          book: book.id,
          part: paragraph1.id,
          route: [book.id, chapter1.id, paragraph1.id],
        },
      ]);
    });

    it("chains two recursing composition steps in one query", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { sectionRoot, sectionChild, sectionGrandchild } =
        await seedCompositionFixtures(store);

      const rows = await store
        .query()
        .from("CnSection", "s")
        .whereNode("s", (section) => section.id.eq(sectionGrandchild.id))
        .wholes("w")
        .parts("p", { from: "w" })
        .select((ctx) => ({ whole: ctx.w.id, part: ctx.p.id }))
        .execute();

      const pairs = rows.map((row) => `${row.whole}>${row.part}`).toSorted();
      expect(pairs).toEqual(
        [
          `${sectionChild.id}>${sectionGrandchild.id}`,
          `${sectionRoot.id}>${sectionChild.id}`,
          `${sectionRoot.id}>${sectionGrandchild.id}`,
        ].toSorted(),
      );
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

    it("subgraph({ composition: true }) returns the COMPLETE owned unit past maxDepth", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      // 14 levels: deeper than DEFAULT_SUBGRAPH_MAX_DEPTH (10), and deeper
      // than the explicit `maxDepth: 2` this call also states.
      const chainLength = 14;
      const chain = [
        await store.nodes.CnSection.create({ title: "Section 0" }),
      ];
      for (let level = 1; level < chainLength; level += 1) {
        const child = await store.nodes.CnSection.create({
          title: `Section ${level}`,
        });
        await store.edges.cnParentSection.create(
          child,
          requireDefined(chain[level - 1]),
          {},
        );
        chain.push(child);
      }

      // MUTATION CHECK: restore `maxHops: ctx.maxDepth` in
      // `buildSubgraphCompositionReachableCte` (src/store/subgraph.ts). The
      // composition closure then stops at `maxDepth` hops and this returns
      // 3 nodes instead of 14 — verified and reverted.
      const result = await store.subgraph(requireDefined(chain[0]).id, {
        edges: [],
        composition: true,
        maxDepth: 2,
      });

      expect(new Set(result.nodes.keys())).toEqual(
        new Set(chain.map((section) => section.id)),
      );
    });

    it("subgraph({ composition: true }) projects composition edges it adds to the traversal", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { podcast, episode1 } = await seedCompositionFixtures(store);

      const result = await store.subgraph(podcast.id, {
        edges: [],
        composition: true,
        project: { edges: { cnEpisodeOf: ["position"] } },
      });

      const pilotEdges =
        result.adjacency.get(episode1.id)?.get("cnEpisodeOf") ?? [];
      expect(pilotEdges).toHaveLength(1);
      const pilotEdge = requireDefined(pilotEdges[0]);
      expect(pilotEdge).toMatchObject({
        kind: "cnEpisodeOf",
        fromId: episode1.id,
        toId: podcast.id,
        position: 1,
      });
      expect(pilotEdge).not.toHaveProperty("note");
      expect(pilotEdge).not.toHaveProperty("meta");
    });

    it("subgraph({ composition: true }) reads every statement at one current instant", async () => {
      const readStart = new Date("2099-01-01T00:00:00.000Z");
      const afterEpisodeEnds = new Date("2099-01-01T00:02:00.000Z");
      let advanceClockOnNextStatement = false;
      const store = await context.createStore(compositionNavigationGraph, {
        hooks: {
          onQueryStart: () => {
            if (!advanceClockOnNextStatement) return;
            advanceClockOnNextStatement = false;
            vi.setSystemTime(afterEpisodeEnds);
          },
        },
      });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(readStart);
        const podcast = await store.nodes.CnPodcast.create({ title: "Pod" });
        const episode = await store.nodes.CnEpisode.create({ title: "Ep" });
        await store.edges.cnEpisodeOf.create(
          episode,
          podcast,
          {},
          { validTo: "2099-01-01T00:01:00.000Z" },
        );

        // The clock moves past the episode edge's end while the read is in
        // flight, after its first statement. Every statement of one read must
        // still evaluate "current" at the instant the read started. The
        // transaction-bound read runs the same executor through the hooked
        // backend, which is what lets the hook move the clock mid-read.
        const result = await store.transaction((tx) => {
          advanceClockOnNextStatement = true;
          return tx.subgraph(podcast.id, { edges: [], composition: true });
        });

        expect(new Set(result.nodes.keys())).toEqual(
          new Set([podcast.id, episode.id]),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("subgraph({ composition: true }) closes the unit under a recorded-pinned read", async () => {
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
      const lateChapter = await history.nodes.CnChapter.create({
        title: "Chapter 2",
      });
      await history.edges.cnBookHasChapter.create(book, lateChapter, {});

      const pinned = await history.asOfRecorded(pin).subgraph(book.id, {
        edges: [],
        composition: true,
      });

      expect(new Set(pinned.nodes.keys())).toEqual(
        new Set([book.id, chapter.id, paragraph.id]),
      );
    });

    it("tx.subgraph({ composition }) returns the same unit as store.subgraph", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { podcast, book } = await seedCompositionFixtures(store);

      const [storePodcast, storeBookViaChapters] = await Promise.all([
        store.subgraph(podcast.id, { edges: [], composition: true }),
        store.subgraph(book.id, {
          edges: [],
          composition: { via: "cnBookHasChapter" },
        }),
      ]);
      const [txPodcast, txBookViaChapters] = await store.transaction(
        async (tx) => [
          await tx.subgraph(podcast.id, { edges: [], composition: true }),
          await tx.subgraph(book.id, {
            edges: [],
            composition: { via: "cnBookHasChapter" },
          }),
        ],
      );

      expect(txPodcast.nodes.size).toBe(4);
      expect(new Set(txPodcast.nodes.keys())).toEqual(
        new Set(storePodcast.nodes.keys()),
      );
      expect(adjacencyEdgeIds(txPodcast.adjacency)).toEqual(
        adjacencyEdgeIds(storePodcast.adjacency),
      );
      expect(txBookViaChapters.nodes.size).toBe(2);
      expect(new Set(txBookViaChapters.nodes.keys())).toEqual(
        new Set(storeBookViaChapters.nodes.keys()),
      );
      await expect(
        store.transaction((tx) =>
          tx.subgraph(book.id, {
            edges: [],
            composition: { via: "cnEpisodeOf" },
          }),
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          details: matchingObject({ code: "COMPOSITION_VIA_NOT_DECLARED" }),
        }),
      );
    });

    it("batchOnce refuses subgraph({ composition }) before running any statement", async () => {
      const statements: string[] = [];
      const store = await context.createStore(compositionNavigationGraph, {
        hooks: { onQueryStart: (ctx) => statements.push(ctx.sql) },
      });
      const { podcast } = await seedCompositionFixtures(store);
      // The batch builder's options type admits no `composition`; only a
      // JavaScript caller can reach this refusal, so the options are
      // untyped here.
      const compositionSelections: readonly unknown[] = [
        true,
        { via: "cnEpisodeOf" },
        { via: "notAnEdgeKind" },
      ];

      for (const composition of compositionSelections) {
        statements.length = 0;
        const options = { edges: [], composition } as never;
        await expect(
          store.batchOnce((read) => [
            read.neighbors(podcast, { edges: ["cnEpisodeOf"] }),
            read.subgraph(podcast.id, options),
          ]),
        ).rejects.toThrow(
          expect.objectContaining({
            code: "CONFIGURATION_ERROR",
            details: matchingObject({
              code: "SUBGRAPH_COMPOSITION_ONE_STATEMENT_UNSUPPORTED",
            }),
          }),
        );
        expect(statements).toEqual([]);
      }
    });

    it("subgraph refuses a composition selection that is neither a boolean nor { via }", async () => {
      const store = await context.createStore(compositionNavigationGraph);
      const { podcast } = await seedCompositionFixtures(store);
      const invalidSelections: readonly unknown[] = ["true", { via: 42 }, []];

      for (const composition of invalidSelections) {
        const options = { edges: [], composition } as never;
        await expect(store.subgraph(podcast.id, options)).rejects.toThrow(
          expect.objectContaining({ code: "VALIDATION_ERROR" }),
        );
      }
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
