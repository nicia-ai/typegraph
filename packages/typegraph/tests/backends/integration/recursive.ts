import { beforeEach, describe, expect, it } from "vitest";

import {
  seedKnowsChain,
  seedPeopleForRecursiveDepthTracking,
} from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

export function registerRecursiveIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Variable-Length Traversals", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedKnowsChain(store);
    });

    it("finds all reachable nodes with unlimited depth", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive()
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();

      // Alice can reach Bob, Charlie, Diana, Eve
      // Note: May include duplicates if nodes are reachable via multiple paths
      // (e.g., Charlie is reachable directly and via Bob)
      const uniqueResults = [...new Set(results)];
      expect(uniqueResults.toSorted()).toEqual([
        "Bob",
        "Charlie",
        "Diana",
        "Eve",
      ]);
    });

    it("respects maxHops limit", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive({ maxHops: 2 })
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();

      // Alice -> Bob (1 hop), Alice -> Charlie (1 hop via direct edge OR 2 hops via Bob)
      // With maxHops(2), can reach: Bob (1), Charlie (1 or 2), Diana (2 via Charlie)
      expect(results.toSorted()).toContain("Bob");
      expect(results.toSorted()).toContain("Charlie");
    });

    it("respects minHops filter", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive({ minHops: 2, maxHops: 3 })
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();

      // minHops(2) means skip direct connections
      // Should include Diana (2 hops via Alice->Charlie->Diana)
      // but NOT Bob (only 1 hop from Alice)
      expect(results).not.toContain("Bob");
      expect(results).toContain("Diana");
    });

    it("executes query with recursive path projection", async () => {
      // recursive({ path }) adds a path column to the SQL output
      // We verify the query compiles and executes correctly
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive({ maxHops: 2, path: "friend_path" })
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();

      // Query should execute successfully and return results
      expect(results.length).toBeGreaterThan(0);
      const uniqueResults = [...new Set(results)];
      expect(uniqueResults).toContain("Bob");
      expect(uniqueResults).toContain("Charlie");
    });

    it("handles cycles without infinite loops", async () => {
      const store = context.getStore();
      // Create a cycle: Eve knows Alice
      const alice = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .select((ctx) => ctx.p)
        .execute();

      const eve = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Eve"))
        .select((ctx) => ctx.p)
        .execute();

      // Create cycle edge
      await store.edges.knows.create(eve[0]!, alice[0]!, { since: "2024" });

      // This should complete without infinite loop due to cycle detection
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive()
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();

      // Should find all reachable nodes (may have duplicates from multiple paths)
      const uniqueResults = [...new Set(results)];
      expect(uniqueResults.toSorted()).toEqual([
        "Bob",
        "Charlie",
        "Diana",
        "Eve",
      ]);
    });
  });

  describe("Recursive Query with Depth Tracking", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForRecursiveDepthTracking(store);
    });

    it("executes recursive query with depth projection", async () => {
      // recursive({ depth }) adds a depth column to the SQL output
      // We verify the query compiles and executes correctly
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("CEO"))
        .traverse("knows", "e")
        .recursive({ depth: "level" })
        .to("Person", "report")
        .select((ctx) => ctx.report.name)
        .execute();

      // Should find all reports (VP1, VP2, Manager1, Manager2, Employee1)
      const uniqueResults = [...new Set(results)];
      expect(uniqueResults.toSorted()).toEqual([
        "Employee1",
        "Manager1",
        "Manager2",
        "VP1",
        "VP2",
      ]);
    });

    it("combines depth projection and maxHops", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("CEO"))
        .traverse("knows", "e")
        .recursive({ maxHops: 2, depth: "depth" })
        .to("Person", "report")
        .select((ctx) => ctx.report.name)
        .execute();

      // maxHops(2) means only level 1 and 2 (VPs and Managers)
      const uniqueResults = [...new Set(results)];
      expect(uniqueResults).toContain("VP1");
      expect(uniqueResults).toContain("VP2");
      expect(uniqueResults).toContain("Manager1");
      expect(uniqueResults).toContain("Manager2");

      // Employee1 is at level 3, should not be included
      expect(uniqueResults).not.toContain("Employee1");
    });

    it("combines depth projection and minHops", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("CEO"))
        .traverse("knows", "e")
        .recursive({ minHops: 2, depth: "depth" })
        .to("Person", "report")
        .select((ctx) => ctx.report.name)
        .execute();

      // minHops(2) skips level 1, only includes level 2+ (Managers and Employee1)
      const uniqueResults = [...new Set(results)];

      // VPs (level 1) should not be included
      expect(uniqueResults).not.toContain("VP1");
      expect(uniqueResults).not.toContain("VP2");

      // Managers and Employee should be included
      expect(uniqueResults).toContain("Manager1");
      expect(uniqueResults).toContain("Manager2");
      expect(uniqueResults).toContain("Employee1");
    });

    it("combines depth and path projection", async () => {
      // Both options can be used together
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("CEO"))
        .traverse("knows", "e")
        .recursive({ maxHops: 2, depth: "depth", path: "path" })
        .to("Person", "report")
        .select((ctx) => ctx.report.name)
        .execute();

      // Query should execute successfully
      expect(results.length).toBeGreaterThan(0);
      const uniqueResults = [...new Set(results)];
      expect(uniqueResults).toContain("VP1");
      expect(uniqueResults).toContain("Manager1");
    });

    it("depth projection works for single-path traversals", async () => {
      // Query from VP1 down - each node only reachable via one path
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("VP1"))
        .traverse("knows", "e")
        .recursive({ depth: "depth" })
        .to("Person", "report")
        .select((ctx) => ctx.report.name)
        .execute();

      // VP1 -> Manager1 -> Employee1
      expect(results).toContain("Manager1");
      expect(results).toContain("Employee1");
    });
  });

  describe("Recursive Depth/Path in Select Context", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForRecursiveDepthTracking(store);
    });

    it("exposes depth value with custom alias in select context", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("CEO"))
        .traverse("knows", "e")
        .recursive({ depth: "level" })
        .to("Person", "report")
        .select((ctx) => ({
          name: ctx.report.name,
          level: ctx.level,
        }))
        .execute();

      const byName = new Map(results.map((r) => [r.name, r.level]));

      // VP1 and VP2 are 1 hop away
      expect(byName.get("VP1")).toBe(1);
      expect(byName.get("VP2")).toBe(1);

      // Manager1 and Manager2 are 2 hops away
      expect(byName.get("Manager1")).toBe(2);
      expect(byName.get("Manager2")).toBe(2);

      // Employee1 is 3 hops away
      expect(byName.get("Employee1")).toBe(3);
    });

    it("exposes depth with default alias (depth: true)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("CEO"))
        .traverse("knows", "e")
        .recursive({ depth: true })
        .to("Person", "report")
        .select((ctx) => ({
          name: ctx.report.name,
          depth: ctx.report_depth,
        }))
        .execute();

      const byName = new Map(results.map((r) => [r.name, r.depth]));
      expect(byName.get("VP1")).toBe(1);
      expect(byName.get("Employee1")).toBe(3);
    });

    it("exposes path value with custom alias in select context", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("CEO"))
        .traverse("knows", "e")
        .recursive({ path: "nodePath", maxHops: 3 })
        .to("Person", "report")
        .select((ctx) => ({
          name: ctx.report.name,
          nodePath: ctx.nodePath,
        }))
        .execute();

      // Path values should be arrays of node IDs
      for (const result of results) {
        const path = result.nodePath;
        expect(Array.isArray(path)).toBe(true);
        expect(path.length).toBeGreaterThan(0);
      }

      // Employee1 path should be the longest (CEO -> VP1 -> Manager1 -> Employee1)
      const employee = results.find((r) => r.name === "Employee1");
      expect(employee).toBeDefined();
      expect(employee!.nodePath.length).toBe(4);
    });

    it("exposes both depth and path together in select context", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("CEO"))
        .traverse("knows", "e")
        .recursive({ depth: "level", path: "route", maxHops: 3 })
        .to("Person", "report")
        .select((ctx) => ({
          name: ctx.report.name,
          level: ctx.level,
          route: ctx.route,
        }))
        .execute();

      const employee = results.find((r) => r.name === "Employee1")!;
      expect(employee).toBeDefined();
      expect(employee.level).toBe(3);
      expect(employee.route.length).toBe(4);

      const vp = results.find((r) => r.name === "VP1")!;
      expect(vp).toBeDefined();
      expect(vp.level).toBe(1);
      expect(vp.route.length).toBe(2);
    });
  });
}
