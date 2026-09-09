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
  });
}
