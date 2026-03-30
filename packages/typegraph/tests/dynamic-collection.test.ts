import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type DynamicEdgeCollection,
  type DynamicNodeCollection,
  getEdgeKinds,
  getNodeKinds,
} from "../src";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string(), industry: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
  from: [Person],
  to: [Company],
});

const knows = defineEdge("knows", {
  from: [Person],
  to: [Person],
});

const graph = defineGraph({
  id: "dynamic_test",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
    knows: { type: knows, from: [Person], to: [Person] },
  },
});

describe("getNodeCollection / getEdgeCollection", () => {
  describe("getNodeCollection", () => {
    it("returns a collection for a registered node kind", () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection = store.getNodeCollection("Person");

      expect(collection).toBeDefined();
    });

    it("returns undefined for an unregistered node kind", () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection = store.getNodeCollection("Ghost");

      expect(collection).toBeUndefined();
    });

    it("returned collection supports create and getById", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection = store.getNodeCollection("Person")!;
      const node = await collection.create({ name: "Alice" });

      expect(node.kind).toBe("Person");
      expect(node.id).toBeDefined();

      const fetched = await collection.getById(node.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(node.id);
    });

    it("returned collection supports find and count", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection = store.getNodeCollection("Company")!;
      await collection.create({ name: "Acme", industry: "Tech" });
      await collection.create({ name: "Globex", industry: "Manufacturing" });

      const nodes = await collection.find();
      expect(nodes).toHaveLength(2);

      const total = await collection.count();
      expect(total).toBe(2);
    });

    it("works when iterating all node kinds", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.create({ name: "Bob" });
      await store.nodes.Company.create({ name: "Acme", industry: "Tech" });

      const counts: Record<string, number> = {};
      for (const kind of getNodeKinds(graph)) {
        const collection = store.getNodeCollection(kind);
        if (collection) {
          counts[kind] = await collection.count();
        }
      }

      expect(counts).toEqual({ Person: 2, Company: 1 });
    });

    it("returned collection supports createFromRecord", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection = store.getNodeCollection("Person")!;
      const node = await collection.createFromRecord({ name: "Runtime Data" });

      expect(node.kind).toBe("Person");
    });
  });

  describe("getEdgeCollection", () => {
    it("returns a collection for a registered edge kind", () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection = store.getEdgeCollection("worksAt");

      expect(collection).toBeDefined();
    });

    it("returns undefined for an unregistered edge kind", () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection = store.getEdgeCollection("hasPet");

      expect(collection).toBeUndefined();
    });

    it("returned collection supports create and find", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({
        name: "Acme",
        industry: "Tech",
      });

      const collection = store.getEdgeCollection("worksAt")!;
      const edge = await collection.create(alice, acme, { role: "Engineer" });

      expect(edge.kind).toBe("worksAt");
      expect(edge.fromKind).toBe("Person");
      expect(edge.toKind).toBe("Company");

      const edges = await collection.find();
      expect(edges).toHaveLength(1);
    });

    it("returned collection supports count", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      const collection = store.getEdgeCollection("knows")!;
      await collection.create(alice, bob);

      const total = await collection.count();
      expect(total).toBe(1);
    });

    it("works when iterating all edge kinds", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({
        name: "Acme",
        industry: "Tech",
      });

      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
      await store.edges.knows.create(alice, bob);
      await store.edges.knows.create(bob, alice);

      const counts: Record<string, number> = {};
      for (const kind of getEdgeKinds(graph)) {
        const collection = store.getEdgeCollection(kind);
        if (collection) {
          counts[kind] = await collection.count();
        }
      }

      expect(counts).toEqual({ worksAt: 1, knows: 2 });
    });

    it("resolves a node from edge metadata via getNodeCollection", async () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({
        name: "Acme",
        industry: "Tech",
      });
      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      const fromCollection = store.getNodeCollection(edge.fromKind)!;
      const resolved = await fromCollection.getById(edge.fromId);
      expect(resolved).toBeDefined();
      expect(resolved?.id).toBe(alice.id);
    });
  });

  describe("type assignability", () => {
    it("getNodeCollection return type is assignable to DynamicNodeCollection", () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection: DynamicNodeCollection | undefined =
        store.getNodeCollection("Person");
      expect(collection).toBeDefined();
    });

    it("getEdgeCollection return type is assignable to DynamicEdgeCollection", () => {
      const backend = createTestBackend();
      const store = createStore(graph, backend);

      const collection: DynamicEdgeCollection | undefined =
        store.getEdgeCollection("worksAt");
      expect(collection).toBeDefined();
    });
  });
});
