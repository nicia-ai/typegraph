/**
 * What a validating import leaves behind, and reports, when it refuses a
 * required-existence part.
 *
 * A part nothing in the payload or on the target can attach is refused before
 * its row is written, so no other row of the import is judged against it. A
 * part whose composition edge turns out not to attach it is refused after the
 * edges are written, which removes its node row together with every edge
 * touching it. Either way the result must describe exactly what was
 * committed: every removed edge is named in `errors` — including one that was
 * on the target before this import ran — and no counter, `created` or
 * `updated`, still counts a row that is gone.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, partOf } from "../../../src";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "../../../src/interchange";
import { type IntegrationTestContext } from "./test-context";

const Part = defineNode("IrpPart", {
  schema: z.object({ code: z.string().optional() }),
});
const Whole = defineNode("IrpWhole", { schema: z.object({}) });
const Tag = defineNode("IrpTag", { schema: z.object({}) });
const partOfWhole = defineEdge("irpPartOf", { schema: z.object({}) });
const tagged = defineEdge("irpTagged", {
  schema: z.object({ note: z.string().optional() }),
});

function purgeGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      IrpPart: {
        type: Part,
        unique: [
          {
            name: "irp_part_code",
            fields: ["code"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      IrpWhole: { type: Whole },
      IrpTag: { type: Tag },
    },
    edges: {
      irpPartOf: {
        type: partOfWhole,
        from: [Part],
        to: [Whole],
        cardinality: "one",
      },
      irpTagged: { type: tagged, from: [Tag], to: [Part] },
    },
    ontology: [
      partOf(Part, Whole, { via: partOfWhole, existence: "required" }),
    ],
  });
}

function document(
  nodes: GraphData["nodes"],
  edges: GraphData["edges"],
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "external", description: "required part purge" },
    nodes,
    edges,
  };
}

function options(overrides: Partial<ImportOptions>): ImportOptions {
  return {
    onConflict: "error",
    onUnknownProperty: "error",
    validateReferences: true,
    batchSize: 100,
    refreshStatistics: false,
    ...overrides,
  };
}

/**
 * A composition edge to a whole that does not exist: it is written under
 * `validateReferences: false` and attaches nothing, so its part is refused
 * only once the edges are in.
 */
function danglingCompositionEdge(
  id: string,
  partId: string,
): GraphData["edges"][number] {
  return {
    kind: "irpPartOf",
    id,
    from: { kind: "IrpPart", id: partId },
    to: { kind: "IrpWhole", id: "w-missing" },
    properties: {},
  };
}

function tagEdge(id: string, partId: string): GraphData["edges"][number] {
  return {
    kind: "irpTagged",
    id,
    from: { kind: "IrpTag", id: "t1" },
    to: { kind: "IrpPart", id: partId },
    properties: {},
  };
}

export function registerImportRequiredPartPurgeIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("import: purging a refused required part", () => {
    it("reports an edge that predates the import when the purge removes it", async () => {
      const store = await context.createStore(
        purgeGraph("import_required_part_purge_preexisting"),
      );
      // Load 1: a tag and an edge to a part that does not exist yet.
      const first = await importGraph(
        store,
        document(
          [{ kind: "IrpTag", id: "t1", properties: {} }],
          [tagEdge("tag-edge", "p1")],
        ),
        options({ validateReferences: false }),
      );
      expect(first.errors).toEqual([]);
      expect(first.edges.created).toBe(1);

      // Load 2: the part, with a composition edge that attaches nothing. The
      // part is written, then refused and purged.
      const second = await importGraph(
        store,
        document(
          [{ kind: "IrpPart", id: "p1", properties: {} }],
          [danglingCompositionEdge("po-1", "p1")],
        ),
        options({ validateReferences: false }),
      );

      console.info("purge of a part with a pre-existing edge", second);
      expect(second.nodes).toEqual({ created: 0, updated: 0, skipped: 0 });
      expect(second.edges).toEqual({ created: 0, updated: 0, skipped: 0 });
      const remaining = await store.edges.irpTagged.find();
      const reported = second.errors.some(
        (error) => error.entityType === "edge" && error.id === "tag-edge",
      );
      // The purge removes every edge on the part; none may go unnamed.
      expect(remaining.map((edge) => edge.id)).toEqual([]);
      expect(reported).toBe(true);
      expect(second.errors.map((error) => error.id).toSorted()).toEqual([
        "p1",
        "po-1",
        "tag-edge",
      ]);
    });

    it("leaves an edge that predates the import alone when the part is refused unwritten", async () => {
      const store = await context.createStore(
        purgeGraph("import_required_part_refused_unwritten"),
      );
      await importGraph(
        store,
        document(
          [{ kind: "IrpTag", id: "t1", properties: {} }],
          [tagEdge("tag-edge", "p1")],
        ),
        options({ validateReferences: false }),
      );

      const second = await importGraph(
        store,
        document([{ kind: "IrpPart", id: "p1", properties: {} }], []),
        options({}),
      );

      expect(second.nodes).toEqual({ created: 0, updated: 0, skipped: 0 });
      expect(second.errors).toEqual([
        expect.objectContaining({
          entityType: "node",
          id: "p1",
          error: expect.stringMatching(/requires a whole/u) as string,
        }),
      ]);
      const remaining = await store.edges.irpTagged.find();
      expect(remaining.map((edge) => edge.id)).toEqual(["tag-edge"]);
    });

    describe.each([
      { order: "doomed part first", ids: ["p1", "p2"] },
      { order: "doomed part last", ids: ["p2", "p1"] },
    ])(
      "a row colliding only with a part the import refuses ($order)",
      ({ ids }) => {
        it.each([{ batchSize: 100 }, { batchSize: 1 }])(
          "commits it whatever the row order (batchSize $batchSize)",
          async ({ batchSize }) => {
            // `p1` has no composition edge anywhere, so it can never be
            // attached. `p2` shares its unique `code` and is otherwise valid.
            const store = await context.createStore(
              purgeGraph(
                `import_required_part_order_${ids.join("_")}_${batchSize}`,
              ),
            );
            await store.nodes.IrpWhole.create({}, { id: "w1" });

            const result = await importGraph(
              store,
              document(
                ids.map((id) => ({
                  kind: "IrpPart",
                  id,
                  properties: { code: "x" },
                })),
                [
                  {
                    kind: "irpPartOf",
                    id: "po-2",
                    from: { kind: "IrpPart", id: "p2" },
                    to: { kind: "IrpWhole", id: "w1" },
                    properties: {},
                  },
                ],
              ),
              options({ batchSize }),
            );

            console.info("rows beside a refused part", result.errors);
            expect(result.errors.map((error) => error.id)).toEqual(["p1"]);
            expect(result.nodes.created).toBe(1);
            expect(result.edges.created).toBe(1);
            const stored = await store.nodes.IrpPart.find();
            expect(stored.map((part) => part.id)).toEqual(["p2"]);
          },
        );
      },
    );

    it("refuses every repeated row of a part it never writes and counts none", async () => {
      const store = await context.createStore(
        purgeGraph("import_required_part_refused_duplicates"),
      );
      const result = await importGraph(
        store,
        document(
          [
            { kind: "IrpPart", id: "dup", properties: {} },
            { kind: "IrpPart", id: "dup", properties: {} },
          ],
          [],
        ),
        options({ onConflict: "update" }),
      );

      expect(result.nodes).toEqual({ created: 0, updated: 0, skipped: 0 });
      expect(result.errors.map((error) => error.id)).toEqual(["dup", "dup"]);
      expect(await store.nodes.IrpPart.count()).toBe(0);
    });

    it("takes a purged part and its edges off the updated counts too", async () => {
      const store = await context.createStore(
        purgeGraph("import_required_part_purge_updated"),
      );
      const result = await importGraph(
        store,
        document(
          [
            { kind: "IrpTag", id: "t1", properties: {} },
            { kind: "IrpPart", id: "dup", properties: {} },
            { kind: "IrpPart", id: "dup", properties: {} },
          ],
          [
            danglingCompositionEdge("po-dup", "dup"),
            tagEdge("e", "dup"),
            tagEdge("e", "dup"),
          ],
        ),
        options({ onConflict: "update", validateReferences: false }),
      );

      console.info("purge of a part a later row updated", result);
      expect(await store.nodes.IrpPart.count()).toBe(0);
      expect(await store.edges.irpTagged.count()).toBe(0);
      expect(result.nodes).toEqual({ created: 1, updated: 0, skipped: 0 });
      expect(result.edges).toEqual({ created: 0, updated: 0, skipped: 0 });
      expect(result.errors.map((error) => error.id).toSorted()).toEqual([
        "dup",
        "e",
        "po-dup",
      ]);
    });
  });
}
