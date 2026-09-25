import { describe, expect, it } from "vitest";

import { defineGraph } from "../src/core/define-graph";
import {
  defineGraphExtension,
  introspectGraphExtension,
} from "../src/graph-extension";
import { createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

describe("introspectGraphExtension", () => {
  it("returns compiled JSON Schema properties without graph or persistence metadata", () => {
    const extension = defineGraphExtension({
      nodes: {
        Paper: {
          description: "A paper",
          properties: {
            title: { type: "string", minLength: 1 },
            abstract: { type: "string", optional: true },
          },
        },
      },
      edges: {
        cites: {
          from: ["Paper"],
          to: ["Paper"],
          properties: { confidence: { type: "number", min: 0, max: 1 } },
        },
      },
    });

    const result = introspectGraphExtension(extension);

    expect(result.kinds).toHaveLength(1);
    expect(result.kinds[0]?.properties).toMatchObject({
      type: "object",
      properties: { title: { type: "string", minLength: 1 } },
      required: ["title"],
    });
    expect(result.edges[0]?.properties).toMatchObject({
      type: "object",
      properties: { confidence: { type: "number", minimum: 0, maximum: 1 } },
    });
    expect(result.edges[0]?.from).toEqual(["Paper"]);
    expect(result.edges[0]?.to).toEqual(["Paper"]);
    expect(result).not.toHaveProperty("graphId");
    expect(result).not.toHaveProperty("schemaVersion");
    expect(result).not.toHaveProperty("schemaHash");
  });

  it("agrees with Store.introspect for compiled extension properties", async () => {
    const extension = defineGraphExtension({
      nodes: {
        Product: {
          properties: {
            title: { type: "string", searchable: {} },
            price: { type: "number", min: 0 },
            active: { type: "boolean" },
            labels: { type: "array", items: { type: "string" } },
            details: {
              type: "object",
              properties: { sku: { type: "string", optional: true } },
            },
          },
          unique: [{ name: "product_title", fields: ["title"] }],
        },
      },
      edges: {
        related: {
          from: ["Product"],
          to: ["Product"],
          properties: { weight: { type: "number" } },
        },
      },
    });
    const graph = defineGraph({
      id: "extension-introspection-parity",
      nodes: {},
      edges: {},
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const evolved = await store.evolve(extension);
    const actual = evolved.introspect();
    const pure = introspectGraphExtension(extension);

    expect(pure.kinds[0]?.properties).toEqual(actual.kinds[0]?.properties);
    expect(pure.kinds[0]?.unique).toEqual(actual.kinds[0]?.unique);
    expect(pure.edges[0]?.properties).toEqual(actual.edges[0]?.properties);
    expect(pure.edges[0]?.from).toEqual(actual.edges[0]?.from);
    expect(pure.edges[0]?.to).toEqual(actual.edges[0]?.to);
  });
});
