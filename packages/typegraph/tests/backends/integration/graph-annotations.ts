import { describe, expect, it } from "vitest";

import { defineGraph, defineGraphExtension } from "../../../src";
import { type IntegrationTestContext } from "./test-context";

export function registerGraphAnnotationsIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("graph-scoped annotations", () => {
    it("persists extension updates and reconstructs them on restart", async () => {
      const graph = defineGraph({
        id: "integration_graph_annotations",
        annotations: { displayName: "Base", owner: "schema" },
        nodes: {},
        edges: {},
      });
      const store = await context.createStore(graph);
      const evolved = await store.evolve(
        defineGraphExtension({
          annotations: {
            displayName: "Runtime",
            capabilities: { search: true },
          },
        }),
      );

      expect(evolved.introspect().annotations).toEqual({
        displayName: "Runtime",
        owner: "schema",
        capabilities: { search: true },
      });

      const restored = await context.createStore(graph);
      expect(restored.introspect().annotations).toEqual(
        evolved.introspect().annotations,
      );
    });
  });
}
