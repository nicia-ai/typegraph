/**
 * Document order for two rows naming ONE edge id in a single import slice.
 *
 * A slice writes most edges with one multi-row insert and routes the rest —
 * a repeated id, an acyclic kind, a composition kind — through the sequential
 * per-row path. Which path a row takes must never decide which of two rows
 * wins: the second occurrence observes the first occurrence's row, on every
 * kind and under every `onConflict` policy.
 *
 * Each case runs a plain kind beside an acyclic kind and expects the same
 * outcome from both.
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

const Item = defineNode("IdoItem", { schema: z.object({}) });
const Part = defineNode("IdoPart", { schema: z.object({}) });
const Whole = defineNode("IdoWhole", { schema: z.object({}) });
const labelled = z.object({ label: z.string() });
const plainLink = defineEdge("idoPlainLink", { schema: labelled });
const acyclicLink = defineEdge("idoAcyclicLink", { schema: labelled });
const holds = defineEdge("idoHolds", { schema: labelled });

const graph = defineGraph({
  id: "import_duplicate_edge_order",
  nodes: {
    IdoItem: { type: Item },
    IdoPart: { type: Part },
    IdoWhole: { type: Whole },
  },
  edges: {
    idoPlainLink: { type: plainLink, from: [Item], to: [Item] },
    idoAcyclicLink: {
      type: acyclicLink,
      from: [Item],
      to: [Item],
      acyclic: true,
    },
    idoHolds: { type: holds, from: [Part], to: [Whole], cardinality: "one" },
  },
  ontology: [partOf(Part, Whole, { via: holds })],
});

const LINK_KINDS = ["idoPlainLink", "idoAcyclicLink"] as const;
type LinkKind = (typeof LINK_KINDS)[number];

function document(edges: GraphData["edges"]): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "external", description: "duplicate edge id order" },
    nodes: [
      { kind: "IdoItem", id: "a", properties: {} },
      { kind: "IdoItem", id: "w1", properties: {} },
      { kind: "IdoItem", id: "w2", properties: {} },
      { kind: "IdoPart", id: "p1", properties: {} },
      { kind: "IdoWhole", id: "w1", properties: {} },
      { kind: "IdoWhole", id: "w2", properties: {} },
    ],
    edges,
  };
}

/**
 * Two rows for edge `e1`, labelled in document order. An edge's endpoints are
 * immutable, so only a second row that also names `secondTo: "w1"` is one an
 * `update` or `skip` policy can accept.
 */
function duplicateLinkRows(
  kind: LinkKind,
  secondTo: "w1" | "w2",
): GraphData["edges"] {
  return [
    {
      kind,
      id: "e1",
      from: { kind: "IdoItem", id: "a" },
      to: { kind: "IdoItem", id: "w1" },
      properties: { label: "first" },
    },
    {
      kind,
      id: "e1",
      from: { kind: "IdoItem", id: "a" },
      to: { kind: "IdoItem", id: secondTo },
      properties: { label: "second" },
    },
  ];
}

function options(onConflict: ImportOptions["onConflict"]): ImportOptions {
  return {
    onConflict,
    onUnknownProperty: "error",
    validateReferences: true,
    batchSize: 100,
    refreshStatistics: false,
  };
}

export function registerImportDuplicateEdgeOrderIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("import: document order for a repeated edge id", () => {
    describe.each(LINK_KINDS)("%s", (kind) => {
      it("update: the second occurrence updates the first's row", async () => {
        const store = await context.createStore(graph);
        const result = await importGraph(
          store,
          document(duplicateLinkRows(kind, "w1")),
          options("update"),
        );

        console.info("duplicate edge id, update", kind, result.edges);
        expect(result.errors).toEqual([]);
        expect(result.edges).toEqual({ created: 1, updated: 1, skipped: 0 });
        const [stored] = await store.edges[kind].find();
        expect(stored?.label).toBe("second");
        expect(stored?.toId).toBe("w1");
      });

      it("error: the first occurrence is stored and the second reported", async () => {
        const store = await context.createStore(graph);
        const result = await importGraph(
          store,
          document(duplicateLinkRows(kind, "w2")),
          options("error"),
        );

        console.info("duplicate edge id, error", kind, result.errors);
        expect(result.edges).toEqual({ created: 1, updated: 0, skipped: 0 });
        expect(result.errors).toHaveLength(1);
        const stored = await store.edges[kind].find();
        expect(stored.map((edge) => [edge.label, edge.toId])).toEqual([
          ["first", "w1"],
        ]);
      });

      it("skip: the first occurrence is stored and the second skipped", async () => {
        const store = await context.createStore(graph);
        const result = await importGraph(
          store,
          document(duplicateLinkRows(kind, "w1")),
          options("skip"),
        );

        expect(result.errors).toEqual([]);
        expect(result.edges).toEqual({ created: 1, updated: 0, skipped: 1 });
        const stored = await store.edges[kind].find();
        expect(stored.map((edge) => [edge.label, edge.toId])).toEqual([
          ["first", "w1"],
        ]);
      });
    });

    it("composition: the part is attached to the first occurrence's whole", async () => {
      const store = await context.createStore(graph);
      const result = await importGraph(
        store,
        document([
          {
            kind: "idoHolds",
            id: "h1",
            from: { kind: "IdoPart", id: "p1" },
            to: { kind: "IdoWhole", id: "w1" },
            properties: { label: "first" },
          },
          {
            kind: "idoHolds",
            id: "h1",
            from: { kind: "IdoPart", id: "p1" },
            to: { kind: "IdoWhole", id: "w2" },
            properties: { label: "second" },
          },
        ]),
        options("error"),
      );

      console.info("duplicate composition edge id", result.errors);
      expect(result.edges).toEqual({ created: 1, updated: 0, skipped: 0 });
      expect(result.errors).toHaveLength(1);
      const stored = await store.edges.idoHolds.find();
      expect(stored.map((edge) => [edge.label, edge.toId])).toEqual([
        ["first", "w1"],
      ]);
    });
  });
}
