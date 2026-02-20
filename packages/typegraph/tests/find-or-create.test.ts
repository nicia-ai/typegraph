/**
 * Tests for findOrCreate and bulkFindOrCreate on NodeCollection.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import { ConstraintNotFoundError } from "../src/errors";
import { createStore } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Entity = defineNode("Entity", {
  schema: z.object({
    entityType: z.string(),
    name: z.string(),
    role: z.string().optional(),
  }),
});

const relatedTo = defineEdge("relatedTo");

const graph = defineGraph({
  id: "find_or_create_test",
  nodes: {
    Entity: {
      type: Entity,
      unique: [
        {
          name: "entity_key",
          fields: ["entityType", "name"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    relatedTo: {
      type: relatedTo,
      from: [Entity],
      to: [Entity],
      cardinality: "many",
    },
  },
  ontology: [],
});

// ============================================================
// findOrCreate Tests
// ============================================================

describe("store.nodes.*.findOrCreate()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("creates a node when none exists", async () => {
    const store = createStore(graph, backend);
    const result = await store.nodes.Entity.findOrCreate("entity_key", {
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });

    expect(result.created).toBe(true);
    expect(result.node.entityType).toBe("Person");
    expect(result.node.name).toBe("Alice");
    expect(result.node.role).toBe("eng");
    expect(result.node.meta.version).toBe(1);
  });

  it("finds existing node with onConflict: skip (default)", async () => {
    const store = createStore(graph, backend);

    // Create first
    const first = await store.nodes.Entity.findOrCreate("entity_key", {
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });
    expect(first.created).toBe(true);

    // Find existing — role should NOT change
    const second = await store.nodes.Entity.findOrCreate("entity_key", {
      entityType: "Person",
      name: "Alice",
      role: "manager",
    });

    expect(second.created).toBe(false);
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("eng"); // unchanged
    expect(second.node.meta.version).toBe(1); // no version bump
  });

  it("updates existing node with onConflict: update", async () => {
    const store = createStore(graph, backend);

    const first = await store.nodes.Entity.findOrCreate("entity_key", {
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });

    const second = await store.nodes.Entity.findOrCreate(
      "entity_key",
      { entityType: "Person", name: "Alice", role: "manager" },
      { onConflict: "update" },
    );

    expect(second.created).toBe(false);
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("manager"); // updated
    expect(second.node.meta.version).toBe(2); // version bumped
  });

  it("resurrects a soft-deleted node", async () => {
    const store = createStore(graph, backend);

    // Create and then delete
    const first = await store.nodes.Entity.findOrCreate("entity_key", {
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });
    await store.nodes.Entity.delete(first.node.id);

    // findOrCreate should resurrect the soft-deleted node
    const second = await store.nodes.Entity.findOrCreate("entity_key", {
      entityType: "Person",
      name: "Alice",
      role: "resurrected",
    });

    expect(second.created).toBe(false);
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("resurrected");
    expect(second.node.meta.deletedAt).toBeUndefined();
  });

  it("throws ConstraintNotFoundError for invalid constraint name", async () => {
    const store = createStore(graph, backend);

    await expect(
      store.nodes.Entity.findOrCreate("nonexistent_constraint", {
        entityType: "Person",
        name: "Alice",
      }),
    ).rejects.toThrow(ConstraintNotFoundError);
  });
});

// ============================================================
// bulkFindOrCreate Tests
// ============================================================

describe("store.nodes.*.bulkFindOrCreate()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("returns empty array for empty input", async () => {
    const store = createStore(graph, backend);
    const results = await store.nodes.Entity.bulkFindOrCreate(
      "entity_key",
      [],
    );
    expect(results).toEqual([]);
  });

  it("creates all new nodes", async () => {
    const store = createStore(graph, backend);
    const results = await store.nodes.Entity.bulkFindOrCreate("entity_key", [
      { props: { entityType: "Person", name: "Alice" } },
      { props: { entityType: "Person", name: "Bob" } },
      { props: { entityType: "Company", name: "Acme" } },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.node.name).toBe("Alice");
    expect(results[1]!.created).toBe(true);
    expect(results[1]!.node.name).toBe("Bob");
    expect(results[2]!.created).toBe(true);
    expect(results[2]!.node.name).toBe("Acme");
  });

  it("finds all existing nodes", async () => {
    const store = createStore(graph, backend);

    // Pre-create
    await store.nodes.Entity.create({ entityType: "Person", name: "Alice" });
    await store.nodes.Entity.create({ entityType: "Person", name: "Bob" });

    const results = await store.nodes.Entity.bulkFindOrCreate("entity_key", [
      { props: { entityType: "Person", name: "Alice" } },
      { props: { entityType: "Person", name: "Bob" } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.created).toBe(false);
    expect(results[1]!.created).toBe(false);
  });

  it("handles mixed creates and finds with correct ordering", async () => {
    const store = createStore(graph, backend);

    // Pre-create Alice
    const alice = await store.nodes.Entity.create({
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });

    const results = await store.nodes.Entity.bulkFindOrCreate("entity_key", [
      { props: { entityType: "Person", name: "Bob" } }, // new
      { props: { entityType: "Person", name: "Alice" } }, // existing
      { props: { entityType: "Company", name: "Acme" } }, // new
    ]);

    expect(results).toHaveLength(3);

    // Bob is new
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.node.name).toBe("Bob");

    // Alice is found
    expect(results[1]!.created).toBe(false);
    expect(results[1]!.node.id).toBe(alice.id);
    expect(results[1]!.node.role).toBe("eng");

    // Acme is new
    expect(results[2]!.created).toBe(true);
    expect(results[2]!.node.name).toBe("Acme");
  });

  it("bulk with onConflict: update updates existing nodes", async () => {
    const store = createStore(graph, backend);

    await store.nodes.Entity.create({
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });

    const results = await store.nodes.Entity.bulkFindOrCreate(
      "entity_key",
      [
        { props: { entityType: "Person", name: "Alice", role: "manager" } },
        { props: { entityType: "Person", name: "Bob", role: "intern" } },
      ],
      { onConflict: "update" },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.created).toBe(false);
    expect(results[0]!.node.role).toBe("manager"); // updated
    expect(results[1]!.created).toBe(true);
    expect(results[1]!.node.role).toBe("intern");
  });

  it("bulk resurrects soft-deleted nodes", async () => {
    const store = createStore(graph, backend);

    const alice = await store.nodes.Entity.create({
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });
    await store.nodes.Entity.delete(alice.id);

    const results = await store.nodes.Entity.bulkFindOrCreate("entity_key", [
      { props: { entityType: "Person", name: "Alice", role: "resurrected" } },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(false);
    expect(results[0]!.node.id).toBe(alice.id);
    expect(results[0]!.node.role).toBe("resurrected");
    expect(results[0]!.node.meta.deletedAt).toBeUndefined();
  });

  it("throws ConstraintNotFoundError for invalid constraint name", async () => {
    const store = createStore(graph, backend);

    await expect(
      store.nodes.Entity.bulkFindOrCreate("nonexistent", [
        { props: { entityType: "Person", name: "Alice" } },
      ]),
    ).rejects.toThrow(ConstraintNotFoundError);
  });
});
