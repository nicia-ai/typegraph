/**
 * What a validating import leaves behind, and reports, when it refuses a
 * required-existence part it created.
 *
 * Refusing the part removes its node row together with every edge touching
 * it. The import's result must then describe exactly what was committed:
 * every removed edge is named in `errors` — including one that was on the
 * target before this import ran — and no counter, `created` or `updated`,
 * still counts a row that is gone.
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

      // Load 2: the part, with no composition edge. It is refused and purged.
      const second = await importGraph(
        store,
        document([{ kind: "IrpPart", id: "p1", properties: {} }], []),
        options({}),
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
        "tag-edge",
      ]);
    });

    it("keeps a row refused against a part it later purges refused, as documented", async () => {
      // The refused part's row exists while the payload is processed, so a
      // later row that collides with it is judged against it. The collision
      // is not re-judged once the part is gone: the documented recovery is
      // to re-run the import without the refused part.
      const store = await context.createStore(
        purgeGraph("import_required_part_purge_ordering"),
      );
      await store.nodes.IrpWhole.create({}, { id: "w1" });
      const nodes: GraphData["nodes"] = [
        { kind: "IrpPart", id: "p1", properties: { code: "x" } },
        { kind: "IrpPart", id: "p2", properties: { code: "x" } },
      ];
      const edges: GraphData["edges"] = [
        {
          kind: "irpPartOf",
          id: "po-2",
          from: { kind: "IrpPart", id: "p2" },
          to: { kind: "IrpWhole", id: "w1" },
          properties: {},
        },
      ];

      const withDoomedPart = await importGraph(
        store,
        document(nodes, edges),
        options({}),
      );
      console.info("row refused against a purged part", withDoomedPart.errors);
      expect(withDoomedPart.errors.map((error) => error.id)).toEqual([
        "p2",
        "po-2",
        "p1",
      ]);
      expect(await store.nodes.IrpPart.count()).toBe(0);

      const withoutDoomedPart = await importGraph(
        store,
        document(nodes.slice(1), edges),
        options({}),
      );
      expect(withoutDoomedPart.errors).toEqual([]);
      expect(withoutDoomedPart.nodes.created).toBe(1);
      expect(await store.nodes.IrpPart.count()).toBe(1);
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
          [tagEdge("e", "dup"), tagEdge("e", "dup")],
        ),
        options({ onConflict: "update" }),
      );

      console.info("purge of a part a later row updated", result);
      expect(await store.nodes.IrpPart.count()).toBe(0);
      expect(await store.edges.irpTagged.count()).toBe(0);
      expect(result.nodes).toEqual({ created: 1, updated: 0, skipped: 0 });
      expect(result.edges).toEqual({ created: 0, updated: 0, skipped: 0 });
      expect(result.errors.map((error) => error.id).toSorted()).toEqual([
        "dup",
        "e",
      ]);
    });
  });
}
