/**
 * Subgraph Integration Tests
 *
 * Tests store.subgraph() against the shared integration test graph.
 * Runs against both SQLite and PostgreSQL via the integration test suite.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { indexSubgraph } from "../../../src";
import { ValidationError } from "../../../src/errors";
import { requireDefined } from "../../../src/utils/presence";
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
type SubgraphTestStore = ReturnType<IntegrationTestContext["getStore"]>;
type PersonNode = Awaited<
  ReturnType<SubgraphTestStore["nodes"]["Person"]["create"]>
>;
type CompanyNode = Awaited<
  ReturnType<SubgraphTestStore["nodes"]["Company"]["create"]>
>;

async function seedSubgraphData(store: SubgraphTestStore): Promise<{
  alice: PersonNode;
  bob: PersonNode;
  charlie: PersonNode;
  acme: CompanyNode;
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

  await store.edges.knows.create(
    alice,
    bob,
    { since: "2020" },
    { id: "knows-alice-bob" },
  );
  await store.edges.knows.create(
    bob,
    charlie,
    { since: "2021" },
    { id: "knows-bob-charlie" },
  );
  await store.edges.worksAt.create(alice, acme, { role: "Engineer" });
  await store.edges.worksAt.create(bob, acme, { role: "Manager" });

  return { alice, bob, charlie, acme };
}

export function registerSubgraphIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Subgraph Extraction", () => {
    let seeded: Awaited<ReturnType<typeof seedSubgraphData>>;

    beforeEach(async () => {
      const store = context.getStore();
      seeded = await seedSubgraphData(store);
    });

    it("extracts immediate neighbors", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows"],
        maxDepth: 1,
      });

      const names = result.nodes
        .map((node) => (node as { name: string }).name)
        .toSorted();
      expect(names).toContain("Alice");
      expect(names).toContain("Bob");
      expect(names).not.toContain("Charlie");
    });

    it("follows multi-hop paths", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows"],
        maxDepth: 2,
      });
      const index = indexSubgraph(result);

      expect(index.node(seeded.alice)).toBeDefined();
      expect(index.node(seeded.bob)).toBeDefined();
      expect(index.node(seeded.charlie)).toBeDefined();
    });

    it("applies per-edge-kind ordering and limits during traversal", async () => {
      const store = context.getStore();
      const dave = await store.nodes.Person.create({ name: "Dave" });
      await store.edges.knows.create(
        { kind: "Person", id: seeded.alice.id },
        dave,
        {},
        { id: "zzzz-alice-dave" },
      );

      const result = await store.subgraph(seeded.alice, {
        edges: ["knows"],
        maxDepth: 2,
        edgeWindows: {
          knows: {
            limit: 1,
            orderBy: { field: "id", direction: "desc" },
          },
        },
      });
      const index = indexSubgraph(result);

      expect(index.node(dave)).toBeDefined();
      expect(index.node(seeded.bob)).toBeUndefined();
      expect(index.outgoing(seeded.alice, "knows")).toHaveLength(1);
    });

    it("partitions edge windows independently at later hops", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows"],
        maxDepth: 2,
        edgeWindows: {
          knows: { limit: 1, orderBy: { field: "id", direction: "asc" } },
        },
      });
      const index = indexSubgraph(result);

      expect(index.node(seeded.bob)).toBeDefined();
      expect(index.node(seeded.charlie)).toBeDefined();
      expect(index.outgoing(seeded.bob, "knows")).toHaveLength(1);
    });

    it("keeps unwindowed kinds and supports per-kind traversal directions", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows", "worksAt"],
        maxDepth: 1,
        edgeWindows: { knows: { limit: 1 } },
      });
      const index = indexSubgraph(result);

      expect(index.node(seeded.bob)).toBeDefined();
      expect(index.node(seeded.acme)).toBeDefined();
      const incoming = await store.subgraph(seeded.bob, {
        edges: ["knows", "worksAt"],
        edgeWindows: {
          knows: { direction: "in", limit: 1 },
          worksAt: { direction: "out", limit: 1 },
        },
      });
      const incomingIndex = indexSubgraph(incoming);
      expect(incomingIndex.node(seeded.alice)).toBeDefined();
      expect(incomingIndex.node(seeded.acme)).toBeDefined();

      const both = await store.subgraph(seeded.bob, {
        edges: ["knows"],
        direction: "both",
        edgeWindows: { knows: { limit: 1 } },
      });
      const bothIndex = indexSubgraph(both);
      expect(bothIndex.node(seeded.alice)).toBeDefined();
      expect(bothIndex.node(seeded.charlie)).toBeDefined();
      await expect(
        store.subgraph(seeded.alice, {
          edges: ["knows"],
          edgeWindows: { worksAt: { limit: 1 } } as never,
        }),
      ).rejects.toThrow("must name a traversed edge kind");
    });

    it("follows multiple edge kinds", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
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
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows", "worksAt"],
        maxDepth: 3,
      });

      const companyNodes = result.nodes.filter(
        (node) => node.kind === "Company",
      );
      expect(companyNodes).toHaveLength(1);
    });

    it("filters with includeKinds", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows", "worksAt"],
        maxDepth: 2,
        includeKinds: ["Company"],
      });

      for (const node of result.nodes) {
        expect(node.kind).toBe("Company");
      }
      expect(result.nodes.length).toBe(1);
    });

    it("excludes root", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows"],
        maxDepth: 1,
        excludeRoot: true,
      });
      const index = indexSubgraph(result);

      expect(index.node(seeded.alice)).toBeUndefined();
      expect(result.nodes.length).toBe(1);
    });

    it("handles bidirectional traversal", async () => {
      const store = context.getStore();
      // Starting from bob, traverse knows in both directions
      const result = await store.subgraph(seeded.bob, {
        edges: ["knows"],
        maxDepth: 1,
        direction: "both",
      });
      const index = indexSubgraph(result);

      // Outbound: bob → charlie
      expect(index.node(seeded.charlie)).toBeDefined();
      // Inbound: alice → bob (reversed)
      expect(index.node(seeded.alice)).toBeDefined();
    });

    it("returns edges only when both endpoints are in result", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows", "worksAt"],
        maxDepth: 2,
        includeKinds: ["Person"],
      });
      const index = indexSubgraph(result);

      const allEdges = result.edges;
      for (const edge of allEdges) {
        expect(
          index.node({ kind: edge.fromKind, id: edge.fromId }),
        ).toBeDefined();
        expect(index.node({ kind: edge.toKind, id: edge.toId })).toBeDefined();
      }

      // worksAt edges connect Person→Company, but Company is excluded
      const edgeKinds = new Set(allEdges.map((edge) => edge.kind));
      expect(edgeKinds.has("worksAt")).toBe(false);
      // knows edges connect Person→Person, both in result
      expect(edgeKinds.has("knows")).toBe(true);
    });

    it("excludes soft-deleted nodes", async () => {
      const store = context.getStore();

      // Delete edges connected to bob first (restrict policy)
      const knowsFromBob = await store.edges.knows.findFrom({
        kind: "Person",
        id: seeded.bob.id,
      });
      for (const edge of knowsFromBob) await store.edges.knows.delete(edge.id);
      const knowsToBob = await store.edges.knows.findTo({
        kind: "Person",
        id: seeded.bob.id,
      });
      for (const edge of knowsToBob) await store.edges.knows.delete(edge.id);
      const worksAtFromBob = await store.edges.worksAt.findFrom({
        kind: "Person",
        id: seeded.bob.id,
      });
      for (const edge of worksAtFromBob)
        await store.edges.worksAt.delete(edge.id);

      await store.nodes.Person.delete(seeded.bob.id);

      const result = await store.subgraph(seeded.alice, {
        edges: ["knows"],
        maxDepth: 2,
      });
      const index = indexSubgraph(result);

      expect(index.node(seeded.bob)).toBeUndefined();
      // charlie is unreachable since bob (the intermediate node) is deleted
      expect(index.node(seeded.charlie)).toBeUndefined();
    });

    it("returns empty for non-existent root", async () => {
      const store = context.getStore();
      const result = await store.subgraph(
        { kind: "Person", id: "nonexistent" } as never,
        {
          edges: ["knows"],
          maxDepth: 1,
        },
      );

      expect(result.root).toBeUndefined();
      expect(result.nodes.length).toBe(0);
    });

    it("handles cycles without infinite loops", async () => {
      const store = context.getStore();
      // Create cycle: charlie knows alice
      const charlieRef = { kind: "Person" as const, id: seeded.charlie.id };
      const aliceRef = { kind: "Person" as const, id: seeded.alice.id };
      await store.edges.knows.create(charlieRef, aliceRef, { since: "2022" });

      const result = await store.subgraph(seeded.alice, {
        edges: ["knows"],
        maxDepth: 10,
      });

      // All three people reachable, each visited once
      expect(result.nodes.length).toBe(3);
    });

    it("returns only root when empty edges option", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: [],
      });

      expect(result.root).toBeDefined();
      expect(requireDefined(result.root).id).toBe(seeded.alice.id);
      expect(result.nodes.length).toBe(1);
      expect(result.edges).toHaveLength(0);
    });

    it("validates traversal options identically for direct and batched reads", async () => {
      const store = context.getStore();
      const rootOnly = await store.subgraph(seeded.alice, {
        edges: ["knows"],
        maxDepth: 0,
      });
      expect(rootOnly.nodes.length).toBe(1);

      const invalidOptions = [
        { edges: ["knows"], maxDepth: -1 },
        { edges: ["knows"], maxDepth: 1.5 },
        { edges: ["knows"], maxDepth: Number.POSITIVE_INFINITY },
        { edges: ["knows"], maxDepth: 1001 },
        { edges: ["knows"], direction: "in" },
        { edges: ["knows"], cyclePolicy: "ignore" },
      ] as const;
      for (const options of invalidOptions) {
        await expect(
          store.subgraph(seeded.alice, options as never),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
          store.batchOnce((read) => [
            read.subgraph(seeded.alice, options as never),
          ]),
        ).rejects.toBeInstanceOf(ValidationError);
      }
    });

    it("projects node and edge fields across backends", async () => {
      const store = context.getStore();
      const result = await store.subgraph(seeded.alice, {
        edges: ["knows", "worksAt"],
        maxDepth: 1,
        project: {
          nodes: {
            Person: ["name"],
            Company: ["name", "meta"],
          },
          edges: {
            knows: [],
            worksAt: ["role"],
          },
        },
      });

      const nodes = result.nodes;
      const people = nodes.filter((node) => node.kind === "Person");
      const companies = nodes.filter((node) => node.kind === "Company");

      expect(people.length).toBeGreaterThan(0);
      for (const person of people) {
        expect(person).toHaveProperty("id");
        expect(person).toHaveProperty("name");
        expect(person).not.toHaveProperty("age");
        expect(person).not.toHaveProperty("meta");
      }

      expect(companies).toHaveLength(1);
      expect(companies[0]).toHaveProperty("name", "Acme");
      expect(companies[0]).toHaveProperty("meta.createdAt");
      expect(companies[0]).toHaveProperty("meta.updatedAt");
      expect(companies[0]).not.toHaveProperty("industry");

      const allEdges = result.edges;
      const worksAtEdges = allEdges.filter(
        (edge): edge is Extract<typeof edge, { kind: "worksAt" }> =>
          edge.kind === "worksAt",
      );
      const knowsEdges = allEdges.filter(
        (edge): edge is Extract<typeof edge, { kind: "knows" }> =>
          edge.kind === "knows",
      );

      expect(worksAtEdges).toHaveLength(2);
      expect(worksAtEdges.map((edge) => edge.role).toSorted()).toEqual([
        "Engineer",
        "Manager",
      ]);
      for (const edge of worksAtEdges) {
        expect(edge).toHaveProperty("toId", seeded.acme.id);
        expect(edge).not.toHaveProperty("meta");
      }

      expect(knowsEdges).toHaveLength(1);
      expect(knowsEdges[0]).toHaveProperty("fromId", seeded.alice.id);
      expect(knowsEdges[0]).toHaveProperty("toId", seeded.bob.id);
      expect(knowsEdges[0]).not.toHaveProperty("meta");
    });

    it("keeps direct and one-statement subgraph reads semantically equivalent", async () => {
      const store = context.getStore();
      const options = {
        edges: ["knows", "worksAt"],
        maxDepth: 2,
        edgeWindows: {
          knows: {
            direction: "both",
            limit: 1,
            orderBy: { field: "id", direction: "asc" },
          },
        },
        project: {
          nodes: {
            Person: ["name"],
            Company: ["name", "meta"],
          },
          edges: {
            knows: [],
            worksAt: ["role"],
          },
        },
      } as const;

      const direct = await store.subgraph(seeded.bob, options);
      const [oneStatement, count] = await store.batchOnce((read) => [
        read.subgraph(seeded.bob, options),
        read.countNeighbors(
          { kind: "Person", id: seeded.bob.id },
          { edges: ["knows"] },
        ),
      ]);

      expect({
        root: oneStatement.root,
        nodes: oneStatement.nodes,
        edges: oneStatement.edges,
      }).toEqual({
        root: direct.root,
        nodes: direct.nodes,
        edges: direct.edges,
      });
      expect(count).toBeGreaterThan(0);
      const edgeIds = oneStatement.edges.map((edge) => edge.id);
      expect(edgeIds).toHaveLength(4);
      expect(new Set(edgeIds).size).toBe(edgeIds.length);
    });

    it("keeps overlapping, duplicate, and missing runtime subgraphs independent", async () => {
      const store = context.getStore();
      const roots = [
        seeded.alice,
        seeded.bob,
        seeded.alice,
        { kind: "Person", id: "missing-subgraph-root" },
      ];
      const results = await store.batchOnce((read) =>
        roots.map((rootRef) =>
          read.subgraph(rootRef as never, {
            edges: ["knows", "worksAt"],
            maxDepth: 2,
            edgeWindows: {
              knows: {
                limit: 1,
                orderBy: { field: "id", direction: "asc" },
              },
            },
            project: {
              nodes: { Person: ["name"], Company: ["name"] },
              edges: { knows: [], worksAt: ["role"] },
            },
          }),
        ),
      );

      expect(results).toHaveLength(4);
      expect(results[0]).toEqual(results[2]);
      expect(results[0]).not.toBe(results[2]);
      expect(
        indexSubgraph(requireDefined(results[0])).node(seeded.acme),
      ).toBeDefined();
      expect(
        indexSubgraph(requireDefined(results[1])).node(seeded.acme),
      ).toBeDefined();
      expect(results[3]?.root).toBeUndefined();
      expect(results[3]?.nodes.length).toBe(0);
      expect(results[3]?.edges).toHaveLength(0);
    });
  });
}
