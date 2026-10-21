/**
 * The composition ATTACHMENT surface, on every backend: how a part names the
 * whole it belongs to (`partOf: { whole, via?, props? }`), how it MOVES
 * between wholes (`nodes.<Kind>.reparent`), and what `getOrCreateByConstraint`
 * guarantees about a node it resolved rather than created.
 *
 * Fixture shape — the (CaChapter, CaBook) pair is deliberately realized by
 * TWO edge kinds, which is what makes `via` load-bearing rather than
 * cosmetic:
 *
 *   CaChapter --(caChapterOf,      partOf, part->whole)-- CaBook
 *   CaChapter --(caDraftChapterOf, partOf, part->whole)-- CaBook
 *   CaChapter --(caIncludedIn,     partOf, part->whole)-- CaAnthology
 *   CaPage    --(caPageOf,         partOf, part->whole)-- CaChapter
 *   CaClip    --(caClipOf,         partOf, part->whole, oneActive)-- CaShow
 *   CaTrack   --(caHasTrack,       hasPart, whole->part)-- CaAlbum
 *   CaFolder  --(caParentFolder,   partOf, part->whole, reflexive)-- CaFolder
 *   CaRelic   --(caRelicOf,        partOf, part->whole, oneActive)-- CaVault
 *   CaReel    --(caReelOf,         partOf, part->whole, oneActive)-- CaShow
 *   CaCell    --(caCellUnder,      partOf, part->whole, oneActive, acyclic)-- CaCell
 *   CaNest    --(caNestUnder,      partOf, part->whole, reflexive)-- CaNest
 *
 *   CaSlot    --(caSlotIn,         partOf, part->whole, one both ways)-- CaRack
 *   CaEngine  --(caEngineOf,       partOf, part->whole, oneActive, whole holds one)-- CaCar
 *
 * CaNest carries a unique key, so a get-or-create batch can name one of its
 * own matched items as the batch's shared whole. CaStamp is no part at all:
 * it carries TWO unique constraints, so a get-or-create update leg can be
 * refused on the one the lookup did not use. CaSlot's whole holds ONE part
 * (`targetCardinality: "one"`), so a matched part and a new one cannot both
 * attach to it. CaGhost is no part either: it is disjoint with CaSpirit, so a
 * tombstoned ghost whose id a spirit now holds cannot be resurrected.
 *
 * CaVault's OWN schema declares properties named `via`, `props`, `validFrom`
 * and `validTo` — the attachment's option names — so a whole passed as a
 * node object proves only its `kind` and `id` are read.
 *
 * Each case states, in a comment, the mutation/revert that must make it
 * fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  CardinalityError,
  CompositionError,
  CompositionExistenceError,
  ConfigurationError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  EdgeAcyclicityError,
  hasPart,
  NodeNotFoundError,
  partOf,
  UniquenessError,
  ValidationError,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { matchingObject } from "../../test-utils";
import { withBindBudget } from "./bind-budget";
import { type IntegrationTestContext } from "./test-context";

const CaBook = defineNode("CaBook", { schema: z.object({}) });
const CaAnthology = defineNode("CaAnthology", { schema: z.object({}) });
const CaChapter = defineNode("CaChapter", {
  schema: z.object({ slug: z.string() }),
});
const CA_CHAPTER_SLUG_UNIQUE = {
  name: "ca_chapter_slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;
const CaPage = defineNode("CaPage", { schema: z.object({}) });
const CaShow = defineNode("CaShow", { schema: z.object({}) });
const CaClip = defineNode("CaClip", { schema: z.object({}) });
const CaAlbum = defineNode("CaAlbum", { schema: z.object({}) });
const CaTrack = defineNode("CaTrack", { schema: z.object({}) });
/** A reflexive composition pair — the acyclicity coverage below. */
const CaFolder = defineNode("CaFolder", { schema: z.object({}) });
/** A reflexive part whose moves leave ended history rows (`oneActive`). */
const CaUnit = defineNode("CaUnit", { schema: z.object({}) });
/** A reflexive `oneActive` part whose realizing edge is also `acyclic: true`. */
const CaCell = defineNode("CaCell", { schema: z.object({}) });
/** Declares no composition pair at all — `reparent`'s not-a-part refusal. */
const CaReader = defineNode("CaReader", { schema: z.object({}) });

/** A whole whose own property names collide with every attachment option. */
const CaVault = defineNode("CaVault", {
  schema: z.object({
    via: z.string(),
    props: z.object({ order: z.number() }),
    validFrom: z.string(),
    validTo: z.string(),
  }),
});
const CaRelic = defineNode("CaRelic", { schema: z.object({}) });
/** An OPTIONAL `oneActive` part with a unique key, for get-or-create. */
const CaReel = defineNode("CaReel", {
  schema: z.object({ slug: z.string() }),
});
const CA_REEL_SLUG_UNIQUE = {
  name: "ca_reel_slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;
/** A reflexive OPTIONAL part with a unique key, for get-or-create batches. */
const CaNest = defineNode("CaNest", {
  schema: z.object({ slug: z.string() }),
});
const CA_NEST_SLUG_UNIQUE = {
  name: "ca_nest_slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;
/** Two unique keys: the lookup reads `code`, an update can collide on `label`. */
const CaStamp = defineNode("CaStamp", {
  schema: z.object({ code: z.string(), label: z.string() }),
});
const CA_STAMP_CODE_UNIQUE = {
  name: "ca_stamp_code",
  fields: ["code"],
  scope: "kind",
  collation: "binary",
} as const;
const CA_STAMP_LABEL_UNIQUE = {
  name: "ca_stamp_label",
  fields: ["label"],
  scope: "kind",
  collation: "binary",
} as const;
/** A part whose whole holds at most one part. */
const CaSlot = defineNode("CaSlot", { schema: z.object({ slug: z.string() }) });
const CaRack = defineNode("CaRack", { schema: z.object({}) });
const CA_SLOT_SLUG_UNIQUE = {
  name: "ca_slot_slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;
/**
 * A required `oneActive` part whose whole holds at most one part row for the
 * row's whole life (`targetCardinality: "one"`): a move ENDS the incumbent's
 * window, and the ended row still occupies the whole's slot.
 */
const CaEngine = defineNode("CaEngine", { schema: z.object({}) });
const CaCar = defineNode("CaCar", { schema: z.object({}) });
/** Disjoint with CaSpirit: a ghost cannot share an id with a live spirit. */
const CaGhost = defineNode("CaGhost", {
  schema: z.object({ slug: z.string(), note: z.string().optional() }),
});
const CaSpirit = defineNode("CaSpirit", { schema: z.object({}) });
const CA_GHOST_SLUG_UNIQUE = {
  name: "ca_ghost_slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;
const CA_VAULT_PROPS = {
  via: "caChapterOf",
  props: { order: 7 },
  validFrom: "1999-01-01T00:00:00.000Z",
  validTo: "1999-06-01T00:00:00.000Z",
} as const;

const caChapterOf = defineEdge("caChapterOf", {
  schema: z.object({ order: z.number().int() }),
});
/** A SECOND realizing edge for the same (CaChapter, CaBook) pair — what makes `via` load-bearing. */
const caDraftChapterOf = defineEdge("caDraftChapterOf", {
  schema: z.object({}),
});
const caIncludedIn = defineEdge("caIncludedIn", { schema: z.object({}) });
const caPageOf = defineEdge("caPageOf", { schema: z.object({}) });
const caClipOf = defineEdge("caClipOf", { schema: z.object({}) });
const caHasTrack = defineEdge("caHasTrack", { schema: z.object({}) });
const caParentFolder = defineEdge("caParentFolder", { schema: z.object({}) });
const caUnitUnder = defineEdge("caUnitUnder", { schema: z.object({}) });
const caCellUnder = defineEdge("caCellUnder", { schema: z.object({}) });
const caRelicOf = defineEdge("caRelicOf", {
  schema: z.object({ order: z.number().optional() }),
});

const caReelOf = defineEdge("caReelOf", { schema: z.object({}) });
const caSlotIn = defineEdge("caSlotIn", { schema: z.object({}) });
const caNestUnder = defineEdge("caNestUnder", { schema: z.object({}) });
const caEngineOf = defineEdge("caEngineOf", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      CaBook: { type: CaBook },
      CaAnthology: { type: CaAnthology },
      CaChapter: { type: CaChapter, unique: [CA_CHAPTER_SLUG_UNIQUE] },
      CaPage: { type: CaPage },
      CaShow: { type: CaShow },
      CaClip: { type: CaClip },
      CaAlbum: { type: CaAlbum },
      CaTrack: { type: CaTrack },
      CaFolder: { type: CaFolder, onDelete: "cascade" },
      CaUnit: { type: CaUnit },
      CaCell: { type: CaCell },
      CaReader: { type: CaReader },
      CaVault: { type: CaVault },
      CaRelic: { type: CaRelic },
      CaReel: { type: CaReel, unique: [CA_REEL_SLUG_UNIQUE] },
      CaNest: { type: CaNest, unique: [CA_NEST_SLUG_UNIQUE] },
      CaSlot: { type: CaSlot, unique: [CA_SLOT_SLUG_UNIQUE] },
      CaRack: { type: CaRack },
      CaEngine: { type: CaEngine },
      CaCar: { type: CaCar },
      CaGhost: { type: CaGhost, unique: [CA_GHOST_SLUG_UNIQUE] },
      CaSpirit: { type: CaSpirit },
      CaStamp: {
        type: CaStamp,
        unique: [CA_STAMP_CODE_UNIQUE, CA_STAMP_LABEL_UNIQUE],
      },
    },
    edges: {
      caChapterOf: {
        type: caChapterOf,
        from: [CaChapter],
        to: [CaBook],
        cardinality: "one",
      },
      caDraftChapterOf: {
        type: caDraftChapterOf,
        from: [CaChapter],
        to: [CaBook],
        cardinality: "one",
      },
      caIncludedIn: {
        type: caIncludedIn,
        from: [CaChapter],
        to: [CaAnthology],
        cardinality: "one",
      },
      caPageOf: {
        type: caPageOf,
        from: [CaPage],
        to: [CaChapter],
        cardinality: "one",
      },
      caClipOf: {
        type: caClipOf,
        from: [CaClip],
        to: [CaShow],
        cardinality: "oneActive",
      },
      caHasTrack: {
        type: caHasTrack,
        from: [CaAlbum],
        to: [CaTrack],
        targetCardinality: "one",
      },
      caParentFolder: {
        type: caParentFolder,
        from: [CaFolder],
        to: [CaFolder],
        cardinality: "one",
      },
      caUnitUnder: {
        type: caUnitUnder,
        from: [CaUnit],
        to: [CaUnit],
        cardinality: "oneActive",
      },
      caCellUnder: {
        type: caCellUnder,
        from: [CaCell],
        to: [CaCell],
        cardinality: "oneActive",
        acyclic: true,
      },
      caRelicOf: {
        type: caRelicOf,
        from: [CaRelic],
        to: [CaVault],
        cardinality: "oneActive",
      },
      caReelOf: {
        type: caReelOf,
        from: [CaReel],
        to: [CaShow],
        cardinality: "oneActive",
      },
      caNestUnder: {
        type: caNestUnder,
        from: [CaNest],
        to: [CaNest],
        cardinality: "one",
      },
      caSlotIn: {
        type: caSlotIn,
        from: [CaSlot],
        to: [CaRack],
        cardinality: "one",
        targetCardinality: "one",
      },
      caEngineOf: {
        type: caEngineOf,
        from: [CaEngine],
        to: [CaCar],
        cardinality: "oneActive",
        targetCardinality: "one",
      },
    },
    ontology: [
      partOf(CaChapter, CaBook, { via: caChapterOf }),
      partOf(CaChapter, CaBook, { via: caDraftChapterOf }),
      partOf(CaChapter, CaAnthology, { via: caIncludedIn }),
      partOf(CaPage, CaChapter, { via: caPageOf }),
      partOf(CaClip, CaShow, { via: caClipOf, existence: "required" }),
      hasPart(CaAlbum, CaTrack, { via: caHasTrack }),
      partOf(CaFolder, CaFolder, {
        via: caParentFolder,
        partSide: "from",
      }),
      partOf(CaUnit, CaUnit, { via: caUnitUnder, partSide: "from" }),
      partOf(CaCell, CaCell, { via: caCellUnder, partSide: "from" }),
      partOf(CaRelic, CaVault, { via: caRelicOf }),
      partOf(CaReel, CaShow, { via: caReelOf }),
      partOf(CaNest, CaNest, { via: caNestUnder, partSide: "from" }),
      partOf(CaSlot, CaRack, { via: caSlotIn }),
      partOf(CaEngine, CaCar, { via: caEngineOf, existence: "required" }),
      disjointWith(CaGhost, CaSpirit),
    ],
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `composition_attachment_${graphIdCounter}`;
}

export function registerCompositionAttachmentIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Composition attachment (via / props / reparent / get-or-create)", () => {
    // ========================================================
    // The attachment names its realizing edge: `via` and `props`
    // ========================================================

    it("refuses an ambiguous partOf with COMPOSITION_VIA_AMBIGUOUS and writes no row", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});

      // MUTATION CHECK: make `resolveCompositionAttachment`
      // (src/store/operations/composition-create.ts) return `declared[0]`
      // instead of refusing when `declared.length > 1` and no `via` is
      // stated — the create then silently succeeds through whichever pair
      // sorts first, and both assertions below fail.
      await expect(
        store.nodes.CaChapter.create(
          { slug: "one" },
          { partOf: { whole: { kind: "CaBook", id: book.id } } },
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          details: matchingObject({ code: "COMPOSITION_VIA_AMBIGUOUS" }),
        }),
      );
      expect(await store.nodes.CaChapter.count()).toBe(0);
    });

    it("refuses a `via` that realizes no declared pair between the two kinds", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});

      // MUTATION CHECK: drop the `via`-named-but-unknown arm and fall
      // through to `declared[0]` — the create then attaches through
      // `caChapterOf` while the caller asked for `caIncludedIn`.
      await expect(
        store.nodes.CaChapter.create(
          { slug: "one" },
          {
            partOf: {
              whole: { kind: "CaBook", id: book.id },
              via: "caIncludedIn",
            },
          },
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          details: matchingObject({ code: "COMPOSITION_VIA_NOT_DECLARED" }),
        }),
      );
      expect(await store.nodes.CaChapter.count()).toBe(0);
    });

    it("attaches through the named `via` and validates its props like edges.<via>.create", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});

      // MUTATION CHECK: revert `buildCompositionCreateEdgeInput` to
      // `props: {}` — the realizing edge is written with no `order` and the
      // `order` assertion below fails (a required schema field would also
      // make the create throw).
      const chapter = await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 3 },
          },
        },
      );

      const edges = await store.edges.caChapterOf.find({});
      expect(edges).toHaveLength(1);
      expect(requireDefined(edges[0]).fromId).toBe(chapter.id);
      expect(requireDefined(edges[0]).order).toBe(3);
    });

    it("validates the realizing edge's props against its own schema", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});

      await expect(
        store.nodes.CaChapter.create(
          { slug: "one" },
          {
            partOf: {
              whole: { kind: "CaBook", id: book.id },
              via: "caChapterOf",
              props: { order: "third" },
            },
          },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
      expect(await store.nodes.CaChapter.count()).toBe(0);
    });

    it("omitting `via` is fine when exactly one pair is declared", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const album = await store.nodes.CaAlbum.create({});
      const track = await store.nodes.CaTrack.create(
        {},
        { partOf: { whole: { kind: "CaAlbum", id: album.id } } },
      );
      const edges = await store.edges.caHasTrack.find({});
      expect(edges).toHaveLength(1);
      expect(requireDefined(edges[0]).toId).toBe(track.id);
    });

    // ========================================================
    // Moving a part: `reparent`
    // ========================================================

    it('reparent moves a `population: "one"` part, keeping its id and descendants', async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const anthology = await store.nodes.CaAnthology.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );
      const page = await store.nodes.CaPage.create(
        {},
        { partOf: { whole: { kind: "CaChapter", id: chapter.id } } },
      );

      // MUTATION CHECK: skip the retire (drop the retire loop in
      // `writeCompositionAttachmentMoves`,
      // src/store/operations/node-operations.ts)
      // — the attach then loses the composition claim and this rejects with
      // COMPOSITION_WHOLE_OCCUPIED instead of moving the chapter.
      await store.nodes.CaChapter.reparent(chapter.id, {
        whole: { kind: "CaAnthology", id: anthology.id },
        via: "caIncludedIn",
      });

      const moved = await store.edges.caIncludedIn.find({});
      expect(moved).toHaveLength(1);
      expect(requireDefined(moved[0]).fromId).toBe(chapter.id);
      expect(requireDefined(moved[0]).toId).toBe(anthology.id);
      // `population: "one"` retires by DELETE — an ended row would still
      // read as an attachment under that population.
      expect(await store.edges.caChapterOf.find({})).toHaveLength(0);
      // Same node, same descendants: nothing below the part was rewritten.
      const reloaded = await store.nodes.CaChapter.getById(chapter.id);
      expect(reloaded?.slug).toBe("one");
      const pages = await store.edges.caPageOf.find({});
      expect(pages).toHaveLength(1);
      expect(requireDefined(pages[0]).fromId).toBe(page.id);
      expect(requireDefined(pages[0]).toId).toBe(chapter.id);
    });

    it('reparent ends the window of a `population: "oneActive"` required part instead of deleting it', async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const showA = await store.nodes.CaShow.create({});
      const showB = await store.nodes.CaShow.create({});
      const clip = await store.nodes.CaClip.create(
        {},
        { partOf: { whole: { kind: "CaShow", id: showA.id } } },
      );

      // MUTATION CHECK: remove the `reattachedPart` arm from
      // `assertCompositionExistencePreserved`
      // (src/store/operations/composition-create.ts) — the window end is
      // then read as a detach of a live required part and this rejects with
      // CompositionExistenceError (`situation: "detach"`).
      await store.nodes.CaClip.reparent(clip.id, {
        whole: { kind: "CaShow", id: showB.id },
      });

      const all = await store.edges.caClipOf.find(
        {},
        {
          temporalMode: "includeEnded",
        },
      );
      expect(all).toHaveLength(2);
      const ended = all.filter((edge) => edge.toId === showA.id);
      const open = all.filter((edge) => edge.toId === showB.id);
      expect(ended).toHaveLength(1);
      expect(requireDefined(ended[0]).meta.validTo).toBeDefined();
      expect(open).toHaveLength(1);
      expect(requireDefined(open[0]).meta.validTo).toBeUndefined();
    });

    it.each(["bulkUpsertById", "getOrCreateByEndpoints"] as const)(
      "resurrecting an ended `oneActive` history row through %s attaches nothing and is not refused",
      async (entry) => {
        const store = await context.createStore(buildGraph(nextGraphId()));
        const showA = await store.nodes.CaShow.create({});
        const showB = await store.nodes.CaShow.create({});
        const reel = await store.nodes.CaReel.create(
          { slug: "reel-1" },
          { partOf: { whole: { kind: "CaShow", id: showA.id } } },
        );
        await store.nodes.CaReel.reparent(reel.id, {
          whole: { kind: "CaShow", id: showB.id },
        });
        const afterMove = await store.edges.caReelOf.find(
          {},
          { temporalMode: "includeEnded" },
        );
        const history = requireDefined(
          afterMove.find((edge) => edge.toId === showA.id),
        );
        expect(history.meta.validTo).toBeDefined();
        await store.edges.caReelOf.delete(history.id);

        // MUTATION CHECK: returning the composition claim unconditionally for a
        // resurrection in `compositionReentryClaim` refuses this with
        // CompositionError COMPOSITION_WHOLE_OCCUPIED, although the row would
        // stay ended — verified and reverted.
        if (entry === "bulkUpsertById") {
          await store.edges.caReelOf.bulkUpsertById([
            { id: history.id, from: reel, to: showA, props: {} },
          ]);
        } else {
          await store.edges.caReelOf.getOrCreateByEndpoints(reel, showA, {});
        }

        const afterRestore = await store.edges.caReelOf.find(
          {},
          { temporalMode: "includeEnded" },
        );
        const restored = requireDefined(
          afterRestore.find((edge) => edge.id === history.id),
        );
        expect(restored.meta.validTo).toBe(history.meta.validTo);
        const live = await store.edges.caReelOf.find({});
        expect(live.map((edge) => edge.toId)).toEqual([showB.id]);
        expect(await store.verifyConstraintFences()).toEqual([]);
      },
    );

    it("reparent is ONE move instant: the ended window and the new one abut", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const showA = await store.nodes.CaShow.create({});
      const showB = await store.nodes.CaShow.create({});
      const clip = await store.nodes.CaClip.create(
        {},
        { partOf: { whole: { kind: "CaShow", id: showA.id } } },
      );

      // This case asserts the invariant on every backend, but a two-read
      // implementation can pass it by luck: two `nowIso()` calls a few
      // statements apart often land in the same millisecond. The mutation
      // check for the SINGLE read lives in
      // `tests/composition-reparent-instant.test.ts`, which advances the
      // clock between the retire and the attach so a second read is
      // guaranteed to sample a later instant.
      await store.nodes.CaClip.reparent(clip.id, {
        whole: { kind: "CaShow", id: showB.id },
      });

      const all = await store.edges.caClipOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      const ended = requireDefined(
        all.find((edge) => edge.toId === showA.id),
        "the former attachment",
      );
      const open = requireDefined(
        all.find((edge) => edge.toId === showB.id),
        "the new attachment",
      );
      const moveInstant = requireDefined(
        ended.meta.validTo,
        "the ended window's validTo",
      );
      expect(open.meta.validFrom).toBe(moveInstant);

      // The windows are half-open, so the move instant belongs to exactly
      // one of them: no coordinate shows the part with zero wholes, and none
      // shows it with two.
      const atMove = await store.asOf(moveInstant).edges.caClipOf.find({});
      expect(atMove).toHaveLength(1);
      expect(requireDefined(atMove[0]).toId).toBe(showB.id);
    });

    it("reparent to the whole the part already holds is an accepted no-op", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );
      const beforeEdges = await store.edges.caChapterOf.find({});
      const before = requireDefined(beforeEdges[0]);

      await store.nodes.CaChapter.reparent(chapter.id, {
        whole: { kind: "CaBook", id: book.id },
        via: "caChapterOf",
      });

      const after = await store.edges.caChapterOf.find({});
      expect(after).toHaveLength(1);
      // No write at all: the SAME row, not a retire-and-recreate.
      expect(requireDefined(after[0]).id).toBe(before.id);
      expect(requireDefined(after[0]).meta.updatedAt).toBe(
        before.meta.updatedAt,
      );
    });

    it("reparent refuses a kind that is not a composition part", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const reader = await store.nodes.CaReader.create({});
      await expect(
        store.nodes.CaReader.reparent(reader.id, {
          // @ts-expect-error CaReader is no declared part, so no whole kind is accepted
          whole: { kind: "CaBook", id: "whatever" },
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          details: matchingObject({ code: "COMPOSITION_NOT_A_PART" }),
        }),
      );
    });

    it("reparent refuses an undeclared target pair and a missing part", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );
      const page = await store.nodes.CaPage.create(
        {},
        { partOf: { whole: { kind: "CaChapter", id: chapter.id } } },
      );

      await expect(
        store.nodes.CaPage.reparent(page.id, {
          // @ts-expect-error CaPage declares CaChapter as its only whole kind
          whole: { kind: "CaBook", id: book.id },
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);

      await expect(
        store.nodes.CaChapter.reparent(asNodeId("no-such-chapter"), {
          whole: { kind: "CaBook", id: book.id },
          via: "caChapterOf",
        }),
      ).rejects.toBeInstanceOf(NodeNotFoundError);
    });

    it("reparent validates acyclicity over the composition union against the FINAL state", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const root = await store.nodes.CaFolder.create({});
      const child = await store.nodes.CaFolder.create(
        {},
        { partOf: { whole: { kind: "CaFolder", id: root.id } } },
      );
      const grandchild = await store.nodes.CaFolder.create(
        {},
        { partOf: { whole: { kind: "CaFolder", id: child.id } } },
      );

      // MUTATION CHECK: drop the `assertPreparedEdgeCreatesAcyclic` call in
      // `prepareCompositionAttachmentMoves`
      // (src/store/operations/node-operations.ts) — the move then succeeds and leaves a three-node composition ring
      // that no ordinary delete can unwind (`CompositionCycleError`).
      await expect(
        store.nodes.CaFolder.reparent(root.id, {
          whole: { kind: "CaFolder", id: grandchild.id },
        }),
      ).rejects.toBeInstanceOf(EdgeAcyclicityError);

      // The refused move left the graph exactly as it was: the retire and
      // the attach are one transaction, so a failing attach rolls the
      // retire back too. Without that, `root` would now be detached.
      const links = await store.edges.caParentFolder.find({});
      expect(links).toHaveLength(2);
      expect(
        new Set(links.map((edge) => `${edge.fromId}->${edge.toId}`)),
      ).toEqual(
        new Set([`${child.id}->${root.id}`, `${grandchild.id}->${child.id}`]),
      );
    });

    it("a `oneActive` move's ended history row does not constrain later moves", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const root = await store.nodes.CaUnit.create({});
      const former = await store.nodes.CaUnit.create(
        {},
        { partOf: { whole: { kind: "CaUnit", id: root.id } } },
      );
      const report = await store.nodes.CaUnit.create(
        {},
        { partOf: { whole: { kind: "CaUnit", id: former.id } } },
      );
      // `report` leaves `former`: the edge between them is ended, not deleted.
      await store.nodes.CaUnit.reparent(report.id, {
        whole: { kind: "CaUnit", id: root.id },
      });

      // MUTATION CHECK: counting every non-deleted row of a `oneActive`
      // realizing edge in `compositionAcyclicRelation` (membership
      // `"allRows"`) refuses this swap with EdgeAcyclicityError "already
      // reaches", through the ended row — verified and reverted.
      await store.nodes.CaUnit.reparent(former.id, {
        whole: { kind: "CaUnit", id: report.id },
      });

      const live = await store.edges.caUnitUnder.find({});
      expect(
        new Set(live.map((edge) => `${edge.fromId}->${edge.toId}`)),
      ).toEqual(
        new Set([`${report.id}->${root.id}`, `${former.id}->${report.id}`]),
      );
      expect(await store.verifyConstraintFences()).toEqual([]);

      // A cycle among the LIVE rows is still refused.
      await expect(
        store.nodes.CaUnit.reparent(report.id, {
          whole: { kind: "CaUnit", id: former.id },
        }),
      ).rejects.toBeInstanceOf(EdgeAcyclicityError);
    });

    it("an `acyclic: true` declaration on a `oneActive` realizing edge keeps counting its ended rows", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const root = await store.nodes.CaCell.create({});
      const former = await store.nodes.CaCell.create(
        {},
        { partOf: { whole: { kind: "CaCell", id: root.id } } },
      );
      const report = await store.nodes.CaCell.create(
        {},
        { partOf: { whole: { kind: "CaCell", id: former.id } } },
      );
      await store.nodes.CaCell.reparent(report.id, {
        whole: { kind: "CaCell", id: root.id },
      });

      // MUTATION CHECK: dropping the `standaloneAcyclicEdgeKinds` exemption in
      // `compositionAcyclicRelation` accepts this move, and the audit then
      // reports the cycle the kind's own `acyclic: true` forbids — verified
      // and reverted.
      await expect(
        store.nodes.CaCell.reparent(former.id, {
          whole: { kind: "CaCell", id: report.id },
        }),
      ).rejects.toBeInstanceOf(EdgeAcyclicityError);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses a composition window that starts or ends later than now on every write path, writing nothing", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const later = "2999-01-01T00:00:00.000Z";
      const book = await store.nodes.CaBook.create({});
      const show = await store.nodes.CaShow.create({});
      const otherShow = await store.nodes.CaShow.create({});
      const clip = await store.nodes.CaClip.create(
        {},
        { partOf: { whole: show } },
      );
      const [held] = await store.edges.caClipOf.find({});
      if (held === undefined) throw new Error("expected the clip's edge");
      const chapterOf = { whole: book, via: "caChapterOf" } as const;

      // MUTATION CHECK: make `compositionWindowRefusal`
      // (src/store/operations/composition-create.ts) return `undefined` —
      // every write below then lands, leaving the clip with two current
      // wholes behind a released claim, or a chapter whose attachment starts
      // in the future, and the assertions after the loop fail.
      const refused: readonly (readonly [string, () => Promise<unknown>])[] = [
        [
          "COMPOSITION_VALIDITY_FUTURE_START",
          () =>
            store.nodes.CaChapter.create(
              { slug: "create" },
              { partOf: { ...chapterOf, validFrom: later } },
            ),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_START",
          () =>
            store.nodes.CaChapter.bulkCreate([
              {
                props: { slug: "bulk" },
                partOf: { ...chapterOf, validFrom: later },
              },
            ]),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_START",
          () =>
            store.nodes.CaChapter.getOrCreateByConstraint(
              "ca_chapter_slug",
              { slug: "get-or-create" },
              { partOf: { ...chapterOf, validFrom: later } },
            ),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_END",
          () =>
            store.nodes.CaChapter.create(
              { slug: "bounded" },
              { partOf: { ...chapterOf, validTo: later } },
            ),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_END",
          () =>
            store.edges.caClipOf.create(
              clip,
              otherShow,
              {},
              { validTo: later },
            ),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_START",
          () =>
            store.edges.caClipOf.create(
              clip,
              otherShow,
              {},
              { validFrom: later },
            ),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_END",
          () =>
            store.edges.caClipOf.bulkCreate([
              { from: clip, to: otherShow, props: {}, validTo: later },
            ]),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_END",
          () => store.edges.caClipOf.update(held.id, {}, { validTo: later }),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_END",
          () =>
            store.edges.caClipOf.bulkUpsertById([
              { id: held.id, from: clip, to: show, props: {}, validTo: later },
            ]),
        ],
        [
          "COMPOSITION_VALIDITY_FUTURE_END",
          () =>
            store.edges.caClipOf.getOrCreateByEndpoints(
              clip,
              show,
              {},
              { ifExists: "update", validTo: later },
            ),
        ],
        [
          "COMPOSITION_MOVE_FUTURE",
          () =>
            store.nodes.CaClip.reparent(clip.id, {
              whole: otherShow,
              at: later,
            }),
        ],
        [
          "COMPOSITION_MOVE_FUTURE",
          () =>
            store.nodes.CaClip.bulkReparent([
              { id: clip.id, options: { whole: otherShow, at: later } },
            ]),
        ],
      ];
      for (const [code, write] of refused) {
        const error = await write().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(CompositionError);
        expect(error).toMatchObject({ code });
      }

      expect(await store.nodes.CaChapter.count()).toBe(0);
      const rows = await store.edges.caClipOf.find(
        {},
        { temporalMode: "includeEnded" },
      );
      expect(rows.map((edge) => [edge.id, edge.meta.validTo])).toEqual([
        [held.id, undefined],
      ]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("judges an ended `oneActive` history row outside the composition relation on every write that proposes it", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const whole = await store.nodes.CaUnit.create({});
      const part = await store.nodes.CaUnit.create({});
      // `whole` under `part` is live; `part` under `whole` is history only.
      await store.edges.caUnitUnder.create(whole, part, {});
      const history = {
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2021-01-01T00:00:00.000Z",
      };

      // MUTATION CHECK: drop the `acyclicRelationCountsRow` filter from
      // `groupProposedByAcyclicRelation` (src/store/acyclicity.ts) — each
      // write below is then refused with EdgeAcyclicityError "would close a
      // cycle in the composition relation", although none of them puts a
      // member into the relation.
      const created = await store.edges.caUnitUnder.create(
        part,
        whole,
        {},
        history,
      );
      await store.edges.caUnitUnder.bulkCreate([
        { from: part, to: whole, props: {}, ...history },
      ]);
      await store.edges.caUnitUnder.delete(created.id);
      const [revived] = await store.edges.caUnitUnder.bulkUpsertById([
        { id: created.id, from: part, to: whole, props: {} },
      ]);
      expect(requireDefined(revived).meta.validTo).toBe(history.validTo);

      const live = await store.edges.caUnitUnder.find({});
      expect(live.map((edge) => `${edge.fromId}->${edge.toId}`)).toEqual([
        `${whole.id}->${part.id}`,
      ]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses reopening an ended `oneActive` history row that would close a composition cycle, on every reopen surface", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const whole = await store.nodes.CaUnit.create({});
      const part = await store.nodes.CaUnit.create({});
      const ended = await store.edges.caUnitUnder.create(
        part,
        whole,
        {},
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
      );
      await store.edges.caUnitUnder.create(whole, part, {});

      // MUTATION CHECK: probe only resurrections in `prepareEdgeUpdate`
      // (`edgeUpdateReentersAcyclicRelation` answering `false` for a reopen,
      // src/store/operations/edge-operations.ts) — every reopen below then
      // lands and the audit reports the cycle.
      const reopens: readonly (() => Promise<unknown>)[] = [
        () =>
          store.edges.caUnitUnder.update(ended.id, {}, { clearValidTo: true }),
        () =>
          store.edges.caUnitUnder.bulkUpsertById([
            {
              id: ended.id,
              from: part,
              to: whole,
              props: {},
              clearValidTo: true,
            },
          ]),
        () =>
          store.edges.caUnitUnder.getOrCreateByEndpoints(
            part,
            whole,
            {},
            { ifExists: "update", clearValidTo: true },
          ),
      ];
      for (const reopen of reopens) {
        await expect(reopen()).rejects.toBeInstanceOf(EdgeAcyclicityError);
      }
      const stillEnded = await store.edges.caUnitUnder.getById(ended.id, {
        temporalMode: "includeEnded",
      });
      expect(stillEnded?.meta.validTo).toBe("2021-01-01T00:00:00.000Z");
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses two reopens that close a composition cycle together before either is written", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const left = await store.nodes.CaUnit.create({});
      const right = await store.nodes.CaUnit.create({});
      const history = {
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2021-01-01T00:00:00.000Z",
      };
      const leftUnderRight = await store.edges.caUnitUnder.create(
        left,
        right,
        {},
        history,
      );
      const rightUnderLeft = await store.edges.caUnitUnder.create(
        right,
        left,
        {},
        history,
      );

      // MUTATION CHECK: drop the reopen arm from
      // `proposedRelationEdgesFromReentries`
      // (src/store/operations/edge-operations.ts) — the batch then writes the
      // first reopen before the second one's own probe refuses, and the
      // caught transaction commits it.
      await store.transaction(async (tx) => {
        await expect(
          tx.edges.caUnitUnder.bulkUpsertById([
            {
              id: leftUnderRight.id,
              from: left,
              to: right,
              props: {},
              clearValidTo: true,
            },
            {
              id: rightUnderLeft.id,
              from: right,
              to: left,
              props: {},
              clearValidTo: true,
            },
          ]),
        ).rejects.toBeInstanceOf(EdgeAcyclicityError);
      });
      expect(await store.edges.caUnitUnder.find({})).toEqual([]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("bulkReparent counts an ended incumbent against a whole-side `one` bound, refusing a swap before any write", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const carA = await store.nodes.CaCar.create({});
      const carB = await store.nodes.CaCar.create({});
      const engineX = await store.nodes.CaEngine.create(
        {},
        { partOf: { whole: carA } },
      );
      const engineY = await store.nodes.CaEngine.create(
        {},
        { partOf: { whole: carB } },
      );
      const openRows = async () => {
        const open = await store.edges.caEngineOf.find({});
        return new Set(open.map((edge) => `${edge.fromId}->${edge.toId}`));
      };
      const before = await openRows();

      // A move ENDS the incumbent's window, and the ended row still occupies
      // its car's one slot, so the single move is refused...
      await expect(
        store.nodes.CaEngine.reparent(engineX.id, { whole: carB }),
      ).rejects.toBeInstanceOf(CardinalityError);

      // ...and so is the swap, before it ends either window. MUTATION CHECK:
      // subtract an `"endWindow"` retire from every count in
      // `retireLeavesCount` (src/store/operations/edge-batch-validation.ts) —
      // the swap then passes its preparation, ends both windows, and fails
      // only at the insert's claim, so the caught transaction commits two
      // required engines with no car.
      await store.transaction(async (tx) => {
        await expect(
          tx.nodes.CaEngine.bulkReparent([
            { id: engineX.id, options: { whole: carB } },
            { id: engineY.id, options: { whole: carA } },
          ]),
        ).rejects.toBeInstanceOf(CardinalityError);
      });
      expect(await openRows()).toEqual(before);
      expect(
        await store.edges.caEngineOf.find({}, { temporalMode: "includeEnded" }),
      ).toHaveLength(2);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("bulkReparent keeps an ended incumbent in an `acyclic: true` relation that counts it", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const root = await store.nodes.CaCell.create({});
      const former = await store.nodes.CaCell.create(
        {},
        { partOf: { whole: root } },
      );
      const report = await store.nodes.CaCell.create(
        {},
        { partOf: { whole: former } },
      );

      // `report` leaves `former` (its row is ended, and still counted by
      // `caCellUnder`'s own `acyclic: true`) while `former` moves under
      // `report`. MUTATION CHECK: exclude every retired incumbent from the
      // probe in `prepareCompositionAttachmentMoves`
      // (`retireRemovesFromAcyclicRelation` answering `true`,
      // src/store/operations/node-operations.ts) — the batch then commits
      // the cycle the sequential moves refuse, and the audit reports it.
      await expect(
        store.nodes.CaCell.bulkReparent([
          { id: report.id, options: { whole: root } },
          { id: former.id, options: { whole: report } },
        ]),
      ).rejects.toBeInstanceOf(EdgeAcyclicityError);
      const live = await store.edges.caCellUnder.find({});
      expect(
        new Set(live.map((edge) => `${edge.fromId}->${edge.toId}`)),
      ).toEqual(
        new Set([`${former.id}->${root.id}`, `${report.id}->${former.id}`]),
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    // `population: "oneActive"` retires by ending the incumbent's window,
    // `population: "one"` by deleting it; both reflexive, so one batch can
    // carry a cycle.
    const reflexivePairs = [
      { population: "oneActive", kind: "CaUnit", via: "caUnitUnder" },
      { population: "one", kind: "CaFolder", via: "caParentFolder" },
    ] as const;

    describe.each(reflexivePairs)(
      "bulkReparent on a `population: $population` pair",
      ({ population, kind, via }) => {
        async function seed() {
          const store = await context.createStore(buildGraph(nextGraphId()));
          const nodes = requireDefined(store.getNodeCollection(kind));
          const edges = requireDefined(store.getEdgeCollection(via));
          const rootA = await nodes.create({});
          const rootB = await nodes.create({});
          const first = await nodes.create(
            {},
            { partOf: { whole: { kind, id: rootA.id } } },
          );
          const second = await nodes.create(
            {},
            { partOf: { whole: { kind, id: rootA.id } } },
          );
          const liveLinks = async (): Promise<ReadonlySet<string>> => {
            const live = await edges.find({});
            return new Set(live.map((edge) => `${edge.fromId}->${edge.toId}`));
          };
          return { store, edges, rootA, rootB, first, second, liveLinks };
        }

        it("leaves no earlier move behind when a later item is refused and the caller catches it in a transaction", async () => {
          const { store, edges, rootA, rootB, first, second, liveLinks } =
            await seed();
          const before = await liveLinks();
          const refusedBatches = [
            // A destination that does not exist.
            [
              { id: first.id, options: { whole: { kind, id: rootB.id } } },
              { id: second.id, options: { whole: { kind, id: "missing" } } },
            ],
            // A cycle the batch's own moves close between them.
            [
              { id: first.id, options: { whole: { kind, id: rootB.id } } },
              { id: rootB.id, options: { whole: { kind, id: first.id } } },
            ],
            // A move instant that precedes the window it would end. Only a
            // `oneActive` retire ends a window; a `one` retire deletes.
            ...(population === "oneActive" ?
              [
                [
                  { id: first.id, options: { whole: { kind, id: rootB.id } } },
                  {
                    id: second.id,
                    options: {
                      whole: { kind, id: rootB.id },
                      at: "1999-01-01T00:00:00.000Z",
                    },
                  },
                ],
              ]
            : []),
          ];

          // MUTATION CHECK: deciding and writing one item at a time in
          // `executeNodeReparentBatch` leaves `first` under `rootB` after
          // each of these — verified and reverted.
          for (const items of refusedBatches) {
            await store.transaction(async (tx) => {
              const parts = requireDefined(tx.getNodeCollection(kind));
              await expect(parts.bulkReparent(items)).rejects.toThrow();
            });
            expect(await liveLinks()).toEqual(before);
          }
          expect(before).toEqual(
            new Set([`${first.id}->${rootA.id}`, `${second.id}->${rootA.id}`]),
          );
          expect(
            await edges.find({}, { temporalMode: "includeEnded" }),
          ).toHaveLength(2);
          expect(await store.verifyConstraintFences()).toEqual([]);
        });

        it("judges acyclicity on the state the whole batch produces, in either item order", async () => {
          const { store, rootA, first, liveLinks } = await seed();
          const nodes = requireDefined(store.getNodeCollection(kind));
          const leaf = await nodes.create(
            {},
            { partOf: { whole: { kind, id: first.id } } },
          );

          // `first` moves under its own child while that child moves out from
          // under it: a cycle only if the first item is judged alone.
          const results = await nodes.bulkReparent([
            { id: first.id, options: { whole: { kind, id: leaf.id } } },
            { id: leaf.id, options: { whole: { kind, id: rootA.id } } },
          ]);

          expect(results.map((result) => result.moved)).toEqual([true, true]);
          const links = await liveLinks();
          expect(links.has(`${first.id}->${leaf.id}`)).toBe(true);
          expect(links.has(`${leaf.id}->${rootA.id}`)).toBe(true);
          expect(links.has(`${leaf.id}->${first.id}`)).toBe(false);
          expect(await store.verifyConstraintFences()).toEqual([]);
        });

        it("refuses a batch that names one part twice, moving nothing", async () => {
          const { store, rootA, rootB, first, liveLinks } = await seed();
          const nodes = requireDefined(store.getNodeCollection(kind));
          const before = await liveLinks();

          await expect(
            nodes.bulkReparent([
              { id: first.id, options: { whole: { kind, id: rootB.id } } },
              { id: first.id, options: { whole: { kind, id: rootA.id } } },
            ]),
          ).rejects.toBeInstanceOf(ValidationError);

          expect(await liveLinks()).toEqual(before);
        });
      },
    );

    it("bulkCreate attaches more parts than one acyclicity statement can carry", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createStore(graph);
      const bindBudget = 100;
      const partCount = 30;
      const budgeted = createStore(
        graph,
        withBindBudget(store.backend, bindBudget),
      );
      const show = await store.nodes.CaShow.create({});

      // MUTATION CHECK: sending every prepared composition edge in one probe
      // statement (`readUnwrittenEdgeReaches` never slicing) binds more than
      // the budget for these 30 parts, and the budgeted backend refuses the
      // statement — verified and reverted.
      await budgeted.nodes.CaClip.bulkCreate(
        Array.from({ length: partCount }, () => ({
          props: {},
          partOf: { whole: { kind: "CaShow", id: show.id } },
        })),
      );

      expect(await store.edges.caClipOf.find({})).toHaveLength(partCount);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("reparent inside a transaction counts as ONE node write intent", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const anthology = await store.nodes.CaAnthology.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      // MUTATION CHECK: drop `reparent` from `NODE_WRITE_NAMES`
      // (src/store/collection-surface.ts) and the sealed transaction
      // collection stops counting the move at all — `writes.nodes` comes back
      // `{}` and `total` 0, while the move itself still lands.
      const { receipt } = await store.transactionWithReceipt(async (tx) => {
        await tx.nodes.CaChapter.reparent(chapter.id, {
          whole: { kind: "CaAnthology", id: anthology.id },
          via: "caIncludedIn",
        });
      });

      // ONE intent for the caller's one call: the retire and the attach are
      // this operation's own row work, not two collection-surface writes.
      expect(receipt.writes.nodes).toEqual({ CaChapter: 1 });
      expect(receipt.writes.edges).toEqual({});
      expect(receipt.writes.total).toBe(1);
      expect(receipt.cascadedParts).toEqual([]);

      const moved = await store.edges.caIncludedIn.find({});
      expect(moved).toHaveLength(1);
      expect(requireDefined(moved[0]).toId).toBe(anthology.id);
      expect(await store.edges.caChapterOf.find({})).toHaveLength(0);
    });

    it("bulkDelete naming a part before its own whole deletes each node once and reports each cascaded part once", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const root = await store.nodes.CaFolder.create({});
      const child = await store.nodes.CaFolder.create(
        {},
        { partOf: { whole: { kind: "CaFolder", id: root.id } } },
      );
      const leaf = await store.nodes.CaFolder.create(
        {},
        { partOf: { whole: { kind: "CaFolder", id: child.id } } },
      );

      // MUTATION CHECK: drop `withoutPlannedDeleteEffects` from
      // `planCascadingNodeDelete` (src/store/operations/node-operations.ts) —
      // the root's plan, read before any delete of the batch ran, still names
      // the child and the leaf, so both are deleted a second time and
      // `cascadedParts` reads [leaf, leaf, child].
      const { receipt } = await store.transactionWithReceipt(async (tx) => {
        await tx.nodes.CaFolder.bulkDelete([child.id, root.id]);
      });

      expect(receipt.cascadedParts).toEqual([
        { kind: "CaFolder", id: leaf.id },
      ]);
      expect(await store.nodes.CaFolder.find({})).toEqual([]);
      expect(await store.edges.caParentFolder.find({})).toEqual([]);
    });

    it("bulkDelete naming a whole before its own part reports the part as cascaded once", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const root = await store.nodes.CaFolder.create({});
      const child = await store.nodes.CaFolder.create(
        {},
        { partOf: { whole: { kind: "CaFolder", id: root.id } } },
      );
      const leaf = await store.nodes.CaFolder.create(
        {},
        { partOf: { whole: { kind: "CaFolder", id: child.id } } },
      );

      const { receipt } = await store.transactionWithReceipt(async (tx) => {
        await tx.nodes.CaFolder.bulkDelete([root.id, child.id]);
      });

      expect(receipt.cascadedParts).toEqual([
        { kind: "CaFolder", id: leaf.id },
        { kind: "CaFolder", id: child.id },
      ]);
      expect(await store.nodes.CaFolder.find({})).toEqual([]);
    });

    // ========================================================
    // `partOf` on get-or-create is a POSTCONDITION
    // ========================================================

    it("getOrCreateByConstraint with partOf is idempotent when the whole already matches", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const attachment = {
        whole: book,
        via: "caChapterOf",
        props: { order: 1 },
      };

      const first = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "one" },
        { partOf: attachment },
      );
      expect(first.action).toBe("created");

      // MUTATION CHECK: restore the unconditional refusal (throw
      // `CompositionExistenceError` whenever `partOf` is stated against a
      // found/updated node — `decideCompositionIncumbent`'s satisfied arm,
      // src/store/operations/composition-create.ts) — this second call then
      // rejects instead of returning `"found"`.
      const second = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "one" },
        { partOf: attachment },
      );
      expect(second.action).toBe("found");
      expect(second.node.id).toBe(first.node.id);
      expect(await store.edges.caChapterOf.find({})).toHaveLength(1);
    });

    it("getOrCreateByConstraint with partOf refuses a DIFFERENT live whole, naming both", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const anthology = await store.nodes.CaAnthology.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      const error = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "one" },
        { partOf: { whole: { kind: "CaAnthology", id: anthology.id } } },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CompositionExistenceError);
      expect((error as CompositionExistenceError).code).toBe(
        "COMPOSITION_WHOLE_CONFLICT",
      );
      const details = (error as CompositionExistenceError).details;
      expect(details.situation).toBe("existing");
      expect(details.partId).toBe(chapter.id);
      expect(details.currentWhole).toEqual({
        kind: "CaBook",
        id: book.id,
      });
      expect(details.requestedWhole).toEqual({
        kind: "CaAnthology",
        id: anthology.id,
      });
      // Refused, not moved.
      expect(await store.edges.caIncludedIn.find({})).toHaveLength(0);
    });

    it("getOrCreateByConstraint with partOf refuses the same whole reached through a different `via`", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      // MUTATION CHECK: drop the realizing-edge conjunct from
      // `incumbentHoldsRequestedAttachment`
      // (src/store/operations/composition-create.ts) — the call then reports
      // success while the node hangs off `caChapterOf`, not the
      // `caDraftChapterOf` the caller asked for.
      const error = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caDraftChapterOf",
          },
        },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CompositionExistenceError);
      const details = (error as CompositionExistenceError).details;
      expect(details.currentVia).toBe("caChapterOf");
      expect(details.requestedVia).toBe("caDraftChapterOf");
      expect(await store.edges.caDraftChapterOf.find({})).toHaveLength(0);
    });

    it("getOrCreateByConstraint with partOf attaches a found node that has NO live whole", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      // An optional part created bare — legal, and exactly the state the
      // postcondition has to repair rather than refuse.
      const chapter = await store.nodes.CaChapter.create({ slug: "one" });
      expect(await store.edges.caChapterOf.find({})).toHaveLength(0);

      // MUTATION CHECK: restore the unconditional refusal — this rejects
      // with `CompositionExistenceError` and no edge is ever written.
      const result = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 7 },
          },
        },
      );

      expect(result.action).toBe("found");
      expect(result.node.id).toBe(chapter.id);
      const edges = await store.edges.caChapterOf.find({});
      expect(edges).toHaveLength(1);
      expect(requireDefined(edges[0]).fromId).toBe(chapter.id);
      expect(requireDefined(edges[0]).order).toBe(7);
    });

    it("getOrCreateByConstraint refuses an AMBIGUOUS partOf on a found node, exactly as on a create", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      // Already attached through ONE of the two declared pairs — the state
      // that used to let the satisfied arm answer "any via will do".
      await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      // MUTATION CHECK: resolve the attachment only after the incumbent is
      // read — move `resolveGetOrCreateAttachmentRequest`'s call
      // (src/store/operations/node-operations.ts) below the satisfied arm, or
      // drop the `resolveCompositionAttachment` call out of
      // `resolveCompositionCreate` (src/store/operations/composition-create.ts)
      // — this call then returns
      // `{ action: "found" }` with no error, while the same `partOf` on a
      // create refuses.
      await expect(
        store.nodes.CaChapter.getOrCreateByConstraint(
          "ca_chapter_slug",
          { slug: "one" },
          { partOf: { whole: { kind: "CaBook", id: book.id } } },
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          details: matchingObject({ code: "COMPOSITION_VIA_AMBIGUOUS" }),
        }),
      );
    });

    it("getOrCreateByConstraint refuses an UNDECLARED whole kind on a found node as a ConfigurationError, not a contradiction", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const reader = await store.nodes.CaReader.create({});
      await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      // MUTATION CHECK: as above — resolving only on the no-whole arm makes
      // this a `CompositionExistenceError` (`situation: "existing"`) naming
      // `CaReader` as the requested whole, and its suggestion tells the
      // caller to `reparent` to a whole `reparent` itself refuses.
      const error = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "one" },
        {
          partOf: {
            // @ts-expect-error CaReader is not a whole kind declared for CaChapter
            whole: { kind: "CaReader", id: reader.id },
          },
        },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).not.toBeInstanceOf(CompositionExistenceError);
      expect((error as ConfigurationError).details).toEqual(
        matchingObject({ code: "COMPOSITION_WHOLE_NOT_DECLARED" }),
      );
    });

    it("bulkGetOrCreateByConstraint discharges the postcondition per item: idempotent hit beside an unattached repair", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const attachment = {
        whole: book,
        via: "caChapterOf",
        props: { order: 1 },
      };
      // Item "a" already holds this exact attachment — same via, same
      // props; item "b" exists with NO whole at all. One batch, two
      // different dispositions.
      const attached = await store.nodes.CaChapter.create(
        { slug: "a" },
        { partOf: attachment },
      );
      const bare = await store.nodes.CaChapter.create({ slug: "b" });
      expect(await store.edges.caChapterOf.find({})).toHaveLength(1);

      // MUTATION CHECK: stop resolving the attachment on the bulk entry's
      // existing-row legs (drop either
      // `resolveGetOrCreateAttachmentRequest` call in
      // `executeNodeBulkGetOrCreateByConstraint`,
      // src/store/operations/node-operations.ts) — item "b" then comes back
      // `"found"` with no edge written, and the edge count below stays 1.
      const results = await store.nodes.CaChapter.bulkGetOrCreateByConstraint(
        "ca_chapter_slug",
        [{ props: { slug: "a" } }, { props: { slug: "b" } }],
        { partOf: attachment },
      );
      expect(results.map((entry) => entry.action)).toEqual(["found", "found"]);

      const edges = await store.edges.caChapterOf.find({});
      expect(edges).toHaveLength(2);
      // "a"'s satisfied hit is genuinely idempotent — the batch's stated
      // props are the same value it already held — and "b"'s brand-new
      // edge is written fresh with the same props.
      expect(
        requireDefined(edges.find((edge) => edge.fromId === attached.id)).order,
      ).toBe(1);
      expect(
        requireDefined(edges.find((edge) => edge.fromId === bare.id)).order,
      ).toBe(1);
    });

    it("getOrCreateByConstraint refuses a satisfied match's DIFFERENT props rather than silently keeping the stored value", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "a" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      // MUTATION CHECK: remove the `assertSatisfiedPartOfPropsHonored` call
      // from `decideCompositionIncumbent`'s satisfied arm
      // (src/store/operations/composition-create.ts) — this then resolves
      // `"found"` with the edge silently left at `order: 1`, and the
      // assertions below fail. Widening the lock-free pre-check in
      // `applyExistingPartOfPostcondition` (node-operations.ts) to skip the
      // fence when `props` are stated does the same.
      const error = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "a" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 2 },
          },
        },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CompositionExistenceError);
      expect((error as CompositionExistenceError).code).toBe(
        "COMPOSITION_PROPS_CONFLICT",
      );
      expect((error as CompositionExistenceError).details).toEqual(
        matchingObject({
          situation: "props",
          edgeKind: "caChapterOf",
          currentProps: matchingObject({ order: 1 }),
          requestedProps: matchingObject({ order: 2 }),
        }),
      );

      // The refusal did not partially apply the stated props.
      const chapterEdges = await store.edges.caChapterOf.find({});
      const edge = requireDefined(
        chapterEdges.find((candidate) => candidate.fromId === chapter.id),
      );
      expect(edge.order).toBe(1);
    });

    it("getOrCreateByConstraint validates a satisfied match's props against the edge schema even though it writes nothing", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      await store.nodes.CaChapter.create(
        { slug: "a" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      // MUTATION CHECK: same call site as above — without the validation
      // step this resolves `"found"` instead of throwing `ValidationError`.
      const error = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "a" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: "not-a-number" },
          },
        },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(ValidationError);
    });

    it("reparent's no-op arm honors stated props the same way: refuses a valid but DIFFERENT value", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "a" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      // MUTATION CHECK: remove the `assertSatisfiedPartOfPropsHonored` call
      // from `decideCompositionIncumbent`'s satisfied arm
      // (src/store/operations/composition-create.ts) — reparent's no-op arm
      // then resolves silently, leaving the edge at `order: 1`.
      const error = await store.nodes.CaChapter.reparent(chapter.id, {
        whole: { kind: "CaBook", id: book.id },
        via: "caChapterOf",
        props: { order: 2 },
      }).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CompositionExistenceError);
      expect((error as CompositionExistenceError).details).toEqual(
        matchingObject({
          situation: "props",
          edgeKind: "caChapterOf",
          currentProps: matchingObject({ order: 1 }),
          requestedProps: matchingObject({ order: 2 }),
        }),
      );

      const chapterEdges = await store.edges.caChapterOf.find({});
      const edge = requireDefined(
        chapterEdges.find((candidate) => candidate.fromId === chapter.id),
      );
      expect(edge.order).toBe(1);
    });

    it("bulkGetOrCreateByConstraint refuses the whole batch when ONE item's found node holds a different whole", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const anthology = await store.nodes.CaAnthology.create({});
      await store.nodes.CaChapter.create(
        { slug: "a" },
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );
      // "b" holds a DIFFERENT whole, through a different realizing edge.
      const elsewhere = await store.nodes.CaChapter.create(
        { slug: "b" },
        { partOf: { whole: { kind: "CaAnthology", id: anthology.id } } },
      );

      // Same props "a" already holds (order: 1): the batch's mismatch is
      // "b"'s whole alone, isolating `situation: "existing"` from the
      // `situation: "props"` refusal covered separately above.
      //
      // MUTATION CHECK: as in the previous case — with the bulk
      // postcondition call sites disabled this batch resolves silently to
      // two `"found"` results and leaves "b" hanging off the anthology.
      const error = await store.nodes.CaChapter.bulkGetOrCreateByConstraint(
        "ca_chapter_slug",
        [{ props: { slug: "a" } }, { props: { slug: "b" } }],
        {
          partOf: {
            whole: { kind: "CaBook", id: book.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CompositionExistenceError);
      const details = (error as CompositionExistenceError).details;
      expect(details.situation).toBe("existing");
      expect(details.partId).toBe(elsewhere.id);
      expect(details.currentWhole).toEqual({
        kind: "CaAnthology",
        id: anthology.id,
      });
      expect(details.requestedWhole).toEqual({ kind: "CaBook", id: book.id });
      // Refused, not moved: "b" keeps the anthology and gains no book edge.
      expect(await store.edges.caIncludedIn.find({})).toHaveLength(1);
      expect(await store.edges.caChapterOf.find({})).toHaveLength(1);
    });

    it("bulkGetOrCreateByConstraint creates nothing when a matched item's refusal is caught inside an enclosing transaction", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const held = await store.nodes.CaBook.create({});
      const requested = await store.nodes.CaBook.create({});
      await store.nodes.CaChapter.create(
        { slug: "held" },
        {
          partOf: {
            whole: { kind: "CaBook", id: held.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      let caught: unknown;
      // MUTATION CHECK: run the batch's creates before its matched items
      // (swap steps 5 and 6 of `executeNodeBulkGetOrCreateByConstraint`,
      // src/store/operations/node-operations.ts) — "fresh" is then created
      // and attached before "held" refuses, and survives the caught refusal.
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaChapter.bulkGetOrCreateByConstraint(
            "ca_chapter_slug",
            [{ props: { slug: "fresh" } }, { props: { slug: "held" } }],
            {
              partOf: {
                whole: { kind: "CaBook", id: requested.id },
                via: "caChapterOf",
                props: { order: 1 },
              },
            },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CompositionExistenceError);
      const chapters = await store.nodes.CaChapter.find({});
      expect(chapters.map((chapter) => chapter.slug)).toEqual(["held"]);
      expect(await store.edges.caChapterOf.find({})).toHaveLength(1);
    });

    // --------------------------------------------------------
    // A batch reaches every matched item's verdict before its first write
    //
    // Each case catches the refusal INSIDE an enclosing transaction and
    // commits: the operations layer has no savepoints, so anything the batch
    // wrote before refusing would stay. MUTATION CHECK, shared by all of
    // them: drop the `assertGetOrCreateBatchApplicable` call from
    // `executeNodeBulkGetOrCreateByConstraint`
    // (src/store/operations/node-operations.ts) — the item listed FIRST is
    // then written before the later item refuses, and survives.
    // --------------------------------------------------------

    it("bulkGetOrCreateByConstraint attaches no earlier found item when a later one is refused and the caller catches it in a transaction", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const held = await store.nodes.CaBook.create({});
      const requested = await store.nodes.CaBook.create({});
      const bare = await store.nodes.CaChapter.create({ slug: "bare" });
      await store.nodes.CaChapter.create(
        { slug: "held" },
        {
          partOf: {
            whole: { kind: "CaBook", id: held.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaChapter.bulkGetOrCreateByConstraint(
            "ca_chapter_slug",
            [{ props: { slug: "bare" } }, { props: { slug: "held" } }],
            {
              partOf: {
                whole: { kind: "CaBook", id: requested.id },
                via: "caChapterOf",
                props: { order: 2 },
              },
            },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CompositionExistenceError);
      expect((caught as CompositionExistenceError).details.situation).toBe(
        "existing",
      );
      // "bare" was never attached: the one edge is still "held"'s own.
      const edges = await store.edges.caChapterOf.find({});
      expect(edges.map((edge) => edge.toId)).toEqual([held.id]);
      expect(edges.some((edge) => edge.fromId === bare.id)).toBe(false);
    });

    it("bulkGetOrCreateByConstraint refuses a satisfied item's different props before attaching an earlier item", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const bare = await store.nodes.CaChapter.create({ slug: "bare" });
      await store.nodes.CaChapter.create(
        { slug: "attached" },
        {
          partOf: { whole: book, via: "caChapterOf", props: { order: 1 } },
        },
      );

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaChapter.bulkGetOrCreateByConstraint(
            "ca_chapter_slug",
            [{ props: { slug: "bare" } }, { props: { slug: "attached" } }],
            {
              partOf: { whole: book, via: "caChapterOf", props: { order: 2 } },
            },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CompositionExistenceError);
      expect((caught as CompositionExistenceError).details.situation).toBe(
        "props",
      );
      const edges = await store.edges.caChapterOf.find({});
      expect(edges).toHaveLength(1);
      expect(edges.some((edge) => edge.fromId === bare.id)).toBe(false);
    });

    it("bulkGetOrCreateByConstraint judges acyclicity over the whole batch before attaching any item", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const outer = await store.nodes.CaNest.create({ slug: "outer" });
      const inner = await store.nodes.CaNest.create({ slug: "inner" });

      // The batch's shared whole is one of its own matched items: "inner"
      // may go under "outer", but "outer" under itself is a self-loop.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaNest.bulkGetOrCreateByConstraint(
            "ca_nest_slug",
            [{ props: { slug: "inner" } }, { props: { slug: "outer" } }],
            { partOf: { whole: outer } },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(EdgeAcyclicityError);
      expect(await store.edges.caNestUnder.find({})).toEqual([]);
      expect(inner.id).not.toBe(outer.id);
    });

    it('bulkGetOrCreateByConstraint with ifExists "update" updates and attaches no earlier item when a later one is refused', async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const held = await store.nodes.CaBook.create({});
      const requested = await store.nodes.CaBook.create({});
      const bare = await store.nodes.CaChapter.create({ slug: "bare" });
      await store.nodes.CaChapter.create(
        { slug: "held" },
        {
          partOf: {
            whole: { kind: "CaBook", id: held.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaChapter.bulkGetOrCreateByConstraint(
            "ca_chapter_slug",
            [{ props: { slug: "bare" } }, { props: { slug: "held" } }],
            {
              ifExists: "update",
              partOf: {
                whole: { kind: "CaBook", id: requested.id },
                via: "caChapterOf",
                props: { order: 2 },
              },
            },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CompositionExistenceError);
      // Neither half of "bare"'s leg landed: no property update (the row's
      // version is the one its create wrote) and no attachment.
      const after = requireDefined(
        await store.nodes.CaChapter.getById(bare.id),
      );
      expect(after.meta.version).toBe(bare.meta.version);
      expect(await store.edges.caChapterOf.find({})).toHaveLength(1);
    });

    it("bulkGetOrCreateByConstraint resurrects no earlier tombstone when a later item is refused", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const held = await store.nodes.CaBook.create({});
      const requested = await store.nodes.CaBook.create({});
      const gone = await store.nodes.CaChapter.create({ slug: "gone" });
      await store.nodes.CaChapter.delete(gone.id);
      await store.nodes.CaChapter.create(
        { slug: "held" },
        {
          partOf: {
            whole: { kind: "CaBook", id: held.id },
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaChapter.bulkGetOrCreateByConstraint(
            "ca_chapter_slug",
            [{ props: { slug: "gone" } }, { props: { slug: "held" } }],
            {
              partOf: {
                whole: { kind: "CaBook", id: requested.id },
                via: "caChapterOf",
                props: { order: 2 },
              },
            },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CompositionExistenceError);
      expect(await store.nodes.CaChapter.getById(gone.id)).toBeUndefined();
      expect(await store.edges.caChapterOf.find({})).toHaveLength(1);
    });

    it('bulkGetOrCreateByConstraint with ifExists "update" updates no earlier item when a later update loses a unique key', async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const first = await store.nodes.CaStamp.create({
        code: "a",
        label: "one",
      });
      await store.nodes.CaStamp.create({ code: "b", label: "two" });
      const holder = await store.nodes.CaStamp.create({
        code: "c",
        label: "taken",
      });

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaStamp.bulkGetOrCreateByConstraint(
            "ca_stamp_code",
            [
              { props: { code: "a", label: "renamed" } },
              { props: { code: "b", label: "taken" } },
            ],
            { ifExists: "update" },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(UniquenessError);
      expect((caught as UniquenessError).details.existingId).toBe(holder.id);
      const after = requireDefined(await store.nodes.CaStamp.getById(first.id));
      expect(after.label).toBe("one");
      expect(after.meta.version).toBe(first.meta.version);
    });

    it('bulkGetOrCreateByConstraint with ifExists "update" refuses two items claiming one unique key, updating neither', async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const first = await store.nodes.CaStamp.create({
        code: "a",
        label: "one",
      });
      const second = await store.nodes.CaStamp.create({
        code: "b",
        label: "two",
      });

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaStamp.bulkGetOrCreateByConstraint(
            "ca_stamp_code",
            [
              { props: { code: "a", label: "shared" } },
              { props: { code: "b", label: "shared" } },
            ],
            { ifExists: "update" },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(UniquenessError);
      expect((caught as UniquenessError).details.existingId).toBe(first.id);
      const labels = await Promise.all(
        [first, second].map(async (stamp) => {
          const row = await store.nodes.CaStamp.getById(stamp.id);
          return requireDefined(row).label;
        }),
      );
      expect(labels).toEqual(["one", "two"]);
    });

    it('bulkGetOrCreateByConstraint with ifExists "update" lets a later item take a unique key an earlier item of the batch gives up', async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const first = await store.nodes.CaStamp.create({
        code: "a",
        label: "one",
      });
      const second = await store.nodes.CaStamp.create({
        code: "b",
        label: "two",
      });

      // MUTATION CHECK: judge each update against the stored claims alone
      // (drop the pending-release overlay in `assertNodeClaimTransitionsAvailable`,
      // src/store/claims/node-claims.ts) — "b" is then refused for a key "a"
      // stops holding in this same batch.
      const results = await store.nodes.CaStamp.bulkGetOrCreateByConstraint(
        "ca_stamp_code",
        [
          { props: { code: "a", label: "moved" } },
          { props: { code: "b", label: "one" } },
        ],
        { ifExists: "update" },
      );

      expect(results.map((entry) => entry.action)).toEqual([
        "updated",
        "updated",
      ]);
      expect(results.map((entry) => entry.node.label)).toEqual([
        "moved",
        "one",
      ]);
      expect(results.map((entry) => entry.node.id)).toEqual([
        first.id,
        second.id,
      ]);
    });

    // --------------------------------------------------------
    // The same rule for what a batch is about to CREATE, and for a
    // resurrection a disjoint kind now blocks
    // --------------------------------------------------------

    it("bulkGetOrCreateByConstraint attaches no matched part when a new row's attachment exceeds the whole's bound", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const rack = await store.nodes.CaRack.create({});
      await store.nodes.CaSlot.create({ slug: "a" });

      // The rack holds ONE slot: the matched "a" and the new row together
      // exceed it, and only the batch counted as a whole sees that.
      //
      // MUTATION CHECK: leave the rows to create out of the moves
      // `assertGetOrCreateBatchApplicable` counts
      // (`newRowAttachmentMoves`, src/store/operations/node-operations.ts) —
      // "a" is then attached before the create batch refuses "new", and
      // survives the caught refusal.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaSlot.bulkGetOrCreateByConstraint(
            "ca_slot_slug",
            [{ props: { slug: "a" } }, { props: { slug: "new" } }],
            { partOf: { whole: rack } },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CardinalityError);
      expect(await store.edges.caSlotIn.find({})).toEqual([]);
      const slots = await store.nodes.CaSlot.find({});
      expect(slots.map((slot) => slot.slug)).toEqual(["a"]);
    });

    it("bulkGetOrCreateByConstraint resurrects and updates no earlier item when a later tombstone's id is held by a disjoint kind", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const live = await store.nodes.CaGhost.create({
        slug: "live",
        note: "before",
      });
      const gone = await store.nodes.CaGhost.create(
        { slug: "gone" },
        { id: "shared-id" },
      );
      await store.nodes.CaGhost.delete(gone.id);
      await store.nodes.CaSpirit.create({}, { id: gone.id });

      // The refusal is a read (`checkDisjointnessConstraint`, the answer a
      // create gets), so it must precede the "live" row's update.
      //
      // MUTATION CHECK: drop the `checkDisjointnessConstraint` read for a
      // restoring leg in `assertGetOrCreateBatchApplicable`
      // (src/store/operations/node-operations.ts) — "live" is then updated
      // before the resurrection's claim refuses, and survives the caught
      // refusal.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.CaGhost.bulkGetOrCreateByConstraint(
            "ca_ghost_slug",
            [
              { props: { slug: "live", note: "changed" } },
              { props: { slug: "gone" } },
            ],
            { ifExists: "update" },
          );
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(DisjointError);
      const after = requireDefined(await store.nodes.CaGhost.getById(live.id));
      expect(after.note).toBe("before");
      expect(after.meta.version).toBe(live.meta.version);
      expect(await store.nodes.CaGhost.getById(gone.id)).toBeUndefined();
    });

    it('bulkGetOrCreateByConstraint with ifExists "update" lets a new row take a unique key a matched item gives up', async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const first = await store.nodes.CaStamp.create({
        code: "a",
        label: "one",
      });

      // The create batch runs after the matched update, which is what frees
      // the label "one" for the new row. A frame that prepared the new row
      // against the stored claims alone would refuse it.
      //
      // MUTATION CHECK: prepare the rows to create inside
      // `assertGetOrCreateBatchApplicable` against the stored claims
      // (`prepareBatchCreates(ctx, creates, target, ...)`) — "new" is then
      // refused for a key "a" stops holding in this same batch.
      const results = await store.nodes.CaStamp.bulkGetOrCreateByConstraint(
        "ca_stamp_code",
        [
          { props: { code: "a", label: "renamed" } },
          { props: { code: "new", label: "one" } },
        ],
        { ifExists: "update" },
      );

      expect(results.map((entry) => entry.action)).toEqual([
        "updated",
        "created",
      ]);
      expect(results.map((entry) => entry.node.label)).toEqual([
        "renamed",
        "one",
      ]);
      expect(results[0]?.node.id).toBe(first.id);
    });

    // ========================================================
    // The attachment object itself: `whole`, and nothing unstated
    // ========================================================

    it("reads only kind and id from a whole passed as a node whose own properties are named like attachment options", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const vaultA = await store.nodes.CaVault.create(CA_VAULT_PROPS);
      const vaultB = await store.nodes.CaVault.create(CA_VAULT_PROPS);

      // MUTATION CHECK: read the options off the whole as well — in
      // `readStatedAttachment` (src/store/operations/composition-create.ts)
      // build `attachment` from `{ ...stated.whole, ...stated }`. The vault's
      // own `via` ("caChapterOf") then names a realizing edge that is not
      // declared for this pair and the create refuses with
      // COMPOSITION_VIA_NOT_DECLARED.
      const relic = await store.nodes.CaRelic.create(
        {},
        { partOf: { whole: vaultA } },
      );

      const createdEdges = await store.edges.caRelicOf.find({});
      const created = requireDefined(createdEdges[0], "the realizing edge");
      expect(created.toKind).toBe("CaVault");
      expect(created.toId).toBe(vaultA.id);
      expect(created.order).toBeUndefined();
      expect(created.meta.validFrom).not.toBe(CA_VAULT_PROPS.validFrom);
      expect(created.meta.validTo).toBeUndefined();

      const moved = await store.nodes.CaRelic.reparent(relic.id, {
        whole: vaultB,
      });
      expect(moved.moved).toBe(true);
      expect(moved.edge.toId).toBe(vaultB.id);
      expect(moved.edge.meta.validTo).toBeUndefined();

      // The already-satisfied arm compares stated props against the stored
      // ones; the vault's own `props` must not count as stated.
      const again = await store.nodes.CaRelic.reparent(relic.id, {
        whole: vaultB,
      });
      expect(again.moved).toBe(false);
    });

    it("get-or-create states the attachment's window on every leg that writes the edge", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      // `caChapterOf` is `population: "one"`: a bounded window still attaches
      // the part, for the row's whole life.
      const window = {
        validFrom: "2021-01-01T00:00:00.000Z",
        validTo: "2022-01-01T00:00:00.000Z",
      };
      const partOf = {
        whole: book,
        via: "caChapterOf",
        props: { order: 1 },
        ...window,
      };
      const windowOf = async (slug: string) => {
        const chapter = await store.nodes.CaChapter.findByConstraint(
          "ca_chapter_slug",
          { slug },
        );
        const edges = await store.edges.caChapterOf.find(
          { from: requireDefined(chapter) },
          { temporalMode: "includeEnded" },
        );
        const edge = requireDefined(edges[0], `the edge of "${slug}"`);
        return {
          validFrom: edge.meta.validFrom,
          validTo: edge.meta.validTo,
        };
      };

      await store.nodes.CaChapter.create({ slug: "single" });
      await store.nodes.CaChapter.create({ slug: "bulk" });
      const doomed = await store.nodes.CaChapter.create({ slug: "revived" });
      await store.nodes.CaChapter.delete(doomed.id);

      // MUTATION CHECK: pass `{}` instead of
      // `decided.request.work.edgeWindow` in
      // `prepareCompositionAttachmentDecision`
      // (src/store/operations/node-operations.ts) — each edge below is then
      // opened at the clock and never ends.
      const single = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "single" },
        { ifExists: "update", partOf },
      );
      expect(single.action).toBe("updated");
      expect(await windowOf("single")).toEqual(window);

      const bulk = await store.nodes.CaChapter.bulkGetOrCreateByConstraint(
        "ca_chapter_slug",
        [{ props: { slug: "bulk" } }],
        { ifExists: "update", partOf },
      );
      expect(bulk.map((entry) => entry.action)).toEqual(["updated"]);
      expect(await windowOf("bulk")).toEqual(window);

      const revived = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "revived" },
        { ifExists: "update", partOf },
      );
      expect(revived.action).toBe("resurrected");
      expect(await windowOf("revived")).toEqual(window);
    });

    it("verifies a stated window against an already-satisfied attachment instead of dropping it", async () => {
      const stored = {
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2022-01-01T00:00:00.000Z",
      } as const;
      const conflicting = {
        validFrom: "2021-06-01T00:00:00.000Z",
        validTo: "2023-06-01T00:00:00.000Z",
      } as const;
      const held = { via: "caChapterOf", props: { order: 1 } } as const;
      const fields = ["validFrom", "validTo"] as const;

      for (const field of fields) {
        const store = await context.createStore(buildGraph(nextGraphId()));
        const book = await store.nodes.CaBook.create({});
        await store.nodes.CaChapter.getOrCreateByConstraint(
          "ca_chapter_slug",
          { slug: "a" },
          { partOf: { whole: book, ...held, ...stored } },
        );
        const windows = async () => {
          const edges = await store.edges.caChapterOf.find(
            {},
            { temporalMode: "includeEnded" },
          );
          return edges.map((edge) => ({
            validFrom: edge.meta.validFrom,
            validTo: edge.meta.validTo,
          }));
        };

        // MUTATION CHECK: drop the window comparison from
        // `judgeSatisfiedAttachment`
        // (src/store/operations/composition-create.ts) — every call below
        // then resolves, with the conflicting bound silently discarded.
        const partOf = {
          whole: book,
          via: "caChapterOf",
          [field]: conflicting[field],
        };
        const calls: readonly (() => Promise<unknown>)[] = [
          () =>
            store.nodes.CaChapter.getOrCreateByConstraint(
              "ca_chapter_slug",
              { slug: "a" },
              { partOf },
            ),
          () =>
            store.nodes.CaChapter.getOrCreateByConstraint(
              "ca_chapter_slug",
              { slug: "a" },
              { ifExists: "update", partOf },
            ),
          () =>
            store.nodes.CaChapter.bulkGetOrCreateByConstraint(
              "ca_chapter_slug",
              [{ props: { slug: "a" } }],
              { partOf },
            ),
          () =>
            store.nodes.CaChapter.bulkGetOrCreateByConstraint(
              "ca_chapter_slug",
              [{ props: { slug: "a" } }],
              { ifExists: "update", partOf },
            ),
          () =>
            store.transaction((tx) =>
              tx.nodes.CaChapter.getOrCreateByConstraint(
                "ca_chapter_slug",
                { slug: "a" },
                { partOf },
              ),
            ),
        ];
        for (const call of calls) {
          const error = await call().catch((error_: unknown) => error_);
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as ValidationError).details.issues).toEqual([
            expect.objectContaining({
              path: `partOf.${field}`,
              code: "COMPOSITION_ATTACHMENT_WINDOW_CONFLICT",
            }),
          ]);
          expect(await windows()).toEqual([stored]);
        }

        // The stored window restated is verified equal: satisfied, no write.
        const restated = await store.nodes.CaChapter.getOrCreateByConstraint(
          "ca_chapter_slug",
          { slug: "a" },
          { partOf: { whole: book, ...held, ...stored } },
        );
        expect(restated.action).toBe("found");
        expect(await windows()).toEqual([stored]);
      }
    });

    it("validates a stated window on an already-satisfied attachment exactly as create does", async () => {
      const malformed: readonly Readonly<{
        validFrom?: string;
        validTo?: string;
      }>[] = [
        { validFrom: "garbage" },
        { validTo: "garbage" },
        {
          validFrom: "2090-01-01T00:00:00.000Z",
          validTo: "2020-01-01T00:00:00.000Z",
        },
      ];
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const base = { whole: book, via: "caChapterOf", props: { order: 1 } };
      await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "a" },
        { partOf: base },
      );

      // MUTATION CHECK: remove the window validation from
      // `readStatedAttachment` (src/store/operations/composition-create.ts) —
      // the two get-or-create calls below then report a window CONFLICT with
      // the held edge rather than the malformed input create refuses.
      for (const window of malformed) {
        const partOf = { ...base, ...window };
        const calls: readonly (() => Promise<unknown>)[] = [
          () => store.nodes.CaChapter.create({ slug: "fresh" }, { partOf }),
          () =>
            store.nodes.CaChapter.bulkCreate([
              { props: { slug: "fresh" }, partOf },
            ]),
          () =>
            store.nodes.CaChapter.getOrCreateByConstraint(
              "ca_chapter_slug",
              { slug: "a" },
              { partOf },
            ),
          () =>
            store.nodes.CaChapter.bulkGetOrCreateByConstraint(
              "ca_chapter_slug",
              [{ props: { slug: "a" } }],
              { partOf },
            ),
        ];
        const refusals: unknown[] = [];
        for (const call of calls) {
          const error = await call().catch((error_: unknown) => error_);
          expect(error).toBeInstanceOf(ValidationError);
          refusals.push(
            (error as ValidationError).details.issues.map((issue) => ({
              path: issue.path,
              code: issue.code,
            })),
          );
        }
        // One validation, so the satisfied legs name the same fault create does.
        expect(
          new Set(refusals.map((issues) => JSON.stringify(issues))),
        ).toEqual(new Set([JSON.stringify(refusals[0])]));
      }
      expect(await store.nodes.CaChapter.find({})).toHaveLength(1);
    });

    it("refuses a bounded window on a oneActive pair on every partOf surface and writes nothing", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const show = await store.nodes.CaShow.create({});
      const other = await store.nodes.CaShow.create({});
      const existing = await store.nodes.CaReel.create({ slug: "bare" });

      // MUTATION CHECK: drop `assertStatedWindowAttachesPart` from
      // `compositionCreateWork` (src/store/operations/composition-create.ts) —
      // every call below then writes an edge the incumbent read cannot see,
      // so the repeat inserts a second one and `other` is accepted beside it.
      for (const validTo of [
        "2022-01-01T00:00:00.000Z",
        "2023-06-01T00:00:00.000Z",
      ]) {
        const partOf = { whole: show, validTo };
        const calls: readonly (() => Promise<unknown>)[] = [
          () => store.nodes.CaReel.create({ slug: "create" }, { partOf }),
          () =>
            store.nodes.CaReel.bulkCreate([
              { props: { slug: "bulk" }, partOf },
            ]),
          () =>
            store.nodes.CaReel.getOrCreateByConstraint(
              "ca_reel_slug",
              { slug: "get-or-create" },
              { partOf },
            ),
          () =>
            store.nodes.CaReel.getOrCreateByConstraint(
              "ca_reel_slug",
              { slug: "bare" },
              { partOf },
            ),
          () =>
            store.nodes.CaReel.bulkGetOrCreateByConstraint(
              "ca_reel_slug",
              [{ props: { slug: "bare" } }, { props: { slug: "bulk-get" } }],
              { partOf },
            ),
        ];
        for (const call of calls) {
          const error = await call().catch((error_: unknown) => error_);
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as ValidationError).details.issues).toEqual([
            expect.objectContaining({
              path: "partOf.validTo",
              code: "COMPOSITION_ATTACHMENT_WINDOW_BOUNDED",
            }),
          ]);
        }
      }
      const reels = await store.nodes.CaReel.find({});
      expect(reels.map((reel) => reel.id)).toEqual([existing.id]);
      expect(
        await store.edges.caReelOf.find({}, { temporalMode: "includeEnded" }),
      ).toEqual([]);

      // The open attachment IS found again, and a different whole refuses.
      const attach = () =>
        store.nodes.CaReel.getOrCreateByConstraint(
          "ca_reel_slug",
          { slug: "bare" },
          { partOf: { whole: show } },
        );
      await attach();
      await attach();
      expect(
        await store.edges.caReelOf.find({}, { temporalMode: "includeEnded" }),
      ).toHaveLength(1);
      await expect(
        store.nodes.CaReel.getOrCreateByConstraint(
          "ca_reel_slug",
          { slug: "bare" },
          { partOf: { whole: other } },
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          details: matchingObject({ situation: "existing" }),
        }),
      );
    });

    it("refuses the flat { kind, id } attachment on every surface and writes nothing", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const other = await store.nodes.CaBook.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "held" },
        { partOf: { whole: book, via: caChapterOf, props: { order: 1 } } },
      );
      const flat = { kind: "CaBook", id: other.id, via: "caChapterOf" };

      // MUTATION CHECK: in `readStatedAttachment`
      // (src/store/operations/composition-create.ts) fall back to the
      // attachment object itself when `whole` is absent and stop refusing
      // unknown keys — every call below then attaches or moves a chapter.
      const attempts: readonly (readonly [string, () => Promise<unknown>])[] = [
        [
          "partOf",
          () =>
            store.nodes.CaChapter.create(
              { slug: "create" },
              // @ts-expect-error the flat form does not compile
              { partOf: flat },
            ),
        ],
        [
          "partOf",
          () =>
            store.nodes.CaChapter.bulkCreate([
              // @ts-expect-error the flat form does not compile
              { props: { slug: "bulk" }, partOf: flat },
            ]),
        ],
        [
          "partOf",
          () =>
            store.nodes.CaChapter.getOrCreateByConstraint(
              "ca_chapter_slug",
              { slug: "get-or-create" },
              // @ts-expect-error the flat form does not compile
              { partOf: flat },
            ),
        ],
        [
          "partOf",
          () =>
            store.nodes.CaChapter.bulkGetOrCreateByConstraint(
              "ca_chapter_slug",
              [{ props: { slug: "held" } }, { props: { slug: "bulk-get" } }],
              // @ts-expect-error the flat form does not compile
              { partOf: flat },
            ),
        ],
        [
          "options",
          () =>
            // @ts-expect-error the flat form does not compile
            store.nodes.CaChapter.reparent(chapter.id, flat),
        ],
        [
          "options",
          () =>
            store.nodes.CaChapter.bulkReparent([
              // @ts-expect-error the flat form does not compile
              { id: chapter.id, options: flat },
            ]),
        ],
      ];

      for (const [base, attempt] of attempts) {
        const error = await attempt().catch((error_: unknown) => error_);
        expect(error).toBeInstanceOf(ValidationError);
        expect(
          (error as ValidationError).details.issues.map((issue) => issue.path),
        ).toEqual([`${base}.kind`, `${base}.id`, `${base}.whole`]);
      }

      const chapters = await store.nodes.CaChapter.find({});
      expect(chapters.map((node) => node.slug)).toEqual(["held"]);
      const edges = await store.edges.caChapterOf.find({});
      expect(edges.map((edge) => edge.toId)).toEqual([book.id]);
    });

    it("refuses an unknown top-level attachment key instead of dropping it", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});

      // MUTATION CHECK: drop the unknown-key issues from
      // `readStatedAttachment` (src/store/operations/composition-create.ts) —
      // the misspelled `prop` is then ignored, the chapter is created with
      // the edge schema's own refusal (a missing `order`) instead of this
      // one, and the issue path below no longer matches.
      const error = await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            whole: book,
            via: caChapterOf,
            // @ts-expect-error `prop` is not an attachment option
            prop: { order: 1 },
          },
        },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details.issues).toEqual([
        expect.objectContaining({ path: "partOf.prop" }),
      ]);
      expect(await store.nodes.CaChapter.find({})).toHaveLength(0);
    });

    it("accepts any whole kind string on a dynamic collection and leaves the refusal to the runtime", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const reader = await store.nodes.CaReader.create({});
      const chapters = requireDefined(
        store.getNodeCollection("CaChapter"),
        "the dynamic chapter collection",
      );

      await expect(
        chapters.create(
          { slug: "one" },
          { partOf: { whole: { kind: "CaReader", id: reader.id } } },
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          details: matchingObject({ code: "COMPOSITION_WHOLE_NOT_DECLARED" }),
        }),
      );
    });
  });
}
