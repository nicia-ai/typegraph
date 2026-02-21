/**
 * Tests for findByConstraint and bulkFindByConstraint APIs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import { NodeConstraintNotFoundError } from "../src/errors";
import { createStore } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    email: z.string(),
    name: z.string(),
    role: z.string().optional(),
  }),
});

const knows = defineEdge("knows");

const graph = defineGraph({
  id: "find_by_constraint_test",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
    },
  },
  ontology: [],
});

// ============================================================
// findByConstraint Tests
// ============================================================

describe("store.nodes.*.findByConstraint()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("returns undefined when no node matches", async () => {
    const store = createStore(graph, backend);
    const result = await store.nodes.Person.findByConstraint("email", {
      email: "nobody@example.com",
      name: "Nobody",
    });
    expect(result).toBeUndefined();
  });

  it("finds an existing node by constraint", async () => {
    const store = createStore(graph, backend);
    const created = await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
      role: "eng",
    });

    const found = await store.nodes.Person.findByConstraint("email", {
      email: "alice@example.com",
      name: "Alice",
    });

    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.email).toBe("alice@example.com");
    expect(found!.name).toBe("Alice");
    expect(found!.role).toBe("eng");
  });

  it("excludes soft-deleted nodes", async () => {
    const store = createStore(graph, backend);
    const created = await store.nodes.Person.create({
      email: "deleted@example.com",
      name: "Deleted",
    });
    await store.nodes.Person.delete(created.id);

    const found = await store.nodes.Person.findByConstraint("email", {
      email: "deleted@example.com",
      name: "Deleted",
    });
    expect(found).toBeUndefined();
  });

  it("throws for unknown constraint name", async () => {
    const store = createStore(graph, backend);
    await expect(
      store.nodes.Person.findByConstraint("nonexistent", {
        email: "a@b.com",
        name: "A",
      }),
    ).rejects.toThrow(NodeConstraintNotFoundError);
  });
});

// ============================================================
// bulkFindByConstraint Tests
// ============================================================

describe("store.nodes.*.bulkFindByConstraint()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("returns empty array for empty input", async () => {
    const store = createStore(graph, backend);
    const results = await store.nodes.Person.bulkFindByConstraint("email", []);
    expect(results).toEqual([]);
  });

  it("returns mixed found and not-found in input order", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });
    await store.nodes.Person.create({
      email: "bob@example.com",
      name: "Bob",
    });

    const results = await store.nodes.Person.bulkFindByConstraint("email", [
      { props: { email: "alice@example.com", name: "Alice" } },
      { props: { email: "nobody@example.com", name: "Nobody" } },
      { props: { email: "bob@example.com", name: "Bob" } },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]).toBeDefined();
    expect(results[0]!.id).toBe(alice.id);
    expect(results[1]).toBeUndefined();
    expect(results[2]).toBeDefined();
    expect(results[2]!.email).toBe("bob@example.com");
  });

  it("excludes soft-deleted nodes from bulk results", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });
    await store.nodes.Person.delete(alice.id);

    const results = await store.nodes.Person.bulkFindByConstraint("email", [
      { props: { email: "alice@example.com", name: "Alice" } },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]).toBeUndefined();
  });

  it("deduplicates within-batch lookups", async () => {
    const store = createStore(graph, backend);
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    const results = await store.nodes.Person.bulkFindByConstraint("email", [
      { props: { email: "alice@example.com", name: "Alice" } },
      { props: { email: "alice@example.com", name: "Alice" } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]).toBeDefined();
    expect(results[1]).toBeDefined();
    expect(results[0]!.id).toBe(results[1]!.id);
  });
});
