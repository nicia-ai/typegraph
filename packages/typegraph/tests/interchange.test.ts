/**
 * Interchange Tests
 *
 * Tests that graphs can be exported and imported while preserving data integrity.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import {
  exportGraph,
  type GraphData,
  importGraph,
  ImportOptionsSchema,
} from "../src/interchange";
import { createStore } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
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
    startYear: z.number().int().optional(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

const testGraph = defineGraph({
  id: "interchange_test",
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
  },
});

type TestStore = ReturnType<typeof createStore<typeof testGraph>>;

/**
 * Helper to create import options with defaults applied.
 */
function importOptions(
  overrides: Partial<z.input<typeof ImportOptionsSchema>>,
) {
  return ImportOptionsSchema.parse(overrides);
}

// ============================================================
// Round-Trip Tests
// ============================================================

describe("Interchange Round-Trip", () => {
  let sourceBackend: GraphBackend;
  let sourceStore: TestStore;

  beforeEach(() => {
    sourceBackend = createTestBackend();
    sourceStore = createStore(testGraph, sourceBackend);
  });

  it("exports and imports an empty graph", async () => {
    const exported = await exportGraph(sourceStore);

    expect(exported.nodes).toHaveLength(0);
    expect(exported.edges).toHaveLength(0);
    expect(exported.formatVersion).toBe("1.0");
    expect(exported.source.type).toBe("typegraph-export");

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(0);
    expect(result.edges.created).toBe(0);
  });

  it("preserves nodes after round-trip", async () => {
    const alice = await sourceStore.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
      age: 30,
    });
    const bob = await sourceStore.nodes.Person.create({
      name: "Bob",
      age: 25,
    });
    const acme = await sourceStore.nodes.Company.create({
      name: "Acme Corp",
      industry: "Technology",
    });

    const exported = await exportGraph(sourceStore);

    expect(exported.nodes).toHaveLength(3);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(3);

    const importedAlice = await targetStore.nodes.Person.getById(alice.id);
    const importedBob = await targetStore.nodes.Person.getById(bob.id);
    const importedAcme = await targetStore.nodes.Company.getById(acme.id);

    expect(importedAlice).toBeDefined();
    expect(importedAlice?.name).toBe("Alice");
    expect(importedAlice?.email).toBe("alice@example.com");
    expect(importedAlice?.age).toBe(30);

    expect(importedBob).toBeDefined();
    expect(importedBob?.name).toBe("Bob");
    expect(importedBob?.age).toBe(25);
    expect(importedBob?.email).toBeUndefined();

    expect(importedAcme).toBeDefined();
    expect(importedAcme?.name).toBe("Acme Corp");
    expect(importedAcme?.industry).toBe("Technology");
  });

  it("preserves edges after round-trip", async () => {
    const alice = await sourceStore.nodes.Person.create({ name: "Alice" });
    const bob = await sourceStore.nodes.Person.create({ name: "Bob" });
    const acme = await sourceStore.nodes.Company.create({ name: "Acme Corp" });

    const aliceWorksAt = await sourceStore.edges.worksAt.create(alice, acme, {
      role: "Engineer",
      startYear: 2020,
    });
    const bobWorksAt = await sourceStore.edges.worksAt.create(bob, acme, {
      role: "Manager",
    });
    const aliceKnowsBob = await sourceStore.edges.knows.create(alice, bob, {
      since: "2019",
    });

    const exported = await exportGraph(sourceStore);

    expect(exported.nodes).toHaveLength(3);
    expect(exported.edges).toHaveLength(3);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(true);
    expect(result.edges.created).toBe(3);

    const importedAliceWorksAt = await targetStore.edges.worksAt.getById(
      aliceWorksAt.id,
    );
    const importedBobWorksAt = await targetStore.edges.worksAt.getById(
      bobWorksAt.id,
    );
    const importedAliceKnowsBob = await targetStore.edges.knows.getById(
      aliceKnowsBob.id,
    );

    expect(importedAliceWorksAt).toBeDefined();
    expect(importedAliceWorksAt?.role).toBe("Engineer");
    expect(importedAliceWorksAt?.startYear).toBe(2020);
    expect(importedAliceWorksAt?.fromId).toBe(alice.id);
    expect(importedAliceWorksAt?.toId).toBe(acme.id);

    expect(importedBobWorksAt).toBeDefined();
    expect(importedBobWorksAt?.role).toBe("Manager");
    expect(importedBobWorksAt?.startYear).toBeUndefined();

    expect(importedAliceKnowsBob).toBeDefined();
    expect(importedAliceKnowsBob?.since).toBe("2019");
    expect(importedAliceKnowsBob?.fromId).toBe(alice.id);
    expect(importedAliceKnowsBob?.toId).toBe(bob.id);
  });

  it("preserves node IDs exactly", async () => {
    const customId = "my-custom-uuid-12345";
    await sourceStore.nodes.Person.create(
      { name: "Custom ID" },
      { id: customId },
    );

    const exported = await exportGraph(sourceStore);
    const exportedNode = exported.nodes.find((n) => n.id === customId);
    expect(exportedNode).toBeDefined();

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    const imported = await targetStore.nodes.Person.getById(customId as never);
    expect(imported).toBeDefined();
    expect(imported?.id).toBe(customId);
  });
});

// ============================================================
// Export Options Tests
// ============================================================

describe("Export Options", () => {
  let backend: GraphBackend;
  let store: TestStore;

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);

    await store.nodes.Person.create({ name: "Alice" });
    await store.nodes.Person.create({ name: "Bob" });
    await store.nodes.Company.create({ name: "Acme Corp" });
  });

  it("filters by nodeKinds", async () => {
    const exported = await exportGraph(store, {
      nodeKinds: ["Person"],
    });

    expect(exported.nodes).toHaveLength(2);
    expect(exported.nodes.every((n) => n.kind === "Person")).toBe(true);
  });

  it("filters by edgeKinds", async () => {
    const people = await store.nodes.Person.find();
    const companies = await store.nodes.Company.find();

    const alice = people[0]!;
    const bob = people[1]!;
    const acme = companies[0]!;

    await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
    await store.edges.knows.create(alice, bob, {});

    const exported = await exportGraph(store, {
      edgeKinds: ["worksAt"],
    });

    expect(exported.edges).toHaveLength(1);
    expect(exported.edges[0]?.kind).toBe("worksAt");
  });

  it("includes metadata when includeMeta is true", async () => {
    const exported = await exportGraph(store, {
      includeMeta: true,
    });

    for (const node of exported.nodes) {
      expect(node.meta).toBeDefined();
      expect(node.meta?.version).toBeDefined();
      expect(node.meta?.createdAt).toBeDefined();
    }
  });

  it("excludes metadata by default", async () => {
    const exported = await exportGraph(store);

    for (const node of exported.nodes) {
      expect(node.meta).toBeUndefined();
    }
  });
});

// ============================================================
// Import Conflict Strategy Tests
// ============================================================

describe("Import Conflict Strategies", () => {
  let sourceBackend: GraphBackend;
  let sourceStore: TestStore;
  let exported: GraphData;

  beforeEach(async () => {
    sourceBackend = createTestBackend();
    sourceStore = createStore(testGraph, sourceBackend);

    await sourceStore.nodes.Person.create(
      { name: "Alice", age: 30 },
      { id: "person-1" },
    );

    exported = await exportGraph(sourceStore);
  });

  it("skips existing nodes with onConflict: skip", async () => {
    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await targetStore.nodes.Person.create(
      { name: "Original Alice", age: 25 },
      { id: "person-1" },
    );

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "skip" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.skipped).toBe(1);
    expect(result.nodes.created).toBe(0);

    const alice = await targetStore.nodes.Person.getById("person-1" as never);
    expect(alice?.name).toBe("Original Alice");
    expect(alice?.age).toBe(25);
  });

  it("updates existing nodes with onConflict: update", async () => {
    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await targetStore.nodes.Person.create(
      { name: "Original Alice", age: 25 },
      { id: "person-1" },
    );

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "update" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.updated).toBe(1);
    expect(result.nodes.created).toBe(0);

    const alice = await targetStore.nodes.Person.getById("person-1" as never);
    expect(alice?.name).toBe("Alice");
    expect(alice?.age).toBe(30);
  });

  it("errors on conflict with onConflict: error", async () => {
    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await targetStore.nodes.Person.create(
      { name: "Original Alice" },
      { id: "person-1" },
    );

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.entityType).toBe("node");
    expect(result.errors[0]?.id).toBe("person-1");
  });
});

// ============================================================
// Data Integrity Tests
// ============================================================

describe("Data Integrity", () => {
  it("preserves all property types correctly", async () => {
    const sourceBackend = createTestBackend();
    const sourceStore = createStore(testGraph, sourceBackend);

    const person = await sourceStore.nodes.Person.create({
      name: "Test Person",
      email: "test@example.com",
      age: 42,
    });

    const exported = await exportGraph(sourceStore);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    const imported = await targetStore.nodes.Person.getById(person.id);

    expect(imported).toBeDefined();
    expect(imported?.name).toBe("Test Person");
    expect(imported?.email).toBe("test@example.com");
    expect(imported?.age).toBe(42);
    expect(typeof imported?.age).toBe("number");
  });

  it("handles optional properties correctly", async () => {
    const sourceBackend = createTestBackend();
    const sourceStore = createStore(testGraph, sourceBackend);

    const minimal = await sourceStore.nodes.Person.create({
      name: "Minimal Person",
    });
    const full = await sourceStore.nodes.Person.create({
      name: "Full Person",
      email: "full@example.com",
      age: 35,
    });

    const exported = await exportGraph(sourceStore);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error" }),
    );

    const importedMinimal = await targetStore.nodes.Person.getById(minimal.id);
    const importedFull = await targetStore.nodes.Person.getById(full.id);

    expect(importedMinimal?.email).toBeUndefined();
    expect(importedMinimal?.age).toBeUndefined();
    expect(importedFull?.email).toBe("full@example.com");
    expect(importedFull?.age).toBe(35);
  });

  it("maintains referential integrity for edges", async () => {
    const sourceBackend = createTestBackend();
    const sourceStore = createStore(testGraph, sourceBackend);

    const alice = await sourceStore.nodes.Person.create({ name: "Alice" });
    const bob = await sourceStore.nodes.Person.create({ name: "Bob" });
    const edge = await sourceStore.edges.knows.create(alice, bob, {
      since: "2020",
    });

    const exported = await exportGraph(sourceStore);

    const targetBackend = createTestBackend();
    const targetStore = createStore(testGraph, targetBackend);

    const result = await importGraph(
      targetStore,
      exported,
      importOptions({ onConflict: "error", validateReferences: true }),
    );

    expect(result.success).toBe(true);

    const importedEdge = await targetStore.edges.knows.getById(edge.id);
    const importedAlice = await targetStore.nodes.Person.getById(alice.id);
    const importedBob = await targetStore.nodes.Person.getById(bob.id);

    expect(importedEdge).toBeDefined();
    expect(importedEdge?.since).toBe("2020");
    expect(importedEdge?.fromId).toBe(importedAlice?.id);
    expect(importedEdge?.toId).toBe(importedBob?.id);
  });
});

// ============================================================
// Multiple Round-Trip Tests
// ============================================================

describe("Multiple Round-Trips", () => {
  it("data remains stable through multiple export/import cycles", async () => {
    const backend1 = createTestBackend();
    const store1 = createStore(testGraph, backend1);

    const alice = await store1.nodes.Person.create(
      { name: "Alice", email: "alice@test.com", age: 30 },
      { id: "alice-id" },
    );
    const bob = await store1.nodes.Person.create(
      { name: "Bob", age: 25 },
      { id: "bob-id" },
    );
    const acme = await store1.nodes.Company.create(
      { name: "Acme", industry: "Tech" },
      { id: "acme-id" },
    );

    await store1.edges.worksAt.create(alice, acme, {
      role: "Engineer",
      startYear: 2020,
    });
    await store1.edges.knows.create(alice, bob, { since: "2019" });

    let exported = await exportGraph(store1);

    for (let index = 0; index < 3; index++) {
      const nextBackend = createTestBackend();
      const nextStore = createStore(testGraph, nextBackend);

      const result = await importGraph(
        nextStore,
        exported,
        importOptions({ onConflict: "error" }),
      );

      expect(result.success).toBe(true);
      expect(result.nodes.created).toBe(3);
      expect(result.edges.created).toBe(2);

      exported = await exportGraph(nextStore);
    }

    expect(exported.nodes).toHaveLength(3);
    expect(exported.edges).toHaveLength(2);

    const aliceNode = exported.nodes.find((n) => n.id === "alice-id");
    expect(aliceNode?.properties).toEqual({
      name: "Alice",
      email: "alice@test.com",
      age: 30,
    });

    const bobNode = exported.nodes.find((n) => n.id === "bob-id");
    expect(bobNode?.properties).toEqual({
      name: "Bob",
      age: 25,
    });
  });
});
