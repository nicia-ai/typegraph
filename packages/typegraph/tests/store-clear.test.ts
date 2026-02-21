/**
 * Tests for store.clear() API.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import { createStore, createStoreWithSchema } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    email: z.string(),
    name: z.string(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

const graph = defineGraph({
  id: "store_clear_test",
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
// store.clear() Tests
// ============================================================

describe("store.clear()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("removes all nodes and edges for the graph", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });
    const bob = await store.nodes.Person.create({
      email: "bob@example.com",
      name: "Bob",
    });
    await store.edges.knows.create(alice, bob, { since: "2020" });

    expect(await store.nodes.Person.count()).toBe(2);
    expect(await store.edges.knows.count()).toBe(1);

    await store.clear();

    expect(await store.nodes.Person.count()).toBe(0);
    expect(await store.edges.knows.count()).toBe(0);
  });

  it("removes uniqueness entries", async () => {
    const store = createStore(graph, backend);
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    await store.clear();

    // After clear, the same unique key should be available
    const newAlice = await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice 2",
    });
    expect(newAlice.name).toBe("Alice 2");
  });

  it("removes schema versions", async () => {
    const [store] = await createStoreWithSchema(graph, backend);
    const schemaBeforeClear = await backend.getActiveSchema(graph.id);
    expect(schemaBeforeClear).toBeDefined();

    await store.clear();

    const schemaAfterClear = await backend.getActiveSchema(graph.id);
    expect(schemaAfterClear).toBeUndefined();
  });

  it("store is usable after clear", async () => {
    const store = createStore(graph, backend);
    await store.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });

    await store.clear();

    const newPerson = await store.nodes.Person.create({
      email: "bob@example.com",
      name: "Bob",
    });
    expect(newPerson.name).toBe("Bob");
    expect(await store.nodes.Person.count()).toBe(1);
  });

  it("does not affect other graphs", async () => {
    const graph2 = defineGraph({
      id: "store_clear_test_other",
      nodes: {
        Person: { type: Person },
      },
      edges: {},
      ontology: [],
    });

    const store1 = createStore(graph, backend);
    const store2 = createStore(graph2, backend);

    await store1.nodes.Person.create({
      email: "alice@example.com",
      name: "Alice",
    });
    await store2.nodes.Person.create({
      email: "bob@example.com",
      name: "Bob",
    });

    await store1.clear();

    expect(await store1.nodes.Person.count()).toBe(0);
    expect(await store2.nodes.Person.count()).toBe(1);
  });

  it("clears an empty store without error", async () => {
    const store = createStore(graph, backend);
    await store.clear();
    expect(await store.nodes.Person.count()).toBe(0);
  });
});
