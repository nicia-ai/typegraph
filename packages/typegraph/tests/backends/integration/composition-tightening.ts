/**
 * Data-validated tightening for a newly-declared composition pair (item E),
 * stacking on item A's schema-tightening preflight
 * (`src/schema/tightening-preflight.ts`, `prepareSchemaTighteningPreflight`).
 *
 * Before item E, `partOf`/`hasPart` classified as `safe` in both directions
 * (item A shipped it that way, pending composition's own constraints — see
 * `src/schema/ontology-change.ts`'s module docblock). Adding the FIRST
 * `partOf`/`hasPart` pair over two edge kinds that already exist as
 * ordinary, independent cardinality-`one` edges is exactly the shape that
 * can be dirty: nothing prevented one part from already holding a live edge
 * under EACH kind before the pair existed to say that is now one whole too
 * many.
 *
 * Each case states, in a comment, the mutation that must make it fail (the
 * revert/mutation check load-bearing tests require).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  MigrationError,
  partOf,
} from "../../../src";
import { getActiveSchema, migrateSchema } from "../../../src/schema";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const CtChapter = defineNode("CtChapter", { schema: z.object({}) });
const CtBook = defineNode("CtBook", { schema: z.object({}) });
const CtAnthology = defineNode("CtAnthology", { schema: z.object({}) });

const ctChapterOf = defineEdge("ctChapterOf", { schema: z.object({}) });
const ctIncludedIn = defineEdge("ctIncludedIn", { schema: z.object({}) });

// Item E.2: flipping an already-declared pair's `existence`.
const CtSegment = defineNode("CtSegment", { schema: z.object({}) });
const CtEpisode = defineNode("CtEpisode", { schema: z.object({}) });
const ctSegmentOf = defineEdge("ctSegmentOf", { schema: z.object({}) });

function buildFlipGraph(id: string, required: boolean) {
  return defineGraph({
    id,
    nodes: { CtSegment: { type: CtSegment }, CtEpisode: { type: CtEpisode } },
    edges: {
      ctSegmentOf: {
        type: ctSegmentOf,
        from: [CtSegment],
        to: [CtEpisode],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(CtSegment, CtEpisode, {
        via: ctSegmentOf,
        ...(required ? { existence: "required" as const } : {}),
      }),
    ],
  });
}

// Item E.2: two DIFFERENT part kinds sharing one realizing edge kind, only
// one of which is tightened to `existence: "required"`.
const CtTag = defineNode("CtTag", { schema: z.object({}) });
const CtClip = defineNode("CtClip", { schema: z.object({}) });
const CtEpisode2 = defineNode("CtEpisode2", { schema: z.object({}) });
const ctSharedOf = defineEdge("ctSharedOf", { schema: z.object({}) });

function buildSharedEdgeGraph(id: string, clipRequired: boolean) {
  return defineGraph({
    id,
    nodes: {
      CtTag: { type: CtTag },
      CtClip: { type: CtClip },
      CtEpisode2: { type: CtEpisode2 },
    },
    edges: {
      ctSharedOf: {
        type: ctSharedOf,
        from: [CtTag, CtClip],
        to: [CtEpisode2],
        cardinality: "one",
      },
    },
    ontology: [
      // CtTag stays `existence: "optional"` across both versions — an
      // unattached CtTag is legal forever and must never block a commit
      // that only tightens its edge-kind sibling, CtClip.
      partOf(CtTag, CtEpisode2, { via: ctSharedOf }),
      partOf(CtClip, CtEpisode2, {
        via: ctSharedOf,
        ...(clipRequired ? { existence: "required" as const } : {}),
      }),
    ],
  });
}

function buildGraph(id: string, composed: boolean) {
  return defineGraph({
    id,
    nodes: {
      CtChapter: { type: CtChapter },
      CtBook: { type: CtBook },
      CtAnthology: { type: CtAnthology },
    },
    edges: {
      ctChapterOf: {
        type: ctChapterOf,
        from: [CtChapter],
        to: [CtBook],
        cardinality: "one",
      },
      ctIncludedIn: {
        type: ctIncludedIn,
        from: [CtChapter],
        to: [CtAnthology],
        cardinality: "one",
      },
    },
    ...(composed ?
      {
        ontology: [
          partOf(CtChapter, CtBook, { via: ctChapterOf }),
          partOf(CtChapter, CtAnthology, { via: ctIncludedIn }),
        ],
      }
    : {}),
  });
}

async function activeVersion(
  context: IntegrationTestContext,
  id: string,
): Promise<number> {
  const active = await getActiveSchema(context.getBackend(), id);
  return requireDefined(active, "active schema").version;
}

export function registerCompositionTighteningIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("composition tightening (data-validated, item A + item E)", () => {
    it("refuses declaring partOf/hasPart against a part that already has two live wholes", async () => {
      const id = "composition_tightening_dirty";
      const store = await context.createStore(buildGraph(id, false));
      const chapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      const anthology = await store.nodes.CtAnthology.create({});
      // Both edges are independently valid under the UN-composed schema:
      // each kind's own cardinality axis sees exactly one edge per chapter.
      await store.edges.ctChapterOf.create(chapter, book, {});
      await store.edges.ctIncludedIn.create(chapter, anthology, {});

      const error = await createAdapterStoreWithSchema(
        buildGraph(id, true),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      const compositionViolation = details.violations.find(
        (violation) => violation.family === "composition",
      );
      expect(compositionViolation).toBeDefined();
      if (compositionViolation?.family !== "composition") {
        throw new Error("expected a composition violation");
      }
      expect(compositionViolation.edgeIds).toHaveLength(2);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: flip the `META_EDGE_PART_OF` / `META_EDGE_HAS_PART`
    // arm in `classifyKnownRelationSeverity`
    // (src/schema/ontology-change.ts) back to
    // `{ severity: "safe", probeKinds: [] }` for `"added"`. The commit above
    // then succeeds and `activeVersion` reads 2 instead of 1.

    it("migrates cleanly when the part has exactly one whole", async () => {
      const id = "composition_tightening_clean";
      const store = await context.createStore(buildGraph(id, false));
      const chapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      await store.edges.ctChapterOf.create(chapter, book, {});

      const version = await migrateSchema(
        context.getBackend(),
        buildGraph(id, true),
        await activeVersion(context, id),
      );
      expect(version).toBe(2);

      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildGraph(id, true),
        context.getBackend(),
      );
      const anthology = await upgradedStore.nodes.CtAnthology.create({});
      await expect(
        upgradedStore.edges.ctIncludedIn.create(chapter, anthology, {}),
      ).rejects.toMatchObject({ code: "COMPOSITION_WHOLE_OCCUPIED" });
    });

    it('item E.2: flipping an already-declared pair to existence: "required" refuses a DIRTY graph directly through ensureSchema, never reaching "breaking-change"', async () => {
      const id = "composition_tightening_flip_required";
      const store = await context.createStore(buildFlipGraph(id, false));
      const orphan = await store.nodes.CtSegment.create({});

      // An in-place `existence` flip classifies as a `modified` change
      // (`classifyExistenceChange`, src/schema/ontology-change.ts) — never
      // as remove + add — so it is backwards-compatible on its own and
      // reaches `prepareSchemaTighteningPreflight` through the ordinary
      // `ensureSchema`/`createAdapterStoreWithSchema` auto-migrate path,
      // exactly like any other `warning`-severity tightening. No explicit
      // `migrateSchema()` call is needed.
      const error = await createAdapterStoreWithSchema(
        buildFlipGraph(id, true),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      const violation = details.violations.find(
        (candidate) => candidate.family === "compositionExistence",
      );
      expect(violation).toBeDefined();
      if (violation?.family !== "compositionExistence") {
        throw new Error("expected a compositionExistence violation");
      }
      expect(violation.partKind).toBe("CtSegment");
      expect(violation.parts).toEqual([{ kind: "CtSegment", id: orphan.id }]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: restore `relation.existence ?? ""` as a fifth element
    // of `relationMapKey`'s tuple (src/schema/ontology-change.ts). The flip
    // then diffs as remove (breaking) + add, `createAdapterStoreWithSchema`
    // throws `MigrationError` reason `"breaking-change"` instead of
    // `"ontology-tightening-violated"`, and the test above fails on the
    // `details.reason` check before ever reaching the composition
    // violation assertions.

    it('item E.2: flipping an already-declared pair to existence: "required" auto-migrates a CLEAN graph directly through ensureSchema', async () => {
      const id = "composition_tightening_flip_required_clean";
      const store = await context.createStore(buildFlipGraph(id, false));
      const segment = await store.nodes.CtSegment.create({});
      const episode = await store.nodes.CtEpisode.create({});
      await store.edges.ctSegmentOf.create(segment, episode, {});

      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildFlipGraph(id, true),
        context.getBackend(),
      );

      expect(await activeVersion(context, id)).toBe(2);
      await expect(
        upgradedStore.nodes.CtSegment.create({}),
      ).rejects.toMatchObject({ code: "COMPOSITION_WHOLE_REQUIRED" });
    });
    // MUTATION CHECK: change the `partOf`/`hasPart` `removed` arm in
    // `classifyKnownRelationSeverity` from unconditional `breaking` to
    // `safe`. `classifyExistenceChange` is a separate function so this
    // mutation does not directly touch it, but it demonstrates the OLD
    // fold-into-remove+add path would have reached this exact commit as a
    // (previously refused) breaking change now silently accepted with no
    // data probe at all; the test's `COMPOSITION_WHOLE_REQUIRED`
    // assertion is the behavioral guarantee this test actually pins.

    it('item E.2: loosening an already-declared pair from existence: "required" to optional is safe and auto-migrates through ensureSchema (a pure loosening is always safe)', async () => {
      const id = "composition_tightening_flip_loosen";
      const store = await context.createStore(buildFlipGraph(id, true));
      const episode = await store.nodes.CtEpisode.create({});
      // `existence: "required"` refuses a bare create with no `partOf` —
      // the episode must exist first, and the segment must name it.
      await store.nodes.CtSegment.create(
        {},
        { partOf: { kind: "CtEpisode", id: episode.id } },
      );

      // Loosening never needs a data probe — no `migrateSchema()` call,
      // straight through `ensureSchema`/`createAdapterStoreWithSchema`.
      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildFlipGraph(id, false),
        context.getBackend(),
      );

      expect(await activeVersion(context, id)).toBe(2);
      // What "loosened" means in practice: a part with no live whole is now
      // legal, where it was refused a moment ago.
      await expect(
        upgradedStore.nodes.CtSegment.create({}),
      ).resolves.toBeDefined();
    });
    // MUTATION CHECK: in `classifyExistenceChange`
    // (src/schema/ontology-change.ts), flip the `afterExistence ===
    // "optional"` branch's severity from `"safe"` to `"breaking"`.
    // `createAdapterStoreWithSchema` then throws `MigrationError` reason
    // `"breaking-change"` instead of returning an upgraded store, and this
    // test fails on the destructuring `const [upgradedStore] = await …`.

    it("item E.2: tightening one part kind never blocks on an unrelated OPTIONAL sibling sharing its edge kind", async () => {
      const id = "composition_tightening_shared_edge_kind";
      const store = await context.createStore(buildSharedEdgeGraph(id, false));
      // Legal forever: CtTag's existence stays "optional" in both versions.
      await store.nodes.CtTag.create({});

      const version = await migrateSchema(
        context.getBackend(),
        buildSharedEdgeGraph(id, true),
        await activeVersion(context, id),
      );
      expect(version).toBe(2);

      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildSharedEdgeGraph(id, true),
        context.getBackend(),
      );
      await expect(upgradedStore.nodes.CtClip.create({})).rejects.toThrow(
        /required/i,
      );
    });
    // MUTATION CHECK: in `readCompositionUnattachedPartsForEdgeKinds`
    // (src/schema/tightening-preflight.ts), drop the
    // `requiredPartKinds.has(concreteKind)` filter (scan every pair sharing
    // the probe's edge kinds, not only the required ones). The unattached
    // CtTag planted above then makes the migration refuse, and `migrateSchema`
    // throws instead of returning `2`.
  });
}
