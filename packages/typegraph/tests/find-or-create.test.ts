/**
 * Tests for getOrCreateBy* APIs on NodeCollection and EdgeCollection.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import {
  CardinalityError,
  NodeConstraintNotFoundError,
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
// getOrCreateByConstraint Tests
// ============================================================

describe("store.nodes.*.getOrCreateByConstraint()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("creates a node when none exists", async () => {
    const store = createStore(graph, backend);
    const result = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "eng",
      },
    );

    expect(result.action).toBe("created");
    expect(result.node.entityType).toBe("Person");
    expect(result.node.name).toBe("Alice");
    expect(result.node.role).toBe("eng");
    expect(result.node.meta.version).toBe(1);
  });

  it("finds existing node with ifExists: return (default)", async () => {
    const store = createStore(graph, backend);

    // Create first
    const first = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "eng",
      },
    );
    expect(first.action).toBe("created");

    // Find existing — role should NOT change
    const second = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "manager",
      },
    );

    expect(second.action).toBe("found");
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("eng"); // unchanged
    expect(second.node.meta.version).toBe(1); // no version bump
  });

  it("updates existing node with ifExists: update", async () => {
    const store = createStore(graph, backend);

    const first = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "eng",
      },
    );

    const second = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      { entityType: "Person", name: "Alice", role: "manager" },
      { ifExists: "update" },
    );

    expect(second.action).toBe("updated");
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("manager"); // updated
    expect(second.node.meta.version).toBe(2); // version bumped
  });

  it("resurrects a soft-deleted node", async () => {
    const store = createStore(graph, backend);

    // Create and then delete
    const first = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "eng",
      },
    );
    await store.nodes.Entity.delete(first.node.id);

    // getOrCreateByConstraint should resurrect the soft-deleted node
    const second = await store.nodes.Entity.getOrCreateByConstraint(
      "entity_key",
      {
        entityType: "Person",
        name: "Alice",
        role: "resurrected",
      },
    );

    expect(second.action).toBe("resurrected");
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.role).toBe("resurrected");
    expect(second.node.meta.deletedAt).toBeUndefined();
  });

  it("throws NodeConstraintNotFoundError for invalid constraint name", async () => {
    const store = createStore(graph, backend);

    await expect(
      store.nodes.Entity.getOrCreateByConstraint("nonexistent_constraint", {
        entityType: "Person",
        name: "Alice",
      }),
    ).rejects.toThrow(NodeConstraintNotFoundError);
  });
});

// ============================================================
// bulkGetOrCreateByConstraint Tests
// ============================================================

describe("store.nodes.*.bulkGetOrCreateByConstraint()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("returns empty array for empty input", async () => {
    const store = createStore(graph, backend);
    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [],
    );
    expect(results).toEqual([]);
  });

  it("creates all new nodes", async () => {
    const store = createStore(graph, backend);
    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [
        { props: { entityType: "Person", name: "Alice" } },
        { props: { entityType: "Person", name: "Bob" } },
        { props: { entityType: "Company", name: "Acme" } },
      ],
    );

    expect(results).toHaveLength(3);
    expect(results[0]!.action).toBe("created");
    expect(results[0]!.node.name).toBe("Alice");
    expect(results[1]!.action).toBe("created");
    expect(results[1]!.node.name).toBe("Bob");
    expect(results[2]!.action).toBe("created");
    expect(results[2]!.node.name).toBe("Acme");
  });

  it("finds all existing nodes", async () => {
    const store = createStore(graph, backend);

    // Pre-create
    await store.nodes.Entity.create({ entityType: "Person", name: "Alice" });
    await store.nodes.Entity.create({ entityType: "Person", name: "Bob" });

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [
        { props: { entityType: "Person", name: "Alice" } },
        { props: { entityType: "Person", name: "Bob" } },
      ],
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("found");
    expect(results[1]!.action).toBe("found");
  });

  it("handles mixed creates and finds with correct ordering", async () => {
    const store = createStore(graph, backend);

    // Pre-create Alice
    const alice = await store.nodes.Entity.create({
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [
        { props: { entityType: "Person", name: "Bob" } }, // new
        { props: { entityType: "Person", name: "Alice" } }, // existing
        { props: { entityType: "Company", name: "Acme" } }, // new
      ],
    );

    expect(results).toHaveLength(3);

    // Bob is new
    expect(results[0]!.action).toBe("created");
    expect(results[0]!.node.name).toBe("Bob");

    // Alice is found
    expect(results[1]!.action).toBe("found");
    expect(results[1]!.node.id).toBe(alice.id);
    expect(results[1]!.node.role).toBe("eng");

    // Acme is new
    expect(results[2]!.action).toBe("created");
    expect(results[2]!.node.name).toBe("Acme");
  });

  it("bulk with ifExists: update updates existing nodes", async () => {
    const store = createStore(graph, backend);

    await store.nodes.Entity.create({
      entityType: "Person",
      name: "Alice",
      role: "eng",
    });

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [
        { props: { entityType: "Person", name: "Alice", role: "manager" } },
        { props: { entityType: "Person", name: "Bob", role: "intern" } },
      ],
      { ifExists: "update" },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("updated");
    expect(results[0]!.node.role).toBe("manager"); // updated
    expect(results[1]!.action).toBe("created");
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

    const results = await store.nodes.Entity.bulkGetOrCreateByConstraint(
      "entity_key",
      [{ props: { entityType: "Person", name: "Alice", role: "resurrected" } }],
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("resurrected");
    expect(results[0]!.node.id).toBe(alice.id);
    expect(results[0]!.node.role).toBe("resurrected");
    expect(results[0]!.node.meta.deletedAt).toBeUndefined();
  });

  it("throws NodeConstraintNotFoundError for invalid constraint name", async () => {
    const store = createStore(graph, backend);

    await expect(
      store.nodes.Entity.bulkGetOrCreateByConstraint("nonexistent", [
        { props: { entityType: "Person", name: "Alice" } },
      ]),
    ).rejects.toThrow(NodeConstraintNotFoundError);
  });
});

// ============================================================
// Edge getOrCreateByEndpoints Test Schema
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
// Edge getOrCreateByEndpoints Tests
// ============================================================

describe("store.edges.*.getOrCreateByEndpoints()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("creates edge when none exists", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const result = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2020,
      },
    );

    expect(result.action).toBe("created");
    expect(result.edge.role).toBe("eng");
    expect(result.edge.since).toBe(2020);
    expect(result.edge.fromId).toBe(alice.id);
    expect(result.edge.toId).toBe(acme.id);
  });

  it("finds existing with ifExists: return (default)", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2020,
      },
    );
    expect(first.action).toBe("created");

    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "manager",
        since: 2024,
      },
    );

    expect(second.action).toBe("found");
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("eng"); // unchanged
  });

  it("updates existing with ifExists: update", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2020,
      },
    );

    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      { role: "manager", since: 2024 },
      { ifExists: "update" },
    );

    expect(second.action).toBe("updated");
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("manager");
    expect(second.edge.since).toBe(2024);
  });

  it("resurrects soft-deleted edge", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2020,
      },
    );
    await store.edges.worksAt.delete(first.edge.id);

    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "resurrected",
        since: 2025,
      },
    );

    expect(second.action).toBe("resurrected");
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.role).toBe("resurrected");
    expect(second.edge.meta.deletedAt).toBeUndefined();
  });

  it("matchOn with prop fields distinguishes edges between same pair", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    // Create first edge with role "eng"
    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      { role: "eng", since: 2020 },
      { matchOn: ["role"] },
    );
    expect(first.action).toBe("created");

    // Same pair but different role → should create new edge
    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      { role: "manager", since: 2024 },
      { matchOn: ["role"] },
    );
    expect(second.action).toBe("created");
    expect(second.edge.id).not.toBe(first.edge.id);

    // Same pair and same role → should find existing
    const third = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      { role: "eng", since: 2025 },
      { matchOn: ["role"] },
    );
    expect(third.action).toBe("found");
    expect(third.edge.id).toBe(first.edge.id);
  });

  it("matchOn: [] (default) matches on endpoints only", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const first = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
      },
    );
    expect(first.action).toBe("created");

    // Different props but same endpoints → should find existing
    const second = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "manager",
      },
    );
    expect(second.action).toBe("found");
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

    // getOrCreateByEndpoints should prefer the live edge
    const result = await store.edges.worksAt.getOrCreateByEndpoints(
      alice,
      acme,
      {
        role: "eng",
        since: 2025,
      },
    );

    expect(result.action).toBe("found");
    expect(result.edge.id).toBe(live.id);
  });

  it("invalid matchOn field → throws error", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    await expect(
      store.edges.worksAt.getOrCreateByEndpoints(
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
      store.edges.oneActiveEdge.getOrCreateByEndpoints(alice, acme, {
        label: "resurrected",
      }),
    ).rejects.toThrow(CardinalityError);
  });
});

// ============================================================
// Edge bulkGetOrCreateByEndpoints Tests
// ============================================================

describe("store.edges.*.bulkGetOrCreateByEndpoints()", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("returns empty array for empty input", async () => {
    const store = createStore(edgeGraph, backend);
    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([]);
    expect(results).toEqual([]);
  });

  it("creates all new edges", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
      { from: alice, to: acme, props: { role: "eng" } },
      { from: bob, to: acme, props: { role: "manager" } },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("created");
    expect(results[0]!.edge.role).toBe("eng");
    expect(results[1]!.action).toBe("created");
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

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
      { from: bob, to: acme, props: { role: "manager" } }, // new
      { from: alice, to: acme, props: { role: "cto" } }, // existing
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("created");
    expect(results[0]!.edge.role).toBe("manager");
    expect(results[1]!.action).toBe("found");
    expect(results[1]!.edge.id).toBe(existing.id);
  });

  it("within-batch duplicates (same endpoint + matchOn key)", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints(
      [
        { from: alice, to: acme, props: { role: "eng", since: 2020 } },
        { from: alice, to: acme, props: { role: "eng", since: 2024 } }, // dup
      ],
      { matchOn: ["role"] },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("created");
    expect(results[1]!.action).toBe("found");
    expect(results[1]!.edge.id).toBe(results[0]!.edge.id);
  });

  it("ifExists: update updates existing edges", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    await store.edges.worksAt.create(alice, acme, { role: "eng", since: 2020 });

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints(
      [{ from: alice, to: acme, props: { role: "manager", since: 2024 } }],
      { ifExists: "update" },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("updated");
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

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
      { from: alice, to: acme, props: { role: "resurrected", since: 2025 } },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("resurrected");
    expect(results[0]!.edge.id).toBe(first.id);
    expect(results[0]!.edge.role).toBe("resurrected");
    expect(results[0]!.edge.meta.deletedAt).toBeUndefined();
  });

  it("duplicate inputs with ifExists: update → first creates, second updates", async () => {
    const store = createStore(edgeGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({ name: "Acme" });

    const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints(
      [
        { from: alice, to: acme, props: { role: "eng", since: 2020 } },
        { from: alice, to: acme, props: { role: "eng", since: 2024 } }, // dup
      ],
      { matchOn: ["role"], ifExists: "update" },
    );

    expect(results).toHaveLength(2);
    expect(results[0]!.action).toBe("created");
    expect(results[1]!.action).toBe("found");
    // Both reference the same edge
    expect(results[1]!.edge.id).toBe(results[0]!.edge.id);
  });
});
