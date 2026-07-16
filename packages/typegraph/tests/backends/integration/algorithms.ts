/**
 * Graph Algorithms Integration Tests
 *
 * Tests `store.algorithms.*` and its temporal behavior against the shared
 * integration test graph. Runs against both SQLite and PostgreSQL so the
 * dialect-specific recursive-CTE path encoding (SQLite pipe-delimited
 * strings vs Postgres text arrays), cycle detection, and temporal filter
 * generation all get exercised on each backend.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { GraphAlgorithmConvergenceError } from "../../../src";
import { TEMPORAL_ANCHORS } from "../../test-utils";
import { type IntegrationStore } from "./fixtures";
import { seedKnowsChain } from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

type AlgorithmFixture = Readonly<{
  aliceId: string;
  bobId: string;
  charlieId: string;
  dianaId: string;
  eveId: string;
}>;

async function resolveAlgorithmFixture(
  store: IntegrationStore,
): Promise<AlgorithmFixture> {
  const byName = new Map<string, string>();
  const people = await store.nodes.Person.find();
  for (const person of people) {
    byName.set(person.name, person.id);
  }
  return {
    aliceId: byName.get("Alice")!,
    bobId: byName.get("Bob")!,
    charlieId: byName.get("Charlie")!,
    dianaId: byName.get("Diana")!,
    eveId: byName.get("Eve")!,
  };
}

type TemporalFixture = Readonly<{
  rootId: string;
  activeId: string;
  endedId: string;
  futureId: string;
}>;

async function seedTemporalGraph(
  store: IntegrationStore,
): Promise<TemporalFixture> {
  const { PAST, EDGE_ENDED, FUTURE } = TEMPORAL_ANCHORS;

  const [root, active, ended, future] = await Promise.all([
    store.nodes.Person.create({ name: "Root" }, { validFrom: PAST }),
    store.nodes.Person.create({ name: "Active" }, { validFrom: PAST }),
    store.nodes.Person.create(
      { name: "Ended" },
      { validFrom: PAST, validTo: EDGE_ENDED },
    ),
    store.nodes.Person.create({ name: "Future" }, { validFrom: FUTURE }),
  ]);

  await Promise.all([
    store.edges.knows.create(root, active, {}, { validFrom: PAST }),
    store.edges.knows.create(
      root,
      ended,
      {},
      { validFrom: PAST, validTo: EDGE_ENDED },
    ),
    store.edges.knows.create(root, future, {}),
  ]);

  return {
    rootId: root.id,
    activeId: active.id,
    endedId: ended.id,
    futureId: future.id,
  };
}

export function registerAlgorithmIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Graph Algorithms", () => {
    describe("core behaviors (seedKnowsChain: Alice→Bob→Charlie→Diana→Eve + Alice→Charlie)", () => {
      let ids: AlgorithmFixture;

      beforeEach(async () => {
        const store = context.getStore();
        await seedKnowsChain(store);
        ids = await resolveAlgorithmFixture(store);
      });

      it("shortestPath finds the direct edge, not the longer route", async () => {
        const store = context.getStore();
        const path = await store.algorithms.shortestPath(
          ids.aliceId,
          ids.charlieId,
          { edges: ["knows"] },
        );
        expect(path?.depth).toBe(1);
        expect(path?.nodes.map((n) => n.id)).toEqual([
          ids.aliceId,
          ids.charlieId,
        ]);
      });

      it("shortestPath finds a multi-hop path", async () => {
        const store = context.getStore();
        const path = await store.algorithms.shortestPath(
          ids.aliceId,
          ids.eveId,
          { edges: ["knows"] },
        );
        expect(path?.depth).toBe(3);
        expect(path?.nodes.at(0)?.id).toBe(ids.aliceId);
        expect(path?.nodes.at(-1)?.id).toBe(ids.eveId);
      });

      it("shortestPath returns undefined for an unreachable target", async () => {
        const store = context.getStore();
        const path = await store.algorithms.shortestPath(
          ids.eveId,
          ids.aliceId,
          { edges: ["knows"] },
        );
        expect(path).toBeUndefined();
      });

      it("reachable returns every node reachable from source", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.aliceId, {
          edges: ["knows"],
        });
        const reachedIds = reached.map((r) => r.id).toSorted();
        expect(reachedIds).toEqual(
          [
            ids.aliceId,
            ids.bobId,
            ids.charlieId,
            ids.dianaId,
            ids.eveId,
          ].toSorted(),
        );
      });

      it("reachable respects maxHops", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.aliceId, {
          edges: ["knows"],
          maxHops: 1,
        });
        const reachedIds = reached.map((r) => r.id).toSorted();
        expect(reachedIds).toEqual(
          [ids.aliceId, ids.bobId, ids.charlieId].toSorted(),
        );
      });

      it("canReach returns true for a reachable target", async () => {
        const store = context.getStore();
        const reaches = await store.algorithms.canReach(
          ids.aliceId,
          ids.eveId,
          { edges: ["knows"] },
        );
        expect(reaches).toBe(true);
      });

      it("canReach returns false when no path exists", async () => {
        const store = context.getStore();
        const reaches = await store.algorithms.canReach(
          ids.eveId,
          ids.aliceId,
          { edges: ["knows"] },
        );
        expect(reaches).toBe(false);
      });

      it("neighbors returns the 1-hop neighborhood, source excluded", async () => {
        const store = context.getStore();
        const neighbors = await store.algorithms.neighbors(ids.aliceId, {
          edges: ["knows"],
        });
        const neighborIds = neighbors.map((n) => n.id).toSorted();
        expect(neighborIds).toEqual([ids.bobId, ids.charlieId].toSorted());
      });

      it("degree counts outgoing edges", async () => {
        const store = context.getStore();
        const degree = await store.algorithms.degree(ids.aliceId, {
          edges: ["knows"],
          direction: "out",
        });
        expect(degree).toBe(2);
      });

      it("degree counts edges in both directions (undirected)", async () => {
        const store = context.getStore();
        const degree = await store.algorithms.degree(ids.bobId, {
          edges: ["knows"],
          direction: "both",
        });
        // Alice→Bob (incoming), Bob→Charlie (outgoing)
        expect(degree).toBe(2);
      });
    });

    describe("weaklyConnectedComponents", () => {
      it("returns deterministic memberships, sizes, isolated nodes, and cross-kind identities", async () => {
        const store = context.getStore();
        const [alpha, beta, gamma, company, isolated] = await Promise.all([
          store.nodes.Person.create({ name: "WCC alpha" }, { id: "wcc-A" }),
          store.nodes.Person.create({ name: "WCC beta" }, { id: "wcc-b" }),
          store.nodes.Person.create({ name: "WCC gamma" }, { id: "wcc-c" }),
          store.nodes.Company.create({ name: "WCC company" }, { id: "wcc-b" }),
          store.nodes.Person.create({ name: "WCC isolated" }, { id: "wcc-z" }),
        ]);
        await Promise.all([
          // Reverse the intuitive order to pin weak/undirected semantics.
          store.edges.knows.create(beta, alpha, {}),
          store.edges.knows.create(gamma, beta, {}),
          store.edges.worksAt.create(gamma, company, { role: "Founder" }),
        ]);

        const memberships = await store.algorithms.weaklyConnectedComponents({
          edges: ["knows", "worksAt"],
        });

        expect(memberships).toEqual([
          {
            id: "wcc-A",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 4,
          },
          {
            id: "wcc-b",
            kind: "Company",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 4,
          },
          {
            id: "wcc-b",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 4,
          },
          {
            id: "wcc-c",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 4,
          },
          {
            id: isolated.id,
            kind: "Person",
            componentId: isolated.id,
            componentKind: "Person",
            size: 1,
          },
        ]);

        const personMemberships =
          await store.algorithms.weaklyConnectedComponents({
            edges: ["knows", "worksAt"],
            nodeKinds: ["Person"],
          });
        expect(personMemberships).toEqual([
          {
            id: "wcc-A",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 3,
          },
          {
            id: "wcc-b",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 3,
          },
          {
            id: "wcc-c",
            kind: "Person",
            componentId: "wcc-A",
            componentKind: "Person",
            size: 3,
          },
          {
            id: isolated.id,
            kind: "Person",
            componentId: isolated.id,
            componentKind: "Person",
            size: 1,
          },
        ]);
      });

      it("returns an empty induced subgraph for an empty node-kind scope", async () => {
        const store = context.getStore();
        await store.nodes.Person.create(
          { name: "Outside empty WCC scope" },
          { id: "empty-scope" },
        );

        await expect(
          store.algorithms.weaklyConnectedComponents({
            edges: ["knows"],
            nodeKinds: [],
          }),
        ).resolves.toEqual([]);
      });

      it("honors an explicit workingMemory budget for iterative rounds", async () => {
        // PostgreSQL applies the value as a transaction-scoped work_mem via
        // set_config(..., is_local => true); SQLite validates and ignores it.
        // Results must be identical on both backends either way.
        const store = context.getStore();
        const [left, right] = await Promise.all([
          store.nodes.Person.create({ name: "Memory left" }, { id: "mem-a" }),
          store.nodes.Person.create({ name: "Memory right" }, { id: "mem-b" }),
        ]);
        await store.edges.knows.create(left, right, {});

        const memberships = await store.algorithms.weaklyConnectedComponents({
          edges: ["knows"],
          workingMemory: "32MB",
        });
        const byId = new Map(memberships.map((row) => [row.id, row]));
        expect(byId.get("mem-a")?.componentId).toBe("mem-a");
        expect(byId.get("mem-b")?.componentId).toBe("mem-a");

        const reached = await store.algorithms.reachable("mem-a", {
          edges: ["knows"],
          workingMemory: "32MB",
        });
        expect(reached.map((row) => row.id)).toContain("mem-b");
      });

      it("throws instead of returning partial labels at the iteration limit", async () => {
        const store = context.getStore();
        const [alpha, beta, gamma] = await Promise.all([
          store.nodes.Person.create({ name: "Limit alpha" }, { id: "limit-a" }),
          store.nodes.Person.create({ name: "Limit beta" }, { id: "limit-b" }),
          store.nodes.Person.create({ name: "Limit gamma" }, { id: "limit-c" }),
        ]);
        await Promise.all([
          store.edges.knows.create(alpha, beta, {}),
          store.edges.knows.create(beta, gamma, {}),
        ]);

        await expect(
          store.algorithms.weaklyConnectedComponents({
            edges: ["knows"],
            maxIterations: 1,
          }),
        ).rejects.toBeInstanceOf(GraphAlgorithmConvergenceError);
      });
    });

    describe("dense cyclic graph", () => {
      it("visits each node once instead of enumerating simple paths", async () => {
        const store = context.getStore();
        const people = await store.nodes.Person.bulkCreate(
          Array.from({ length: 9 }, (_, index) => ({
            props: { name: `Dense ${index}` },
          })),
        );
        await store.edges.knows.bulkCreate(
          people.flatMap((from) =>
            people
              .filter((to) => to.id !== from.id)
              .map((to) => ({ from, to, props: { since: "2020" } })),
          ),
        );

        const source = people[0]!;
        const target = people.at(-1)!;
        const reached = await store.algorithms.reachable(source, {
          edges: ["knows"],
          maxHops: 8,
        });
        const neighbors = await store.algorithms.neighbors(source, {
          edges: ["knows"],
          depth: 8,
        });
        const path = await store.algorithms.shortestPath(source, target, {
          edges: ["knows"],
          maxHops: 8,
        });

        expect(reached).toHaveLength(9);
        expect(reached.filter((node) => node.depth === 1)).toHaveLength(8);
        expect(neighbors).toHaveLength(8);
        expect(path).toEqual({
          nodes: [
            { id: source.id, kind: "Person" },
            { id: target.id, kind: "Person" },
          ],
          depth: 1,
        });
        await expect(
          store.algorithms.canReach(source, target, {
            edges: ["knows"],
            maxHops: 8,
          }),
        ).resolves.toBe(true);
      });
    });

    describe("node identity", () => {
      it("keeps different node kinds that share an ID", async () => {
        const store = context.getStore();
        const source = await store.nodes.Person.create(
          { name: "Identity source" },
          { id: "algorithm-identity-source" },
        );
        const person = await store.nodes.Person.create(
          { name: "Shared person" },
          { id: "algorithm-shared-id" },
        );
        const company = await store.nodes.Company.create(
          { name: "Shared company" },
          { id: "algorithm-shared-id" },
        );
        await Promise.all([
          store.edges.knows.create(source, person, {}),
          store.edges.worksAt.create(source, company, { role: "Founder" }),
        ]);

        const reached = await store.algorithms.reachable(source, {
          edges: ["knows", "worksAt"],
          maxHops: 1,
          excludeSource: true,
        });

        expect(reached).toEqual([
          { id: "algorithm-shared-id", kind: "Company", depth: 1 },
          { id: "algorithm-shared-id", kind: "Person", depth: 1 },
        ]);
      });
    });

    describe("temporal behavior", () => {
      const { BEFORE } = TEMPORAL_ANCHORS;
      let ids: TemporalFixture;

      beforeEach(async () => {
        const store = context.getStore();
        ids = await seedTemporalGraph(store);
      });

      it("reachable defaults to current mode", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.rootId, {
          edges: ["knows"],
          excludeSource: true,
        });
        const reachedIds = reached.map((r) => r.id).toSorted();
        expect(reachedIds).toEqual([ids.activeId].toSorted());
      });

      it("reachable under asOf surfaces historically-valid rows", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.rootId, {
          edges: ["knows"],
          excludeSource: true,
          temporalMode: "asOf",
          asOf: BEFORE,
        });
        const reachedIds = reached.map((r) => r.id);
        expect(reachedIds).toContain(ids.activeId);
        expect(reachedIds).toContain(ids.endedId);
        expect(reachedIds).not.toContain(ids.futureId);
      });

      it("exposes WCC through the StoreView algorithms facade", async () => {
        const store = context.getStore();
        const current = await store.algorithms.weaklyConnectedComponents({
          edges: ["knows"],
        });
        const historical = await store
          .asOf(BEFORE)
          .algorithms.weaklyConnectedComponents({ edges: ["knows"] });

        const currentRoot = current.find((row) => row.id === ids.rootId);
        const historicalRoot = historical.find((row) => row.id === ids.rootId);
        expect(currentRoot?.size).toBe(2);
        expect(historicalRoot?.size).toBe(3);
        expect(historical.some((row) => row.id === ids.endedId)).toBe(true);
        expect(historical.some((row) => row.id === ids.futureId)).toBe(false);
      });

      it("reachable under includeEnded includes validity-ended nodes and edges", async () => {
        const store = context.getStore();
        const reached = await store.algorithms.reachable(ids.rootId, {
          edges: ["knows"],
          excludeSource: true,
          temporalMode: "includeEnded",
        });
        const reachedIds = reached.map((r) => r.id).toSorted();
        expect(reachedIds).toEqual(
          [ids.activeId, ids.endedId, ids.futureId].toSorted(),
        );
      });

      it("shortestPath under asOf traverses the historical edge", async () => {
        const store = context.getStore();
        const path = await store.algorithms.shortestPath(
          ids.rootId,
          ids.endedId,
          { edges: ["knows"], temporalMode: "asOf", asOf: BEFORE },
        );
        expect(path?.depth).toBe(1);
        expect(path?.nodes.at(-1)?.id).toBe(ids.endedId);
      });

      it("canReach self-path honors the resolved temporal filter", async () => {
        const store = context.getStore();
        // Future node is not visible under current mode — canReach(a, a)
        // should return false, matching shortestPath(a, a).
        const currentSelf = await store.algorithms.canReach(
          ids.futureId,
          ids.futureId,
          { edges: ["knows"] },
        );
        expect(currentSelf).toBe(false);

        const endedSelf = await store.algorithms.canReach(
          ids.futureId,
          ids.futureId,
          { edges: ["knows"], temporalMode: "includeEnded" },
        );
        expect(endedSelf).toBe(true);
      });

      it("degree honors temporalMode for the edge count", async () => {
        const store = context.getStore();
        // Current mode excludes only the expired root→ended edge. The
        // root→future edge (no explicit validFrom) defaults to "now" at
        // creation, so it's already valid.
        const current = await store.algorithms.degree(ids.rootId, {
          edges: ["knows"],
          direction: "out",
        });
        expect(current).toBe(2);

        // includeEnded lifts the validity filter and counts all three edges.
        const ended = await store.algorithms.degree(ids.rootId, {
          edges: ["knows"],
          direction: "out",
          temporalMode: "includeEnded",
        });
        expect(ended).toBe(3);
      });

      it("rejects temporalMode: 'asOf' without asOf timestamp", async () => {
        const store = context.getStore();
        await expect(
          store.algorithms.reachable(ids.rootId, {
            edges: ["knows"],
            temporalMode: "asOf",
          }),
        ).rejects.toThrow(/asOf/);
      });
    });
  });
}
