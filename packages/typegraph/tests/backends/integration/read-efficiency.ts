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

      const [people, companies] = await store.batchOnce(() => [
        store
          .query()
          .from("Person", "person")
          .orderBy("person", "age", "desc")
          .select((ctx) => ctx.person.name),
        store
          .query()
          .from("Company", "company")
          .select((ctx) => ctx.company),
      ]);

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

    it("orders neighbors by adjacent-node properties", async () => {
      const store = await context.createStore(integrationTestGraph);
      const root = await store.nodes.Person.create({ name: "root" });
      const older = await store.nodes.Person.create({ name: "older", age: 2 });
      const newer = await store.nodes.Person.create({ name: "newer", age: 10 });
      await store.edges.knows.create(root, older, {}, { id: "edge-a" });
      await store.edges.knows.create(root, newer, {}, { id: "edge-b" });

      const neighbors = await store.neighbors(root, {
        edges: ["knows"],
        orderBy: { by: "node", field: "age", direction: "desc" },
        limit: 1,
      });

      expect(neighbors[0]?.node.id).toBe(newer.id);
    });

    it("composes neighbor aggregates and subgraphs into one statement", async () => {
      const statements: string[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: { onQueryStart: (ctx) => statements.push(ctx.sql) },
      });
      const root = await store.nodes.Person.create({ name: "root" });
      const target = await store.nodes.Person.create({ name: "target" });
      await store.edges.knows.create(root, target, {});
      const directNeighbors = await store.neighbors(root, { edges: ["knows"] });
      statements.length = 0;

      const [neighbors, count, subgraph] = await store.batchOnce((read) => [
        read.neighbors(root, { edges: ["knows"] }),
        read.countNeighbors(root, { edges: ["knows"] }),
        read.subgraph(root.id, { edges: ["knows"], maxDepth: 1 }),
      ]);

      expect(neighbors).toHaveLength(1);
      expect(neighbors).toEqual(directNeighbors);
      expect(count).toBe(1);
      expect(subgraph.nodes.has(target.id)).toBe(true);
      expect(statements).toHaveLength(1);
    });

    it("binds composable graph reads to the current transaction", async () => {
      const statements: string[] = [];
      const attempts: number[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (ctx) => {
            statements.push(ctx.sql);
            attempts.push(ctx.attempt ?? -1);
          },
        },
      });

      await store.transaction(async (tx) => {
        const root = await tx.nodes.Person.create({ name: "root" });
        const target = await tx.nodes.Person.create({ name: "target" });
        await tx.edges.knows.create(root, target, {});

        const neighbors = await tx.neighbors(root, { edges: ["knows"] });
        await expect(
          tx.countNeighbors(root, { edges: ["knows"] }),
        ).resolves.toBe(1);
        const directSubgraph = await tx.subgraph(root.id, {
          edges: ["knows"],
          maxDepth: 1,
        });

        expect(neighbors[0]?.node.id).toBe(target.id);
        expect(directSubgraph.nodes.has(target.id)).toBe(true);
        expect(statements).toHaveLength(3);

        statements.length = 0;
        attempts.length = 0;
        const [people, batchedNeighbors, count, batchedSubgraph] =
          await tx.batchOnce((read) => [
            tx
              .query()
              .from("Person", "person")
              .orderBy("person", "name", "asc")
              .select((ctx) => ctx.person.name),
            read.neighbors(root, { edges: ["knows"] }),
            read.countNeighbors(root, { edges: ["knows"] }),
            read.subgraph(root.id, { edges: ["knows"], maxDepth: 1 }),
          ]);

        expect(people).toEqual(["root", "target"]);
        expect(batchedNeighbors).toEqual(neighbors);
        expect(count).toBe(1);
        expect(batchedSubgraph.nodes.has(target.id)).toBe(true);
        expect(statements).toHaveLength(1);
        expect(attempts).toEqual([1]);
      });
    });
  });
}
