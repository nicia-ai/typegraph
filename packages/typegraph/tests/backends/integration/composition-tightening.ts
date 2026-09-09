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

// Item E2-1: flipping an already-declared pair's `existence`.
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

// Item E2-6: two DIFFERENT part kinds sharing one realizing edge kind, only
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

    it('item E2-1: flipping an already-declared pair to existence: "required" refuses a dirty graph', async () => {
      const id = "composition_tightening_flip_required";
      const store = await context.createStore(buildFlipGraph(id, false));
      const orphan = await store.nodes.CtSegment.create({});

      // The flip diffs as remove (old, `existence: "optional"`) + add (new,
      // `existence: "required"`) — the REMOVE half is unconditionally
      // `breaking` (dropping a composition declaration is a
      // read/write-semantics change), so this reaches the data preflight
      // only through the explicit `migrateSchema()` path, exactly like any
      // other breaking change. `ensureSchema`/`createAdapterStoreWithSchema`
      // would refuse it as `"breaking-change"` before ever probing the data.
      const error = await migrateSchema(
        context.getBackend(),
        buildFlipGraph(id, true),
        await activeVersion(context, id),
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
    // MUTATION CHECK: drop `relation.existence ?? ""` from `relationMapKey`
    // (src/schema/ontology-change.ts). The flip then keys identically
    // before/after, `classifyOntologyChanges` sees no relation change at
    // all, and the migration above succeeds — `activeVersion` reads 2
    // instead of 1.

    it("item E2-6: tightening one part kind never blocks on an unrelated OPTIONAL sibling sharing its edge kind", async () => {
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
