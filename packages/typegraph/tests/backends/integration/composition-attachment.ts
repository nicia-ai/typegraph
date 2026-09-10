/**
 * The composition ATTACHMENT surface, on every backend: how a part names the
 * whole it belongs to (`partOf: { kind, id, via?, props? }`), how it MOVES
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
 *
 * Each case states, in a comment, the mutation/revert that must make it
 * fail; the checks actually performed are recorded in the scratchpad
 * `lane-RVA-load-bearing.md` note.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  CompositionExistenceError,
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  EdgeAcyclicityError,
  hasPart,
  NodeNotFoundError,
  partOf,
  ValidationError,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { matchingObject } from "../../test-utils";
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
/** Declares no composition pair at all — `reparent`'s not-a-part refusal. */
const CaReader = defineNode("CaReader", { schema: z.object({}) });

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
      CaFolder: { type: CaFolder },
      CaReader: { type: CaReader },
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
          { partOf: { kind: "CaBook", id: book.id } },
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
          { partOf: { kind: "CaBook", id: book.id, via: "caIncludedIn" } },
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
            kind: "CaBook",
            id: book.id,
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
              kind: "CaBook",
              id: book.id,
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
        { partOf: { kind: "CaAlbum", id: album.id } },
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
            kind: "CaBook",
            id: book.id,
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );
      const page = await store.nodes.CaPage.create(
        {},
        { partOf: { kind: "CaChapter", id: chapter.id } },
      );

      // MUTATION CHECK: skip the retire (drop the `if (disposition ===
      // "replace")` block in `applyCompositionAttachmentDecision`,
      // src/store/operations/node-operations.ts)
      // — the attach then loses the composition claim and this rejects with
      // COMPOSITION_WHOLE_OCCUPIED instead of moving the chapter.
      await store.nodes.CaChapter.reparent(chapter.id, {
        kind: "CaAnthology",
        id: anthology.id,
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
        { partOf: { kind: "CaShow", id: showA.id } },
      );

      // MUTATION CHECK: remove the `reattachedPart` arm from
      // `assertCompositionExistencePreserved`
      // (src/store/operations/composition-create.ts) — the window end is
      // then read as a detach of a live required part and this rejects with
      // CompositionExistenceError (`situation: "detach"`).
      await store.nodes.CaClip.reparent(clip.id, {
        kind: "CaShow",
        id: showB.id,
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

    it("reparent is ONE move instant: the ended window and the new one abut", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const showA = await store.nodes.CaShow.create({});
      const showB = await store.nodes.CaShow.create({});
      const clip = await store.nodes.CaClip.create(
        {},
        { partOf: { kind: "CaShow", id: showA.id } },
      );

      // This case asserts the invariant on every backend, but a two-read
      // implementation can pass it by luck: two `nowIso()` calls a few
      // statements apart often land in the same millisecond. The mutation
      // check for the SINGLE read lives in
      // `tests/composition-reparent-instant.test.ts`, which advances the
      // clock between the retire and the attach so a second read is
      // guaranteed to sample a later instant.
      await store.nodes.CaClip.reparent(clip.id, {
        kind: "CaShow",
        id: showB.id,
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
            kind: "CaBook",
            id: book.id,
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );
      const beforeEdges = await store.edges.caChapterOf.find({});
      const before = requireDefined(beforeEdges[0]);

      await store.nodes.CaChapter.reparent(chapter.id, {
        kind: "CaBook",
        id: book.id,
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
          kind: "CaBook",
          id: "whatever",
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
            kind: "CaBook",
            id: book.id,
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );
      const page = await store.nodes.CaPage.create(
        {},
        { partOf: { kind: "CaChapter", id: chapter.id } },
      );

      await expect(
        store.nodes.CaPage.reparent(page.id, { kind: "CaBook", id: book.id }),
      ).rejects.toBeInstanceOf(ConfigurationError);

      await expect(
        store.nodes.CaChapter.reparent(asNodeId("no-such-chapter"), {
          kind: "CaBook",
          id: book.id,
          via: "caChapterOf",
        }),
      ).rejects.toBeInstanceOf(NodeNotFoundError);
    });

    it("reparent validates acyclicity over the composition union against the FINAL state", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const root = await store.nodes.CaFolder.create({});
      const child = await store.nodes.CaFolder.create(
        {},
        { partOf: { kind: "CaFolder", id: root.id } },
      );
      const grandchild = await store.nodes.CaFolder.create(
        {},
        { partOf: { kind: "CaFolder", id: child.id } },
      );

      // MUTATION CHECK: pass `validateAcyclicity: false` in
      // `attachCompositionCreateEdge` (src/store/operations/node-operations.ts)
      // — the move then succeeds and leaves a three-node composition ring
      // that no ordinary delete can unwind (`CompositionCycleError`).
      await expect(
        store.nodes.CaFolder.reparent(root.id, {
          kind: "CaFolder",
          id: grandchild.id,
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

    it("reparent inside a transaction counts as ONE node write intent", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const anthology = await store.nodes.CaAnthology.create({});
      const chapter = await store.nodes.CaChapter.create(
        { slug: "one" },
        {
          partOf: {
            kind: "CaBook",
            id: book.id,
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
          kind: "CaAnthology",
          id: anthology.id,
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

    // ========================================================
    // `partOf` on get-or-create is a POSTCONDITION
    // ========================================================

    it("getOrCreateByConstraint with partOf is idempotent when the whole already matches", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const book = await store.nodes.CaBook.create({});
      const attachment = {
        kind: "CaBook" as const,
        id: book.id,
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
            kind: "CaBook",
            id: book.id,
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );

      const error = await store.nodes.CaChapter.getOrCreateByConstraint(
        "ca_chapter_slug",
        { slug: "one" },
        { partOf: { kind: "CaAnthology", id: anthology.id } },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CompositionExistenceError);
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
            kind: "CaBook",
            id: book.id,
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
            kind: "CaBook",
            id: book.id,
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
            kind: "CaBook",
            id: book.id,
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
            kind: "CaBook",
            id: book.id,
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
          { partOf: { kind: "CaBook", id: book.id } },
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
            kind: "CaBook",
            id: book.id,
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
        { partOf: { kind: "CaReader", id: reader.id } },
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
        kind: "CaBook" as const,
        id: book.id,
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
            kind: "CaBook",
            id: book.id,
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
            kind: "CaBook",
            id: book.id,
            via: "caChapterOf",
            props: { order: 2 },
          },
        },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CompositionExistenceError);
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
            kind: "CaBook",
            id: book.id,
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
            kind: "CaBook",
            id: book.id,
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
            kind: "CaBook",
            id: book.id,
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
        kind: "CaBook",
        id: book.id,
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
            kind: "CaBook",
            id: book.id,
            via: "caChapterOf",
            props: { order: 1 },
          },
        },
      );
      // "b" holds a DIFFERENT whole, through a different realizing edge.
      const elsewhere = await store.nodes.CaChapter.create(
        { slug: "b" },
        { partOf: { kind: "CaAnthology", id: anthology.id } },
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
            kind: "CaBook",
            id: book.id,
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
  });
}
