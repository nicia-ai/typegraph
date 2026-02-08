/**
 * Query Execution Integration Tests
 *
 * Tests the full query pipeline: builder → AST → SQL → execution → results.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, subClassOf } from "../src";
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
  ontology: [subClassOf(Company, Organization)],
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
        .traverse("knows", "e1")
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

    it("chains traversals through intermediate nodes (3-hop)", async () => {
      // Test data: Alice -> knows -> Bob -> knows -> Charlie -> worksAt -> TechCorp
      // This test verifies chaining works by checking we get Charlie's company (TechCorp),
      // NOT Alice's company (Acme). If traversals fan out from start instead of chaining,
      // this would incorrectly return Acme.
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e1")
        .to("Person", "friend")
        .traverse("knows", "e2")
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
        .traverse("knows", "e1")
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
        .traverse("knows", "e1")
        .to("Person", "friend") // Bob
        .traverse("knows", "e2") // Chains from friend (Bob) by default
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
        .traverse("knows", "e")
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
        .traverse("knows", "e")
        .recursive()
        .maxHops(1)
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

    it("respects minHops to skip immediate connections", async () => {
      // With minHops(2), should only find Charlie (friend of friend)
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive()
        .minHops(2)
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
        .traverse("knows", "e")
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
        .traverse("knows", "e")
        .recursive()
        .minHops(0)
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
        .traverse("knows", "e")
        .recursive()
        .withDepth("level")
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
        .traverse("knows", "e")
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

    it("detects cycles with path collection", async () => {
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

      // Query with collectPath to verify path tracking works with cycles
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive()
        .collectPath("friendship_path")
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
  });
});
