import { describe, expect, it } from "vitest";

import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

export function registerReadEfficiencyIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("set-oriented read efficiency", () => {
    it("returns independent query payloads through one statement", async () => {
      const statements: string[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (ctx) => {
            statements.push(ctx.sql);
          },
        },
      });
      await store.nodes.Person.create({ name: "B", age: 2 });
      await store.nodes.Person.create({ name: "A", age: 1 });
      await store.nodes.Company.create({ name: "Company" });
      statements.length = 0;

      const [people, companies] = await store.batchOnce(
        store
          .query()
          .from("Person", "person")
          .orderBy("person", "age", "desc")
          .select((ctx) => ctx.person.name),
        store
          .query()
          .from("Company", "company")
          .select((ctx) => ctx.company),
      );

      expect(people).toEqual(["B", "A"]);
      expect(companies[0]?.name).toBe("Company");
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY/i);
    });

    it("orders, limits, and counts through an edge in one statement each", async () => {
      const statements: string[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (ctx) => {
            statements.push(ctx.sql);
          },
        },
      });
      const root = await store.nodes.Person.create({ name: "root" });
      const first = await store.nodes.Person.create({ name: "first" });
      const second = await store.nodes.Person.create({ name: "second" });
      await store.edges.knows.create(root, first, {}, { id: "edge-first" });
      const secondEdge = await store.edges.knows.create(
        root,
        second,
        {},
        { id: "edge-second" },
      );
      statements.length = 0;

      const neighbors = await store.neighbors(root, {
        edges: ["knows"],
        orderBy: { field: "id", direction: "desc" },
        limit: 1,
      });
      expect(neighbors[0]?.edge.id).toBe(secondEdge.id);
      expect(neighbors[0]?.node.id).toBe(secondEdge.toId);
      expect(statements).toHaveLength(1);

      statements.length = 0;
      await expect(
        store.countNeighbors(root, { edges: ["knows"] }),
      ).resolves.toBe(2);
      expect(statements).toHaveLength(1);
    });

    it("orders nullable edge metadata consistently across dialects", async () => {
      const store = await context.createStore(integrationTestGraph);
      const root = await store.nodes.Person.create({ name: "root" });
      const bounded = await store.nodes.Person.create({ name: "bounded" });
      const unbounded = await store.nodes.Person.create({ name: "unbounded" });
      const boundedEdge = await store.edges.knows.create(
        root,
        bounded,
        {},
        { id: "bounded-edge", validTo: "2099-01-01T00:00:00.000Z" },
      );
      await store.edges.knows.create(
        root,
        unbounded,
        {},
        { id: "unbounded-edge" },
      );

      const neighbors = await store.neighbors(root, {
        edges: ["knows"],
        orderBy: { field: "validTo", direction: "asc" },
        limit: 1,
      });

      expect(neighbors[0]?.edge.id).toBe(boundedEdge.id);
    });
  });
}
