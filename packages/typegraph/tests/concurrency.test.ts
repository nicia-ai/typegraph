/**
 * Concurrency tests for TypeGraph.
 *
 * Tests race conditions and parallel access patterns.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
} from "../src";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Graph Definition
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.email(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

const graph = defineGraph({
  id: "concurrency_test",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "email_unique",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
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
  ontology: [disjointWith(Person, Company)],
});

// ============================================================
// Test Setup
// ============================================================

function createTestStoreForConcurrency() {
  const backend = createTestBackend();
  return { store: createStore(graph, backend) };
}

// ============================================================
// Concurrency Tests
// ============================================================

describe("Concurrency", () => {
  describe("parallel node creation", () => {
    it("creates multiple nodes in parallel without conflicts", async () => {
      const { store } = createTestStoreForConcurrency();

      // Create 10 nodes in parallel with different emails
      const promises = Array.from({ length: 10 }, (_, index) =>
        store.nodes.Person.create({
          name: `Person ${index}`,
          email: `person${index}@example.com`,
        }),
      );

      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(10);
      expect(new Set(results.map((r) => r.id)).size).toBe(10);

      // Verify all were created
      const count = await store.nodes.Person.count();
      expect(count).toBe(10);
    });

    it("rejects sequential creation with same unique constraint", async () => {
      const { store } = createTestStoreForConcurrency();

      // First create should succeed
      await store.nodes.Person.create({
        name: "Person 1",
        email: "duplicate@example.com",
      });

      // Second create with same email should fail
      await expect(
        store.nodes.Person.create({
          name: "Person 2",
          email: "duplicate@example.com",
        }),
      ).rejects.toThrow(/[Uu]nique/);

      // Verify only one was created
      const count = await store.nodes.Person.count();
      expect(count).toBe(1);
    });
  });

  describe("parallel edge creation", () => {
    it("creates multiple edges to same node in parallel", async () => {
      const { store } = createTestStoreForConcurrency();

      // Create one company and multiple people
      const company = await store.nodes.Company.create({ name: "Acme" });
      const people = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          store.nodes.Person.create({
            name: `Person ${index}`,
            email: `person${index}@example.com`,
          }),
        ),
      );

      // Create edges in parallel
      const edgePromises = people.map((person, index) =>
        store.edges.worksAt.create(person, company, { role: `Role ${index}` }),
      );

      const edges = await Promise.all(edgePromises);

      expect(edges).toHaveLength(5);

      // Verify all edges were created
      const edgeCount = await store.edges.worksAt.count({});
      expect(edgeCount).toBe(5);
    });
  });

  describe("parallel updates", () => {
    it("handles parallel updates to different nodes", async () => {
      const { store } = createTestStoreForConcurrency();

      // Create nodes
      const nodes = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          store.nodes.Person.create({
            name: `Person ${index}`,
            email: `person${index}@example.com`,
          }),
        ),
      );

      // Update all in parallel
      const updatePromises = nodes.map((node, index) =>
        store.nodes.Person.update(node.id, { name: `Updated Person ${index}` }),
      );

      const updated = await Promise.all(updatePromises);

      // All should succeed with version incremented
      expect(updated.every((n) => n.meta.version === 2)).toBe(true);
    });
  });

  describe("parallel deletes", () => {
    it("handles parallel deletes without errors", async () => {
      const { store } = createTestStoreForConcurrency();

      // Create nodes
      const nodes = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          store.nodes.Person.create({
            name: `Person ${index}`,
            email: `person${index}@example.com`,
          }),
        ),
      );

      // Delete all in parallel
      const deletePromises = nodes.map((node) =>
        store.nodes.Person.delete(node.id),
      );

      await Promise.all(deletePromises);

      // All should be deleted
      const count = await store.nodes.Person.count();
      expect(count).toBe(0);
    });

    it("handles double-delete gracefully", async () => {
      const { store } = createTestStoreForConcurrency();

      const person = await store.nodes.Person.create({
        name: "Test",
        email: "test@example.com",
      });

      // Delete same node twice in parallel - should not throw
      await Promise.all([
        store.nodes.Person.delete(person.id),
        store.nodes.Person.delete(person.id),
      ]);

      const count = await store.nodes.Person.count();
      expect(count).toBe(0);
    });
  });

  describe("transaction isolation", () => {
    it("transactions see consistent state", async () => {
      const { store } = createTestStoreForConcurrency();

      const person = await store.nodes.Person.create({
        name: "Test",
        email: "test@example.com",
      });

      // Run transaction that reads and updates
      const result = await store.transaction(async (tx) => {
        const fetched = await tx.nodes.Person.getById(person.id);
        if (!fetched) throw new Error("Not found");

        const updated = await tx.nodes.Person.update(fetched.id, {
          name: "Updated",
        });

        return updated;
      });

      expect(result.name).toBe("Updated");
      expect(result.meta.version).toBe(2);
    });
  });

  describe("mixed operations", () => {
    it("handles mixed create/update/delete operations in parallel", async () => {
      const { store } = createTestStoreForConcurrency();

      // Create initial nodes
      const [person1, person2] = await Promise.all([
        store.nodes.Person.create({
          name: "Person 1",
          email: "p1@example.com",
        }),
        store.nodes.Person.create({
          name: "Person 2",
          email: "p2@example.com",
        }),
      ]);

      // Run mixed operations in parallel
      const results = await Promise.allSettled([
        // Create new
        store.nodes.Person.create({
          name: "Person 3",
          email: "p3@example.com",
        }),
        // Update existing
        store.nodes.Person.update(person1.id, { name: "Updated 1" }),
        // Delete one
        store.nodes.Person.delete(person2.id),
        // Create another
        store.nodes.Person.create({
          name: "Person 4",
          email: "p4@example.com",
        }),
      ]);

      // All should succeed
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);

      // Verify final state: 3 nodes (1 updated, 1 deleted, 2 created)
      const count = await store.nodes.Person.count();
      expect(count).toBe(3);
    });
  });
});
