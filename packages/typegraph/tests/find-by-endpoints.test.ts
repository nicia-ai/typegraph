/**
 * Tests for findByEndpoints API on EdgeCollection.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import { ValidationError } from "../src/errors";
import { createStore } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({
    relationship: z.string(),
    since: z.string().optional(),
  }),
});

const emptyEdge = defineEdge("emptyEdge");

const graph = defineGraph({
  id: "find_by_endpoints_test",
  nodes: {
    Person: { type: Person },
  },
  edges: {
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
    emptyEdge: {
      type: emptyEdge,
      from: [Person],
      to: [Person],
    },
  },
  ontology: [],
});

// ============================================================
// findByEndpoints Tests
// ============================================================

describe("store.edges.*.findByEndpoints()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("returns undefined when no edge matches", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    const result = await store.edges.knows.findByEndpoints(alice, bob);
    expect(result).toBeUndefined();
  });

  it("finds an existing edge by endpoints (no matchOn)", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const created = await store.edges.knows.create(alice, bob, {
      relationship: "friend",
    });

    const found = await store.edges.knows.findByEndpoints(alice, bob);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
    expect(found!.relationship).toBe("friend");
  });

  it("finds an existing edge by endpoints with matchOn", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.edges.knows.create(alice, bob, {
      relationship: "friend",
      since: "2020",
    });
    const colleague = await store.edges.knows.create(alice, bob, {
      relationship: "colleague",
      since: "2022",
    });

    const found = await store.edges.knows.findByEndpoints(alice, bob, {
      matchOn: ["relationship"] as const,
      props: { relationship: "colleague" },
    });

    expect(found).toBeDefined();
    expect(found!.id).toBe(colleague.id);
    expect(found!.relationship).toBe("colleague");
  });

  it("returns undefined when matchOn doesn't match any edge", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.edges.knows.create(alice, bob, {
      relationship: "friend",
    });

    const found = await store.edges.knows.findByEndpoints(alice, bob, {
      matchOn: ["relationship"] as const,
      props: { relationship: "enemy" },
    });

    expect(found).toBeUndefined();
  });

  it("excludes soft-deleted edges", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const edge = await store.edges.knows.create(alice, bob, {
      relationship: "friend",
    });
    await store.edges.knows.delete(edge.id);

    const found = await store.edges.knows.findByEndpoints(alice, bob);
    expect(found).toBeUndefined();
  });

  it("validates matchOn fields", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    await expect(
      store.edges.knows.findByEndpoints(alice, bob, {
        matchOn: ["nonexistent" as never] as const,
        props: { nonexistent: "x" } as never,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("works with edges that have empty schemas", async () => {
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const created = await store.edges.emptyEdge.create(alice, bob);

    const found = await store.edges.emptyEdge.findByEndpoints(alice, bob);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });
});
