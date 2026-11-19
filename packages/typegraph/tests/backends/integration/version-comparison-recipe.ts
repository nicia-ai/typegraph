/**
 * The "Version Comparison" examples in the docs
 * (apps/docs/src/content/docs/queries/temporal.md and
 * apps/docs/src/content/docs/examples/document-management.md), run against a
 * real store so the documented approach cannot drift from what the store
 * keeps. Keep `compareVersions` below identical to the temporal.md block.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, type NodeId } from "../../../src";
import { type RecordedInstant } from "../../../src/core";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const Document = defineNode("Document", {
  schema: z.object({ title: z.string() }),
});

const recipeGraph = defineGraph({
  id: "version_comparison_recipe",
  nodes: { Document: { type: Document } },
  edges: {},
});

export function registerVersionComparisonRecipeTests(
  context: IntegrationTestContext,
): void {
  describe("documented version comparison", () => {
    it("reads two versions of one document from recorded time, which the live table does not keep", async () => {
      const store = await context.createHistoryStore(recipeGraph);

      async function compareVersions(
        documentId: NodeId<typeof Document>,
        before: RecordedInstant,
        after: RecordedInstant,
      ) {
        const [version1, version2] = await Promise.all([
          store.asOfRecorded(before).nodes.Document.getById(documentId),
          store.asOfRecorded(after).nodes.Document.getById(documentId),
        ]);

        return { version1, version2 };
      }

      const draft = await store.nodes.Document.create({ title: "Draft" });
      const drafted = requireDefined(await store.recordedNow());
      await store.nodes.Document.update(draft.id, { title: "Revised" });
      const revised = requireDefined(await store.recordedNow());

      const { version1, version2 } = await compareVersions(
        draft.id,
        drafted,
        revised,
      );
      // What the examples used to read: every stored row for the id, which
      // is only the live version.
      const includeEnded = await store
        .query()
        .from("Document", "d")
        .temporal("includeEnded")
        .whereNode("d", (d) => d.id.eq(draft.id))
        .select((ctx) => ({
          title: ctx.d.title,
          version: ctx.d.meta.version,
        }))
        .execute();

      expect({
        version1: {
          title: version1?.title,
          version: version1?.meta.version,
        },
        version2: {
          title: version2?.title,
          version: version2?.meta.version,
        },
        includeEnded,
      }).toEqual({
        version1: { title: "Draft", version: 1 },
        version2: { title: "Revised", version: 2 },
        includeEnded: [{ title: "Revised", version: 2 }],
      });
    });
  });
}
