/**
 * Interchange Tests
 *
 * Tests that graphs can be exported and imported while preserving data integrity.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import { UniquenessError } from "../src/errors";
import {
  exportGraph,
  type GraphData,
  importGraph,
  ImportOptionsSchema,
  InterchangeEdgeSchema,
  InterchangeNodeSchema,
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

describe("Canonical validity-window validation", () => {
  it("rejects non-canonical validFrom / validTo on the interchange schemas", () => {
    const nodeBase = {
      kind: "Person",
      id: "p1",
      properties: { name: "Alice" },
    };
    // Missing milliseconds, zoned offset, and date-only all parse under the
    // lenient z.iso.datetime() but are not canonical fixed-width UTC, so they
    // would mis-sort as text against the asOf read coordinate. Import must
    // reject them, matching create/update — not persist a non-canonical row.
    for (const validFrom of [
      "2024-01-15T10:30:00Z",
      "2024-01-15T10:30:00+02:00",
      "2024-01-15",
    ]) {
      expect(
        InterchangeNodeSchema.safeParse({ ...nodeBase, validFrom }).success,
      ).toBe(false);
    }

    expect(
      InterchangeEdgeSchema.safeParse({
        kind: "knows",
        id: "e1",
        from: { kind: "Person", id: "p1" },
        to: { kind: "Person", id: "p2" },
        properties: {},
        // ".1Z" (= .100) sorts AFTER ".101Z" as text — the canonical contract
        // rejects variable-width milliseconds.
        validTo: "2024-01-15T10:30:00.1Z",
      }).success,
    ).toBe(false);
  });

  it("accepts canonical fixed-width UTC validFrom / validTo", () => {
    expect(
      InterchangeNodeSchema.safeParse({
        kind: "Person",
        id: "p1",
        properties: { name: "Alice" },
        validFrom: "2024-01-15T10:30:00.000Z",
        validTo: "2025-01-15T10:30:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-canonical validFrom at the import write seam (schema bypassed)", async () => {
    // importGraph accepts a pre-typed GraphData without re-parsing, so a caller
    // that casts a hand-built object bypasses the schema. The write seam must
    // still reject a non-canonical validFrom — recorded as a per-row error, not
    // persisted as a row the asOf coordinate would later mis-compare.
    const sourceStore = createStore(testGraph, createTestBackend());
    await sourceStore.nodes.Person.create(
      { name: "Alice" },
      { id: "person-1" },
    );
    const exported = await exportGraph(sourceStore);
    const corrupted: GraphData = {
      ...exported,
      nodes: exported.nodes.map((node) =>
        node.id === "person-1" ?
          { ...node, validFrom: "2024-01-15T10:30:00Z" } // missing milliseconds
        : node,
      ),
    };

    const targetStore = createStore(testGraph, createTestBackend());
    const result = await importGraph(
      targetStore,
      corrupted,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.entityType).toBe("node");
    expect(result.errors[0]?.id).toBe("person-1");
    expect(result.errors[0]?.error).toMatch(/canonical ISO 8601/);
    // The malformed row was not written.
    expect(
      await targetStore.nodes.Person.getById("person-1" as never),
    ).toBeUndefined();
  });
});

// ============================================================
// Import Integrity (uniqueness side-table maintenance)
// ============================================================

const UniquePerson = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
  }),
});

const uniqueGraph = defineGraph({
  id: "interchange_unique_test",
  nodes: {
    Person: {
      type: UniquePerson,
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
  edges: {},
});

const TwoUniquePerson = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    username: z.string(),
  }),
});

// Two independent unique constraints; `email` is declared first so a per-
// constraint update would mutate its sidecar before reaching the conflicting
// `username`.
const twoUniqueGraph = defineGraph({
  id: "interchange_two_unique_test",
  nodes: {
    Person: {
      type: TwoUniquePerson,
      unique: [
        {
          name: "email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
        {
          name: "username",
          fields: ["username"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

describe("Interchange import integrity", () => {
  it("writes uniqueness entries so a later create detects the conflict", async () => {
    const source = createStore(uniqueGraph, createTestBackend());
    await source.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });
    const exported = await exportGraph(source);

    const target = createStore(uniqueGraph, createTestBackend());
    const result = await importGraph(
      target,
      exported,
      importOptions({ onConflict: "error" }),
    );
    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(1);

    // The imported node's uniqueness entry must exist, so creating another
    // Person with the same email is rejected. Before the write-pipeline
    // migration, import skipped the side-table write and this create would
    // have succeeded — a silent duplicate the store believes is impossible.
    await expect(
      target.nodes.Person.create({
        name: "Alice II",
        email: "alice@example.com",
      }),
    ).rejects.toThrow(UniquenessError);
  });

  it("rejects a duplicate unique value within a single import", async () => {
    const source = createStore(uniqueGraph, createTestBackend());
    await source.nodes.Person.create({ name: "A", email: "a@example.com" });
    await source.nodes.Person.create({ name: "B", email: "b@example.com" });
    const exported = await exportGraph(source);

    // Force both exported people to share an email — a duplicate the store's
    // uniqueness constraint forbids. The second import row must fail its
    // uniqueness check (against the first row's just-written entry) rather than
    // import cleanly.
    const duplicated: GraphData = {
      ...exported,
      nodes: exported.nodes.map((node) => ({
        ...node,
        properties: { ...node.properties, email: "same@example.com" },
      })),
    };

    const target = createStore(uniqueGraph, createTestBackend());
    const result = await importGraph(
      target,
      duplicated,
      importOptions({ onConflict: "error" }),
    );

    expect(result.success).toBe(false);
    expect(result.nodes.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.entityType).toBe("node");
  });

  it("a failed unique update preserves the old key (onConflict: update)", async () => {
    // Source doc: person-a now carries b@example.com — the conflicting update.
    const source = createStore(uniqueGraph, createTestBackend());
    await source.nodes.Person.create(
      { name: "A", email: "b@example.com" },
      { id: "person-a" },
    );
    const document = await exportGraph(source);

    // Target: person-a reserves a@example.com, person-b reserves b@example.com.
    const target = createStore(uniqueGraph, createTestBackend());
    await target.nodes.Person.create(
      { name: "A", email: "a@example.com" },
      { id: "person-a" },
    );
    await target.nodes.Person.create(
      { name: "B", email: "b@example.com" },
      { id: "person-b" },
    );

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "update" }),
    );

    // Updating person-a to b@example.com conflicts with person-b — reported as a
    // per-row error, not applied.
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // person-a must STILL reserve a@example.com. Before the fix,
    // updateUniquenessEntries deleted the old key before the conflict check and
    // the import swallowed the throw, so this create wrongly succeeded — a
    // silent loss of person-a's uniqueness reservation.
    await expect(
      target.nodes.Person.create({ name: "C", email: "a@example.com" }),
    ).rejects.toThrow(UniquenessError);
  });

  it("preflights all unique constraints before mutating any sidecar (onConflict: update)", async () => {
    // Source doc updates person-a to email c@example.com (free) AND username
    // "buser" (held by person-b) — the first constraint would change cleanly, the
    // second conflicts.
    const source = createStore(twoUniqueGraph, createTestBackend());
    await source.nodes.Person.create(
      { name: "A", email: "c@example.com", username: "buser" },
      { id: "person-a" },
    );
    const document = await exportGraph(source);

    const target = createStore(twoUniqueGraph, createTestBackend());
    await target.nodes.Person.create(
      { name: "A", email: "a@example.com", username: "auser" },
      { id: "person-a" },
    );
    await target.nodes.Person.create(
      { name: "B", email: "b@example.com", username: "buser" },
      { id: "person-b" },
    );

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "update" }),
    );

    // The username conflict is reported per-row; nothing is applied.
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // The EARLIER (email) constraint must not have been touched. Before the
    // two-phase preflight, updateUniquenessEntries mutated email's sidecar before
    // reaching the conflicting username, so both of these went wrong:
    //   - person-a's old email key was released (this create wrongly succeeded);
    await expect(
      target.nodes.Person.create({
        name: "C",
        email: "a@example.com",
        username: "cuser",
      }),
    ).rejects.toThrow(UniquenessError);
    //   - and c@example.com was wrongly reserved for person-a (this failed).
    const created = await target.nodes.Person.create({
      name: "D",
      email: "c@example.com",
      username: "duser",
    });
    expect(created.email).toBe("c@example.com");
  });

  it("never creates a live edge pointing at a tombstoned batch node", async () => {
    // Target: person-a exists but is soft-deleted.
    const target = createStore(testGraph, createTestBackend());
    await target.nodes.Person.create({ name: "A" }, { id: "person-a" });
    await target.nodes.Person.delete("person-a" as never);

    // Document: person-a (will be tombstone-skipped), person-b (created),
    // and an edge person-a -> person-b.
    const source = createStore(testGraph, createTestBackend());
    const personA = await source.nodes.Person.create(
      { name: "A" },
      { id: "person-a" },
    );
    const personB = await source.nodes.Person.create(
      { name: "B" },
      { id: "person-b" },
    );
    await source.edges.knows.create(personA, personB, {}, { id: "knows-ab" });
    const document = await exportGraph(source);

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "update" }),
    );

    // The tombstone skip must NOT count person-a as an available edge
    // endpoint: the edge is rejected per-row instead of silently violating
    // the endpoint-liveness invariant the collection API enforces.
    expect(result.nodes.skipped).toBe(1);
    expect(result.nodes.created).toBe(1);
    expect(result.edges.created).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ entityType: "edge" });
    await expect(
      target.edges.knows.getById("knows-ab" as never),
    ).resolves.toBeUndefined();
  });

  it("rejects edges referencing tombstoned nodes outside the batch", async () => {
    // Target: person-a exists only as a tombstone and is NOT in the import
    // document, so the reference check falls back to the database — which
    // must require a LIVE row.
    const target = createStore(testGraph, createTestBackend());
    await target.nodes.Person.create({ name: "A" }, { id: "person-a" });
    await target.nodes.Person.delete("person-a" as never);

    const source = createStore(testGraph, createTestBackend());
    const personB = await source.nodes.Person.create(
      { name: "B" },
      { id: "person-b" },
    );
    const document = await exportGraph(source);
    const withEdge: GraphData = {
      ...document,
      edges: [
        {
          kind: "knows",
          id: "knows-ab",
          from: { kind: "Person", id: "person-a" },
          to: { kind: "Person", id: personB.id },
          properties: {},
        },
      ],
    };

    const result = await importGraph(
      target,
      withEdge,
      importOptions({ onConflict: "error" }),
    );

    expect(result.edges.created).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors[0]?.error).toContain("From node not found");
  });

  it("skips tombstoned nodes without touching their sidecars (onConflict: update)", async () => {
    // Source doc: person-a with a new email.
    const source = createStore(uniqueGraph, createTestBackend());
    await source.nodes.Person.create(
      { name: "A", email: "new@example.com" },
      { id: "person-a" },
    );
    const document = await exportGraph(source);

    // Target: person-a existed, then was soft-deleted — the delete removed
    // its uniqueness entry (and any embedding/fulltext rows).
    const target = createStore(uniqueGraph, createTestBackend());
    await target.nodes.Person.create(
      { name: "A", email: "old@example.com" },
      { id: "person-a" },
    );
    await target.nodes.Person.delete("person-a" as never);

    const result = await importGraph(
      target,
      document,
      importOptions({ onConflict: "update" }),
    );

    // Import never resurrects a tombstone: the row is skipped, stays
    // tombstoned, and no uniqueness reservation is made for it — a live
    // create of the same value has to succeed.
    expect(result.success).toBe(true);
    expect(result.nodes.updated).toBe(0);
    expect(result.nodes.skipped).toBe(1);
    await expect(
      target.nodes.Person.getById("person-a" as never),
    ).resolves.toBeUndefined();
    const created = await target.nodes.Person.create({
      name: "C",
      email: "new@example.com",
    });
    expect(created.email).toBe("new@example.com");
  });
});

// ============================================================
// Import Property Fidelity (onUnknownProperty: "allow")
// ============================================================

const TransformDocument = defineNode("Doc", {
  schema: z.object({
    title: z.string().transform((value) => value.trim()),
    status: z.string().default("draft"),
  }),
});

const transformGraph = defineGraph({
  id: "interchange_transform_test",
  nodes: { Doc: { type: TransformDocument } },
  edges: {},
});

describe("Interchange import property fidelity", () => {
  it("preserves properties verbatim under onUnknownProperty: allow", async () => {
    const store = createStore(transformGraph, createTestBackend());
    const data: GraphData = {
      formatVersion: "1.0",
      exportedAt: "2024-01-01T00:00:00.000Z",
      source: { type: "external" },
      nodes: [
        {
          kind: "Doc",
          id: "d1",
          properties: { title: "  hello  ", extra: "keepme" },
        },
      ],
      edges: [],
    };

    const result = await importGraph(
      store,
      data,
      importOptions({ onConflict: "error", onUnknownProperty: "allow" }),
    );
    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(1);

    // "allow" is the fidelity-preserving strategy: the schema validates the
    // known fields, but the given properties are persisted byte-for-byte —
    // no transform re-application, no default injection — so an
    // export→import round trip cannot mutate stored values (a re-applied
    // non-idempotent transform would corrupt them). Use "strip" for a
    // normalizing import.
    const document = await store.nodes.Doc.getById("d1" as never);
    expect(document?.title).toBe("  hello  ");
    expect((document as unknown as { status?: string }).status).toBeUndefined();
    expect((document as unknown as { extra?: string }).extra).toBe("keepme");
  });
});
