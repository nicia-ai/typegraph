import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  isEdgeTypeWithEndpoints,
} from "../src";
import { createStore } from "../src/store";
import { createTestBackend } from "./test-utils";

describe("defineEdge() with domain/range", () => {
  const Person = defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const Company = defineNode("Company", {
    schema: z.object({ name: z.string() }),
  });
  const Subsidiary = defineNode("Subsidiary", {
    schema: z.object({ name: z.string() }),
  });

  describe("edge creation", () => {
    it("creates edge with built-in from/to", () => {
      const worksAt = defineEdge("worksAt", {
        schema: z.object({ role: z.string() }),
        from: [Person],
        to: [Company],
      });

      expect(worksAt.from).toEqual([Person]);
      expect(worksAt.to).toEqual([Company]);
      expect(worksAt.kind).toBe("worksAt");
    });

    it("creates edge without from/to (backwards compatible)", () => {
      const knows = defineEdge("knows", {
        schema: z.object({ since: z.string() }),
      });

      expect(knows.from).toBeUndefined();
      expect(knows.to).toBeUndefined();
      expect(knows.kind).toBe("knows");
    });

    it("creates edge with no options", () => {
      const follows = defineEdge("follows");

      expect(follows.from).toBeUndefined();
      expect(follows.to).toBeUndefined();
      expect(follows.kind).toBe("follows");
    });

    it("creates edge with multiple from/to types", () => {
      const worksAt = defineEdge("worksAt", {
        from: [Person],
        to: [Company, Subsidiary],
      });

      expect(worksAt.from).toEqual([Person]);
      expect(worksAt.to).toEqual([Company, Subsidiary]);
    });
  });

  describe("isEdgeTypeWithEndpoints", () => {
    it("returns true for edge with from/to", () => {
      const worksAt = defineEdge("worksAt", {
        from: [Person],
        to: [Company],
      });

      expect(isEdgeTypeWithEndpoints(worksAt)).toBe(true);
    });

    it("returns false for edge without from/to", () => {
      const knows = defineEdge("knows");

      expect(isEdgeTypeWithEndpoints(knows)).toBe(false);
    });

    it("returns false for non-edge values", () => {
      // eslint-disable-next-line unicorn/no-null -- testing null handling
      expect(isEdgeTypeWithEndpoints(null)).toBe(false);
      // eslint-disable-next-line unicorn/no-useless-undefined -- testing undefined property values
      expect(isEdgeTypeWithEndpoints(undefined)).toBe(false);
      expect(isEdgeTypeWithEndpoints({})).toBe(false);
      expect(isEdgeTypeWithEndpoints("worksAt")).toBe(false);
    });
  });

  describe("defineGraph with EdgeType directly", () => {
    it("allows EdgeType directly when from/to defined", () => {
      const worksAt = defineEdge("worksAt", {
        schema: z.object({ role: z.string() }),
        from: [Person],
        to: [Company],
      });

      const graph = defineGraph({
        id: "test",
        nodes: {
          Person: { type: Person },
          Company: { type: Company },
        },
        edges: { worksAt },
      });

      expect(graph.edges.worksAt.from).toContain(Person);
      expect(graph.edges.worksAt.to).toContain(Company);
      expect(graph.edges.worksAt.type).toBe(worksAt);
    });

    it("allows mixing EdgeType and EdgeRegistration", () => {
      const worksAt = defineEdge("worksAt", {
        from: [Person],
        to: [Company],
      });
      const knows = defineEdge("knows");

      const graph = defineGraph({
        id: "test",
        nodes: {
          Person: { type: Person },
          Company: { type: Company },
        },
        edges: {
          worksAt, // Direct EdgeType
          knows: { type: knows, from: [Person], to: [Person] }, // EdgeRegistration
        },
      });

      expect(graph.edges.worksAt.from).toContain(Person);
      expect(graph.edges.knows.from).toContain(Person);
    });
  });

  describe("EdgeRegistration constraint narrowing", () => {
    it("allows EdgeRegistration to narrow constraints", () => {
      const worksAt = defineEdge("worksAt", {
        from: [Person],
        to: [Company, Subsidiary],
      });

      const graph = defineGraph({
        id: "test",
        nodes: {
          Person: { type: Person },
          Company: { type: Company },
          Subsidiary: { type: Subsidiary },
        },
        edges: {
          worksAt: { type: worksAt, from: [Person], to: [Subsidiary] },
        },
      });

      expect(graph.edges.worksAt.to).toContain(Subsidiary);
      expect(graph.edges.worksAt.to).not.toContain(Company);
    });

    it("throws when EdgeRegistration widens 'to' beyond edge constraints", () => {
      const worksAt = defineEdge("worksAt", {
        from: [Person],
        to: [Company],
      });

      expect(() =>
        defineGraph({
          id: "test",
          nodes: {
            Person: { type: Person },
            Company: { type: Company },
            Subsidiary: { type: Subsidiary },
          },
          edges: {
            worksAt: { type: worksAt, from: [Person], to: [Subsidiary] },
          },
        }),
      ).toThrow(/not in edge's built-in range/);
    });

    it("throws when EdgeRegistration widens 'from' beyond edge constraints", () => {
      const worksAt = defineEdge("worksAt", {
        from: [Person],
        to: [Company],
      });

      expect(() =>
        defineGraph({
          id: "test",
          nodes: {
            Person: { type: Person },
            Company: { type: Company },
            Subsidiary: { type: Subsidiary },
          },
          edges: {
            worksAt: { type: worksAt, from: [Company], to: [Company] },
          },
        }),
      ).toThrow(/not in edge's built-in domain/);
    });
  });

  describe("backwards compatibility", () => {
    it("edges without from/to still work with EdgeRegistration", () => {
      const knows = defineEdge("knows", {
        schema: z.object({ since: z.string() }),
      });

      const graph = defineGraph({
        id: "test",
        nodes: { Person: { type: Person } },
        edges: {
          knows: { type: knows, from: [Person], to: [Person] },
        },
      });

      expect(graph.edges.knows.from).toContain(Person);
      expect(graph.edges.knows.to).toContain(Person);
    });

    it("preserves cardinality and other EdgeRegistration options", () => {
      const worksAt = defineEdge("worksAt", {
        from: [Person],
        to: [Company],
      });

      const graph = defineGraph({
        id: "test",
        nodes: {
          Person: { type: Person },
          Company: { type: Company },
        },
        edges: {
          worksAt: {
            type: worksAt,
            from: [Person],
            to: [Company],
            cardinality: "one",
          },
        },
      });

      expect(graph.edges.worksAt.cardinality).toBe("one");
    });
  });

  describe("unconstrained edges", () => {
    it("allows bare EdgeType without from/to directly in defineGraph", () => {
      const sameAs = defineEdge("sameAs");

      const graph = defineGraph({
        id: "test",
        nodes: {
          Person: { type: Person },
          Company: { type: Company },
        },
        edges: { sameAs },
      });

      expect(graph.edges.sameAs.type).toBe(sameAs);
      expect(graph.edges.sameAs.from).toContain(Person);
      expect(graph.edges.sameAs.from).toContain(Company);
      expect(graph.edges.sameAs.to).toContain(Person);
      expect(graph.edges.sameAs.to).toContain(Company);
    });

    it("allows unconstrained edge with schema", () => {
      const related = defineEdge("related", {
        schema: z.object({ reason: z.string() }),
      });

      const graph = defineGraph({
        id: "test",
        nodes: {
          Person: { type: Person },
          Company: { type: Company },
        },
        edges: { related },
      });

      expect(graph.edges.related.type.schema).toBe(related.schema);
      expect(graph.edges.related.from).toHaveLength(2);
      expect(graph.edges.related.to).toHaveLength(2);
    });

    it("mixes constrained and unconstrained edges", () => {
      const worksAt = defineEdge("worksAt", {
        from: [Person],
        to: [Company],
      });
      const sameAs = defineEdge("sameAs");

      const graph = defineGraph({
        id: "test",
        nodes: {
          Person: { type: Person },
          Company: { type: Company },
        },
        edges: {
          worksAt,
          sameAs,
        },
      });

      // Constrained edge: only Person→Company
      expect(graph.edges.worksAt.from).toEqual([Person]);
      expect(graph.edges.worksAt.to).toEqual([Company]);

      // Unconstrained edge: any→any
      expect(graph.edges.sameAs.from).toContain(Person);
      expect(graph.edges.sameAs.from).toContain(Company);
      expect(graph.edges.sameAs.to).toContain(Person);
      expect(graph.edges.sameAs.to).toContain(Company);
    });

    it("works with store for cross-type edges", async () => {
      const sameAs = defineEdge("sameAs");

      const graph = defineGraph({
        id: "test_unconstrained",
        nodes: {
          Person: { type: Person },
          Company: { type: Company },
        },
        edges: { sameAs },
      });

      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      // Person→Company
      const edge1 = await store.edges.sameAs.create(alice, acme, {});
      expect(edge1.id).toBeDefined();

      // Company→Person
      const edge2 = await store.edges.sameAs.create(acme, alice, {});
      expect(edge2.id).toBeDefined();

      // Person→Person
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const edge3 = await store.edges.sameAs.create(alice, bob, {});
      expect(edge3.id).toBeDefined();
    });
  });
});
