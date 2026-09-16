import { describe, expect, it } from "vitest";

import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

export function registerReadEfficiencyIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("set-oriented read efficiency", () => {
    it("embeds independent cursor pages in one statement", async () => {
      const statements: string[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (query) => {
            statements.push(query.sql);
          },
        },
      });
      await store.nodes.Person.bulkCreate([
        { props: { name: "Ada", age: 31 } },
        { props: { name: "Grace", age: 37 } },
        { props: { name: "Linus", age: 55 } },
      ]);
      await store.nodes.Company.create({ name: "Example Company" });
      const people = store
        .query()
        .from("Person", "person")
        .orderBy("person", "age", "asc")
        .select((fields) => ({
          name: fields.person.name,
          age: fields.person.age,
        }));

      const standalonePage = await people.page({ first: 1 }).execute();
      expect(standalonePage.data).toEqual([{ name: "Ada", age: 31 }]);
      expect(standalonePage.hasNextPage).toBe(true);
      statements.length = 0;

      const [firstPage, companies] = await store.batchOnce(() => [
        people.page({ first: 2 }),
        store
          .query()
          .from("Company", "company")
          .select((fields) => fields.company.name),
      ]);

      expect(firstPage.data).toEqual([
        { name: "Ada", age: 31 },
        { name: "Grace", age: 37 },
      ]);
      expect(firstPage.hasNextPage).toBe(true);
      expect(firstPage.hasPrevPage).toBe(false);
      expect(companies).toEqual(["Example Company"]);
      expect(statements).toHaveLength(1);
      const nextCursor = firstPage.nextCursor;
      if (nextCursor === undefined)
        throw new Error("Expected a next-page cursor");

      statements.length = 0;
      const [secondPage] = await store.batchOnce(() => [
        people.page({
          first: 2,
          after: nextCursor,
        }),
      ]);
      expect(secondPage.data).toEqual([{ name: "Linus", age: 55 }]);
      expect(secondPage.hasNextPage).toBe(false);
      expect(secondPage.hasPrevPage).toBe(true);
      expect(statements).toHaveLength(1);
      const previousCursor = secondPage.prevCursor;
      if (previousCursor === undefined)
        throw new Error("Expected a previous-page cursor");

      statements.length = 0;
      const [previousPage] = await store.batchOnce(() => [
        people.page({ last: 2, before: previousCursor }),
      ]);
      expect(previousPage.data).toEqual([
        { name: "Ada", age: 31 },
        { name: "Grace", age: 37 },
      ]);
      expect(previousPage.hasNextPage).toBe(true);
      expect(previousPage.hasPrevPage).toBe(false);
      expect(statements).toHaveLength(1);
    });

    it("snapshots page options for standalone and batched execution", async () => {
      const store = await context.createStore(integrationTestGraph);
      await store.nodes.Person.bulkCreate([
        { id: "snapshot-a", props: { name: "Ada", age: 31 } },
        { id: "snapshot-b", props: { name: "Grace", age: 37 } },
        { id: "snapshot-c", props: { name: "Linus", age: 55 } },
      ]);
      const people = store
        .query()
        .from("Person", "person")
        .orderBy("person", "age", "asc")
        .select((fields) => fields.person.name);
      const options = { first: 1 };
      const page = people.page(options);

      options.first = 3;

      const standalone = await page.execute();
      expect(standalone.data).toEqual(["Ada"]);
      const [batched] = await store.batchOnce(() => [page]);
      expect(batched.data).toEqual(["Ada"]);
    });

    it("shares cursor semantics for nullable non-unique omitted sort keys", async () => {
      const store = await context.createStore(integrationTestGraph);
      await store.nodes.Person.bulkCreate([
        { id: "cursor-a", props: { name: "Ada", age: 30 } },
        { id: "cursor-b", props: { name: "Babbage", age: 30 } },
        { id: "cursor-c", props: { name: "Curie", age: 40 } },
        { id: "cursor-null", props: { name: "No age" } },
      ]);
      const people = store
        .query()
        .from("Person", "person")
        .orderBy("person", "age", "asc")
        .select((fields) => fields.person.name);

      const first = await people.paginate({ first: 2 });
      expect(first.data).toEqual(["Ada", "Babbage"]);
      const nextCursor = first.nextCursor;
      if (nextCursor === undefined)
        throw new Error("Expected a next-page cursor");

      const [second] = await store.batchOnce(() => [
        people.page({ first: 2, after: nextCursor }),
      ]);
      expect(second.data).toEqual(["Curie", "No age"]);
      const previousCursor = second.prevCursor;
      if (previousCursor === undefined)
        throw new Error("Expected a previous-page cursor");

      const previous = await people
        .page({ last: 2, before: previousCursor })
        .execute();
      expect(previous.data).toEqual(["Ada", "Babbage"]);

      const empty = store
        .query()
        .from("Person", "person")
        .whereNode("person", (person) => person.name.eq("missing"))
        .orderBy("person", "age", "asc")
        .select((fields) => fields.person.name)
        .page({ first: 2 });
      expect(await empty.execute()).toEqual({
        data: [],
        nextCursor: undefined,
        prevCursor: undefined,
        hasNextPage: false,
        hasPrevPage: false,
      });
      const [emptyBatch] = await store.batchOnce(() => [empty]);
      expect(emptyBatch).toEqual(await empty.execute());
    });

    it("shares hydration only when requested and preserves independent nested data", async () => {
      const statements: string[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (query) => {
            statements.push(query.sql);
          },
        },
      });
      const root = await store.nodes.Document.create({
        title: "Shared nested document",
        metadata: { author: "Original" },
      });
      statements.length = 0;
      await store.batchOnce((read) => [
        read.subgraph(root.id, {
          edges: [],
          maxDepth: 0,
          includeKinds: ["Document"],
          project: { nodes: { Document: ["metadata"] } },
        }),
        read.subgraph(root.id, {
          edges: [],
          maxDepth: 0,
          includeKinds: ["Document"],
          project: { nodes: { Document: ["metadata"] } },
        }),
      ]);
      expect(statements).toHaveLength(1);
      expect(statements[0]).not.toContain("typegraph_shared_hydrated");
      statements.length = 0;
      const [first, duplicate] = await store.batchOnce(
        (read) => [
          read.subgraph(root.id, {
            edges: [],
            maxDepth: 0,
            includeKinds: ["Document"],
            project: { nodes: { Document: ["metadata"] } },
          }),
          read.subgraph(root.id, {
            edges: [],
            maxDepth: 0,
            includeKinds: ["Document"],
            project: { nodes: { Document: ["metadata"] } },
          }),
        ],
        { shareSubgraphs: true },
      );
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("typegraph_shared_hydrated");
      expect(duplicate).toEqual(first);
      const duplicateMetadata = duplicate.root?.metadata;
      expect(duplicateMetadata).toBeDefined();
      if (duplicateMetadata === undefined)
        throw new Error("Expected nested metadata");
      Reflect.set(duplicateMetadata, "author", "Changed");
      expect(first.root?.metadata?.author).toBe("Original");
      statements.length = 0;
      await store.transaction(async (transaction) => {
        const [copy] = await transaction.batchOnce(
          (read) => [
            read.subgraph(root.id, { edges: [], maxDepth: 0 }),
            read.subgraph(root.id, { edges: [], maxDepth: 0 }),
          ],
          { shareSubgraphs: true },
        );
        expect(copy.root?.id).toBe(root.id);
      });
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("typegraph_shared_hydrated");
    });

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
