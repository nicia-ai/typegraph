/**
 * Collection API Tests
 *
 * Tests the ergonomic store.nodes and store.edges collection APIs.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { createSqliteBackend } from "../src/backend/sqlite";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import { createStore } from "../src/store";
import { createTestBackend, createTestDatabase } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.email().optional(),
    age: z.number().int().positive().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
});

const testGraph = defineGraph({
  id: "test_graph",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
  },
});

// ============================================================
// Node Collection Tests (SQLite)
// ============================================================

describe("Node Collections (SQLite)", () => {
  let db: BetterSQLite3Database;
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof testGraph>>;

  beforeEach(() => {
    db = createTestDatabase();
    backend = createSqliteBackend(db);
    store = createStore(testGraph, backend);
  });

  it("reuses node collection instances across repeated access", () => {
    expect(store.nodes.Person).toBe(store.nodes.Person);
  });

  describe("store.nodes.*.create()", () => {
    it("creates a node with the collection API", async () => {
      const person = await store.nodes.Person.create({
        name: "Alice",
        email: "alice@example.com",
      });

      expect(person.kind).toBe("Person");
      expect(person.name).toBe("Alice");
      expect(person.email).toBe("alice@example.com");
      expect(person.id).toBeDefined();
    });

    it("allows specifying a custom id", async () => {
      const person = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "custom-id" },
      );

      expect(person.id).toBe("custom-id");
    });
  });

  describe("store.nodes.*.getById()", () => {
    it("retrieves a node by id", async () => {
      const person = await store.nodes.Person.create({ name: "Alice" });

      const fetched = await store.nodes.Person.getById(person.id);

      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Alice");
    });

    it("returns undefined for non-existent id", async () => {
      // Create a person to establish the branded type and verify it exists
      const person = await store.nodes.Person.create({ name: "Alice" });
      expect(person.id).toBeDefined();

      // Use the same branded type to search for a non-existent id
      const fetched = await store.nodes.Person.getById(
        "non-existent" as typeof person.id,
      );
      expect(fetched).toBeUndefined();
    });
  });

  describe("store.nodes.*.getByIds()", () => {
    it("returns nodes in input order with undefined for missing IDs", async () => {
      const alice = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "person-a" },
      );
      const bob = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "person-b" },
      );

      const results = await store.nodes.Person.getByIds([
        bob.id,
        "nonexistent" as typeof alice.id,
        alice.id,
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]!.name).toBe("Bob");
      expect(results[1]).toBeUndefined();
      expect(results[2]!.name).toBe("Alice");
    });

    it("returns empty array for empty input", async () => {
      const results = await store.nodes.Person.getByIds([]);
      expect(results).toEqual([]);
    });

    it("falls back to individual getNode when backend lacks getNodes", async () => {
      const { getNodes: _getNodes, ...rest } = backend;
      const backendWithoutBatch = rest as GraphBackend;
      const localStore = createStore(testGraph, backendWithoutBatch);

      const alice = await localStore.nodes.Person.create(
        { name: "Alice" },
        { id: "fb-a" },
      );
      await localStore.nodes.Person.create({ name: "Bob" }, { id: "fb-b" });

      const results = await localStore.nodes.Person.getByIds([
        alice.id,
        "missing" as typeof alice.id,
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]!.name).toBe("Alice");
      expect(results[1]).toBeUndefined();
    });
  });

  describe("store.nodes.*.update()", () => {
    it("updates a node", async () => {
      const person = await store.nodes.Person.create({ name: "Alice" });

      const updated = await store.nodes.Person.update(person.id, {
        name: "Alice Smith",
        age: 30,
      });

      expect(updated.name).toBe("Alice Smith");
      expect(updated.age).toBe(30);
      expect(updated.meta.version).toBe(2);
    });
  });

  describe("store.nodes.*.delete()", () => {
    it("soft-deletes a node", async () => {
      const person = await store.nodes.Person.create({ name: "Alice" });

      await store.nodes.Person.delete(person.id);

      const fetched = await store.nodes.Person.getById(person.id);
      expect(fetched).toBeUndefined();
    });
  });

  describe("store.nodes.*.find()", () => {
    it("finds all nodes of a type", async () => {
      await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.create({ name: "Bob" });
      await store.nodes.Person.create({ name: "Charlie" });

      const people = await store.nodes.Person.find();

      expect(people).toHaveLength(3);
    });

    it("supports limit and offset", async () => {
      await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.create({ name: "Bob" });
      await store.nodes.Person.create({ name: "Charlie" });

      const page1 = await store.nodes.Person.find({ limit: 2 });
      expect(page1).toHaveLength(2);

      const page2 = await store.nodes.Person.find({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(1);
    });

    it("uses transaction backend for where-filtered find() inside transactions", async () => {
      const baseBackend = backend;
      let rootExecuteCount = 0;
      let txExecuteCount = 0;

      const observedBackend: GraphBackend = {
        ...baseBackend,
        async execute<T>(
          query: Parameters<GraphBackend["execute"]>[0],
        ): Promise<readonly T[]> {
          rootExecuteCount++;
          return baseBackend.execute<T>(query);
        },
        async transaction<T>(
          fn: (tx: TransactionBackend) => Promise<T>,
          options?: Parameters<GraphBackend["transaction"]>[1],
        ): Promise<T> {
          return baseBackend.transaction(async (txBackend) => {
            const observedTxBackend: TransactionBackend = {
              ...txBackend,
              async execute<T>(
                query: Parameters<GraphBackend["execute"]>[0],
              ): Promise<readonly T[]> {
                txExecuteCount++;
                return txBackend.execute<T>(query);
              },
            };
            return fn(observedTxBackend);
          }, options);
        },
      };

      const observedStore = createStore(testGraph, observedBackend);

      await observedStore.transaction(async (tx) => {
        await tx.nodes.Person.create(
          { name: "Transaction Person" },
          { id: "tx-person" },
        );

        const txResults = await tx.nodes.Person.find({
          where: (person) => person.id.eq("tx-person"),
        });

        expect(txResults).toHaveLength(1);
        expect(txResults[0]!.id).toBe("tx-person");
      });

      expect(txExecuteCount).toBeGreaterThan(0);
      expect(rootExecuteCount).toBe(0);

      const committed = await observedStore.nodes.Person.find({
        where: (person) => person.id.eq("tx-person"),
      });
      expect(committed).toHaveLength(1);
    });
  });

  describe("store.nodes.*.count()", () => {
    it("counts nodes of a type", async () => {
      await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.create({ name: "Bob" });

      const count = await store.nodes.Person.count();

      expect(count).toBe(2);
    });

    it("excludes deleted nodes from count", async () => {
      const person = await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.create({ name: "Bob" });

      await store.nodes.Person.delete(person.id);

      const count = await store.nodes.Person.count();
      expect(count).toBe(1);
    });
  });
});

// ============================================================
// Edge Collection Tests (SQLite)
// ============================================================

describe("Edge Collections (SQLite)", () => {
  let db: BetterSQLite3Database;
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof testGraph>>;

  beforeEach(() => {
    db = createTestDatabase();
    backend = createSqliteBackend(db);
    store = createStore(testGraph, backend);
  });

  it("reuses edge collection instances across repeated access", () => {
    expect(store.edges.worksAt).toBe(store.edges.worksAt);
  });

  describe("store.edges.*.create()", () => {
    it("creates an edge with explicit kind/id objects", async () => {
      const person = await store.nodes.Person.create({ name: "Alice" });
      const company = await store.nodes.Company.create({ name: "Acme Inc" });

      const edge = await store.edges.worksAt.create(
        { kind: "Person", id: person.id },
        { kind: "Company", id: company.id },
        { role: "Engineer" },
      );

      expect(edge.kind).toBe("worksAt");
      expect(edge.fromId).toBe(person.id);
      expect(edge.toId).toBe(company.id);
      expect(edge.role).toBe("Engineer");
    });

    it("creates an edge by passing Node objects directly", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      // Pass nodes directly - their kind and id properties are used
      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      expect(edge.kind).toBe("worksAt");
      expect(edge.fromId).toBe(alice.id);
      expect(edge.toId).toBe(acme.id);
      expect(edge.role).toBe("Engineer");
    });
  });

  describe("store.edges.*.getByIds()", () => {
    it("returns edges in input order with undefined for missing IDs", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const edge1 = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });
      const edge2 = await store.edges.worksAt.create(alice, techCorp, {
        role: "Consultant",
      });

      const results = await store.edges.worksAt.getByIds([
        edge2.id,
        "nonexistent",
        edge1.id,
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]!.role).toBe("Consultant");
      expect(results[1]).toBeUndefined();
      expect(results[2]!.role).toBe("Engineer");
    });

    it("returns empty array for empty input", async () => {
      const results = await store.edges.worksAt.getByIds([]);
      expect(results).toEqual([]);
    });

    it("falls back to individual getEdge when backend lacks getEdges", async () => {
      const { getEdges: _getEdges, ...rest } = backend;
      const backendWithoutBatch = rest as GraphBackend;
      const localStore = createStore(testGraph, backendWithoutBatch);

      const alice = await localStore.nodes.Person.create({ name: "Alice" });
      const acme = await localStore.nodes.Company.create({ name: "Acme Inc" });

      const edge = await localStore.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      const results = await localStore.edges.worksAt.getByIds([
        edge.id,
        "missing",
      ]);

      expect(results).toHaveLength(2);
      expect(results[0]!.role).toBe("Engineer");
      expect(results[1]).toBeUndefined();
    });
  });

  describe("store.edges.*.findFrom()", () => {
    it("finds edges from a specific node", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
      await store.edges.worksAt.create(alice, techCorp, { role: "Consultant" });

      // Pass node directly to findFrom
      const edges = await store.edges.worksAt.findFrom(alice);

      expect(edges).toHaveLength(2);
    });
  });

  describe("store.edges.*.findTo()", () => {
    it("finds edges to a specific node", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
      await store.edges.worksAt.create(bob, acme, { role: "Designer" });

      // Pass node directly to findTo
      const edges = await store.edges.worksAt.findTo(acme);

      expect(edges).toHaveLength(2);
    });
  });

  describe("store.edges.*.find()", () => {
    it("finds edges with combined filters", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

      // Pass nodes directly to find options
      const edges = await store.edges.worksAt.find({
        from: alice,
        to: acme,
      });

      expect(edges).toHaveLength(1);
      expect(edges[0]!.role).toBe("Engineer");
    });

    it("rejects unsupported where filter options", async () => {
      const find = store.edges.worksAt.find as (
        options: Readonly<{ where: () => unknown }>,
      ) => Promise<unknown>;

      await expect(
        find({
          where: () => true,
        }),
      ).rejects.toThrow("store.edges.worksAt.find({ where }) is not supported");
    });
  });

  describe("store.edges.*.update()", () => {
    it("updates an edge's properties", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      const updated = await store.edges.worksAt.update(edge.id, {
        role: "Senior Engineer",
        startDate: "2024-01-01",
      });

      expect(updated.role).toBe("Senior Engineer");
      expect(updated.startDate).toBe("2024-01-01");
    });

    it("merges with existing properties", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
        startDate: "2023-06-01",
      });

      // Update only role, startDate should be preserved
      const updated = await store.edges.worksAt.update(edge.id, {
        role: "Lead Engineer",
      });

      expect(updated.role).toBe("Lead Engineer");
      expect(updated.startDate).toBe("2023-06-01");
    });
  });

  describe("store.edges.*.count()", () => {
    it("counts all edges of a type", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
      await store.edges.worksAt.create(bob, acme, { role: "Designer" });

      const count = await store.edges.worksAt.count();

      expect(count).toBe(2);
    });

    it("counts edges from a specific node", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
      await store.edges.worksAt.create(alice, techCorp, { role: "Consultant" });
      await store.edges.worksAt.create(bob, acme, { role: "Designer" });

      const aliceCount = await store.edges.worksAt.count({ from: alice });
      const bobCount = await store.edges.worksAt.count({ from: bob });

      expect(aliceCount).toBe(2);
      expect(bobCount).toBe(1);
    });

    it("counts edges to a specific node", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
      await store.edges.worksAt.create(bob, acme, { role: "Designer" });

      const count = await store.edges.worksAt.count({ to: acme });

      expect(count).toBe(2);
    });

    it("excludes deleted edges from count", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });
      await store.edges.worksAt.create(alice, acme, { role: "Consultant" });

      await store.edges.worksAt.delete(edge.id);

      const count = await store.edges.worksAt.count();
      expect(count).toBe(1);
    });
  });
});

// ============================================================
// Bulk Operations Tests (SQLite)
// ============================================================

describe("Bulk Operations (SQLite)", () => {
  let db: BetterSQLite3Database;
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof testGraph>>;

  beforeEach(() => {
    db = createTestDatabase();
    backend = createSqliteBackend(db);
    store = createStore(testGraph, backend);
  });

  describe("store.nodes.*.upsertById()", () => {
    it("creates a node if it does not exist", async () => {
      const person = await store.nodes.Person.upsertById("person-1", {
        name: "Alice",
        email: "alice@example.com",
      });

      expect(person.id).toBe("person-1");
      expect(person.name).toBe("Alice");
      expect(person.meta.version).toBe(1);
    });

    it("updates a node if it exists", async () => {
      await store.nodes.Person.create({ name: "Alice" }, { id: "person-1" });

      const updated = await store.nodes.Person.upsertById("person-1", {
        name: "Alice Updated",
        email: "alice@example.com",
      });

      expect(updated.id).toBe("person-1");
      expect(updated.name).toBe("Alice Updated");
      expect(updated.meta.version).toBe(2);
    });

    it("un-deletes a soft-deleted node", async () => {
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "person-1" },
      );
      await store.nodes.Person.delete(person.id);

      // Verify node is deleted
      const deleted = await store.nodes.Person.getById(person.id);
      expect(deleted).toBeUndefined();

      // Upsert should un-delete and update the node
      const recreated = await store.nodes.Person.upsertById("person-1", {
        name: "Alice Reborn",
      });

      expect(recreated.id).toBe("person-1");
      expect(recreated.name).toBe("Alice Reborn");
      expect(recreated.meta.deletedAt).toBeUndefined();

      // Should be findable again
      const fetched = await store.nodes.Person.getById(person.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Alice Reborn");
    });
  });

  describe("store.nodes.*.bulkCreate()", () => {
    it("creates multiple nodes in a batch", async () => {
      const nodes = await store.nodes.Person.bulkCreate([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
        { props: { name: "Charlie" } },
      ]);

      expect(nodes).toHaveLength(3);
      expect(nodes[0]!.name).toBe("Alice");
      expect(nodes[1]!.name).toBe("Bob");
      expect(nodes[2]!.name).toBe("Charlie");

      const count = await store.nodes.Person.count();
      expect(count).toBe(3);
    });

    it("supports custom ids in bulk create", async () => {
      const nodes = await store.nodes.Person.bulkCreate([
        { id: "person-1", props: { name: "Alice" } },
        { id: "person-2", props: { name: "Bob" } },
      ]);

      expect(nodes[0]!.id).toBe("person-1");
      expect(nodes[1]!.id).toBe("person-2");
    });

    it("always returns created nodes", async () => {
      const nodes = await store.nodes.Person.bulkCreate([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);

      expect(nodes).toHaveLength(2);
      expect(nodes[0]!.name).toBe("Alice");
      expect(nodes[1]!.name).toBe("Bob");
    });

    it("uses batched backend node inserts for bulkInsert", async () => {
      const baseBackend = createSqliteBackend(createTestDatabase());
      let nodeNoReturnCalls = 0;
      let nodeBatchCalls = 0;

      async function insertNodeNoReturnWithFallback(
        activeBackend: GraphBackend | TransactionBackend,
        params: Parameters<GraphBackend["insertNode"]>[0],
      ): Promise<void> {
        await (activeBackend.insertNodeNoReturn?.(params) ??
          activeBackend.insertNode(params));
      }

      async function insertNodesBatchWithFallback(
        activeBackend: GraphBackend | TransactionBackend,
        params: readonly Parameters<GraphBackend["insertNode"]>[0][],
      ): Promise<void> {
        if (activeBackend.insertNodesBatch !== undefined) {
          await activeBackend.insertNodesBatch(params);
          return;
        }
        for (const insertParams of params) {
          await insertNodeNoReturnWithFallback(activeBackend, insertParams);
        }
      }

      const backendWithCounters: GraphBackend = {
        ...baseBackend,
        async insertNodeNoReturn(params) {
          nodeNoReturnCalls += 1;
          await insertNodeNoReturnWithFallback(baseBackend, params);
        },
        async insertNodesBatch(params) {
          nodeBatchCalls += 1;
          await insertNodesBatchWithFallback(baseBackend, params);
        },
        async transaction(fn, options) {
          return baseBackend.transaction(async (tx) => {
            const wrappedTx: TransactionBackend = {
              ...tx,
              async insertNodeNoReturn(params) {
                nodeNoReturnCalls += 1;
                await insertNodeNoReturnWithFallback(tx, params);
              },
              async insertNodesBatch(params) {
                nodeBatchCalls += 1;
                await insertNodesBatchWithFallback(tx, params);
              },
            };
            return fn(wrappedTx);
          }, options);
        },
      };

      const localStore = createStore(testGraph, backendWithCounters);
      await localStore.nodes.Person.bulkInsert([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);

      expect(nodeBatchCalls).toBe(1);
      expect(nodeNoReturnCalls).toBe(0);
    });

    it("rolls back bulkInsert batches when an item fails", async () => {
      await expect(
        store.nodes.Person.bulkInsert([
          { id: "dup-person", props: { name: "Alice" } },
          { id: "dup-person", props: { name: "Bob" } },
        ]),
      ).rejects.toThrow();

      const count = await store.nodes.Person.count();
      expect(count).toBe(0);
    });
  });

  describe("store.nodes.*.bulkUpsertById()", () => {
    it("creates nodes that do not exist", async () => {
      const nodes = await store.nodes.Person.bulkUpsertById([
        { id: "person-1", props: { name: "Alice" } },
        { id: "person-2", props: { name: "Bob" } },
      ]);

      expect(nodes).toHaveLength(2);
      expect(nodes[0]!.meta.version).toBe(1);
      expect(nodes[1]!.meta.version).toBe(1);
    });

    it("updates nodes that exist", async () => {
      await store.nodes.Person.create({ name: "Alice" }, { id: "person-1" });
      await store.nodes.Person.create({ name: "Bob" }, { id: "person-2" });

      const nodes = await store.nodes.Person.bulkUpsertById([
        { id: "person-1", props: { name: "Alice Updated" } },
        { id: "person-2", props: { name: "Bob Updated" } },
      ]);

      expect(nodes[0]!.name).toBe("Alice Updated");
      expect(nodes[0]!.meta.version).toBe(2);
      expect(nodes[1]!.name).toBe("Bob Updated");
      expect(nodes[1]!.meta.version).toBe(2);
    });

    it("handles mixed create and update", async () => {
      await store.nodes.Person.create({ name: "Alice" }, { id: "person-1" });

      const nodes = await store.nodes.Person.bulkUpsertById([
        { id: "person-1", props: { name: "Alice Updated" } },
        { id: "person-2", props: { name: "Bob New" } },
      ]);

      expect(nodes[0]!.meta.version).toBe(2); // Updated
      expect(nodes[1]!.meta.version).toBe(1); // Created
    });
  });

  describe("store.nodes.*.bulkDelete()", () => {
    it("deletes multiple nodes by id", async () => {
      const p1 = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "person-1" },
      );
      const p2 = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "person-2" },
      );
      await store.nodes.Person.create({ name: "Charlie" }, { id: "person-3" });

      await store.nodes.Person.bulkDelete([p1.id, p2.id]);

      const count = await store.nodes.Person.count();
      expect(count).toBe(1);

      const remaining = await store.nodes.Person.find();
      expect(remaining[0]!.name).toBe("Charlie");
    });

    it("silently ignores non-existent ids", async () => {
      const person = await store.nodes.Person.create({ name: "Alice" });

      // Should not throw
      await store.nodes.Person.bulkDelete([
        person.id,
        "non-existent" as typeof person.id,
      ]);

      const count = await store.nodes.Person.count();
      expect(count).toBe(0);
    });
  });

  describe("store.edges.*.bulkCreate()", () => {
    it("creates multiple edges in a batch", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const edges = await store.edges.worksAt.bulkCreate([
        { from: alice, to: acme, props: { role: "Engineer" } },
        { from: alice, to: techCorp, props: { role: "Consultant" } },
        { from: bob, to: acme, props: { role: "Designer" } },
      ]);

      expect(edges).toHaveLength(3);
      expect(edges[0]!.role).toBe("Engineer");
      expect(edges[1]!.role).toBe("Consultant");
      expect(edges[2]!.role).toBe("Designer");

      const count = await store.edges.worksAt.count();
      expect(count).toBe(3);
    });

    it("supports custom ids in bulk create", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edges = await store.edges.worksAt.bulkCreate([
        { id: "edge-1", from: alice, to: acme, props: { role: "Engineer" } },
      ]);

      expect(edges[0]!.id).toBe("edge-1");
    });

    it("always returns created edges", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edges = await store.edges.worksAt.bulkCreate([
        { from: alice, to: acme, props: { role: "Engineer" } },
      ]);

      expect(edges).toHaveLength(1);
      expect(edges[0]!.role).toBe("Engineer");
    });

    it("uses batched backend edge inserts for bulkInsert", async () => {
      const baseBackend = createSqliteBackend(createTestDatabase());
      let edgeNoReturnCalls = 0;
      let edgeBatchCalls = 0;

      async function insertEdgeNoReturnWithFallback(
        activeBackend: GraphBackend | TransactionBackend,
        params: Parameters<GraphBackend["insertEdge"]>[0],
      ): Promise<void> {
        await (activeBackend.insertEdgeNoReturn?.(params) ??
          activeBackend.insertEdge(params));
      }

      async function insertEdgesBatchWithFallback(
        activeBackend: GraphBackend | TransactionBackend,
        params: readonly Parameters<GraphBackend["insertEdge"]>[0][],
      ): Promise<void> {
        if (activeBackend.insertEdgesBatch !== undefined) {
          await activeBackend.insertEdgesBatch(params);
          return;
        }
        for (const insertParams of params) {
          await insertEdgeNoReturnWithFallback(activeBackend, insertParams);
        }
      }

      const backendWithCounters: GraphBackend = {
        ...baseBackend,
        async insertEdgeNoReturn(params) {
          edgeNoReturnCalls += 1;
          await insertEdgeNoReturnWithFallback(baseBackend, params);
        },
        async insertEdgesBatch(params) {
          edgeBatchCalls += 1;
          await insertEdgesBatchWithFallback(baseBackend, params);
        },
        async transaction(fn, options) {
          return baseBackend.transaction(async (tx) => {
            const wrappedTx: TransactionBackend = {
              ...tx,
              async insertEdgeNoReturn(params) {
                edgeNoReturnCalls += 1;
                await insertEdgeNoReturnWithFallback(tx, params);
              },
              async insertEdgesBatch(params) {
                edgeBatchCalls += 1;
                await insertEdgesBatchWithFallback(tx, params);
              },
            };
            return fn(wrappedTx);
          }, options);
        },
      };

      const localStore = createStore(testGraph, backendWithCounters);
      const alice = await localStore.nodes.Person.create({ name: "Alice" });
      const acme = await localStore.nodes.Company.create({ name: "Acme Inc" });
      await localStore.edges.worksAt.bulkInsert([
        { from: alice, to: acme, props: { role: "Engineer" } },
        { from: alice, to: acme, props: { role: "Architect" } },
      ]);

      expect(edgeBatchCalls).toBe(1);
      expect(edgeNoReturnCalls).toBe(0);
    });

    it("rolls back edge bulkInsert batches when an item fails", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      await expect(
        store.edges.worksAt.bulkInsert([
          {
            id: "dup-edge",
            from: alice,
            to: acme,
            props: { role: "Engineer" },
          },
          {
            id: "dup-edge",
            from: alice,
            to: acme,
            props: { role: "Manager" },
          },
        ]),
      ).rejects.toThrow();

      const count = await store.edges.worksAt.count();
      expect(count).toBe(0);
    });

    it("reuses endpoint existence checks for bulkInsert edge batches", async () => {
      const baseBackend = createSqliteBackend(createTestDatabase());
      let getNodeCalls = 0;

      const backendWithNodeCounter: GraphBackend = {
        ...baseBackend,
        async getNode(graphId, kind, id) {
          getNodeCalls += 1;
          return baseBackend.getNode(graphId, kind, id);
        },
        async transaction(fn, options) {
          return baseBackend.transaction(async (tx) => {
            const wrappedTx = {
              ...tx,
              async getNode(graphId: string, kind: string, id: string) {
                getNodeCalls += 1;
                return tx.getNode(graphId, kind, id);
              },
            };
            return fn(wrappedTx);
          }, options);
        },
      };

      const localStore = createStore(testGraph, backendWithNodeCounter);
      const alice = await localStore.nodes.Person.create({ name: "Alice" });
      const acme = await localStore.nodes.Company.create({ name: "Acme Inc" });

      getNodeCalls = 0;
      await localStore.edges.worksAt.bulkInsert([
        {
          id: "edge-cache-1",
          from: alice,
          to: acme,
          props: { role: "Engineer" },
        },
        {
          id: "edge-cache-2",
          from: alice,
          to: acme,
          props: { role: "Architect" },
        },
        {
          id: "edge-cache-3",
          from: alice,
          to: acme,
          props: { role: "Manager" },
        },
      ]);

      // Two endpoint checks total: one for from-node, one for to-node.
      expect(getNodeCalls).toBe(2);
    });
  });

  describe("store.edges.*.bulkUpsertById()", () => {
    it("creates edges that do not exist", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const edges = await store.edges.worksAt.bulkUpsertById([
        {
          id: "edge-1",
          from: alice,
          to: acme,
          props: { role: "Engineer" },
        },
        {
          id: "edge-2",
          from: alice,
          to: techCorp,
          props: { role: "Consultant" },
        },
      ]);

      expect(edges).toHaveLength(2);
      expect(edges[0]!.role).toBe("Engineer");
      expect(edges[1]!.role).toBe("Consultant");

      const count = await store.edges.worksAt.count();
      expect(count).toBe(2);
    });

    it("updates edges that exist", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { id: "edge-1" },
      );

      const edges = await store.edges.worksAt.bulkUpsertById([
        {
          id: "edge-1",
          from: alice,
          to: acme,
          props: { role: "Senior Engineer" },
        },
      ]);

      expect(edges).toHaveLength(1);
      expect(edges[0]!.role).toBe("Senior Engineer");
    });

    it("handles mixed create and update", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { id: "edge-existing" },
      );

      const edges = await store.edges.worksAt.bulkUpsertById([
        {
          id: "edge-existing",
          from: alice,
          to: acme,
          props: { role: "Lead Engineer" },
        },
        {
          id: "edge-new",
          from: alice,
          to: techCorp,
          props: { role: "Advisor" },
        },
      ]);

      expect(edges).toHaveLength(2);
      expect(edges[0]!.role).toBe("Lead Engineer");
      expect(edges[1]!.role).toBe("Advisor");

      const count = await store.edges.worksAt.count();
      expect(count).toBe(2);
    });

    it("returns empty array for empty input", async () => {
      const edges = await store.edges.worksAt.bulkUpsertById([]);
      expect(edges).toEqual([]);
    });

    it("un-deletes soft-deleted edges", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        { id: "edge-del" },
      );
      await store.edges.worksAt.delete(edge.id);

      const deleted = await store.edges.worksAt.getById(edge.id);
      expect(deleted).toBeUndefined();

      const edges = await store.edges.worksAt.bulkUpsertById([
        {
          id: "edge-del",
          from: alice,
          to: acme,
          props: { role: "Engineer Reborn" },
        },
      ]);

      expect(edges).toHaveLength(1);
      expect(edges[0]!.role).toBe("Engineer Reborn");
      expect(edges[0]!.meta.deletedAt).toBeUndefined();

      const fetched = await store.edges.worksAt.getById(edge.id);
      expect(fetched).toBeDefined();
      expect(fetched!.role).toBe("Engineer Reborn");
    });
  });

  describe("store.edges.*.bulkDelete()", () => {
    it("deletes multiple edges by id", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const firstEdge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });
      const secondEdge = await store.edges.worksAt.create(alice, techCorp, {
        role: "Consultant",
      });

      await store.edges.worksAt.bulkDelete([firstEdge.id, secondEdge.id]);

      const count = await store.edges.worksAt.count();
      expect(count).toBe(0);
    });

    it("silently ignores non-existent ids", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      // Should not throw
      await store.edges.worksAt.bulkDelete([edge.id, "non-existent"]);

      const count = await store.edges.worksAt.count();
      expect(count).toBe(0);
    });
  });
});

// ============================================================
// Node Collection Tests (Memory)
// ============================================================

describe("Node Collections (Memory)", () => {
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof testGraph>>;

  beforeEach(() => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);
  });

  it("creates and retrieves nodes with the collection API", async () => {
    const person = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });

    expect(person.kind).toBe("Person");
    expect(person.name).toBe("Alice");

    const fetched = await store.nodes.Person.getById(person.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("Alice");
  });

  it("finds and counts nodes", async () => {
    await store.nodes.Person.create({ name: "Alice" });
    await store.nodes.Person.create({ name: "Bob" });

    const people = await store.nodes.Person.find();
    expect(people).toHaveLength(2);

    const count = await store.nodes.Person.count();
    expect(count).toBe(2);
  });
});

// ============================================================
// Date Validation Tests
// ============================================================

describe("Date Validation", () => {
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof testGraph>>;

  beforeEach(() => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);
  });

  describe("node creation", () => {
    it("accepts valid ISO 8601 validFrom", async () => {
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { validFrom: "2024-01-15T10:30:00.000Z" },
      );
      expect(person.meta.validFrom).toBe("2024-01-15T10:30:00.000Z");
    });

    it("accepts valid ISO 8601 validTo", async () => {
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { validTo: "2024-12-31T23:59:59.999Z" },
      );
      expect(person.meta.validTo).toBe("2024-12-31T23:59:59.999Z");
    });

    it("rejects invalid validFrom format", async () => {
      await expect(
        store.nodes.Person.create(
          { name: "Alice" },
          { validFrom: "not-a-date" },
        ),
      ).rejects.toThrow(/Invalid ISO 8601 datetime for "validFrom"/);
    });

    it("rejects invalid validTo format", async () => {
      await expect(
        store.nodes.Person.create({ name: "Alice" }, { validTo: "2024-01-15" }),
      ).rejects.toThrow(/Invalid ISO 8601 datetime for "validTo"/);
    });

    it("rejects dates with timezone offset instead of Z", async () => {
      await expect(
        store.nodes.Person.create(
          { name: "Alice" },
          { validFrom: "2024-01-15T10:30:00+00:00" },
        ),
      ).rejects.toThrow(/Invalid ISO 8601 datetime/);
    });
  });

  describe("edge creation", () => {
    it("accepts valid ISO 8601 temporal fields", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Engineer" },
        {
          validFrom: "2024-01-01T00:00:00.000Z",
          validTo: "2024-12-31T23:59:59.999Z",
        },
      );

      expect(edge.meta.validFrom).toBe("2024-01-01T00:00:00.000Z");
      expect(edge.meta.validTo).toBe("2024-12-31T23:59:59.999Z");
    });

    it("rejects invalid validFrom on edge", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      await expect(
        store.edges.worksAt.create(
          alice,
          acme,
          { role: "Engineer" },
          { validFrom: "bad-date" },
        ),
      ).rejects.toThrow(/Invalid ISO 8601 datetime for "validFrom"/);
    });
  });

  describe("node update", () => {
    it("rejects invalid validTo on update", async () => {
      const person = await store.nodes.Person.create({ name: "Alice" });

      await expect(
        store.nodes.Person.update(
          person.id,
          { name: "Alice Updated" },
          { validTo: "not-iso" },
        ),
      ).rejects.toThrow(/Invalid ISO 8601 datetime for "validTo"/);
    });
  });
});

// ============================================================
// Temporal Filtering in count() and find()
// ============================================================

describe("Temporal filtering in count() and find()", () => {
  let db: BetterSQLite3Database;
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof testGraph>>;

  const PAST = "2020-01-01T00:00:00.000Z";
  const NOW = "2025-06-01T00:00:00.000Z";
  const FUTURE = "2030-01-01T00:00:00.000Z";

  beforeEach(() => {
    db = createTestDatabase();
    backend = createSqliteBackend(db);
    store = createStore(testGraph, backend);
  });

  describe("node count() temporal filtering", () => {
    it("excludes future nodes from count by default", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Future" },
        { validFrom: FUTURE },
      );

      const count = await store.nodes.Person.count();

      expect(count).toBe(1);
    });

    it("excludes expired nodes from count by default", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );

      const count = await store.nodes.Person.count();

      expect(count).toBe(1);
    });

    it("includes expired nodes with temporalMode: includeEnded", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );

      const count = await store.nodes.Person.count({
        temporalMode: "includeEnded",
      });

      expect(count).toBe(2);
    });

    it("includes deleted nodes with temporalMode: includeTombstones", async () => {
      const person = await store.nodes.Person.create({ name: "Will Delete" });
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.delete(person.id);

      const countDefault = await store.nodes.Person.count();
      expect(countDefault).toBe(1);

      const countAll = await store.nodes.Person.count({
        temporalMode: "includeTombstones",
      });
      expect(countAll).toBe(2);
    });

    it("filters by asOf timestamp", async () => {
      await store.nodes.Person.create(
        { name: "Early" },
        { validFrom: PAST, validTo: NOW },
      );
      await store.nodes.Person.create({ name: "Current" }, { validFrom: PAST });
      await store.nodes.Person.create(
        { name: "Future" },
        { validFrom: FUTURE },
      );

      const countAsOfNow = await store.nodes.Person.count({
        temporalMode: "asOf",
        asOf: NOW,
      });
      expect(countAsOfNow).toBe(1); // Only "Current"

      const countAsOfPast = await store.nodes.Person.count({
        temporalMode: "asOf",
        asOf: "2020-06-01T00:00:00.000Z",
      });
      expect(countAsOfPast).toBe(2); // "Early" + "Current"
    });
  });

  describe("node find() temporal filtering", () => {
    it("excludes future nodes from find by default", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Future" },
        { validFrom: FUTURE },
      );

      const results = await store.nodes.Person.find();

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("Active");
    });

    it("excludes expired nodes from find by default", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );

      const results = await store.nodes.Person.find();

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("Active");
    });

    it("includes expired nodes with temporalMode: includeEnded", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );

      const results = await store.nodes.Person.find({
        temporalMode: "includeEnded",
      });

      expect(results).toHaveLength(2);
    });

    it("includes deleted nodes with temporalMode: includeTombstones", async () => {
      const person = await store.nodes.Person.create({ name: "Will Delete" });
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.delete(person.id);

      const results = await store.nodes.Person.find({
        temporalMode: "includeTombstones",
      });

      expect(results).toHaveLength(2);
    });

    it("filters by asOf timestamp", async () => {
      await store.nodes.Person.create(
        { name: "Early" },
        { validFrom: PAST, validTo: NOW },
      );
      await store.nodes.Person.create({ name: "Current" }, { validFrom: PAST });

      const results = await store.nodes.Person.find({
        temporalMode: "asOf",
        asOf: NOW,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("Current");
    });

    it("respects limit and offset with temporal filtering", async () => {
      await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.create({ name: "Bob" });
      await store.nodes.Person.create(
        { name: "Future" },
        { validFrom: FUTURE },
      );

      const page1 = await store.nodes.Person.find({ limit: 1 });
      expect(page1).toHaveLength(1);

      const all = await store.nodes.Person.find();
      expect(all).toHaveLength(2);
    });
  });

  describe("node find() temporal filtering with where", () => {
    it("applies temporalMode when where is also provided", async () => {
      const person = await store.nodes.Person.create({ name: "Will Delete" });
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.delete(person.id);

      const withoutWhere = await store.nodes.Person.find({
        temporalMode: "includeTombstones",
      });
      expect(withoutWhere).toHaveLength(2);

      const withWhere = await store.nodes.Person.find({
        temporalMode: "includeTombstones",
        where: (person) => person.name.startsWith("Will"),
      });
      expect(withWhere).toHaveLength(1);
      expect(withWhere[0]!.name).toBe("Will Delete");
    });

    it("excludes future nodes from where-filtered find by default", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Future" },
        { validFrom: FUTURE },
      );

      const results = await store.nodes.Person.find({
        where: (person) => person.name.startsWith(""),
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("Active");
    });

    it("respects asOf with where-filtered find", async () => {
      await store.nodes.Person.create(
        { name: "Early" },
        { validFrom: PAST, validTo: NOW },
      );
      await store.nodes.Person.create({ name: "Current" }, { validFrom: PAST });

      const results = await store.nodes.Person.find({
        temporalMode: "asOf",
        asOf: "2020-06-01T00:00:00.000Z",
        where: (person) => person.name.startsWith(""),
      });

      expect(results).toHaveLength(2);
    });
  });

  describe("edge count() temporal filtering", () => {
    it("excludes future edges from count by default", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await store.edges.worksAt.create(alice, acme, { role: "Current" });
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Future" },
        { validFrom: FUTURE },
      );

      const count = await store.edges.worksAt.count();

      expect(count).toBe(1);
    });

    it("includes expired edges with temporalMode: includeEnded", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await store.edges.worksAt.create(alice, acme, { role: "Current" });
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );

      const countDefault = await store.edges.worksAt.count();
      expect(countDefault).toBe(1);

      const countIncludeEnded = await store.edges.worksAt.count({
        temporalMode: "includeEnded",
      });
      expect(countIncludeEnded).toBe(2);
    });

    it("includes deleted edges with temporalMode: includeTombstones", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Will Delete",
      });
      await store.edges.worksAt.create(alice, acme, { role: "Active" });
      await store.edges.worksAt.delete(edge.id);

      const countAll = await store.edges.worksAt.count({
        temporalMode: "includeTombstones",
      });
      expect(countAll).toBe(2);
    });

    it("filters edge count by asOf timestamp", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Past" },
        { validFrom: PAST, validTo: NOW },
      );
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Current" },
        { validFrom: PAST },
      );

      const count = await store.edges.worksAt.count({
        temporalMode: "asOf",
        asOf: NOW,
      });
      expect(count).toBe(1);
    });

    it("combines endpoint filters with temporal filtering", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await store.edges.worksAt.create(alice, acme, { role: "Current" });
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );
      await store.edges.worksAt.create(bob, acme, { role: "Current" });

      const aliceCount = await store.edges.worksAt.count({ from: alice });
      expect(aliceCount).toBe(1);

      const aliceCountAll = await store.edges.worksAt.count({
        from: alice,
        temporalMode: "includeEnded",
      });
      expect(aliceCountAll).toBe(2);
    });
  });

  describe("edge find() temporal filtering", () => {
    it("excludes future edges from find by default", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await store.edges.worksAt.create(alice, acme, { role: "Current" });
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Future" },
        { validFrom: FUTURE },
      );

      const results = await store.edges.worksAt.find();

      expect(results).toHaveLength(1);
      expect(results[0]!.role).toBe("Current");
    });

    it("includes expired edges with temporalMode: includeEnded", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await store.edges.worksAt.create(alice, acme, { role: "Current" });
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );

      const results = await store.edges.worksAt.find({
        temporalMode: "includeEnded",
      });

      expect(results).toHaveLength(2);
    });

    it("filters edges by asOf timestamp", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });

      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Past" },
        { validFrom: PAST, validTo: NOW },
      );
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Current" },
        { validFrom: PAST },
      );

      const results = await store.edges.worksAt.find({
        temporalMode: "asOf",
        asOf: NOW,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.role).toBe("Current");
    });
  });
});
