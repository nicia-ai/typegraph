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
    byName.set(person.name, person.id as string);
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
    rootId: root.id as string,
    activeId: active.id as string,
    endedId: ended.id as string,
    futureId: future.id as string,
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
