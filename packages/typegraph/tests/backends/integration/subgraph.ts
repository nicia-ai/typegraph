/**
 * Subgraph Integration Tests
 *
 * Tests store.subgraph() against the shared integration test graph.
 * Runs against both SQLite and PostgreSQL via the integration test suite.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { type IntegrationTestContext } from "./test-context";

/**
 * Seed data for subgraph tests.
 *
 * Graph structure:
 *   alice --knows--> bob --knows--> charlie
 *   alice --worksAt--> acme
 *   bob --worksAt--> acme (same company — diamond)
 *
 * Allows testing:
 * - Multi-hop traversal (alice → bob → charlie via knows)
 * - Diamond deduplication (acme reachable from both alice and bob)
 * - Multi-edge-kind traversal (knows + worksAt)
 * - Bidirectional traversal
 * - includeKinds filtering
 */
async function seedSubgraphData(
  store: ReturnType<IntegrationTestContext["getStore"]>,
): Promise<{
  aliceId: string;
  bobId: string;
  charlieId: string;
  acmeId: string;
}> {
  const alice = await store.nodes.Person.create({
    name: "Alice",
    age: 30,
    email: "alice@example.com",
  });
  const bob = await store.nodes.Person.create({
    name: "Bob",
    age: 25,
    email: "bob@example.com",
  });
  const charlie = await store.nodes.Person.create({
    name: "Charlie",
    age: 35,
  });
  const acme = await store.nodes.Company.create({
    name: "Acme",
    industry: "Tech",
  });

  await store.edges.knows.create(alice, bob, { since: "2020" });
  await store.edges.knows.create(bob, charlie, { since: "2021" });
  await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
  await store.edges.worksAt.create(bob, acme, { role: "Manager" });

  return {
    aliceId: alice.id as string,
    bobId: bob.id as string,
    charlieId: charlie.id as string,
    acmeId: acme.id as string,
  };
}

export function registerSubgraphIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Subgraph Extraction", () => {
    let ids: Awaited<ReturnType<typeof seedSubgraphData>>;

    beforeEach(async () => {
      const store = context.getStore();
      ids = await seedSubgraphData(store);
    });

    it("extracts immediate neighbors", async () => {
      const store = context.getStore();
      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows"],
        maxDepth: 1,
      });

      const names = result.nodes
        .map((n) => (n as { name: string }).name)
        .toSorted();
      expect(names).toContain("Alice");
      expect(names).toContain("Bob");
      expect(names).not.toContain("Charlie");
    });

    it("follows multi-hop paths", async () => {
      const store = context.getStore();
      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows"],
        maxDepth: 2,
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      expect(nodeIds.has(ids.aliceId)).toBe(true);
      expect(nodeIds.has(ids.bobId)).toBe(true);
      expect(nodeIds.has(ids.charlieId)).toBe(true);
    });

    it("follows multiple edge kinds", async () => {
      const store = context.getStore();
      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows", "worksAt"],
        maxDepth: 2,
      });

      const kinds = new Set(result.nodes.map((n) => n.kind));
      expect(kinds.has("Person")).toBe(true);
      expect(kinds.has("Company")).toBe(true);
    });

    it("deduplicates diamond-reachable nodes", async () => {
      const store = context.getStore();
      // acme is reachable via alice→worksAt AND alice→knows→bob→worksAt
      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows", "worksAt"],
        maxDepth: 3,
      });

      const companyNodes = result.nodes.filter((n) => n.kind === "Company");
      expect(companyNodes).toHaveLength(1);
    });

    it("filters with includeKinds", async () => {
      const store = context.getStore();
      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows", "worksAt"],
        maxDepth: 2,
        includeKinds: ["Company"],
      });

      for (const node of result.nodes) {
        expect(node.kind).toBe("Company");
      }
      expect(result.nodes).toHaveLength(1);
    });

    it("excludes root", async () => {
      const store = context.getStore();
      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows"],
        maxDepth: 1,
        excludeRoot: true,
      });

      expect(result.nodes.every((n) => n.id !== ids.aliceId)).toBe(true);
      expect(result.nodes).toHaveLength(1);
    });

    it("handles bidirectional traversal", async () => {
      const store = context.getStore();
      // Starting from bob, traverse knows in both directions
      const result = await store.subgraph(ids.bobId as never, {
        edges: ["knows"],
        maxDepth: 1,
        direction: "both",
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      // Outbound: bob → charlie
      expect(nodeIds.has(ids.charlieId)).toBe(true);
      // Inbound: alice → bob (reversed)
      expect(nodeIds.has(ids.aliceId)).toBe(true);
    });

    it("returns edges only when both endpoints are in result", async () => {
      const store = context.getStore();
      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows", "worksAt"],
        maxDepth: 2,
        includeKinds: ["Person"],
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      for (const edge of result.edges) {
        expect(nodeIds.has(edge.fromId as string)).toBe(true);
        expect(nodeIds.has(edge.toId as string)).toBe(true);
      }

      // worksAt edges connect Person→Company, but Company is excluded
      expect(result.edges.some((edge) => edge.kind === "worksAt")).toBe(false);
      // knows edges connect Person→Person, both in result
      expect(result.edges.some((edge) => edge.kind === "knows")).toBe(true);
    });

    it("excludes soft-deleted nodes", async () => {
      const store = context.getStore();

      // Delete edges connected to bob first (restrict policy)
      const knowsFromBob = await store.edges.knows.findFrom({
        kind: "Person",
        id: ids.bobId,
      });
      for (const edge of knowsFromBob) await store.edges.knows.delete(edge.id);
      const knowsToBob = await store.edges.knows.findTo({
        kind: "Person",
        id: ids.bobId,
      });
      for (const edge of knowsToBob) await store.edges.knows.delete(edge.id);
      const worksAtFromBob = await store.edges.worksAt.findFrom({
        kind: "Person",
        id: ids.bobId,
      });
      for (const edge of worksAtFromBob)
        await store.edges.worksAt.delete(edge.id);

      await store.nodes.Person.delete(ids.bobId as never);

      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows"],
        maxDepth: 2,
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      expect(nodeIds.has(ids.bobId)).toBe(false);
      // charlie is unreachable since bob (the intermediate node) is deleted
      expect(nodeIds.has(ids.charlieId)).toBe(false);
    });

    it("returns empty for non-existent root", async () => {
      const store = context.getStore();
      const result = await store.subgraph("nonexistent" as never, {
        edges: ["knows"],
        maxDepth: 1,
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it("handles cycles without infinite loops", async () => {
      const store = context.getStore();
      // Create cycle: charlie knows alice
      const charlieRef = { kind: "Person" as const, id: ids.charlieId };
      const aliceRef = { kind: "Person" as const, id: ids.aliceId };
      await store.edges.knows.create(charlieRef, aliceRef, { since: "2022" });

      const result = await store.subgraph(ids.aliceId as never, {
        edges: ["knows"],
        maxDepth: 10,
      });

      // All three people reachable, each visited once
      expect(result.nodes).toHaveLength(3);
    });

    it("returns empty edges when empty edges option", async () => {
      const store = context.getStore();
      const result = await store.subgraph(ids.aliceId as never, {
        edges: [],
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });
  });
}
