import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  isEdgeTypeWithEndpoints,
} from "../src";

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
});
