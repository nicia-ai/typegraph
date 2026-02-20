/**
 * Tests for findOrCreate and bulkFindOrCreate on NodeCollection and EdgeCollection.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import {
  CardinalityError,
  ConstraintNotFoundError,
  ValidationError,
} from "../src/errors";
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
    const results = await store.nodes.Entity.bulkFindOrCreate("entity_key", []);
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

// ============================================================
// Edge findOrCreate Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    since: z.number().optional(),
  }),
});

const knows = defineEdge("knows");

const uniqueEdge = defineEdge("uniqueEdge", {
  schema: z.object({ label: z.string() }),
});

const oneActiveEdge = defineEdge("oneActiveEdge", {
  schema: z.object({ label: z.string() }),
});

const edgeGraph = defineGraph({
  id: "edge_foc_test",
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
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
    uniqueEdge: {
      type: uniqueEdge,
      from: [Person],
      to: [Company],
      cardinality: "unique",
    },
    oneActiveEdge: {
      type: oneActiveEdge,
      from: [Person],
      to: [Company],
      cardinality: "oneActive",
    },
  },
  ontology: [],
});

// ============================================================
// Edge findOrCreate Tests
// ============================================================

describe("store.edges.*.findOrCreate()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("creates edge when none exists", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const result = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "eng",
      since: 2020,
    });

    expect(result.created).toBe(true);
    expect(result.edge.role).toBe("eng");
    expect(result.edge.since).toBe(2020);
    expect(result.edge.fromId).toBe(alice.id);
    expect(result.edge.toId).toBe(acme.id);
  });

  it("finds existing with onConflict: skip (default)", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "eng",
      since: 2020,
    });
    expect(first.created).toBe(true);

    const second = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "manager",
      since: 2024,
    });

    expect(second.created).toBe(false);
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("eng"); // unchanged
  });

  it("updates existing with onConflict: update", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "eng",
      since: 2020,
    });

    const second = await store.edges.worksAt.findOrCreate(
      alice,
      acme,
      { role: "manager", since: 2024 },
      { onConflict: "update" },
    );

    expect(second.created).toBe(false);
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("manager");
    expect(second.edge.since).toBe(2024);
  });

  it("resurrects soft-deleted edge", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "eng",
      since: 2020,
    });
    await store.edges.worksAt.delete(first.edge.id);

    const second = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "resurrected",
      since: 2025,
    });

    expect(second.created).toBe(false);
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("resurrected");
    expect(second.edge.meta.deletedAt).toBeUndefined();
  });

  it("matchOn with prop fields distinguishes edges between same pair", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    // Create first edge with role "eng"
    const first = await store.edges.worksAt.findOrCreate(
      alice,
      acme,
      { role: "eng", since: 2020 },
      { matchOn: ["role"] },
    );
    expect(first.created).toBe(true);

    // Same pair but different role → should create new edge
    const second = await store.edges.worksAt.findOrCreate(
      alice,
      acme,
      { role: "manager", since: 2024 },
      { matchOn: ["role"] },
    );
    expect(second.created).toBe(true);
    expect(second.edge.id).not.toBe(first.edge.id);

    // Same pair and same role → should find existing
    const third = await store.edges.worksAt.findOrCreate(
      alice,
      acme,
      { role: "eng", since: 2025 },
      { matchOn: ["role"] },
    );
    expect(third.created).toBe(false);
    expect(third.edge.id).toBe(first.edge.id);
  });

  it("matchOn: [] (default) matches on endpoints only", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "eng",
    });
    expect(first.created).toBe(true);

    // Different props but same endpoints → should find existing
    const second = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "manager",
    });
    expect(second.created).toBe(false);
    expect(second.edge.id).toBe(first.edge.id);
  });

  it("live + deleted same match key → must choose live", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    // Create and delete first edge
    const deleted = await store.edges.worksAt.create(alice, acme, {
      role: "eng",
      since: 2020,
    });
    await store.edges.worksAt.delete(deleted.id);

    // Create a live edge for the same pair
    const live = await store.edges.worksAt.create(alice, acme, {
      role: "eng",
      since: 2022,
    });

    // findOrCreate should prefer the live edge
    const result = await store.edges.worksAt.findOrCreate(alice, acme, {
      role: "eng",
      since: 2025,
    });

    expect(result.created).toBe(false);
    expect(result.edge.id).toBe(live.id);
  });

  it("invalid matchOn field → throws error", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    await expect(
      store.edges.worksAt.findOrCreate(
        alice,
        acme,
        { role: "eng" },
        // @ts-expect-error - intentionally passing invalid field
        { matchOn: ["nonexistent"] },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("cardinality conflict on resurrect → throws if cardinality violated", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });
    const bigCo = await store.nodes.Company.create({ name: "BigCo" });

    // Create and delete an oneActive edge from alice→acme
    const oaFirst = await store.edges.oneActiveEdge.create(alice, acme, {
      label: "first",
    });
    await store.edges.oneActiveEdge.delete(oaFirst.id);

    // Create a live active edge from alice→bigCo
    await store.edges.oneActiveEdge.create(alice, bigCo, { label: "second" });

    // Trying to resurrect the deleted edge should throw because
    // there's already an active edge from alice
    await expect(
      store.edges.oneActiveEdge.findOrCreate(alice, acme, {
        label: "resurrected",
      }),
    ).rejects.toThrow(CardinalityError);
  });
});

// ============================================================
// Edge bulkFindOrCreate Tests
// ============================================================

describe("store.edges.*.bulkFindOrCreate()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("returns empty array for empty input", async () => {
    const store = createStore(edgeGraph, backend);
    const results = await store.edges.worksAt.bulkFindOrCreate([]);
    expect(results).toEqual([]);
  });

  it("creates all new edges", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const results = await store.edges.worksAt.bulkFindOrCreate([
      { from: alice, to: acme, props: { role: "eng" } },
      { from: bob, to: acme, props: { role: "manager" } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.edge.role).toBe("eng");
    expect(results[1]!.created).toBe(true);
    expect(results[1]!.edge.role).toBe("manager");
  });

  it("mixed creates and finds with correct ordering", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    // Pre-create edge for Alice
    const existing = await store.edges.worksAt.create(alice, acme, {
      role: "eng",
      since: 2020,
    });

    const results = await store.edges.worksAt.bulkFindOrCreate([
      { from: bob, to: acme, props: { role: "manager" } }, // new
      { from: alice, to: acme, props: { role: "cto" } }, // existing
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.created).toBe(true);
    expect(results[0]!.edge.role).toBe("manager");
    expect(results[1]!.created).toBe(false);
    expect(results[1]!.edge.id).toBe(existing.id);
  });

  it("within-batch duplicates (same endpoint + matchOn key)", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const results = await store.edges.worksAt.bulkFindOrCreate(
      [
        { from: alice, to: acme, props: { role: "eng", since: 2020 } },
        { from: alice, to: acme, props: { role: "eng", since: 2024 } }, // dup
      ],
      { matchOn: ["role"] },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.created).toBe(true);
    expect(results[1]!.created).toBe(false);
    expect(results[1]!.edge.id).toBe(results[0]!.edge.id);
  });

  it("onConflict: update updates existing edges", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    await store.edges.worksAt.create(alice, acme, { role: "eng", since: 2020 });

    const results = await store.edges.worksAt.bulkFindOrCreate(
      [{ from: alice, to: acme, props: { role: "manager", since: 2024 } }],
      { onConflict: "update" },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(false);
    expect(results[0]!.edge.role).toBe("manager");
    expect(results[0]!.edge.since).toBe(2024);
  });

  it("resurrects soft-deleted edge", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.create(alice, acme, {
      role: "eng",
      since: 2020,
    });
    await store.edges.worksAt.delete(first.id);

    const results = await store.edges.worksAt.bulkFindOrCreate([
      { from: alice, to: acme, props: { role: "resurrected", since: 2025 } },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.created).toBe(false);
    expect(results[0]!.edge.id).toBe(first.id);
    expect(results[0]!.edge.role).toBe("resurrected");
    expect(results[0]!.edge.meta.deletedAt).toBeUndefined();
  });

  it("duplicate inputs with onConflict: update → first creates, second updates", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const results = await store.edges.worksAt.bulkFindOrCreate(
      [
        { from: alice, to: acme, props: { role: "eng", since: 2020 } },
        { from: alice, to: acme, props: { role: "eng", since: 2024 } }, // dup
      ],
      { matchOn: ["role"], onConflict: "update" },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.created).toBe(true);
    expect(results[1]!.created).toBe(false);
    // Both reference the same edge
    expect(results[1]!.edge.id).toBe(results[0]!.edge.id);
  });
});
