/**
 * Collection API Tests
 *
 * Tests the ergonomic store.nodes and store.edges collection APIs.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeId,
  type NodeId,
} from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { createSqliteBackend } from "../src/backend/sqlite";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import { ValidationError } from "../src/errors";
import { createStore } from "../src/store";
import { requireDefined } from "../src/utils/presence";
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

  it("passes Object prototype members through StoreView collection maps", () => {
    const view = store.view({ mode: "current" });
    const nodeToString: unknown = Reflect.get(view.nodes, "toString");
    const edgeToString: unknown = Reflect.get(view.edges, "toString");

    expect(typeof nodeToString).toBe("function");
    expect(typeof edgeToString).toBe("function");
    expect((nodeToString as () => string).call(view.nodes)).toBe(
      "[object Object]",
    );
    expect((edgeToString as () => string).call(view.edges)).toBe(
      "[object Object]",
    );
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
      expect(requireDefined(fetched).name).toBe("Alice");
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
      expect(requireDefined(results[0]).name).toBe("Bob");
      expect(results[1]).toBeUndefined();
      expect(requireDefined(results[2]).name).toBe("Alice");
    });

    it("returns empty array for empty input", async () => {
      const results = await store.nodes.Person.getByIds([]);
      expect(results).toEqual([]);
    });

    it("falls back to individual getNode when backend lacks getNodes", async () => {
      const backendWithoutBatch: GraphBackend = projectBackendWithout(backend, [
        "getNodes",
      ]);
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
      expect(requireDefined(results[0]).name).toBe("Alice");
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

  describe("store.nodes.*.compareAndSet()", () => {
    it("updates only while the id and exact current-value predicate match", async () => {
      const person = await store.nodes.Person.create({
        name: "Alice",
        age: 30,
      });

      const updated = await store.nodes.Person.compareAndSet(person.id, {
        expected: { name: "Alice", age: 30 },
        patch: { age: 31 },
      });
      const staleRetry = await store.nodes.Person.compareAndSet(person.id, {
        expected: { age: 30 },
        patch: { age: 32 },
      });

      expect(updated).toBe(true);
      expect(staleRetry).toBe(false);
      expect(await store.nodes.Person.getById(person.id)).toMatchObject({
        name: "Alice",
        age: 31,
        meta: { version: 2 },
      });
    });

    it("refuses a backend without the dedicated guarded-write port", async () => {
      const unsupported = createStore(
        testGraph,
        projectBackendWithout(backend, ["compareAndSetNode"]),
      );
      const person = await unsupported.nodes.Person.create({ name: "Alice" });

      await expect(
        unsupported.nodes.Person.compareAndSet(person.id, {
          expected: { name: "Alice" },
          patch: { age: 31 },
        }),
      ).rejects.toMatchObject({
        details: { code: "COMPARE_AND_SET_UNSUPPORTED" },
      });
      expect(await unsupported.nodes.Person.getById(person.id)).toMatchObject({
        name: "Alice",
        meta: { version: 1 },
      });
    });
  });

  describe("store.nodes.*.updateWhere()", () => {
    it("ANDs property filters with independent relationship predicates", async () => {
      const acme = await store.nodes.Company.create({
        name: "Acme",
        industry: "technology",
      });
      const bank = await store.nodes.Company.create({
        name: "Bank",
        industry: "finance",
      });
      const alice = await store.nodes.Person.create({ name: "Alice", age: 35 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 35 });
      await store.edges.worksAt.create(alice, acme, { role: "engineer" });
      await store.edges.worksAt.create(alice, bank, { role: "analyst" });
      await store.edges.worksAt.create(bob, bank, { role: "engineer" });

      const result = await store.nodes.Person.updateWhere({
        patch: { age: 36 },
        where: (person) => person.age.gte(30),
        exists: [
          {
            edgeKind: "worksAt",
            direction: "out",
            relatedKind: "Company",
            whereRelated: (company) =>
              company.field("industry").string().eq("technology"),
          },
          {
            edgeKind: "worksAt",
            direction: "out",
            relatedKind: "Company",
            whereEdge: (edge) => edge.field("role").string().eq("analyst"),
          },
        ],
      });

      expect(result).toEqual({ affectedCount: 1 });
      expect(
        requireDefined(await store.nodes.Person.getById(alice.id)).age,
      ).toBe(36);
      expect(requireDefined(await store.nodes.Person.getById(bob.id)).age).toBe(
        35,
      );
    });

    it("supports a schema property named field in the typed predicate", async () => {
      const Entry = defineNode("Entry", {
        schema: z.object({ field: z.string(), selected: z.boolean() }),
      });
      const fieldGraph = defineGraph({
        id: "update_where_field_property",
        nodes: { Entry: { type: Entry } },
        edges: {},
      });
      const fieldStore = createStore(fieldGraph, createTestBackend());
      const matching = await fieldStore.nodes.Entry.create({
        field: "match",
        selected: false,
      });
      const other = await fieldStore.nodes.Entry.create({
        field: "other",
        selected: false,
      });

      const result = await fieldStore.nodes.Entry.updateWhere({
        patch: { selected: true },
        where: (entry) => entry.field.eq("match"),
      });

      expect(result).toEqual({ affectedCount: 1 });
      expect(
        requireDefined(await fieldStore.nodes.Entry.getById(matching.id))
          .selected,
      ).toBe(true);
      expect(
        requireDefined(await fieldStore.nodes.Entry.getById(other.id)).selected,
      ).toBe(false);

      await fieldStore.getNodeCollectionOrThrow("Entry").updateWhere({
        patch: { selected: true },
        where: (entry) => entry.field("field").string().eq("other"),
      });
      expect(
        requireDefined(await fieldStore.nodes.Entry.getById(other.id)).selected,
      ).toBe(true);
    });

    it("requires explicit all and removes optional properties with undefined", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice", age: 35 });
      await expect(
        store.nodes.Person.updateWhere({ patch: { age: 36 } }),
      ).rejects.toThrow("explicit all: true");

      await store.nodes.Person.updateWhere({
        patch: { age: undefined },
        all: true,
      });
      expect(
        requireDefined(await store.nodes.Person.getById(alice.id)).age,
      ).toBeUndefined();
    });

    it("rolls back every row when a complete after-image fails validation", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      await expect(
        store
          .getNodeCollectionOrThrow("Person")
          .updateWhere({ patch: { name: undefined }, all: true }),
      ).rejects.toThrow(ValidationError);

      expect(
        requireDefined(await store.nodes.Person.getById(alice.id)).name,
      ).toBe("Alice");
      expect(
        requireDefined(await store.nodes.Person.getById(bob.id)).name,
      ).toBe("Bob");
    });

    it("replaces uniqueness sidecars without leaking the old key", async () => {
      const Account = defineNode("Account", {
        schema: z.object({ email: z.email(), active: z.boolean() }),
      });
      const uniqueGraph = defineGraph({
        id: "update_where_unique",
        nodes: {
          Account: {
            type: Account,
            unique: [
              {
                name: "account_email",
                fields: ["email"],
                scope: "kind",
                collation: "binary",
              },
            ],
          },
        },
        edges: {},
      });
      const uniqueStore = createStore(uniqueGraph, createTestBackend());
      await uniqueStore.nodes.Account.create({
        email: "old@example.com",
        active: true,
      });

      await uniqueStore.nodes.Account.updateWhere({
        patch: { email: "new@example.com" },
        where: (account) => account.active.eq(true),
      });

      await expect(
        uniqueStore.nodes.Account.create({
          email: "old@example.com",
          active: false,
        }),
      ).resolves.toBeDefined();
      await expect(
        uniqueStore.nodes.Account.create({
          email: "new@example.com",
          active: false,
        }),
      ).rejects.toThrow();
    });

    it("fires one dedicated bulk hook with the affected row count", async () => {
      const starts: string[] = [];
      const counts: number[] = [];
      const hooked = createStore(testGraph, backend, {
        hooks: {
          onBulkOperationStart: (context) => starts.push(context.operation),
          onBulkOperationEnd: (_context, result) =>
            counts.push(result.affectedCount),
        },
      });
      await hooked.nodes.Person.create({ name: "Alice" });
      await hooked.nodes.Person.create({ name: "Bob" });

      await hooked.nodes.Person.updateWhere({ patch: { age: 30 }, all: true });
      const alice = requireDefined(
        await hooked.nodes.Person.find({
          where: (person) => person.name.eq("Alice"),
        }),
      )[0];
      await hooked.nodes.Person.compareAndSet(requireDefined(alice).id, {
        expected: { age: 30 },
        patch: { age: 31 },
      });

      expect(starts).toEqual(["updateWhere", "compareAndSet"]);
      expect(counts).toEqual([2, 1]);
    });
  });

  describe("store.nodes.*.delete()", () => {
    it("soft-deletes a node", async () => {
      const person = await store.nodes.Person.create({ name: "Alice" });

      await store.nodes.Person.delete(person.id);

      const fetched = await store.nodes.Person.getById(person.id);
      expect(fetched).toBeUndefined();
    });

    it("does not open an empty top-level transaction for absent non-history deletes", async () => {
      const baseBackend = backend;
      let transactionCount = 0;
      const observedBackend: GraphBackend = deriveBackend(baseBackend, {
        async transaction<T>(
          fn: (tx: TransactionBackend) => Promise<T>,
          options?: Parameters<GraphBackend["transaction"]>[1],
        ): Promise<T> {
          transactionCount++;
          return baseBackend.transaction(fn, options);
        },
      });
      const observedStore = createStore(testGraph, observedBackend);
      const missingId = "missing-person" as NodeId<typeof Person>;

      await observedStore.nodes.Person.delete(missingId);
      await observedStore.nodes.Person.hardDelete(missingId);

      expect(transactionCount).toBe(0);
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

      // Reads may run through backend.execute (Drizzle path) or the cached
      // template's executeRaw fast path; count both so "ran on the tx backend"
      // holds regardless of which path a where-filtered find() takes.
      const observedBackend: GraphBackend = deriveBackend(baseBackend, {
        async execute<T>(
          query: Parameters<GraphBackend["execute"]>[0],
        ): Promise<readonly T[]> {
          rootExecuteCount++;
          return baseBackend.execute<T>(query);
        },
        async executeRaw<T>(sqlText: string, params: readonly unknown[]) {
          rootExecuteCount++;
          return requireDefined(baseBackend.executeRaw)<T>(sqlText, params);
        },
        async transaction<T>(
          fn: (tx: TransactionBackend) => Promise<T>,
          options?: Parameters<GraphBackend["transaction"]>[1],
        ): Promise<T> {
          return baseBackend.transaction(async (txBackend) => {
            const observedTxBackend: TransactionBackend = deriveBackend(
              txBackend,
              {
                async execute<T>(
                  query: Parameters<GraphBackend["execute"]>[0],
                ): Promise<readonly T[]> {
                  txExecuteCount++;
                  return txBackend.execute<T>(query);
                },
                async executeRaw<T>(
                  sqlText: string,
                  params: readonly unknown[],
                ) {
                  txExecuteCount++;
                  return requireDefined(txBackend.executeRaw)<T>(
                    sqlText,
                    params,
                  );
                },
              },
            );
            return fn(observedTxBackend);
          }, options);
        },
      });

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
        expect(requireDefined(txResults[0]).id).toBe("tx-person");
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
        "nonexistent" as EdgeId<typeof worksAt>,
        edge1.id,
      ]);

      expect(results).toHaveLength(3);
      expect(requireDefined(results[0]).role).toBe("Consultant");
      expect(results[1]).toBeUndefined();
      expect(requireDefined(results[2]).role).toBe("Engineer");
    });

    it("returns empty array for empty input", async () => {
      const results = await store.edges.worksAt.getByIds([]);
      expect(results).toEqual([]);
    });

    it("falls back to individual getEdge when backend lacks getEdges", async () => {
      const backendWithoutBatch: GraphBackend = projectBackendWithout(backend, [
        "getEdges",
      ]);
      const localStore = createStore(testGraph, backendWithoutBatch);

      const alice = await localStore.nodes.Person.create({ name: "Alice" });
      const acme = await localStore.nodes.Company.create({ name: "Acme Inc" });

      const edge = await localStore.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      const results = await localStore.edges.worksAt.getByIds([
        edge.id,
        "missing" as EdgeId<typeof worksAt>,
      ]);

      expect(results).toHaveLength(2);
      expect(requireDefined(results[0]).role).toBe("Engineer");
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
      expect(requireDefined(edges[0]).role).toBe("Engineer");
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
      expect(requireDefined(fetched).name).toBe("Alice Reborn");
    });
  });

  describe("store.nodes.*.createFromRecord()", () => {
    it("creates a node from untyped record data", async () => {
      const data: Record<string, unknown> = { name: "Alice", age: 30 };
      const person = await store.nodes.Person.createFromRecord(data);

      expect(person.name).toBe("Alice");
      expect(person.age).toBe(30);
      expect(person.kind).toBe("Person");
      expect(person.id).toBeDefined();
    });

    it("accepts options (custom id, temporal)", async () => {
      const data: Record<string, unknown> = { name: "Bob" };
      const person = await store.nodes.Person.createFromRecord(data, {
        id: "custom-bob",
      });

      expect(person.id).toBe("custom-bob");
      expect(person.name).toBe("Bob");
    });

    it("rejects invalid data at runtime via Zod validation", async () => {
      const data: Record<string, unknown> = { age: 30 };
      await expect(store.nodes.Person.createFromRecord(data)).rejects.toThrow();
    });

    it("rejects data with wrong types at runtime", async () => {
      const data: Record<string, unknown> = { name: 42 };
      await expect(store.nodes.Person.createFromRecord(data)).rejects.toThrow();
    });
  });

  describe("store.nodes.*.upsertByIdFromRecord()", () => {
    it("creates a node when id does not exist", async () => {
      const data: Record<string, unknown> = { name: "Alice" };
      const person = await store.nodes.Person.upsertByIdFromRecord(
        "person-1",
        data,
      );

      expect(person.id).toBe("person-1");
      expect(person.name).toBe("Alice");
    });

    it("updates an existing node", async () => {
      await store.nodes.Person.createFromRecord(
        { name: "Alice" },
        { id: "person-1" },
      );

      const updated = await store.nodes.Person.upsertByIdFromRecord(
        "person-1",
        { name: "Alice Updated", age: 31 },
      );

      expect(updated.id).toBe("person-1");
      expect(updated.name).toBe("Alice Updated");
      expect(updated.age).toBe(31);
    });

    it("resurrects a soft-deleted node", async () => {
      const person = await store.nodes.Person.createFromRecord(
        { name: "Alice" },
        { id: "person-1" },
      );
      await store.nodes.Person.delete(person.id);

      const resurrected = await store.nodes.Person.upsertByIdFromRecord(
        "person-1",
        { name: "Alice Reborn" },
      );

      expect(resurrected.id).toBe("person-1");
      expect(resurrected.name).toBe("Alice Reborn");
      expect(resurrected.meta.deletedAt).toBeUndefined();
    });

    it("stores no lower bound for a lone past validTo on a resurrecting upsert", async () => {
      // A resurrection RESETS the window, so with no `validFrom` accompanying a
      // historical `validTo` there is no bound to invert against: the write
      // stamps none, and the row means "ended at T, start unknown" — the same
      // stored shape a create reaches for the same stated window.
      //
      // This case used to REFUSE, on the reasoning that the reset bound was the
      // write instant. The write no longer chooses an instant that would leave
      // the row readable at no coordinate, so there is nothing left to refuse.
      const person = await store.nodes.Person.createFromRecord(
        { name: "Windowed" },
        { id: "person-window" },
      );
      await store.nodes.Person.delete(person.id);

      const reborn = await store.nodes.Person.upsertByIdFromRecord(
        "person-window",
        { name: "Windowed Reborn" },
        { validTo: "2021-01-01T00:00:00.000Z" },
      );
      expect(reborn.meta.validFrom).toBeUndefined();
      expect(reborn.meta.validTo).toBe("2021-01-01T00:00:00.000Z");

      // Naming the full historical window still stores it verbatim. Tombstoned
      // again first: the accepted upsert above left the row LIVE, and a live
      // row's lower bound is history — only a resurrection writes one.
      await store.nodes.Person.delete(person.id);
      const resurrected = await store.nodes.Person.upsertByIdFromRecord(
        "person-window",
        { name: "Windowed Reborn" },
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
      );
      expect(resurrected.id).toBe("person-window");
      expect(resurrected.meta.validFrom).toBe("2020-01-01T00:00:00.000Z");
    });

    it("rejects invalid data at runtime via Zod validation", async () => {
      const data: Record<string, unknown> = { wrongField: true };
      await expect(
        store.nodes.Person.upsertByIdFromRecord("person-1", data),
      ).rejects.toThrow();
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
      expect(requireDefined(nodes[0]).name).toBe("Alice");
      expect(requireDefined(nodes[1]).name).toBe("Bob");
      expect(requireDefined(nodes[2]).name).toBe("Charlie");

      const count = await store.nodes.Person.count();
      expect(count).toBe(3);
    });

    it("supports custom ids in bulk create", async () => {
      const nodes = await store.nodes.Person.bulkCreate([
        { id: "person-1", props: { name: "Alice" } },
        { id: "person-2", props: { name: "Bob" } },
      ]);

      expect(requireDefined(nodes[0]).id).toBe("person-1");
      expect(requireDefined(nodes[1]).id).toBe("person-2");
    });

    it("always returns created nodes", async () => {
      const nodes = await store.nodes.Person.bulkCreate([
        { props: { name: "Alice" } },
        { props: { name: "Bob" } },
      ]);

      expect(nodes).toHaveLength(2);
      expect(requireDefined(nodes[0]).name).toBe("Alice");
      expect(requireDefined(nodes[1]).name).toBe("Bob");
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

      const backendWithCounters: GraphBackend = deriveBackend(baseBackend, {
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
      });

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
      expect(requireDefined(nodes[0]).meta.version).toBe(1);
      expect(requireDefined(nodes[1]).meta.version).toBe(1);
    });

    it("updates nodes that exist", async () => {
      await store.nodes.Person.create({ name: "Alice" }, { id: "person-1" });
      await store.nodes.Person.create({ name: "Bob" }, { id: "person-2" });

      const nodes = await store.nodes.Person.bulkUpsertById([
        { id: "person-1", props: { name: "Alice Updated" } },
        { id: "person-2", props: { name: "Bob Updated" } },
      ]);

      expect(requireDefined(nodes[0]).name).toBe("Alice Updated");
      expect(requireDefined(nodes[0]).meta.version).toBe(2);
      expect(requireDefined(nodes[1]).name).toBe("Bob Updated");
      expect(requireDefined(nodes[1]).meta.version).toBe(2);
    });

    it("handles mixed create and update", async () => {
      await store.nodes.Person.create({ name: "Alice" }, { id: "person-1" });

      const nodes = await store.nodes.Person.bulkUpsertById([
        { id: "person-1", props: { name: "Alice Updated" } },
        { id: "person-2", props: { name: "Bob New" } },
      ]);

      expect(requireDefined(nodes[0]).meta.version).toBe(2); // Updated
      expect(requireDefined(nodes[1]).meta.version).toBe(1); // Created
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
      expect(requireDefined(remaining[0]).name).toBe("Charlie");
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
      expect(requireDefined(edges[0]).role).toBe("Engineer");
      expect(requireDefined(edges[1]).role).toBe("Consultant");
      expect(requireDefined(edges[2]).role).toBe("Designer");

      const count = await store.edges.worksAt.count();
      expect(count).toBe(3);
    });

    it("supports custom ids in bulk create", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edges = await store.edges.worksAt.bulkCreate([
        { id: "edge-1", from: alice, to: acme, props: { role: "Engineer" } },
      ]);

      expect(requireDefined(edges[0]).id).toBe("edge-1");
    });

    it("always returns created edges", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });

      const edges = await store.edges.worksAt.bulkCreate([
        { from: alice, to: acme, props: { role: "Engineer" } },
      ]);

      expect(edges).toHaveLength(1);
      expect(requireDefined(edges[0]).role).toBe("Engineer");
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

      const backendWithCounters: GraphBackend = deriveBackend(baseBackend, {
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
      });

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

    it("batch-prefetches endpoint existence checks for bulkInsert edge batches", async () => {
      const baseBackend = createSqliteBackend(createTestDatabase());
      let getNodeCalls = 0;
      let getNodesCalls = 0;

      const backendWithNodeCounter: GraphBackend = deriveBackend(baseBackend, {
        async getNode(graphId, kind, id) {
          getNodeCalls += 1;
          return baseBackend.getNode(graphId, kind, id);
        },
        async getNodes(graphId, kind, ids) {
          getNodesCalls += 1;
          return requireDefined(baseBackend.getNodes)(graphId, kind, ids);
        },
        async transaction(fn, options) {
          return baseBackend.transaction(async (tx) => {
            const wrappedTx = {
              ...tx,
              async getNode(graphId: string, kind: string, id: string) {
                getNodeCalls += 1;
                return tx.getNode(graphId, kind, id);
              },
              async getNodes(
                graphId: string,
                kind: string,
                ids: readonly string[],
              ) {
                getNodesCalls += 1;
                return requireDefined(tx.getNodes)(graphId, kind, ids);
              },
            };
            return fn(wrappedTx);
          }, options);
        },
      });

      const localStore = createStore(testGraph, backendWithNodeCounter);
      const alice = await localStore.nodes.Person.create({ name: "Alice" });
      const acme = await localStore.nodes.Company.create({ name: "Acme Inc" });

      getNodeCalls = 0;
      getNodesCalls = 0;
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

      // The batch is prefetched with one getNodes() call per distinct
      // endpoint kind (Person for `from`, Company for `to`) instead of a
      // getNode() probe per edge — zero individual endpoint lookups even
      // though the batch references two distinct nodes across three edges.
      expect(getNodeCalls).toBe(0);
      expect(getNodesCalls).toBe(2);
    });
  });

  describe("store.edges.*.bulkUpsertById()", () => {
    it("creates edges that do not exist", async () => {
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Inc" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const edges = await store.edges.worksAt.bulkUpsertById([
        {
          id: "edge-1" as EdgeId<typeof worksAt>,
          from: alice,
          to: acme,
          props: { role: "Engineer" },
        },
        {
          id: "edge-2" as EdgeId<typeof worksAt>,
          from: alice,
          to: techCorp,
          props: { role: "Consultant" },
        },
      ]);

      expect(edges).toHaveLength(2);
      expect(requireDefined(edges[0]).role).toBe("Engineer");
      expect(requireDefined(edges[1]).role).toBe("Consultant");

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
          id: "edge-1" as EdgeId<typeof worksAt>,
          from: alice,
          to: acme,
          props: { role: "Senior Engineer" },
        },
      ]);

      expect(edges).toHaveLength(1);
      expect(requireDefined(edges[0]).role).toBe("Senior Engineer");
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
          id: "edge-existing" as EdgeId<typeof worksAt>,
          from: alice,
          to: acme,
          props: { role: "Lead Engineer" },
        },
        {
          id: "edge-new" as EdgeId<typeof worksAt>,
          from: alice,
          to: techCorp,
          props: { role: "Advisor" },
        },
      ]);

      expect(edges).toHaveLength(2);
      expect(requireDefined(edges[0]).role).toBe("Lead Engineer");
      expect(requireDefined(edges[1]).role).toBe("Advisor");

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
          id: "edge-del" as EdgeId<typeof worksAt>,
          from: alice,
          to: acme,
          props: { role: "Engineer Reborn" },
        },
      ]);

      expect(edges).toHaveLength(1);
      expect(requireDefined(edges[0]).role).toBe("Engineer Reborn");
      expect(requireDefined(edges[0]).meta.deletedAt).toBeUndefined();

      const fetched = await store.edges.worksAt.getById(edge.id);
      expect(fetched).toBeDefined();
      expect(requireDefined(fetched).role).toBe("Engineer Reborn");
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
      await store.edges.worksAt.bulkDelete([
        edge.id,
        "non-existent" as EdgeId<typeof worksAt>,
      ]);

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
    expect(requireDefined(fetched).name).toBe("Alice");
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
      ).rejects.toThrow(/Invalid canonical ISO 8601 datetime for "validFrom"/);
    });

    it("rejects invalid validTo format", async () => {
      await expect(
        store.nodes.Person.create({ name: "Alice" }, { validTo: "2024-01-15" }),
      ).rejects.toThrow(/Invalid canonical ISO 8601 datetime for "validTo"/);
    });

    it("rejects dates with timezone offset instead of Z", async () => {
      await expect(
        store.nodes.Person.create(
          { name: "Alice" },
          { validFrom: "2024-01-15T10:30:00+00:00" },
        ),
      ).rejects.toThrow(/Invalid canonical ISO 8601 datetime/);
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
      ).rejects.toThrow(/Invalid canonical ISO 8601 datetime for "validFrom"/);
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
      ).rejects.toThrow(/Invalid canonical ISO 8601 datetime for "validTo"/);
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
      expect(requireDefined(results[0]).name).toBe("Active");
    });

    it("excludes expired nodes from find by default", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );

      const results = await store.nodes.Person.find();

      expect(results).toHaveLength(1);
      expect(requireDefined(results[0]).name).toBe("Active");
    });

    it("includes expired nodes with temporalMode: includeEnded", async () => {
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.create(
        { name: "Expired" },
        { validFrom: PAST, validTo: PAST },
      );

      const results = await store.nodes.Person.find(undefined, {
        temporalMode: "includeEnded",
      });

      expect(results).toHaveLength(2);
    });

    it("includes deleted nodes with temporalMode: includeTombstones", async () => {
      const person = await store.nodes.Person.create({ name: "Will Delete" });
      await store.nodes.Person.create({ name: "Active" });
      await store.nodes.Person.delete(person.id);

      const results = await store.nodes.Person.find(undefined, {
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

      const results = await store.nodes.Person.find(undefined, {
        temporalMode: "asOf",
        asOf: NOW,
      });

      expect(results).toHaveLength(1);
      expect(requireDefined(results[0]).name).toBe("Current");
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

      const withoutWhere = await store.nodes.Person.find(undefined, {
        temporalMode: "includeTombstones",
      });
      expect(withoutWhere).toHaveLength(2);

      const withWhere = await store.nodes.Person.find(
        { where: (person) => person.name.startsWith("Will") },
        { temporalMode: "includeTombstones" },
      );
      expect(withWhere).toHaveLength(1);
      expect(requireDefined(withWhere[0]).name).toBe("Will Delete");
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
      expect(requireDefined(results[0]).name).toBe("Active");
    });

    it("respects asOf with where-filtered find", async () => {
      await store.nodes.Person.create(
        { name: "Early" },
        { validFrom: PAST, validTo: NOW },
      );
      await store.nodes.Person.create({ name: "Current" }, { validFrom: PAST });

      const results = await store.nodes.Person.find(
        { where: (person) => person.name.startsWith("") },
        { temporalMode: "asOf", asOf: "2020-06-01T00:00:00.000Z" },
      );

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

      const countIncludeEnded = await store.edges.worksAt.count(undefined, {
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

      const countAll = await store.edges.worksAt.count(undefined, {
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

      const count = await store.edges.worksAt.count(undefined, {
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

      const aliceCountAll = await store.edges.worksAt.count(
        { from: alice },
        { temporalMode: "includeEnded" },
      );
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
      expect(requireDefined(results[0]).role).toBe("Current");
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

      const results = await store.edges.worksAt.find(undefined, {
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

      const results = await store.edges.worksAt.find(undefined, {
        temporalMode: "asOf",
        asOf: NOW,
      });

      expect(results).toHaveLength(1);
      expect(requireDefined(results[0]).role).toBe("Current");
    });

    it("rejects non-canonical asOf timestamps across collection reads", async () => {
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { validFrom: PAST },
      );
      const company = await store.nodes.Company.create(
        { name: "Acme" },
        { validFrom: PAST },
      );
      const edge = await store.edges.worksAt.create(
        person,
        company,
        { role: "Engineer" },
        { validFrom: PAST },
      );
      const nonCanonical = "2021-01-01T00:00:00Z";
      const options = {
        temporalMode: "asOf",
        asOf: nonCanonical,
      } as const;

      await expect(
        store.nodes.Person.getById(person.id, options),
      ).rejects.toThrow(ValidationError);
      await expect(
        store.nodes.Person.find(undefined, {
          temporalMode: "asOf",
          asOf: nonCanonical,
        }),
      ).rejects.toThrow(ValidationError);
      await expect(store.nodes.Person.count(options)).rejects.toThrow(
        ValidationError,
      );
      await expect(
        store.edges.worksAt.getById(edge.id, options),
      ).rejects.toThrow(ValidationError);
      await expect(
        store.edges.worksAt.findFrom(person, options),
      ).rejects.toThrow(ValidationError);
      await expect(
        store.edges.worksAt.count(undefined, options),
      ).rejects.toThrow(ValidationError);
    });

    it("find({ where }) validates the coordinate like find(filter)", async () => {
      // A missing asOf in asOf mode must throw on BOTH paths — the where path
      // used to silently default to "now" while the non-where path threw.
      await expect(
        store.nodes.Person.find(undefined, { temporalMode: "asOf" }),
      ).rejects.toThrow(ValidationError);
      await expect(
        store.nodes.Person.find(
          { where: (person) => person.name.startsWith("A") },
          { temporalMode: "asOf" },
        ),
      ).rejects.toThrow(ValidationError);

      // A non-canonical asOf is rejected on the where path too.
      await expect(
        store.nodes.Person.find(
          { where: (person) => person.name.startsWith("A") },
          { temporalMode: "asOf", asOf: "2021-01-01T00:00:00Z" },
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("find({ where }) honors a supplied asOf the same as find(filter)", async () => {
      await store.nodes.Person.create(
        { name: "Past" },
        { validFrom: PAST, validTo: NOW },
      );
      await store.nodes.Person.create({ name: "Present" }, { validFrom: NOW });

      // In asOf mode the where path must compare against the supplied instant,
      // not the DB clock — the same as find(filter).
      const temporal = { temporalMode: "asOf", asOf: PAST } as const;
      const viaFilter = await store.nodes.Person.find(undefined, temporal);
      const viaWhere = await store.nodes.Person.find(
        { where: (person) => person.name.startsWith("P") },
        temporal,
      );
      expect(viaFilter.map((person) => person.name).toSorted()).toEqual([
        "Past",
      ]);
      expect(viaWhere.map((person) => person.name).toSorted()).toEqual([
        "Past",
      ]);
    });

    it("rejects current + asOf instead of pinning to the supplied instant", async () => {
      // Pinning an instant is only meaningful in asOf mode. current + asOf used
      // to pin on the collection path while query()/algorithms silently dropped
      // it — a split contract. Both find paths now reject it identically, matching
      // query(), subgraph, algorithms, and StoreView.
      const currentWithAsOf = { temporalMode: "current", asOf: PAST } as const;
      await expect(
        store.nodes.Person.find(undefined, currentWithAsOf),
      ).rejects.toThrow(ValidationError);
      await expect(
        store.nodes.Person.find(
          { where: (person) => person.name.startsWith("P") },
          currentWithAsOf,
        ),
      ).rejects.toThrow(ValidationError);
    });
  });
});
