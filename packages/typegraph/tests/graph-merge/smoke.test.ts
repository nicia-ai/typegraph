import { defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

describe("graph-merge scaffold smoke", () => {
  it("constructs a trivial graph from @nicia-ai/typegraph", () => {
    const graph = defineGraph({
      id: "social",
      nodes: { Person: { type: Person } },
      edges: {
        knows: { type: knows, from: [Person], to: [Person] },
      },
    });

    expect(graph.id).toBe("social");
    expect(Object.keys(graph.nodes)).toContain("Person");
    expect(Object.keys(graph.edges)).toContain("knows");
  });
});
