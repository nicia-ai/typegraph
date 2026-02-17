/**
 * Query Execution Integration Tests
 *
 * Tests the full query pipeline: builder → AST → SQL → execution → results.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  count,
  defineEdge,
  defineGraph,
  defineNode,
  exists,
  fieldRef,
  inSubquery,
  inverseOf,
  param as parameter,
  subClassOf,
} from "../src";
import { createSqliteBackend } from "../src/backend/sqlite";
import type { GraphBackend } from "../src/backend/types";
import { createQueryBuilder } from "../src/query/builder";
import { createStore } from "../src/store";
import { createTestDatabase } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.email().optional(),
    age: z.number().int().positive().optional(),
    active: z.boolean().optional(),
  }),
});

const Organization = defineNode("Organization", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
    ticker: z.string().optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startDate: z.string().optional(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({
    since: z.string().optional(),
  }),
});

const testGraph = defineGraph({
  id: "test_graph",
  nodes: {
    Person: { type: Person },
    Organization: { type: Organization },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Organization, Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
  ontology: [subClassOf(Company, Organization), inverseOf(knows, knows)],
});

// ============================================================
// Test Helpers
// ============================================================

async function seedTestData(backend: GraphBackend): Promise<{
  alice: string;
  bob: string;
  charlie: string;
  acme: string;
  techCorp: string;
}> {
  const graphId = "test_graph";

  // Create nodes
  const alice = await backend.insertNode({
    graphId,
    kind: "Person",
    id: "alice",
    props: { name: "Alice", email: "alice@example.com", age: 30 },
  });

  const bob = await backend.insertNode({
    graphId,
    kind: "Person",
    id: "bob",
    props: { name: "Bob", email: "bob@example.com", age: 25 },
  });

  const charlie = await backend.insertNode({
    graphId,
    kind: "Person",
    id: "charlie",
    props: { name: "Charlie", age: 35 },
  });

  const acme = await backend.insertNode({
    graphId,
    kind: "Company",
    id: "acme",
    props: { name: "Acme Inc", industry: "Technology", ticker: "ACME" },
  });

  const techCorp = await backend.insertNode({
    graphId,
    kind: "Company",
    id: "techcorp",
    props: { name: "TechCorp", industry: "Software" },
  });

  // Create edges
  await backend.insertEdge({
    graphId,
    id: "edge-1",
    kind: "worksAt",
    fromKind: "Person",
    fromId: "alice",
    toKind: "Company",
    toId: "acme",
    props: { role: "Engineer", startDate: "2020-01-01" },
  });

  await backend.insertEdge({
    graphId,
    id: "edge-2",
    kind: "worksAt",
    fromKind: "Person",
    fromId: "bob",
    toKind: "Company",
    toId: "acme",
    props: { role: "Designer" },
  });

  await backend.insertEdge({
    graphId,
    id: "edge-3",
    kind: "worksAt",
    fromKind: "Person",
    fromId: "charlie",
    toKind: "Company",
    toId: "techcorp",
    props: { role: "Manager" },
  });

  await backend.insertEdge({
    graphId,
    id: "edge-4",
    kind: "knows",
    fromKind: "Person",
    fromId: "alice",
    toKind: "Person",
    toId: "bob",
    props: { since: "2019-01-01" },
  });

  // Create a chain for variable-length path testing: Alice -> Bob -> Charlie
  await backend.insertEdge({
    graphId,
    id: "edge-5",
    kind: "knows",
    fromKind: "Person",
    fromId: "bob",
    toKind: "Person",
    toId: "charlie",
    props: { since: "2020-01-01" },
  });

  return {
    alice: alice.id,
    bob: bob.id,
    charlie: charlie.id,
    acme: acme.id,
    techCorp: techCorp.id,
  };
}

// ============================================================
// Query Execution Tests (SQLite)
// ============================================================

describe("Query Execution (SQLite)", () => {
  let db: BetterSQLite3Database;
  let backend: GraphBackend;
  let store: ReturnType<typeof createStore<typeof testGraph>>;

  beforeEach(async () => {
    db = createTestDatabase();
    backend = createSqliteBackend(db);
    store = createStore(testGraph, backend);
    await seedTestData(backend);
  });

  describe("Basic Queries", () => {
    it("queries all nodes of a kind", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .select((context) => context.p)
        .execute();

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.name).toSorted()).toEqual([
        "Alice",
        "Bob",
        "Charlie",
      ]);
    });

    it("queries with property filter", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .select((context) => context.p)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("Alice");
      expect(results[0]!.email).toBe("alice@example.com");
    });

    it("queries with contains filter", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.contains("li"))
        .select((context) => context.p)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name).toSorted()).toEqual([
        "Alice",
        "Charlie",
      ]);
    });

    it("queries with startsWith filter", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.startsWith("A"))
        .select((context) => context.p)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe("Alice");
    });

    it("queries with limit and offset", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .select((context) => context.p)
        .orderBy("p", "name", "asc")
        .limit(2)
        .execute();

      expect(results).toHaveLength(2);
      expect(results[0]!.name).toBe("Alice");
      expect(results[1]!.name).toBe("Bob");

      const offsetResults = await store
        .query()
        .from("Person", "p")
        .select((context) => context.p)
        .orderBy("p", "name", "asc")
        .limit(2)
        .offset(1)
        .execute();

      expect(offsetResults).toHaveLength(2);
      expect(offsetResults[0]!.name).toBe("Bob");
      expect(offsetResults[1]!.name).toBe("Charlie");
    });
  });

  describe("Traversal Queries", () => {
    it("traverses edges to related nodes", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((context) => ({ person: context.p, company: context.c }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]!.person.name).toBe("Alice");
      expect(results[0]!.company.name).toBe("Acme Inc");
    });

    it("traverses multiple hops", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1", { expand: "none" })
        .to("Person", "friend")
        .traverse("worksAt", "e2")
        .to("Company", "c")
        .select((context) => ({
          person: context.p,
          friend: context.friend,
          company: context.c,
        }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]!.person.name).toBe("Alice");
      expect(results[0]!.friend.name).toBe("Bob");
      expect(results[0]!.company.name).toBe("Acme Inc");
    });

    it("returns multiple results for one-to-many traversals", async () => {
      const results = await store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.name.eq("Acme Inc"))
        .traverse("worksAt", "e", { direction: "in" })
        .to("Person", "p")
        .select((context) => ({ company: context.c, employee: context.p }))
        .execute();

      expect(results).toHaveLength(2);
      const employeeNames = results.map((r) => r.employee.name).toSorted();
      expect(employeeNames).toEqual(["Alice", "Bob"]);
    });

    it("supports symmetric traversal with expand: inverse", async () => {
      const withoutInverseExpansion = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Bob"))
        .traverse("knows", "e", { expand: "none" })
        .to("Person", "peer")
        .select((context) => ({ peerName: context.peer.name }))
        .execute();

      expect(withoutInverseExpansion).toHaveLength(1);
      expect(withoutInverseExpansion[0]!.peerName).toBe("Charlie");

      const withInverseExpansion = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Bob"))
        .traverse("knows", "e", { expand: "inverse" })
        .to("Person", "peer")
        .select((context) => ({ peerName: context.peer.name }))
        .execute();

      const peerNames = withInverseExpansion
        .map((result) => result.peerName)
        .toSorted();

      expect(peerNames).toEqual(["Alice", "Charlie"]);
    });

    it("uses inverse expansion as the default expand behavior", async () => {
      // Default expand (no option) should behave identically to expand: "inverse"
      const defaultExpandResults = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Bob"))
        .traverse("knows", "e")
        .to("Person", "peer")
        .select((context) => ({ peerName: context.peer.name }))
        .execute();

      const explicitInverseResults = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Bob"))
        .traverse("knows", "e", { expand: "inverse" })
        .to("Person", "peer")
        .select((context) => ({ peerName: context.peer.name }))
        .execute();

      const defaultNames = defaultExpandResults
        .map((result) => result.peerName)
        .toSorted();
      const explicitNames = explicitInverseResults
        .map((result) => result.peerName)
        .toSorted();

      expect(defaultNames).toEqual(explicitNames);
    });

    it("does not over-match traversal targets when ids overlap across kinds", async () => {
      await backend.insertNode({
        graphId: "test_graph",
        kind: "Person",
        id: "collision-person",
        props: { name: "Collision Person" },
      });

      await backend.insertNode({
        graphId: "test_graph",
        kind: "Company",
        id: "shared-org-id",
        props: { name: "Company Winner" },
      });

      await backend.insertNode({
        graphId: "test_graph",
        kind: "Organization",
        id: "shared-org-id",
        props: { name: "Organization Shadow" },
      });

      await backend.insertEdge({
        graphId: "test_graph",
        id: "collision-edge",
        kind: "worksAt",
        fromKind: "Person",
        fromId: "collision-person",
        toKind: "Company",
        toId: "shared-org-id",
        props: { role: "Engineer" },
      });

      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.id.eq("collision-person"))
        .traverse("worksAt", "e")
        .to("Organization", "o", { includeSubClasses: true })
        .select((context) => ({
          id: context.o.id,
          kind: context.o.kind,
          name: context.o.name,
        }))
        .execute();

      expect(results).toEqual([
        {
          id: "shared-org-id",
          kind: "Company",
          name: "Company Winner",
        },
      ]);

      const aggregate = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.id.eq("collision-person"))
        .optionalTraverse("worksAt", "e")
        .to("Organization", "o", { includeSubClasses: true })
        .groupByNode("p")
        .aggregate({
          orgCount: count("o"),
        })
        .execute();

      expect(aggregate).toEqual([{ orgCount: 1 }]);
    });

    it("chains traversals through intermediate nodes (3-hop)", async () => {
      // Test data: Alice -> knows -> Bob -> knows -> Charlie -> worksAt -> TechCorp
      // This test verifies chaining works by checking we get Charlie's company (TechCorp),
      // NOT Alice's company (Acme). If traversals fan out from start instead of chaining,
      // this would incorrectly return Acme.
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1", { expand: "none" })
        .to("Person", "friend")
        .traverse("knows", "e2", { expand: "none" })
        .to("Person", "friendOfFriend")
        .traverse("worksAt", "e3")
        .to("Company", "c")
        .select((context) => ({
          start: context.p.name,
          friend: context.friend.name,
          friendOfFriend: context.friendOfFriend.name,
          company: context.c.name,
        }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        start: "Alice",
        friend: "Bob",
        friendOfFriend: "Charlie",
        company: "TechCorp", // Charlie's company, NOT Alice's
      });
    });

    it("supports fan-out with explicit from option", async () => {
      // Fan-out: from Alice, get both her friends AND her company (independent traversals)
      // Uses explicit `from` to traverse from start node ("p") instead of chaining
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1", { expand: "none" })
        .to("Person", "friend")
        .traverse("worksAt", "e2", { from: "p" }) // Explicit: from "p" (Alice), not "friend"
        .to("Company", "c")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
          company: context.c.name, // Alice's company
        }))
        .execute();

      // Alice knows Bob, Alice works at Acme
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        person: "Alice",
        friend: "Bob",
        company: "Acme Inc", // Alice's company (fan-out from start)
      });
    });

    it("allows mixed chaining and fan-out patterns", async () => {
      // Start with Alice, chain to her friend Bob, then fan out:
      // - From Bob: get Bob's friends (Charlie)
      // - From Alice (via explicit from): get Alice's company
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1", { expand: "none" })
        .to("Person", "friend") // Bob
        .traverse("knows", "e2", { expand: "none" }) // Chains from friend (Bob) by default
        .to("Person", "friendOfFriend") // Charlie
        .traverse("worksAt", "e3", { from: "p" }) // Fan-out: Alice's company
        .to("Company", "c")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
          friendOfFriend: context.friendOfFriend.name,
          company: context.c.name,
        }))
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        person: "Alice",
        friend: "Bob",
        friendOfFriend: "Charlie",
        company: "Acme Inc", // Alice's company (explicit fan-out)
      });
    });
  });

  describe("Custom Projections", () => {
    it("projects specific fields", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .select((context) => ({
          name: context.p.name,
          id: context.p.id,
        }))
        .execute();

      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r).toHaveProperty("name");
        expect(r).toHaveProperty("id");
      }
    });

    it("projects computed values", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .select((context) => ({
          displayName: `${context.p.name} (${context.p.id})`,
        }))
        .execute();

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.displayName).toSorted()).toEqual([
        "Alice (alice)",
        "Bob (bob)",
        "Charlie (charlie)",
      ]);
    });
  });

  describe("Query Compilation", () => {
    it("compiles to Drizzle SQL object", () => {
      const query = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .select((context) => context.p);

      const compiled = query.compile();

      // compile() returns a Drizzle SQL object
      expect(compiled).toBeDefined();
      expect(compiled.queryChunks).toBeDefined();
    });

    it("generates AST for inspection", () => {
      const query = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((context) => ({ person: context.p, company: context.c }));

      const ast = query.toAst();

      expect(ast.start.alias).toBe("p");
      expect(ast.start.kinds).toContain("Person");
      expect(ast.traversals).toHaveLength(1);
      expect(ast.traversals[0]!.edgeKinds).toEqual(["worksAt"]);
      expect(ast.traversals[0]!.nodeAlias).toBe("c");
      expect(ast.predicates).toHaveLength(1);
    });
  });

  describe("toSQL()", () => {
    it("returns SQL text and params from ExecutableQuery", () => {
      const query = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .select((context) => context.p);

      const result = query.toSQL();

      expect(typeof result.sql).toBe("string");
      expect(result.sql.length).toBeGreaterThan(0);
      expect(Array.isArray(result.params)).toBe(true);
      expect(result.params).toContain("Alice");
    });

    it("returns SQL text and params from ExecutableAggregateQuery", () => {
      const query = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .aggregate({
          total: count("p"),
        });

      const result = query.toSQL();

      expect(typeof result.sql).toBe("string");
      expect(result.sql.length).toBeGreaterThan(0);
      expect(Array.isArray(result.params)).toBe(true);
    });

    it("returns SQL text and params from UnionableQuery", () => {
      const q1 = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .select((context) => context.p);

      const q2 = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Bob"))
        .select((context) => context.p);

      const result = q1.union(q2).toSQL();

      expect(typeof result.sql).toBe("string");
      expect(result.sql).toContain("UNION");
      expect(Array.isArray(result.params)).toBe(true);
    });

    it("throws when no backend is configured", () => {
      const builder = createQueryBuilder<typeof testGraph>(
        "test_graph",
        store.registry,
      );

      const query = builder.from("Person", "p").select((context) => context.p);

      expect(() => query.toSQL()).toThrow("Cannot convert to SQL");
    });

    it("throws for aggregate query when no backend is configured", () => {
      const builder = createQueryBuilder<typeof testGraph>(
        "test_graph",
        store.registry,
      );

      const query = builder
        .from("Person", "p")
        .aggregate({ total: count("p") });

      expect(() => query.toSQL()).toThrow("Cannot convert to SQL");
    });
  });

  describe("Error Handling", () => {
    it("throws when executing without backend", async () => {
      const builder = createQueryBuilder<typeof testGraph>(
        "test_graph",
        store.registry,
        // No backend provided
      );

      const query = builder.from("Person", "p").select((context) => context.p);

      await expect(query.execute()).rejects.toThrow("no backend configured");
    });
  });

  describe("Variable-Length Paths", () => {
    it("traverses recursive chain with unlimited depth", async () => {
      // Alice -> Bob -> Charlie (2 hops)
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e", { expand: "none" })
        .recursive()
        .to("Person", "friend")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
        }))
        .execute();

      // Should find: Alice (depth 0), Bob (depth 1), Charlie (depth 2)
      expect(results.length).toBeGreaterThanOrEqual(2);
      const friends = results.map((r) => r.friend);
      expect(friends).toContain("Bob");
      expect(friends).toContain("Charlie");
    });

    it("respects maxHops limit", async () => {
      // With maxHops(1), should only find Bob (immediate friend)
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e", { expand: "none" })
        .recursive({ maxHops: 1 })
        .to("Person", "friend")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
        }))
        .execute();

      const friends = results.map((r) => r.friend);
      expect(friends).toContain("Bob");
      expect(friends).not.toContain("Charlie"); // Charlie is 2 hops away
    });

    it("does not over-match recursive traversal targets when ids overlap across kinds", async () => {
      await backend.insertNode({
        graphId: "test_graph",
        kind: "Person",
        id: "recursive-collision-person",
        props: { name: "Recursive Collision Person" },
      });

      await backend.insertNode({
        graphId: "test_graph",
        kind: "Company",
        id: "recursive-shared-org-id",
        props: { name: "Recursive Company Winner" },
      });

      await backend.insertNode({
        graphId: "test_graph",
        kind: "Organization",
        id: "recursive-shared-org-id",
        props: { name: "Recursive Organization Shadow" },
      });

      await backend.insertEdge({
        graphId: "test_graph",
        id: "recursive-collision-edge",
        kind: "worksAt",
        fromKind: "Person",
        fromId: "recursive-collision-person",
        toKind: "Company",
        toId: "recursive-shared-org-id",
        props: { role: "Lead" },
      });

      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.id.eq("recursive-collision-person"))
        .traverse("worksAt", "e")
        .recursive({ maxHops: 1 })
        .to("Organization", "o", { includeSubClasses: true })
        .select((context) => ({
          id: context.o.id,
          kind: context.o.kind,
          name: context.o.name,
        }))
        .execute();

      expect(results).toEqual([
        {
          id: "recursive-shared-org-id",
          kind: "Company",
          name: "Recursive Company Winner",
        },
      ]);
    });

    it("respects minHops to skip immediate connections", async () => {
      // With minHops(2), should only find Charlie (friend of friend)
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e", { expand: "none" })
        .recursive({ minHops: 2 })
        .to("Person", "friend")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
        }))
        .execute();

      const friends = results.map((r) => r.friend);
      expect(friends).not.toContain("Bob"); // Bob is only 1 hop away
      expect(friends).toContain("Charlie"); // Charlie is 2 hops
    });

    it("handles nodes with no outgoing edges", async () => {
      // Charlie has no outgoing knows edges (is a leaf node)
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Charlie"))
        .traverse("knows", "e", { expand: "none" })
        .recursive()
        .to("Person", "friend")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
        }))
        .execute();

      // Default minDepth is 1, so depth 0 (starting node) is filtered out
      // Charlie has no friends, so no results at depth >= 1
      expect(results).toHaveLength(0);
    });

    it("includes starting node when minHops is 0", async () => {
      // With minHops(0), include the starting node itself
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Charlie"))
        .traverse("knows", "e", { expand: "none" })
        .recursive({ minHops: 0 })
        .to("Person", "friend")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
        }))
        .execute();

      // With minHops(0), should include Charlie himself at depth 0
      expect(results).toHaveLength(1);
      expect(results[0]!.friend).toBe("Charlie");
    });

    it("returns results with depth information", async () => {
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e", { expand: "none" })
        .recursive({ depth: "level" })
        .to("Person", "friend")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
        }))
        .execute();

      // Verify depth is tracked (even if not directly exposed in select)
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("handles cycles without infinite loops", async () => {
      // Create a cycle: Alice -> Bob -> Charlie -> Alice
      await backend.insertEdge({
        graphId: "test_graph",
        id: "cycle-edge",
        kind: "knows",
        fromKind: "Person",
        fromId: "charlie",
        toKind: "Person",
        toId: "alice",
        props: { since: "2021-01-01" },
      });

      // Query should terminate and return each node exactly once
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e", { expand: "none" })
        .recursive()
        .to("Person", "friend")
        .select((context) => ({
          person: context.p.name,
          friend: context.friend.name,
        }))
        .execute();

      // Should find Bob and Charlie but NOT revisit Alice due to cycle detection
      const friends = results.map((r) => r.friend);
      expect(friends).toContain("Bob");
      expect(friends).toContain("Charlie");

      // Should not revisit the starting node (cycle is detected)
      // Note: Alice appears once as the starting node at depth 0 (if minHops=0),
      // but with default minHops=1, Alice should not appear in results
      expect(friends.filter((f) => f === "Alice")).toHaveLength(0);
    });

    it("detects cycles with recursive path projection", async () => {
      // Create a cycle: Alice -> Bob -> Charlie -> Alice
      await backend.insertEdge({
        graphId: "test_graph",
        id: "cycle-edge-2",
        kind: "knows",
        fromKind: "Person",
        fromId: "charlie",
        toKind: "Person",
        toId: "alice",
        props: {},
      });

      // Query with recursive path projection to verify tracking works with cycles
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e", { expand: "none" })
        .recursive({ path: "friendship_path" })
        .to("Person", "friend")
        .select((context) => ({
          friend: context.friend.name,
        }))
        .execute();

      // Query terminates and returns results
      expect(results.length).toBeGreaterThanOrEqual(2);
      const friends = results.map((r) => r.friend);
      expect(friends).toContain("Bob");
      expect(friends).toContain("Charlie");
    });

    it("preserves multi-hop limit semantics with downstream filters", async () => {
      await backend.insertNode({
        graphId: "test_graph",
        kind: "Person",
        id: "limit-anchor",
        props: { name: "Limit Anchor" },
      });

      for (let index = 1; index <= 200; index++) {
        const intermediateId = `limit-mid-${index}`;
        await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: intermediateId,
          props: { name: `Intermediate ${index}` },
        });
        await backend.insertEdge({
          graphId: "test_graph",
          id: `limit-anchor-edge-${index}`,
          kind: "knows",
          fromKind: "Person",
          fromId: "limit-anchor",
          toKind: "Person",
          toId: intermediateId,
          props: {},
        });

        if (index <= 120) {
          continue;
        }

        const targetId = `limit-target-${index}`;
        await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: targetId,
          props: { name: "Limit Match" },
        });
        await backend.insertEdge({
          graphId: "test_graph",
          id: `limit-mid-target-edge-${index}`,
          kind: "knows",
          fromKind: "Person",
          fromId: intermediateId,
          toKind: "Person",
          toId: targetId,
          props: {},
        });
      }

      const baseQuery = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.id.eq("limit-anchor"))
        .traverse("knows", "e1", { expand: "none" })
        .to("Person", "mid")
        .traverse("knows", "e2", { expand: "none" })
        .to("Person", "target")
        .whereNode("target", (target) => target.name.eq("Limit Match"))
        .select((context) => ({
          midId: context.mid.id,
          targetId: context.target.id,
        }));

      const allRows = await baseQuery.execute();
      const limitedRows = await baseQuery.limit(10).execute();

      expect(allRows).toHaveLength(80);
      expect(limitedRows).toHaveLength(10);
    });
  });

  describe("Prepared Queries", () => {
    it("keeps parameterized string-operator semantics aligned with direct execute", async () => {
      await store.nodes.Person.create({ name: "ALICIA" });

      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.contains(parameter("needle")))
        .select((context) => context.p.name)
        .prepare();

      const preparedResults = await prepared.execute({ needle: "ali" });
      const directResults = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.contains("ali"))
        .select((context) => context.p.name)
        .execute();

      expect(preparedResults.toSorted()).toEqual(directResults.toSorted());
    });

    it("falls back to full fetch when selective prepared mapping is insufficient", async () => {
      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.id.eq(parameter("id")))
        .select((context) => ({
          id: context.p.id,
          whole: context.p,
        }))
        .prepare();

      const results = await prepared.execute({ id: "alice" });

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe("alice");
      expect(results[0]!.whole.name).toBe("Alice");
    });

    it("supports prepared fallback when executeRaw is unavailable", async () => {
      const {
        compileSql: ignoredCompileSql,
        executeRaw: ignoredExecuteRaw,
        ...restBackend
      } = backend;
      void ignoredCompileSql;
      void ignoredExecuteRaw;
      const backendWithoutRaw: GraphBackend = { ...restBackend };
      const storeWithoutRaw = createStore(testGraph, backendWithoutRaw);

      const prepared = storeWithoutRaw
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.startsWith(parameter("prefix")))
        .select((context) => context.p.name)
        .prepare();

      const preparedResults = await prepared.execute({ prefix: "Al" });
      const directResults = await storeWithoutRaw
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.startsWith("Al"))
        .select((context) => context.p.name)
        .execute();

      expect(preparedResults.toSorted()).toEqual(directResults.toSorted());
    });

    it("validates missing and unknown prepared bindings", async () => {
      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.id.eq(parameter("id")))
        .select((context) => context.p.id)
        .prepare();

      await expect(prepared.execute()).rejects.toThrow(
        'Missing bindings for parameter: "id"',
      );
      await expect(
        prepared.execute({ id: "alice", extra: "unused" }),
      ).rejects.toThrow('Unexpected bindings provided: "extra"');
    });

    it("rejects null binding values on both execution paths", async () => {
      const makePrepared = (
        target: ReturnType<typeof createStore<typeof testGraph>>,
      ) =>
        target
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.id.eq(parameter("id")))
          .select((context) => context.p.id)
          .prepare();

      // eslint-disable-next-line unicorn/no-null -- intentionally testing null rejection
      const nullValue = null as unknown as string;

      // Fast path (executeRaw available)
      const fastPrepared = makePrepared(store);
      await expect(fastPrepared.execute({ id: nullValue })).rejects.toThrow(
        "must not be null",
      );

      // Fallback path (executeRaw stripped)
      const { compileSql: _cs, executeRaw: _er, ...restBackend } = backend;
      const fallbackStore = createStore(testGraph, { ...restBackend });
      const fallbackPrepared = makePrepared(fallbackStore);
      await expect(fallbackPrepared.execute({ id: nullValue })).rejects.toThrow(
        "must not be null",
      );
    });

    it("rejects non-string binding for string operations on both paths", async () => {
      const makePrepared = (
        target: ReturnType<typeof createStore<typeof testGraph>>,
      ) =>
        target
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.name.contains(parameter("needle")))
          .select((context) => context.p.name)
          .prepare();

      // Fast path
      const fastPrepared = makePrepared(store);
      await expect(
        fastPrepared.execute({ needle: 42 as unknown as string }),
      ).rejects.toThrow("must be a string for string operations");

      // Fallback path
      const { compileSql: _cs, executeRaw: _er, ...restBackend } = backend;
      const fallbackStore = createStore(testGraph, { ...restBackend });
      const fallbackPrepared = makePrepared(fallbackStore);
      await expect(
        fallbackPrepared.execute({ needle: 42 as unknown as string }),
      ).rejects.toThrow("must be a string for string operations");
    });

    it("rejects object/array binding values on both execution paths", async () => {
      const makePrepared = (
        target: ReturnType<typeof createStore<typeof testGraph>>,
      ) =>
        target
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.id.eq(parameter("id")))
          .select((context) => context.p.id)
          .prepare();

      // Fast path
      const fastPrepared = makePrepared(store);
      await expect(
        fastPrepared.execute({ id: { nested: true } as unknown as string }),
      ).rejects.toThrow("Unsupported parameter value type");

      // Fallback path
      const { compileSql: _cs, executeRaw: _er, ...restBackend } = backend;
      const fallbackStore = createStore(testGraph, { ...restBackend });
      const fallbackPrepared = makePrepared(fallbackStore);
      await expect(
        fallbackPrepared.execute({ id: [1, 2, 3] as unknown as string }),
      ).rejects.toThrow("Unsupported parameter value type");
    });

    it("supports parameters inside EXISTS subqueries", async () => {
      const preparedSubquery = store
        .query()
        .from("Person", "q")
        .whereNode("q", (q) => q.name.eq(parameter("needle")))
        .select((context) => context.q.id)
        .toAst();

      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", () => exists(preparedSubquery))
        .select((context) => context.p.id)
        .prepare();

      const preparedResults = await prepared.execute({ needle: "Alice" });

      const directSubquery = store
        .query()
        .from("Person", "q")
        .whereNode("q", (q) => q.name.eq("Alice"))
        .select((context) => context.q.id)
        .toAst();
      const directResults = await store
        .query()
        .from("Person", "p")
        .whereNode("p", () => exists(directSubquery))
        .select((context) => context.p.id)
        .execute();

      expect(preparedResults.toSorted()).toEqual(directResults.toSorted());
    });

    it("supports parameters inside IN subqueries", async () => {
      const preparedSubquery = store
        .query()
        .from("Person", "q")
        .whereNode("q", (q) => q.name.eq(parameter("needle")))
        .aggregate({
          id: fieldRef("q", ["id"], { valueType: "string" }),
        })
        .toAst();

      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", () =>
          inSubquery(
            fieldRef("p", ["id"], { valueType: "string" }),
            preparedSubquery,
          ),
        )
        .select((context) => context.p.id)
        .prepare();

      const preparedResults = await prepared.execute({ needle: "Alice" });

      const directSubquery = store
        .query()
        .from("Person", "q")
        .whereNode("q", (q) => q.name.eq("Alice"))
        .aggregate({
          id: fieldRef("q", ["id"], { valueType: "string" }),
        })
        .toAst();
      const directResults = await store
        .query()
        .from("Person", "p")
        .whereNode("p", () =>
          inSubquery(
            fieldRef("p", ["id"], { valueType: "string" }),
            directSubquery,
          ),
        )
        .select((context) => context.p.id)
        .execute();

      expect(preparedResults.toSorted()).toEqual(directResults.toSorted());
      expect(preparedResults).toEqual(["alice"]);
    });

    it("rejects IN subqueries that project multiple columns", () => {
      const invalidSubquery = store
        .query()
        .from("Person", "q")
        .select((context) => ({
          id: context.q.id,
          name: context.q.name,
        }))
        .toAst();

      expect(() =>
        store
          .query()
          .from("Person", "p")
          .whereNode("p", () =>
            inSubquery(
              fieldRef("p", ["id"], { valueType: "string" }),
              invalidSubquery,
            ),
          ),
      ).toThrow("must project exactly 1 column");
    });

    it("supports numeric IN subqueries with typed field refs", async () => {
      const ageSubquery = store
        .query()
        .from("Person", "q")
        .whereNode("q", (q) => q.age.gte(30))
        .aggregate({
          age: fieldRef("q", ["props", "age"], { valueType: "number" }),
        })
        .toAst();

      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", () =>
          inSubquery(
            fieldRef("p", ["props", "age"], { valueType: "number" }),
            ageSubquery,
          ),
        )
        .select((context) => context.p.id)
        .execute();

      expect(results.toSorted()).toEqual(["alice", "charlie"]);
    });

    it("handles boolean parameter bindings on SQLite (fast path)", async () => {
      await store.nodes.Person.create(
        { name: "Active User", active: true },
        { id: "active-user" },
      );
      await store.nodes.Person.create(
        { name: "Inactive User", active: false },
        { id: "inactive-user" },
      );

      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.active.eq(parameter("isActive")))
        .select((context) => context.p.name)
        .prepare();

      const activeResults = await prepared.execute({ isActive: true });
      const inactiveResults = await prepared.execute({ isActive: false });

      const directActive = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.active.eq(true))
        .select((context) => context.p.name)
        .execute();

      expect(activeResults.toSorted()).toEqual(directActive.toSorted());
      expect(activeResults).toHaveLength(1);
      expect(activeResults[0]).toBe("Active User");
      expect(inactiveResults).toHaveLength(1);
      expect(inactiveResults[0]).toBe("Inactive User");
    });
  });
});
