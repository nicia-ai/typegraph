/**
 * Graph algorithm tests.
 *
 * Exercises `store.algorithms.{shortestPath, reachable, canReach,
 * neighbors, degree}` against the SQLite backend with a fixture that
 * includes branching paths, cycles, self-loops, and disconnected regions.
 */
import { sql as drizzleSql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type {
  AdoptedTransaction,
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../src/backend/types";
import type { NodeId } from "../src/core/types";
import {
  ConfigurationError,
  GraphAlgorithmConvergenceError,
  ValidationError,
} from "../src/errors";
import type {
  CompiledRowsSql,
  CompiledTemporaryStatementSql,
} from "../src/query/sql-intent";
import { createStore, type Store } from "../src/store";
import {
  collectAllEdges,
  createTestBackend,
  TEMPORAL_ANCHORS,
} from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Task = defineNode("Task", {
  schema: z.object({ title: z.string() }),
});

const knows = defineEdge("knows", { schema: z.object({}) });
const reportsTo = defineEdge("reports_to", { schema: z.object({}) });
const dependsOn = defineEdge("depends_on", { schema: z.object({}) });
const road = defineEdge("road", {
  schema: z.object({
    cost: z.number().optional(),
    note: z.string().optional(),
  }),
});

const testGraph = defineGraph({
  id: "algorithms_test",
  nodes: {
    Person: { type: Person },
    Task: { type: Task },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    reports_to: { type: reportsTo, from: [Person], to: [Person] },
    depends_on: { type: dependsOn, from: [Task], to: [Task] },
    road: { type: road, from: [Person], to: [Person, Task] },
  },
});

type TestGraph = typeof testGraph;

// ============================================================
// Fixture
// ============================================================
//
// People graph (directed "knows"):
//   alice --> bob --> charlie --> dave
//               \          ^
//                \         |
//                 +---> eve (knows charlie)
//   frank (isolated — no edges)
//
// Cycle component:
//   xavier <-> yves  (two-node cycle via "knows")
//
// Self-loop:
//   narcissus --> narcissus (knows)
//
// Reports-to (different edge kind):
//   bob reports_to alice
//   charlie reports_to bob
//
// Task dependency DAG:
//   t1 --> t2 --> t3
//           \--> t4

type Fixture = Readonly<{
  alice: string;
  bob: string;
  charlie: string;
  dave: string;
  eve: string;
  frank: string;
  xavier: string;
  yves: string;
  narcissus: string;
  t1: string;
  t2: string;
  t3: string;
  t4: string;
}>;

async function seed(store: Store<TestGraph>): Promise<Fixture> {
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  const charlie = await store.nodes.Person.create({ name: "Charlie" });
  const dave = await store.nodes.Person.create({ name: "Dave" });
  const eve = await store.nodes.Person.create({ name: "Eve" });
  const frank = await store.nodes.Person.create({ name: "Frank" });
  const xavier = await store.nodes.Person.create({ name: "Xavier" });
  const yves = await store.nodes.Person.create({ name: "Yves" });
  const narcissus = await store.nodes.Person.create({ name: "Narcissus" });

  await store.edges.knows.create(alice, bob, {});
  await store.edges.knows.create(bob, charlie, {});
  await store.edges.knows.create(charlie, dave, {});
  await store.edges.knows.create(bob, eve, {});
  await store.edges.knows.create(eve, charlie, {});

  // Cycle component.
  await store.edges.knows.create(xavier, yves, {});
  await store.edges.knows.create(yves, xavier, {});

  // Self-loop.
  await store.edges.knows.create(narcissus, narcissus, {});

  // Reports-to (different edge kind).
  await store.edges.reports_to.create(bob, alice, {});
  await store.edges.reports_to.create(charlie, bob, {});

  // Task DAG.
  const t1 = await store.nodes.Task.create({ title: "T1" });
  const t2 = await store.nodes.Task.create({ title: "T2" });
  const t3 = await store.nodes.Task.create({ title: "T3" });
  const t4 = await store.nodes.Task.create({ title: "T4" });

  await store.edges.depends_on.create(t1, t2, {});
  await store.edges.depends_on.create(t2, t3, {});
  await store.edges.depends_on.create(t2, t4, {});

  return {
    alice: alice.id,
    bob: bob.id,
    charlie: charlie.id,
    dave: dave.id,
    eve: eve.id,
    frank: frank.id,
    xavier: xavier.id,
    yves: yves.id,
    narcissus: narcissus.id,
    t1: t1.id,
    t2: t2.id,
    t3: t3.id,
    t4: t4.id,
  };
}

/**
 * Counts every statement (row-returning and temporary) issued inside a
 * traversal's transaction, so a reintroduced per-round COUNT or meeting
 * probe fails the round-trip budget tests instead of silently doubling
 * round-trips.
 */
function createCountingBackend(
  backend: GraphBackend,
  collected: string[],
): GraphBackend {
  return {
    ...backend,
    transaction<T>(
      fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      return backend.transaction(async (tx, adoptedTransaction) => {
        const observedTransaction: TransactionBackend = {
          ...tx,
          execute<Result>(query: CompiledRowsSql): Promise<readonly Result[]> {
            collected.push(backend.compileSql!(query).sql);
            return tx.execute<Result>(query);
          },
          async executeTemporaryStatement(
            query: CompiledTemporaryStatementSql,
          ): Promise<void> {
            collected.push(backend.compileSql!(query).sql);
            await tx.executeTemporaryStatement!(query);
          },
        };
        return fn(observedTransaction, adoptedTransaction);
      }, options);
    },
  };
}

// ============================================================
// Test Setup
// ============================================================

describe("store.algorithms", () => {
  let backend: GraphBackend;
  let store: Store<TestGraph>;
  let ids: Fixture;

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);
    ids = await seed(store);
  });

  // --------------------------------------------------------------
  // shortestPath
  // --------------------------------------------------------------

  describe("shortestPath", () => {
    it("returns a direct single-hop path", async () => {
      const path = await store.algorithms.shortestPath(ids.alice, ids.bob, {
        edges: ["knows"],
      });

      expect(path).toBeDefined();
      expect(path?.depth).toBe(1);
      expect(path?.nodes.map((node) => node.id)).toEqual([ids.alice, ids.bob]);
      expect(path?.nodes.every((node) => node.kind === "Person")).toBe(true);
    });

    it("prefers a shorter path when multiple routes exist", async () => {
      // alice -> bob -> charlie is 2 hops.
      // alice -> bob -> eve -> charlie is 3 hops.
      const path = await store.algorithms.shortestPath(ids.alice, ids.charlie, {
        edges: ["knows"],
      });

      expect(path?.depth).toBe(2);
      expect(path?.nodes.map((node) => node.id)).toEqual([
        ids.alice,
        ids.bob,
        ids.charlie,
      ]);
    });

    it("returns undefined when the target is unreachable", async () => {
      const path = await store.algorithms.shortestPath(ids.alice, ids.frank, {
        edges: ["knows"],
      });
      expect(path).toBeUndefined();
    });

    it("returns a zero-length path when source equals target", async () => {
      const path = await store.algorithms.shortestPath(ids.alice, ids.alice, {
        edges: ["knows"],
      });
      expect(path).toEqual({
        depth: 0,
        nodes: [{ id: ids.alice, kind: "Person" }],
      });
    });

    it("respects maxHops", async () => {
      const shallow = await store.algorithms.shortestPath(ids.alice, ids.dave, {
        edges: ["knows"],
        maxHops: 2,
      });
      expect(shallow).toBeUndefined();

      const deeper = await store.algorithms.shortestPath(ids.alice, ids.dave, {
        edges: ["knows"],
        maxHops: 3,
      });
      expect(deeper?.depth).toBe(3);
    });

    it("traverses reverse edges when direction is 'in'", async () => {
      const path = await store.algorithms.shortestPath(ids.bob, ids.alice, {
        edges: ["knows"],
        direction: "in",
      });
      expect(path?.depth).toBe(1);
      expect(path?.nodes.map((node) => node.id)).toEqual([ids.bob, ids.alice]);
    });

    it("treats edges as undirected when direction is 'both'", async () => {
      const path = await store.algorithms.shortestPath(ids.dave, ids.alice, {
        edges: ["knows"],
        direction: "both",
      });
      expect(path?.depth).toBe(3);
    });

    it("tolerates cycles with the default cyclePolicy", async () => {
      const path = await store.algorithms.shortestPath(ids.xavier, ids.yves, {
        edges: ["knows"],
      });
      expect(path?.depth).toBe(1);
    });

    it("restricts traversal to the specified edge kinds", async () => {
      const viaKnows = await store.algorithms.shortestPath(
        ids.charlie,
        ids.alice,
        { edges: ["knows"] },
      );
      expect(viaKnows).toBeUndefined();

      const viaReports = await store.algorithms.shortestPath(
        ids.charlie,
        ids.alice,
        { edges: ["reports_to"] },
      );
      expect(viaReports?.depth).toBe(2);
    });

    it("accepts node objects in addition to raw ids", async () => {
      const alice = await store.nodes.Person.getById(
        ids.alice as NodeId<typeof Person>,
      );
      const bob = await store.nodes.Person.getById(
        ids.bob as NodeId<typeof Person>,
      );
      const path = await store.algorithms.shortestPath(alice!, bob!, {
        edges: ["knows"],
      });
      expect(path?.depth).toBe(1);
    });
  });

  // --------------------------------------------------------------
  // weightedShortestPath
  // --------------------------------------------------------------

  describe("weightedShortestPath", () => {
    type RoadFixture = Readonly<{
      a: string;
      b: string;
      c: string;
      d: string;
    }>;

    /**
     * Weighted road network:
     *   a --(5)--> c            expensive direct road
     *   a --(1)--> b --(1)--> c cheap detour
     *   c --(2)--> d
     * `d` has no outgoing roads; nothing reaches `a`.
     */
    async function seedRoads(): Promise<RoadFixture> {
      const a = await store.nodes.Person.create({ name: "RoadA" });
      const b = await store.nodes.Person.create({ name: "RoadB" });
      const c = await store.nodes.Person.create({ name: "RoadC" });
      const d = await store.nodes.Person.create({ name: "RoadD" });
      await store.edges.road.create(a, c, { cost: 5 });
      await store.edges.road.create(a, b, { cost: 1 });
      await store.edges.road.create(b, c, { cost: 1 });
      await store.edges.road.create(c, d, { cost: 2 });
      return { a: a.id, b: b.id, c: c.id, d: d.id };
    }

    it("prefers a cheaper multi-hop path over an expensive direct edge", async () => {
      const roads = await seedRoads();
      const path = await store.algorithms.weightedShortestPath(
        roads.a,
        roads.c,
        { edges: ["road"], weightProperty: "cost" },
      );
      expect(path?.totalWeight).toBe(2);
      expect(path?.depth).toBe(2);
      expect(path?.nodes.map((node) => node.id)).toEqual([
        roads.a,
        roads.b,
        roads.c,
      ]);

      const unweighted = await store.algorithms.shortestPath(roads.a, roads.c, {
        edges: ["road"],
      });
      expect(unweighted?.depth).toBe(1);
    });

    it("accumulates weights across longer paths", async () => {
      const roads = await seedRoads();
      const path = await store.algorithms.weightedShortestPath(
        roads.a,
        roads.d,
        { edges: ["road"], weightProperty: "cost" },
      );
      expect(path?.totalWeight).toBe(4);
      expect(path?.depth).toBe(3);
      expect(path?.nodes.map((node) => node.id)).toEqual([
        roads.a,
        roads.b,
        roads.c,
        roads.d,
      ]);
    });

    it("uses the cheapest of parallel edges between the same endpoints", async () => {
      const a = await store.nodes.Person.create({ name: "ParallelA" });
      const b = await store.nodes.Person.create({ name: "ParallelB" });
      await store.edges.road.create(a, b, { cost: 9 });
      await store.edges.road.create(a, b, { cost: 3 });

      const path = await store.algorithms.weightedShortestPath(a, b, {
        edges: ["road"],
        weightProperty: "cost",
      });
      expect(path?.totalWeight).toBe(3);
      expect(path?.depth).toBe(1);
    });

    it("supports zero-weight edges, including zero-weight cycles", async () => {
      const a = await store.nodes.Person.create({ name: "ZeroA" });
      const b = await store.nodes.Person.create({ name: "ZeroB" });
      const c = await store.nodes.Person.create({ name: "ZeroC" });
      await store.edges.road.create(a, b, { cost: 0 });
      await store.edges.road.create(b, a, { cost: 0 });
      await store.edges.road.create(b, c, { cost: 1 });

      const path = await store.algorithms.weightedShortestPath(a, c, {
        edges: ["road"],
        weightProperty: "cost",
      });
      expect(path?.totalWeight).toBe(1);
      expect(path?.nodes.map((node) => node.id)).toEqual([a.id, b.id, c.id]);
    });

    it("returns a zero-weight self path", async () => {
      const roads = await seedRoads();
      const path = await store.algorithms.weightedShortestPath(
        roads.a,
        roads.a,
        { edges: ["road"], weightProperty: "cost" },
      );
      expect(path?.totalWeight).toBe(0);
      expect(path?.depth).toBe(0);
      expect(path?.nodes.map((node) => node.id)).toEqual([roads.a]);
    });

    it("returns undefined when the target is unreachable", async () => {
      const roads = await seedRoads();
      const path = await store.algorithms.weightedShortestPath(
        roads.d,
        roads.a,
        { edges: ["road"], weightProperty: "cost" },
      );
      expect(path).toBeUndefined();
    });

    it("follows direction 'in' and 'both'", async () => {
      const roads = await seedRoads();
      const inbound = await store.algorithms.weightedShortestPath(
        roads.c,
        roads.a,
        { edges: ["road"], weightProperty: "cost", direction: "in" },
      );
      expect(inbound?.totalWeight).toBe(2);
      expect(inbound?.nodes.map((node) => node.id)).toEqual([
        roads.c,
        roads.b,
        roads.a,
      ]);

      const undirected = await store.algorithms.weightedShortestPath(
        roads.d,
        roads.a,
        { edges: ["road"], weightProperty: "cost", direction: "both" },
      );
      expect(undirected?.totalWeight).toBe(4);
    });

    it("throws InvalidEdgeWeightError for a missing weight without defaultWeight", async () => {
      const a = await store.nodes.Person.create({ name: "MissingA" });
      const b = await store.nodes.Person.create({ name: "MissingB" });
      await store.edges.road.create(a, b, {});

      await expect(
        store.algorithms.weightedShortestPath(a, b, {
          edges: ["road"],
          weightProperty: "cost",
        }),
      ).rejects.toMatchObject({
        name: "InvalidEdgeWeightError",
        details: { reason: "missing", property: "cost" },
      });
    });

    it("substitutes defaultWeight for edges missing the property", async () => {
      const a = await store.nodes.Person.create({ name: "DefaultA" });
      const b = await store.nodes.Person.create({ name: "DefaultB" });
      const c = await store.nodes.Person.create({ name: "DefaultC" });
      await store.edges.road.create(a, b, {});
      await store.edges.road.create(b, c, { cost: 2 });

      const path = await store.algorithms.weightedShortestPath(a, c, {
        edges: ["road"],
        weightProperty: "cost",
        defaultWeight: 7,
      });
      expect(path?.totalWeight).toBe(9);
    });

    it("bounds defaultWeight like stored weights so missing-weight sums cannot overflow", async () => {
      const maxEdgeWeight = Number.MAX_VALUE / 2 ** 64;
      const a = await store.nodes.Person.create({ name: "BoundA" });
      const b = await store.nodes.Person.create({ name: "BoundB" });
      const c = await store.nodes.Person.create({ name: "BoundC" });
      await store.edges.road.create(a, b, {});
      await store.edges.road.create(b, c, {});

      // Above the audit bound: rejected up front, before any SQL runs —
      // otherwise two defaulted hops at MAX_VALUE would overflow float8 on
      // PostgreSQL (raw 22003) while SQLite returned Infinity.
      await expect(
        store.algorithms.weightedShortestPath(a, c, {
          edges: ["road"],
          weightProperty: "cost",
          defaultWeight: Number.MAX_VALUE,
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);

      // At the exact bound: accepted, and the two-hop sum stays finite.
      const path = await store.algorithms.weightedShortestPath(a, c, {
        edges: ["road"],
        weightProperty: "cost",
        defaultWeight: maxEdgeWeight,
      });
      expect(path?.totalWeight).toBe(maxEdgeWeight * 2);
      expect(Number.isFinite(path?.totalWeight)).toBe(true);
    });

    it("throws InvalidEdgeWeightError for a negative weight anywhere in the selected kinds", async () => {
      const roads = await seedRoads();
      const x = await store.nodes.Person.create({ name: "NegativeX" });
      const y = await store.nodes.Person.create({ name: "NegativeY" });
      await store.edges.road.create(x, y, { cost: -1 });

      // The offending edge is not even reachable from the queried source —
      // the audit is global over the selected kinds, so the failure is
      // deterministic regardless of traversal order.
      await expect(
        store.algorithms.weightedShortestPath(roads.a, roads.c, {
          edges: ["road"],
          weightProperty: "cost",
        }),
      ).rejects.toMatchObject({
        name: "InvalidEdgeWeightError",
        details: { reason: "negative" },
      });
    });

    it("throws InvalidEdgeWeightError for a non-numeric weight property", async () => {
      const a = await store.nodes.Person.create({ name: "TextA" });
      const b = await store.nodes.Person.create({ name: "TextB" });
      await store.edges.road.create(a, b, { cost: 1, note: "scenic" });

      await expect(
        store.algorithms.weightedShortestPath(a, b, {
          edges: ["road"],
          weightProperty: "note",
        }),
      ).rejects.toMatchObject({
        name: "InvalidEdgeWeightError",
        details: { reason: "non_numeric", value: "scenic" },
      });
    });

    it("supports fractional weights with double-precision totals", async () => {
      const a = await store.nodes.Person.create({ name: "FracA" });
      const b = await store.nodes.Person.create({ name: "FracB" });
      const c = await store.nodes.Person.create({ name: "FracC" });
      await store.edges.road.create(a, b, { cost: 0.1 });
      await store.edges.road.create(b, c, { cost: 0.2 });

      const path = await store.algorithms.weightedShortestPath(a, c, {
        edges: ["road"],
        weightProperty: "cost",
      });
      expect(path?.totalWeight).toBe(0.1 + 0.2);
    });

    it("throws GraphAlgorithmConvergenceError when maxIterations is exhausted", async () => {
      const roads = await seedRoads();
      await expect(
        store.algorithms.weightedShortestPath(roads.a, roads.d, {
          edges: ["road"],
          weightProperty: "cost",
          maxIterations: 1,
        }),
      ).rejects.toBeInstanceOf(GraphAlgorithmConvergenceError);
    });

    it("keeps the smallest-identity tie-break for a target id under multiple kinds", async () => {
      // Target id exists as both a Person and a Task at equal total weight,
      // with the smaller identity (Person) discovered one round later — the
      // best-target pruning must still admit it.
      const targetId = "wsp-multi-kind-target";
      const a = await store.nodes.Person.create({ name: "MultiA" });
      const b = await store.nodes.Person.create({ name: "MultiB" });
      const personTarget = await store.nodes.Person.create(
        { name: "MultiTarget" },
        { id: targetId },
      );
      const taskTarget = await store.nodes.Task.create(
        { title: "MultiTarget" },
        { id: targetId },
      );
      await store.edges.road.create(a, taskTarget, { cost: 2 });
      await store.edges.road.create(a, b, { cost: 1 });
      await store.edges.road.create(b, personTarget, { cost: 1 });

      const path = await store.algorithms.weightedShortestPath(a, targetId, {
        edges: ["road"],
        weightProperty: "cost",
      });
      expect(path?.totalWeight).toBe(2);
      expect(path?.nodes.at(-1)).toEqual({ id: targetId, kind: "Person" });
    });

    it("reaches a smaller-identity target through a zero-weight edge from an equal-cost intermediate", async () => {
      // Equal-bound pruning regression: after TaskT settles at cost 2, the
      // intermediate x also costs exactly 2, and only a zero-weight edge
      // from x reaches PersonT — the documented smallest-identity winner.
      // Pruning must drop strictly-worse candidates only, or x (and with it
      // PersonT) disappears.
      const targetId = "wsp-zero-weight-target";
      const a = await store.nodes.Person.create({ name: "PlateauA" });
      const b = await store.nodes.Person.create({ name: "PlateauB" });
      const x = await store.nodes.Person.create({ name: "PlateauX" });
      const personTarget = await store.nodes.Person.create(
        { name: "PlateauTarget" },
        { id: targetId },
      );
      const taskTarget = await store.nodes.Task.create(
        { title: "PlateauTarget" },
        { id: targetId },
      );
      await store.edges.road.create(a, taskTarget, { cost: 2 });
      await store.edges.road.create(a, b, { cost: 1 });
      await store.edges.road.create(b, x, { cost: 1 });
      await store.edges.road.create(x, personTarget, { cost: 0 });

      const options = { edges: ["road"], weightProperty: "cost" } as const;
      const workingTablePath = await store.algorithms.weightedShortestPath(
        a,
        targetId,
        options,
      );
      expect(workingTablePath?.totalWeight).toBe(2);
      expect(workingTablePath?.nodes.at(-1)).toEqual({
        id: targetId,
        kind: "Person",
      });

      const inlineStore = createStore(testGraph, {
        ...backend,
        capabilities: { ...backend.capabilities, transactions: false },
      });
      const inlinePath = await inlineStore.algorithms.weightedShortestPath(
        a,
        targetId,
        options,
      );
      expect(inlinePath).toEqual(workingTablePath);
    });

    it("rejects weights beyond the double range instead of overflowing", async () => {
      const { backend: rawBackend, db } = createLocalSqliteBackend();
      try {
        const rawStore = createStore(testGraph, rawBackend);
        const a = await rawStore.nodes.Person.create({ name: "HugeA" });
        const b = await rawStore.nodes.Person.create({ name: "HugeB" });
        await rawStore.edges.road.create(a, b, { cost: 1 });
        // 1e999 is valid JSON but outside IEEE 754 double range; it can only
        // enter through raw writes or imports, never the Zod write path.
        db.run(drizzleSql`UPDATE typegraph_edges SET props = '{"cost":1e999}'`);

        await expect(
          rawStore.algorithms.weightedShortestPath(a, b, {
            edges: ["road"],
            weightProperty: "cost",
          }),
        ).rejects.toMatchObject({
          name: "InvalidEdgeWeightError",
          details: { reason: "out_of_range" },
        });
      } finally {
        await rawBackend.close();
      }
    });

    it("produces identical results through the inline fallback", async () => {
      const roads = await seedRoads();
      const inlineBackend: GraphBackend = {
        ...backend,
        capabilities: { ...backend.capabilities, transactions: false },
      };
      const inlineStore = createStore(testGraph, inlineBackend);

      const workingTablePath = await store.algorithms.weightedShortestPath(
        roads.a,
        roads.d,
        { edges: ["road"], weightProperty: "cost" },
      );
      const inlinePath = await inlineStore.algorithms.weightedShortestPath(
        roads.a,
        roads.d,
        { edges: ["road"], weightProperty: "cost" },
      );
      expect(inlinePath).toEqual(workingTablePath);

      await expect(
        inlineStore.algorithms.weightedShortestPath(roads.d, roads.a, {
          edges: ["road"],
          weightProperty: "cost",
        }),
      ).resolves.toBeUndefined();

      const x = await store.nodes.Person.create({ name: "InlineNegX" });
      const y = await store.nodes.Person.create({ name: "InlineNegY" });
      await store.edges.road.create(x, y, { cost: -2 });
      await expect(
        inlineStore.algorithms.weightedShortestPath(roads.a, roads.d, {
          edges: ["road"],
          weightProperty: "cost",
        }),
      ).rejects.toMatchObject({ name: "InvalidEdgeWeightError" });
    });
  });

  // --------------------------------------------------------------
  // reachable
  // --------------------------------------------------------------

  describe("reachable", () => {
    it("returns every reachable node with its shortest depth", async () => {
      const reachable = await store.algorithms.reachable(ids.alice, {
        edges: ["knows"],
      });

      const byId = new Map(reachable.map((row) => [row.id, row.depth]));
      expect(byId.get(ids.alice)).toBe(0);
      expect(byId.get(ids.bob)).toBe(1);
      expect(byId.get(ids.eve)).toBe(2);
      expect(byId.get(ids.charlie)).toBe(2);
      expect(byId.get(ids.dave)).toBe(3);
      expect(byId.has(ids.frank)).toBe(false);
    });

    it("excludes the source when requested", async () => {
      const reachable = await store.algorithms.reachable(ids.alice, {
        edges: ["knows"],
        excludeSource: true,
      });
      expect(reachable.some((row) => row.id === ids.alice)).toBe(false);
    });

    it("is bounded by maxHops", async () => {
      const reachable = await store.algorithms.reachable(ids.alice, {
        edges: ["knows"],
        maxHops: 1,
      });
      const ids1 = reachable.map((row) => row.id).toSorted();
      expect(ids1).toEqual([ids.alice, ids.bob].toSorted());
    });

    it("returns only the source for disconnected nodes", async () => {
      const reachable = await store.algorithms.reachable(ids.frank, {
        edges: ["knows"],
      });
      expect(reachable).toEqual([{ id: ids.frank, kind: "Person", depth: 0 }]);
    });

    it("returns an ordering by ascending depth", async () => {
      const reachable = await store.algorithms.reachable(ids.alice, {
        edges: ["knows"],
      });
      for (let index = 1; index < reachable.length; index++) {
        expect(reachable[index]!.depth).toBeGreaterThanOrEqual(
          reachable[index - 1]!.depth,
        );
      }
    });

    it("uses bounded frontier queries and stops when the frontier is empty", async () => {
      const statements: string[] = [];
      const observedBackend: GraphBackend = {
        ...backend,
        capabilities: { ...backend.capabilities, transactions: false },
        execute<T>(query: CompiledRowsSql): Promise<readonly T[]> {
          statements.push(backend.compileSql!(query).sql);
          return backend.execute<T>(query);
        },
      };
      const observedStore = createStore(testGraph, observedBackend);

      const reachable = await observedStore.algorithms.reachable(ids.alice, {
        edges: ["knows"],
        maxHops: 1000,
      });

      expect(reachable).toHaveLength(5);
      expect(statements).toHaveLength(5);
      expect(
        statements.every((statement) => !statement.includes("RECURSIVE")),
      ).toBe(true);
    });

    it("deduplicates edge targets before node visibility without ranking predecessors", async () => {
      const statements: string[] = [];
      const observedBackend: GraphBackend = {
        ...backend,
        transaction<T>(
          fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> {
          return backend.transaction(async (tx, adoptedTransaction) => {
            const observedTransaction: TransactionBackend = {
              ...tx,
              execute<Result>(
                query: CompiledRowsSql,
              ): Promise<readonly Result[]> {
                statements.push(backend.compileSql!(query).sql);
                return tx.execute<Result>(query);
              },
            };
            return fn(observedTransaction, adoptedTransaction);
          }, options);
        },
      };
      const observedStore = createStore(testGraph, observedBackend);

      await observedStore.algorithms.reachable(ids.alice, {
        edges: ["knows"],
        maxHops: 3,
      });

      const expansionStatement = statements.find(
        (statement) =>
          statement.includes("SELECT DISTINCT") &&
          statement.includes("RETURNING node_id"),
      );
      expect(expansionStatement).toBeDefined();
      expect(expansionStatement).not.toContain("ROW_NUMBER");
      expect(expansionStatement).toMatch(
        /SELECT DISTINCT[\s\S]+JOIN "typegraph_nodes"/,
      );
    });

    it("chunks duplicate edge filters within a small bind budget", async () => {
      const constrainedBackend: GraphBackend = {
        ...backend,
        capabilities: {
          ...backend.capabilities,
          transactions: false,
          maxBindParameters: 100,
        },
      };
      const constrainedStore = createStore(testGraph, constrainedBackend);

      const reachable = await constrainedStore.algorithms.reachable(ids.alice, {
        edges: Array.from({ length: 49 }, () => "knows" as const),
        maxHops: 3,
        direction: "both",
      });

      expect(reachable.some((node) => node.id === ids.dave)).toBe(true);
    });

    it("runs through the temporary working-table seam with history enabled", async () => {
      const historyStore = createStore(testGraph, backend, { history: true });

      const reachable = await historyStore.algorithms.reachable(ids.alice, {
        edges: ["knows"],
        maxHops: 3,
      });

      expect(reachable.some((node) => node.id === ids.dave)).toBe(true);
    });

    it("drops the temporary working table when initialization fails", async () => {
      const temporaryStatements: string[] = [];
      let failNextRead = false;
      const failingBackend: GraphBackend = {
        ...backend,
        transaction<T>(
          fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> {
          return backend.transaction(async (tx, adoptedTransaction) => {
            const failingTransaction: TransactionBackend = {
              ...tx,
              async executeTemporaryStatement(
                query: CompiledTemporaryStatementSql,
              ): Promise<void> {
                const statement = backend.compileSql!(query).sql;
                temporaryStatements.push(statement);
                await tx.executeTemporaryStatement!(query);
                if (temporaryStatements.length === 1) {
                  failNextRead = true;
                }
              },
              execute<Result>(
                query: CompiledRowsSql,
              ): Promise<readonly Result[]> {
                if (failNextRead) {
                  failNextRead = false;
                  return Promise.reject(new Error("forced round failure"));
                }
                return tx.execute<Result>(query);
              },
            };
            return fn(failingTransaction, adoptedTransaction);
          }, options);
        },
      };
      const failingStore = createStore(testGraph, failingBackend);

      await expect(
        failingStore.algorithms.reachable(ids.alice, {
          edges: ["knows"],
        }),
      ).rejects.toThrow("forced round failure");

      expect(temporaryStatements[0]?.trimStart()).toMatch(/^CREATE TEMP TABLE/);
      expect(temporaryStatements.at(-1)?.trimStart()).toMatch(
        /^DROP TABLE IF EXISTS/,
      );
    });
  });

  // --------------------------------------------------------------
  // round-trip budget
  // --------------------------------------------------------------

  describe("working-table round-trip budget", () => {
    it("runs a 3-hop reachable in one statement per round", async () => {
      const statements: string[] = [];
      const observedStore = createStore(
        testGraph,
        createCountingBackend(backend, statements),
      );

      const reached = await observedStore.algorithms.reachable(ids.alice, {
        edges: ["knows"],
        maxHops: 3,
      });

      expect(reached.map((node) => node.id)).toContain(ids.dave);
      // Budget: CREATE TEMP TABLE + seed (INSERT … RETURNING) + one
      // statement per round (3 on this fixture) + result read + DROP TABLE
      // = 7. An upper bound so incidental fixture changes don't fail it; a
      // reintroduced per-round COUNT would push a round to two statements
      // and blow the budget.
      expect(statements.length).toBeLessThanOrEqual(7);
      expect(
        statements.some((statement) =>
          statement.trimStart().startsWith("SELECT COUNT"),
        ),
      ).toBe(false);
    });

    it("runs a 3-hop shortestPath in one statement per round", async () => {
      const statements: string[] = [];
      const observedStore = createStore(
        testGraph,
        createCountingBackend(backend, statements),
      );

      const path = await observedStore.algorithms.shortestPath(
        ids.alice,
        ids.dave,
        { edges: ["knows"], maxHops: 3 },
      );

      expect(path?.depth).toBe(3);
      // Budget: CREATE TEMP TABLE + two seeds (INSERT … RETURNING) + one
      // statement per bidirectional round (3 on this fixture) + result read
      // + DROP TABLE = 8. An upper bound so incidental fixture changes don't
      // fail it; the content assertions below are the real regression guard.
      expect(statements.length).toBeLessThanOrEqual(8);
      // Rounds must carry their own meeting probe (meeting_depth) rather
      // than issuing separate COUNT / meeting statements.
      const roundStatements = statements.filter((statement) =>
        statement.includes("meeting_depth"),
      );
      expect(roundStatements.length).toBeGreaterThan(0);
      expect(
        statements.some((statement) =>
          statement.trimStart().startsWith("SELECT COUNT"),
        ),
      ).toBe(false);
      expect(
        statements.some((statement) => statement.includes("AS total_depth")),
      ).toBe(false);
    });

    it("emits no working-memory settings statement on SQLite", async () => {
      const statements: string[] = [];
      const observedStore = createStore(
        testGraph,
        createCountingBackend(backend, statements),
      );

      const reached = await observedStore.algorithms.reachable(ids.alice, {
        edges: ["knows"],
        maxHops: 3,
        workingMemory: "32MB",
      });

      expect(reached.map((node) => node.id)).toContain(ids.dave);
      // Same 7-statement budget as the plain 3-hop reachable above: SQLite
      // must not add a settings statement for workingMemory.
      expect(statements.length).toBeLessThanOrEqual(7);
      expect(
        statements.some((statement) => statement.includes("set_config")),
      ).toBe(false);
    });

    it("detects a meeting when the driver returns meeting_depth as BigInt", async () => {
      // better-sqlite3 with defaultSafeIntegers(true) (and custom pg int
      // parsers) deliver INTEGER columns as BigInt. A meeting must still be
      // detected — regression for a typeof guard that silently dropped
      // BigInt rows and made shortestPath return undefined.
      const bigintBackend: GraphBackend = {
        ...backend,
        transaction<T>(
          fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> {
          return backend.transaction(async (tx, adoptedTransaction) => {
            const observedTransaction: TransactionBackend = {
              ...tx,
              async execute<Result>(
                query: CompiledRowsSql,
              ): Promise<readonly Result[]> {
                const rows = await tx.execute<Record<string, unknown>>(query);
                return rows.map((row) =>
                  typeof row.meeting_depth === "number" ?
                    { ...row, meeting_depth: BigInt(row.meeting_depth) }
                  : row,
                ) as readonly Result[];
              },
            };
            return fn(observedTransaction, adoptedTransaction);
          }, options);
        },
      };
      const bigintStore = createStore(testGraph, bigintBackend);

      const path = await bigintStore.algorithms.shortestPath(
        ids.alice,
        ids.dave,
        { edges: ["knows"], maxHops: 3 },
      );

      expect(path?.depth).toBe(3);
      expect(path?.nodes.at(0)?.id).toBe(ids.alice);
      expect(path?.nodes.at(-1)?.id).toBe(ids.dave);
    });
  });

  // --------------------------------------------------------------
  // canReach
  // --------------------------------------------------------------

  describe("canReach", () => {
    it("returns true for reachable targets", async () => {
      const reachable = await store.algorithms.canReach(
        ids.alice,
        ids.charlie,
        { edges: ["knows"] },
      );
      expect(reachable).toBe(true);
    });

    it("returns false for unreachable targets", async () => {
      const reachable = await store.algorithms.canReach(ids.alice, ids.frank, {
        edges: ["knows"],
      });
      expect(reachable).toBe(false);
    });

    it("returns true when source equals target", async () => {
      const reachable = await store.algorithms.canReach(ids.alice, ids.alice, {
        edges: ["knows"],
      });
      expect(reachable).toBe(true);
    });

    it("respects maxHops", async () => {
      const shallow = await store.algorithms.canReach(ids.alice, ids.dave, {
        edges: ["knows"],
        maxHops: 2,
      });
      expect(shallow).toBe(false);

      const deeper = await store.algorithms.canReach(ids.alice, ids.dave, {
        edges: ["knows"],
        maxHops: 3,
      });
      expect(deeper).toBe(true);
    });
  });

  // --------------------------------------------------------------
  // neighbors
  // --------------------------------------------------------------

  describe("neighbors", () => {
    it("returns direct neighbors at depth 1 by default", async () => {
      const neighbors = await store.algorithms.neighbors(ids.alice, {
        edges: ["knows"],
      });
      expect(neighbors.map((row) => row.id)).toEqual([ids.bob]);
    });

    it("returns k-hop neighborhood when depth > 1", async () => {
      const neighbors = await store.algorithms.neighbors(ids.alice, {
        edges: ["knows"],
        depth: 2,
      });
      const neighborIds = neighbors.map((row) => row.id).toSorted();
      expect(neighborIds).toEqual([ids.bob, ids.charlie, ids.eve].toSorted());
      for (const neighbor of neighbors) {
        expect(neighbor.id).not.toBe(ids.alice);
      }
    });

    it("includes reverse neighbors with direction 'in'", async () => {
      const reverse = await store.algorithms.neighbors(ids.bob, {
        edges: ["knows"],
        direction: "in",
      });
      expect(reverse.map((row) => row.id)).toEqual([ids.alice]);
    });

    it("handles cycles without infinite expansion", async () => {
      const neighbors = await store.algorithms.neighbors(ids.xavier, {
        edges: ["knows"],
        depth: 5,
      });
      expect(neighbors.map((row) => row.id)).toEqual([ids.yves]);
    });
  });

  // --------------------------------------------------------------
  // degree
  // --------------------------------------------------------------

  describe("degree", () => {
    it("counts outgoing edges for direction 'out'", async () => {
      const outDegree = await store.algorithms.degree(ids.bob, {
        edges: ["knows"],
        direction: "out",
      });
      expect(outDegree).toBe(2);
    });

    it("counts incoming edges for direction 'in'", async () => {
      const inDegree = await store.algorithms.degree(ids.charlie, {
        edges: ["knows"],
        direction: "in",
      });
      expect(inDegree).toBe(2);
    });

    it("counts both directions by default and deduplicates self-loops", async () => {
      const selfDegree = await store.algorithms.degree(ids.narcissus, {
        edges: ["knows"],
      });
      expect(selfDegree).toBe(1);

      const bobDegree = await store.algorithms.degree(ids.bob, {
        edges: ["knows"],
      });
      // bob: knows alice (in), knows charlie (out), knows eve (out)
      expect(bobDegree).toBe(3);
    });

    it("aggregates across all edge kinds when edges is omitted", async () => {
      // bob has 2 'knows' outgoing, 1 'knows' incoming, 1 'reports_to'
      // outgoing, 1 'reports_to' incoming = 5 distinct edges.
      const total = await store.algorithms.degree(ids.bob);
      expect(total).toBe(5);
    });

    it("restricts to specific edge kinds", async () => {
      const reports = await store.algorithms.degree(ids.bob, {
        edges: ["reports_to"],
      });
      expect(reports).toBe(2);
    });

    it("returns 0 when edges is an empty list", async () => {
      const none = await store.algorithms.degree(ids.bob, { edges: [] });
      expect(none).toBe(0);
    });

    it("returns 0 for disconnected nodes", async () => {
      const zero = await store.algorithms.degree(ids.frank, {
        edges: ["knows"],
      });
      expect(zero).toBe(0);
    });
  });

  // --------------------------------------------------------------
  // weaklyConnectedComponents
  // --------------------------------------------------------------

  describe("weaklyConnectedComponents", () => {
    it("returns exact component membership and singleton nodes", async () => {
      const memberships = await store.algorithms.weaklyConnectedComponents({
        edges: ["knows"],
      });
      const byId = new Map(memberships.map((row) => [row.id, row]));
      const connectedIds = [ids.alice, ids.bob, ids.charlie, ids.dave, ids.eve];
      const connectedLabels = new Set(
        connectedIds.map((id) => {
          const membership = byId.get(id)!;
          expect(membership.size).toBe(5);
          return `${membership.componentKind}\u0000${membership.componentId}`;
        }),
      );

      expect(connectedLabels.size).toBe(1);
      expect(byId.get(ids.xavier)?.size).toBe(2);
      expect(byId.get(ids.yves)?.size).toBe(2);
      expect(byId.get(ids.frank)?.size).toBe(1);
      expect(byId.get(ids.t1)?.size).toBe(1);
      expect(memberships).toHaveLength(13);
    });

    it("uses only the selected edge kinds", async () => {
      const memberships = await store.algorithms.weaklyConnectedComponents({
        edges: ["depends_on"],
      });
      const taskMemberships = memberships.filter((row) => row.kind === "Task");
      expect(taskMemberships).toHaveLength(4);
      expect(taskMemberships.every((row) => row.size === 4)).toBe(true);
      expect(
        memberships
          .filter((row) => row.kind === "Person")
          .every((row) => row.size === 1),
      ).toBe(true);
    });

    it("uses indexed delta frontiers without reset or redundant joins", async () => {
      const statements: string[] = [];
      const observedBackend = createCountingBackend(backend, statements);
      const observedStore = createStore(testGraph, observedBackend);

      await observedStore.algorithms.weaklyConnectedComponents({
        edges: ["knows"],
      });

      const createTableStatement = statements.find((statement) =>
        statement.trimStart().startsWith("CREATE TEMP TABLE"),
      );
      expect(createTableStatement).toContain("improved_round INTEGER NOT NULL");
      const createIndexStatement = statements.find((statement) =>
        statement.trimStart().startsWith("CREATE INDEX"),
      );
      expect(createIndexStatement).toContain(
        "(graph_id, run_id, improved_round)",
      );
      const seedStatementIndex = statements.findIndex((statement) =>
        statement.trimStart().startsWith("INSERT INTO"),
      );
      const createIndexStatementIndex = statements.findIndex((statement) =>
        statement.trimStart().startsWith("CREATE INDEX"),
      );
      expect(createIndexStatementIndex).toBeGreaterThan(seedStatementIndex);

      // The working table is seeded with exactly the visible, in-scope nodes,
      // so frontier and target membership prove endpoint visibility without
      // re-checking the node table or re-joining the frontier row.
      const seedStatement = statements.find((statement) =>
        statement.trimStart().startsWith("INSERT INTO"),
      );
      expect(seedStatement).toContain('"typegraph_nodes"');
      const propagateStatements = statements.filter((statement) =>
        statement.includes("WITH candidates"),
      );
      expect(propagateStatements.length).toBeGreaterThan(0);
      for (const statement of propagateStatements) {
        expect(statement).toContain("w.improved_round = ?");
        expect(statement).toContain("expanded.source_label_id AS label_id");
        expect(statement).not.toContain('"typegraph_nodes"');
        expect(statement).not.toMatch(
          /JOIN "typegraph_iterative_[^"]+" source/u,
        );
      }
      expect(
        statements.some((statement) =>
          statement.includes("SET next_label_id = label_id"),
        ),
      ).toBe(false);
    });

    it("rejects a backend without graph-analytics support", async () => {
      const unsupportedBackend: GraphBackend = {
        ...backend,
        capabilities: {
          ...backend.capabilities,
          graphAnalytics: { supported: false, mathFunctions: false },
        },
      };
      const unsupportedStore = createStore(testGraph, unsupportedBackend);

      await expect(
        unsupportedStore.algorithms.weaklyConnectedComponents({
          edges: ["knows"],
        }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_BACKEND_CAPABILITY",
        details: { capability: "graphAnalytics", supported: false },
      });
    });

    it("validates maxIterations", async () => {
      await expect(
        store.algorithms.weaklyConnectedComponents({
          edges: ["knows"],
          maxIterations: 0,
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });

    it("throws a typed error when exact convergence is not reached", async () => {
      await expect(
        store.algorithms.weaklyConnectedComponents({
          edges: ["knows"],
          maxIterations: 1,
        }),
      ).rejects.toBeInstanceOf(GraphAlgorithmConvergenceError);
    });
  });

  // --------------------------------------------------------------
  // PageRank / personalized PageRank
  // --------------------------------------------------------------

  describe("PageRank", () => {
    it("assigns equal scores to a directed cycle", async () => {
      const rankStore = createStore(testGraph, createTestBackend());
      const [alpha, beta, gamma] = await Promise.all([
        rankStore.nodes.Person.create({ name: "Rank alpha" }, { id: "rank-a" }),
        rankStore.nodes.Person.create({ name: "Rank beta" }, { id: "rank-b" }),
        rankStore.nodes.Person.create({ name: "Rank gamma" }, { id: "rank-c" }),
      ]);
      await Promise.all([
        rankStore.edges.knows.create(alpha, beta, {}),
        rankStore.edges.knows.create(beta, gamma, {}),
        rankStore.edges.knows.create(gamma, alpha, {}),
      ]);

      const scores = await rankStore.algorithms.pageRank({
        edges: ["knows"],
        tolerance: 1e-12,
      });

      expect(scores).toHaveLength(3);
      expect(scores.map((row) => row.id)).toEqual([
        "rank-a",
        "rank-b",
        "rank-c",
      ]);
      for (const row of scores) expect(row.score).toBeCloseTo(1 / 3, 12);
      expect(scores.reduce((total, row) => total + row.score, 0)).toBeCloseTo(
        1,
        12,
      );
    });

    it("redistributes dangling mass and ranks a terminal node highest", async () => {
      const rankStore = createStore(testGraph, createTestBackend());
      const [alpha, beta, gamma] = await Promise.all([
        rankStore.nodes.Person.create({ name: "Rank alpha" }, { id: "rank-a" }),
        rankStore.nodes.Person.create({ name: "Rank beta" }, { id: "rank-b" }),
        rankStore.nodes.Person.create({ name: "Rank gamma" }, { id: "rank-c" }),
      ]);
      await Promise.all([
        rankStore.edges.knows.create(alpha, beta, {}),
        rankStore.edges.knows.create(beta, gamma, {}),
      ]);

      const scores = await rankStore.algorithms.pageRank({ edges: ["knows"] });
      const reversedScores = await rankStore.algorithms.pageRank({
        edges: ["knows"],
        direction: "in",
      });

      expect(scores.map((row) => row.id)).toEqual([
        "rank-c",
        "rank-b",
        "rank-a",
      ]);
      expect(reversedScores.map((row) => row.id)).toEqual([
        "rank-a",
        "rank-b",
        "rank-c",
      ]);
      expect(scores.reduce((total, row) => total + row.score, 0)).toBeCloseTo(
        1,
        10,
      );
    });

    it("precomputes weights and ping-pongs scores without an apply rewrite", async () => {
      const statements: string[] = [];
      const observedStore = createStore(
        testGraph,
        createCountingBackend(backend, statements),
      );

      await observedStore.algorithms.pageRank({ edges: ["knows"] });

      const degreeStatements = statements.filter(
        (statement) =>
          statement.includes("degrees AS") && statement.includes("out_weight"),
      );
      expect(degreeStatements).toHaveLength(1);
      const contributionStatements = statements.filter((statement) =>
        statement.includes("contributions AS"),
      );
      expect(contributionStatements.length).toBeGreaterThan(1);
      for (const statement of contributionStatements) {
        expect(statement).toMatch(
          /w\."?(?:next_score|score)"? AS source_score/,
        );
        expect(statement).toContain("w.out_weight AS source_out_weight");
        expect(statement).not.toContain('"typegraph_nodes"');
      }
      const resetStatements = statements.filter((statement) =>
        statement.includes("personalization *"),
      );
      const changeStatements = statements.filter((statement) =>
        statement.includes("MAX(ABS("),
      );
      expect(resetStatements).toHaveLength(contributionStatements.length);
      expect(changeStatements).toHaveLength(contributionStatements.length);
      for (const statement of resetStatements) {
        expect(statement).toContain("SELECT COALESCE(SUM(dangling.");
      }
      expect(
        statements.some((statement) =>
          /SET\s+"?score"?\s*=\s*"?next_score"?/.test(statement),
        ),
      ).toBe(false);
    });

    it("computes the analytic two-node personalized solution", async () => {
      const rankStore = createStore(testGraph, createTestBackend());
      const [alpha, beta] = await Promise.all([
        rankStore.nodes.Person.create({ name: "Rank alpha" }, { id: "rank-a" }),
        rankStore.nodes.Person.create({ name: "Rank beta" }, { id: "rank-b" }),
      ]);
      await Promise.all([
        rankStore.edges.knows.create(alpha, beta, {}),
        rankStore.edges.knows.create(beta, alpha, {}),
      ]);

      const scores = await rankStore.algorithms.personalizedPageRank({
        edges: ["knows"],
        seeds: [{ id: alpha.id, kind: "Person" }],
        tolerance: 1e-12,
        maxIterations: 200,
      });
      const byId = new Map(scores.map((row) => [row.id, row.score]));

      expect(byId.get(alpha.id)).toBeCloseTo(1 / 1.85, 10);
      expect(byId.get(beta.id)).toBeCloseTo(0.85 / 1.85, 10);
    });

    it("normalizes weighted and duplicate personalization seeds", async () => {
      const rankStore = createStore(testGraph, createTestBackend());
      const [alpha, beta] = await Promise.all([
        rankStore.nodes.Person.create({ name: "Rank alpha" }, { id: "rank-a" }),
        rankStore.nodes.Person.create({ name: "Rank beta" }, { id: "rank-b" }),
      ]);

      const scores = await rankStore.algorithms.personalizedPageRank({
        edges: ["knows"],
        dampingFactor: 0,
        seeds: [
          { id: alpha.id, kind: "Person" },
          { id: beta.id, kind: "Person", weight: 2 },
          { id: beta.id, kind: "Person" },
        ],
      });
      const byId = new Map(scores.map((row) => [row.id, row.score]));

      expect(byId.get(alpha.id)).toBeCloseTo(0.25, 12);
      expect(byId.get(beta.id)).toBeCloseTo(0.75, 12);
    });

    it("returns an empty score set for an empty induced subgraph", async () => {
      await expect(
        store.algorithms.pageRank({ edges: ["knows"], nodeKinds: [] }),
      ).resolves.toEqual([]);
    });

    it("rejects missing personalization seeds and incomplete convergence", async () => {
      await expect(
        store.algorithms.personalizedPageRank({
          edges: ["knows"],
          seeds: [{ id: "missing", kind: "Person" }],
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);

      await expect(
        store.algorithms.pageRank({
          edges: ["knows"],
          maxIterations: 1,
          tolerance: 1e-15,
        }),
      ).rejects.toBeInstanceOf(GraphAlgorithmConvergenceError);
    });

    it("rejects malformed numerical and personalization options", async () => {
      for (const dampingFactor of [-0.1, 1, Number.NaN]) {
        await expect(
          store.algorithms.pageRank({ edges: ["knows"], dampingFactor }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
      for (const tolerance of [0, -1, Number.POSITIVE_INFINITY]) {
        await expect(
          store.algorithms.pageRank({ edges: ["knows"], tolerance }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
      for (const maxIterations of [0, -1, 1.5, Number.NaN]) {
        await expect(
          store.algorithms.pageRank({ edges: ["knows"], maxIterations }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
      await expect(
        store.algorithms.personalizedPageRank({
          edges: ["knows"],
          seeds: [],
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      for (const weight of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(
          store.algorithms.personalizedPageRank({
            edges: ["knows"],
            seeds: [{ id: ids.alice, kind: "Person", weight }],
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
      await expect(
        store.algorithms.personalizedPageRank({
          edges: ["knows"],
          seeds: [{ id: ids.alice, kind: "Person", weight: 0 }],
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      for (const seed of [
        { id: "", kind: "Person" as const },
        { id: undefined as unknown as string, kind: "Person" as const },
        { id: ids.alice, kind: undefined as unknown as "Person" },
      ]) {
        await expect(
          store.algorithms.personalizedPageRank({
            edges: ["knows"],
            seeds: [seed],
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
    });

    it("rejects a backend without graph-analytics support", async () => {
      const unsupportedBackend: GraphBackend = {
        ...backend,
        capabilities: {
          ...backend.capabilities,
          graphAnalytics: { supported: false, mathFunctions: false },
        },
      };
      const unsupportedStore = createStore(testGraph, unsupportedBackend);

      await expect(
        unsupportedStore.algorithms.pageRank({ edges: ["knows"] }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_BACKEND_CAPABILITY",
        details: {
          capability: "graphAnalytics",
          operation: "pageRank",
          supported: false,
        },
      });
      await expect(
        unsupportedStore.algorithms.personalizedPageRank({
          edges: ["knows"],
          seeds: [{ id: ids.alice, kind: "Person" }],
        }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_BACKEND_CAPABILITY",
        details: {
          capability: "graphAnalytics",
          operation: "personalizedPageRank",
          supported: false,
        },
      });
    });
  });

  // --------------------------------------------------------------
  // validation
  // --------------------------------------------------------------

  describe("validation", () => {
    it("rejects empty edge kinds for traversal algorithms", async () => {
      await expect(
        store.algorithms.shortestPath(ids.alice, ids.bob, { edges: [] }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        store.algorithms.reachable(ids.alice, { edges: [] }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        store.algorithms.canReach(ids.alice, ids.bob, { edges: [] }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        store.algorithms.neighbors(ids.alice, { edges: [] }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        store.algorithms.weaklyConnectedComponents({ edges: [] }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        store.algorithms.pageRank({ edges: [] }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        store.algorithms.personalizedPageRank({
          edges: [],
          seeds: [{ id: ids.alice, kind: "Person" }],
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        store.algorithms.weightedShortestPath(ids.alice, ids.bob, {
          edges: [],
          weightProperty: "cost",
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });

    it("rejects malformed weightedShortestPath weight options", async () => {
      await expect(
        store.algorithms.weightedShortestPath(ids.alice, ids.bob, {
          edges: ["road"],
          weightProperty: "",
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      // Number.MAX_VALUE is finite but above the audit's accumulation
      // bound — accepting it would reopen the overflow gap for
      // missing-weight edges that skip the stored-weight audit.
      for (const defaultWeight of [
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_VALUE,
      ]) {
        await expect(
          store.algorithms.weightedShortestPath(ids.alice, ids.bob, {
            edges: ["road"],
            weightProperty: "cost",
            defaultWeight,
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
      for (const maxIterations of [0, -5, 1.5, Number.NaN]) {
        await expect(
          store.algorithms.weightedShortestPath(ids.alice, ids.bob, {
            edges: ["road"],
            weightProperty: "cost",
            maxIterations,
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
    });

    it("rejects non-positive maxHops", async () => {
      await expect(
        store.algorithms.reachable(ids.alice, {
          edges: ["knows"],
          maxHops: 0,
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        store.algorithms.neighbors(ids.alice, {
          edges: ["knows"],
          depth: -1,
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });

    it("rejects malformed workingMemory values across iterative algorithms", async () => {
      // SET LOCAL work_mem cannot take arbitrary text, so the option accepts
      // only <digits><kB|MB|GB> — no spaces, fractions, lowercase units, or
      // anything that could smuggle SQL into a settings statement.
      const malformedValues = [
        "64 MB",
        "64mb",
        "-64MB",
        "1.5GB",
        "64MB; DROP TABLE typegraph_nodes",
        "",
      ];
      for (const workingMemory of malformedValues) {
        await expect(
          store.algorithms.reachable(ids.alice, {
            edges: ["knows"],
            workingMemory,
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
        await expect(
          store.algorithms.shortestPath(ids.alice, ids.bob, {
            edges: ["knows"],
            workingMemory,
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
        await expect(
          store.algorithms.weaklyConnectedComponents({
            edges: ["knows"],
            workingMemory,
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
        await expect(
          store.algorithms.pageRank({ edges: ["knows"], workingMemory }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
    });

    it("rejects workingMemory values outside PostgreSQL's work_mem range", async () => {
      // work_mem accepts 64kB..2147483647kB; anything outside would fail
      // set_config mid-transaction with a raw engine error on PostgreSQL
      // while SQLite silently succeeded. Both backends reject up front.
      const outOfRangeValues = [
        "0MB",
        "1kB",
        "63kB",
        "2147483648kB",
        "999999GB",
      ];
      for (const workingMemory of outOfRangeValues) {
        await expect(
          store.algorithms.reachable(ids.alice, {
            edges: ["knows"],
            workingMemory,
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
        await expect(
          store.algorithms.weaklyConnectedComponents({
            edges: ["knows"],
            workingMemory,
          }),
        ).rejects.toBeInstanceOf(ConfigurationError);
        await expect(
          store.algorithms.pageRank({ edges: ["knows"], workingMemory }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
    });

    it("accepts well-formed workingMemory values including the range bounds", async () => {
      for (const workingMemory of ["32MB", "64kB", "2147483647kB", "2GB"]) {
        const reached = await store.algorithms.reachable(ids.alice, {
          edges: ["knows"],
          workingMemory,
        });
        expect(reached.some((node) => node.id === ids.dave)).toBe(true);
      }
    });

    it("rejects maxHops over the explicit recursive limit", async () => {
      await expect(
        store.algorithms.reachable(ids.alice, {
          edges: ["knows"],
          maxHops: 10_000,
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });
  });

  // --------------------------------------------------------------
  // task DAG sanity
  // --------------------------------------------------------------

  describe("task dependency DAG", () => {
    it("finds the shortest path through a DAG", async () => {
      const path = await store.algorithms.shortestPath(ids.t1, ids.t3, {
        edges: ["depends_on"],
      });
      expect(path?.depth).toBe(2);
      expect(path?.nodes.map((node) => node.id)).toEqual([
        ids.t1,
        ids.t2,
        ids.t3,
      ]);
    });

    it("reaches every dependent task", async () => {
      const reachable = await store.algorithms.reachable(ids.t1, {
        edges: ["depends_on"],
        excludeSource: true,
      });
      const reached = reachable.map((row) => row.id).toSorted();
      expect(reached).toEqual([ids.t2, ids.t3, ids.t4].toSorted());
    });
  });
});

// ============================================================
// Temporal Behavior
// ============================================================
//
// Algorithms honor the same temporal model as the rest of the store.
// Default is graph.defaults.temporalMode ("current"), with per-call
// overrides via `temporalMode` / `asOf`.
//
// Fixture (all nodes are Person, edges are "knows"):
//
//   alice  -- current edge -->  bob    (both always valid)
//   bob    -- expired edge -->  david  (edge validTo = PAST)
//   alice  -- current edge -->  eve    (eve validFrom = FUTURE)
//   alice  -- current edge -->  ghost  (ghost soft-deleted)
//
// Time anchors:
//   PAST   = 2020-01-01
//   BEFORE = 2021-01-01   (before expired-edge ended)
//   NOW    = 2025-06-01
//   FUTURE = 2030-01-01

describe("store.algorithms temporal behavior", () => {
  const { PAST, BEFORE, EDGE_ENDED, FUTURE } = TEMPORAL_ANCHORS;

  type TemporalFixture = Readonly<{
    alice: string;
    bob: string;
    david: string;
    eve: string;
    ghost: string;
  }>;

  let backend: GraphBackend;
  let store: Store<TestGraph>;
  let temporalIds: TemporalFixture;

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);

    // Alice/Bob/David valid from PAST so asOf: BEFORE sees them.
    const [alice, bob, david, eve, ghost] = await Promise.all([
      store.nodes.Person.create({ name: "Alice" }, { validFrom: PAST }),
      store.nodes.Person.create({ name: "Bob" }, { validFrom: PAST }),
      store.nodes.Person.create({ name: "David" }, { validFrom: PAST }),
      store.nodes.Person.create({ name: "Eve" }, { validFrom: FUTURE }),
      store.nodes.Person.create({ name: "Ghost" }),
    ]);

    // Edges: alice→bob (always valid), bob→david (ended), alice→eve (current),
    // alice→ghost (soft-deleted along with ghost below, to exercise tombstone
    // traversal). Edge must be deleted before ghost — node delete is restricted
    // while live connected edges exist.
    const edgeToGhostPromise = store.edges.knows.create(alice, ghost, {});
    await Promise.all([
      store.edges.knows.create(alice, bob, {}, { validFrom: PAST }),
      store.edges.knows.create(
        bob,
        david,
        {},
        { validFrom: PAST, validTo: EDGE_ENDED },
      ),
      store.edges.knows.create(alice, eve, {}),
      edgeToGhostPromise,
    ]);
    const edgeToGhost = await edgeToGhostPromise;
    await store.edges.knows.delete(edgeToGhost.id);
    await store.nodes.Person.delete(ghost.id);

    temporalIds = {
      alice: alice.id,
      bob: bob.id,
      david: david.id,
      eve: eve.id,
      ghost: ghost.id,
    };
  });

  describe("reachable", () => {
    it("defaults to current mode — excludes future and deleted nodes", async () => {
      const reached = await store.algorithms.reachable(temporalIds.alice, {
        edges: ["knows"],
        excludeSource: true,
      });
      const reachedIds = reached.map((row) => row.id).toSorted();

      expect(reachedIds).toEqual([temporalIds.bob].toSorted());
    });

    it("asOf = BEFORE sees the expired edge to david", async () => {
      const reached = await store.algorithms.reachable(temporalIds.alice, {
        edges: ["knows"],
        excludeSource: true,
        temporalMode: "asOf",
        asOf: BEFORE,
      });
      const reachedIds = reached.map((row) => row.id).toSorted();

      // Eve not yet valid (validFrom = FUTURE). Ghost is excluded regardless
      // of asOf — it's soft-deleted, and deleted_at is unconditional in
      // asOf mode (see "includeTombstones surfaces the deleted ghost node"
      // below for that coverage). Bob and David are reachable via the
      // historical edge.
      expect(reachedIds).toContain(temporalIds.bob);
      expect(reachedIds).toContain(temporalIds.david);
      expect(reachedIds).not.toContain(temporalIds.eve);
    });

    it("includeEnded traverses through the expired edge", async () => {
      const reached = await store.algorithms.reachable(temporalIds.alice, {
        edges: ["knows"],
        excludeSource: true,
        temporalMode: "includeEnded",
      });
      const reachedIds = reached.map((row) => row.id).toSorted();

      // Ended edges included; deleted ghost excluded.
      expect(reachedIds).toContain(temporalIds.bob);
      expect(reachedIds).toContain(temporalIds.david);
      expect(reachedIds).toContain(temporalIds.eve);
      expect(reachedIds).not.toContain(temporalIds.ghost);
    });

    it("includeTombstones surfaces the deleted ghost node", async () => {
      const reached = await store.algorithms.reachable(temporalIds.alice, {
        edges: ["knows"],
        excludeSource: true,
        temporalMode: "includeTombstones",
      });
      const reachedIds = reached.map((row) => row.id).toSorted();

      expect(reachedIds).toContain(temporalIds.ghost);
    });

    it("rejects current + asOf instead of pinning the instant", async () => {
      // An asOf is only meaningful in asOf mode; the algorithm path resolves
      // current via the DB clock and would silently drop the pin. Reject it so
      // the contract matches collection, query(), subgraph, and StoreView.
      await expect(
        store.algorithms.reachable(temporalIds.alice, {
          edges: ["knows"],
          temporalMode: "current",
          asOf: BEFORE,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("canReach", () => {
    it("self-path returns false when the node is not visible under current mode", async () => {
      // Eve has validFrom = FUTURE — not current. The self-path short-circuit
      // was removed so this honors the temporal filter like shortestPath does.
      const reaches = await store.algorithms.canReach(
        temporalIds.eve,
        temporalIds.eve,
        { edges: ["knows"] },
      );
      expect(reaches).toBe(false);
    });

    it("self-path returns true under includeEnded (ignores validity periods)", async () => {
      const reaches = await store.algorithms.canReach(
        temporalIds.eve,
        temporalIds.eve,
        { edges: ["knows"], temporalMode: "includeEnded" },
      );
      expect(reaches).toBe(true);
    });

    it("self-path returns true for ghost only under includeTombstones", async () => {
      const currentReach = await store.algorithms.canReach(
        temporalIds.ghost,
        temporalIds.ghost,
        { edges: ["knows"] },
      );
      expect(currentReach).toBe(false);

      const tombstoneReach = await store.algorithms.canReach(
        temporalIds.ghost,
        temporalIds.ghost,
        { edges: ["knows"], temporalMode: "includeTombstones" },
      );
      expect(tombstoneReach).toBe(true);
    });

    it("asOf finds a target through a historically-valid edge", async () => {
      const reaches = await store.algorithms.canReach(
        temporalIds.alice,
        temporalIds.david,
        { edges: ["knows"], temporalMode: "asOf", asOf: BEFORE },
      );
      expect(reaches).toBe(true);

      // Default current mode: the bob→david edge is expired, so no path.
      const currentReaches = await store.algorithms.canReach(
        temporalIds.alice,
        temporalIds.david,
        { edges: ["knows"] },
      );
      expect(currentReaches).toBe(false);
    });
  });

  describe("neighbors", () => {
    it("forwards temporalMode through to the underlying reachable query", async () => {
      // Alice's 1-hop current-mode neighbors: only bob (eve-future, ghost-deleted).
      const current = await store.algorithms.neighbors(temporalIds.alice, {
        edges: ["knows"],
      });
      expect(current.map((row) => row.id).toSorted()).toEqual(
        [temporalIds.bob].toSorted(),
      );

      // Under includeEnded, eve becomes reachable too.
      const ended = await store.algorithms.neighbors(temporalIds.alice, {
        edges: ["knows"],
        temporalMode: "includeEnded",
      });
      expect(ended.map((row) => row.id)).toContain(temporalIds.eve);

      // Under includeTombstones, the deleted ghost surfaces.
      const tombstones = await store.algorithms.neighbors(temporalIds.alice, {
        edges: ["knows"],
        temporalMode: "includeTombstones",
      });
      expect(tombstones.map((row) => row.id)).toContain(temporalIds.ghost);
    });

    it("forwards asOf through to the underlying reachable query", async () => {
      // 2-hop at BEFORE: alice → bob → david via the historical edge.
      const historical = await store.algorithms.neighbors(temporalIds.alice, {
        edges: ["knows"],
        depth: 2,
        temporalMode: "asOf",
        asOf: BEFORE,
      });
      expect(historical.map((row) => row.id)).toContain(temporalIds.david);
    });
  });

  describe("shortestPath", () => {
    it("defaults to current mode — no path to david through expired edge", async () => {
      const path = await store.algorithms.shortestPath(
        temporalIds.alice,
        temporalIds.david,
        { edges: ["knows"] },
      );

      expect(path).toBeUndefined();
    });

    it("asOf = BEFORE traverses the historical edge to david", async () => {
      const path = await store.algorithms.shortestPath(
        temporalIds.alice,
        temporalIds.david,
        { edges: ["knows"], temporalMode: "asOf", asOf: BEFORE },
      );

      expect(path?.depth).toBe(2);
      expect(path?.nodes.map((node) => node.id)).toEqual([
        temporalIds.alice,
        temporalIds.bob,
        temporalIds.david,
      ]);
    });

    it("self-path short-circuit respects temporal mode", async () => {
      // Eve is not yet valid under "current", so self-path returns undefined.
      const currentSelf = await store.algorithms.shortestPath(
        temporalIds.eve,
        temporalIds.eve,
        { edges: ["knows"] },
      );
      expect(currentSelf).toBeUndefined();

      // Under "includeEnded", Eve exists regardless of validFrom — self-path succeeds.
      const endedSelf = await store.algorithms.shortestPath(
        temporalIds.eve,
        temporalIds.eve,
        { edges: ["knows"], temporalMode: "includeEnded" },
      );
      expect(endedSelf?.depth).toBe(0);
      expect(endedSelf?.nodes[0]?.id).toBe(temporalIds.eve);
    });

    it("self-path under asOf honors the snapshot's validity window", async () => {
      // Eve's validFrom is FUTURE — even at asOf BEFORE she isn't yet valid.
      const beforeSelf = await store.algorithms.shortestPath(
        temporalIds.eve,
        temporalIds.eve,
        { edges: ["knows"], temporalMode: "asOf", asOf: BEFORE },
      );
      expect(beforeSelf).toBeUndefined();

      // Alice was valid from PAST, so asOf BEFORE sees her.
      const aliceAtBefore = await store.algorithms.shortestPath(
        temporalIds.alice,
        temporalIds.alice,
        { edges: ["knows"], temporalMode: "asOf", asOf: BEFORE },
      );
      expect(aliceAtBefore?.depth).toBe(0);
      expect(aliceAtBefore?.nodes[0]?.id).toBe(temporalIds.alice);
    });

    it("self-path under includeTombstones resolves the deleted ghost", async () => {
      // Ghost is soft-deleted. Under default current, self-path is undefined.
      const currentSelf = await store.algorithms.shortestPath(
        temporalIds.ghost,
        temporalIds.ghost,
        { edges: ["knows"] },
      );
      expect(currentSelf).toBeUndefined();

      // includeTombstones surfaces the deleted node.
      const tombstoneSelf = await store.algorithms.shortestPath(
        temporalIds.ghost,
        temporalIds.ghost,
        { edges: ["knows"], temporalMode: "includeTombstones" },
      );
      expect(tombstoneSelf?.depth).toBe(0);
      expect(tombstoneSelf?.nodes[0]?.id).toBe(temporalIds.ghost);
    });
  });

  describe("degree", () => {
    it("defaults to current mode — excludes expired edge", async () => {
      // Bob has one outgoing edge (bob → david) but it's expired.
      const currentDegree = await store.algorithms.degree(temporalIds.bob, {
        edges: ["knows"],
        direction: "out",
      });
      expect(currentDegree).toBe(0);
    });

    it("includeEnded counts the expired edge", async () => {
      const degree = await store.algorithms.degree(temporalIds.bob, {
        edges: ["knows"],
        direction: "out",
        temporalMode: "includeEnded",
      });
      expect(degree).toBe(1);
    });

    it("asOf counts edges that were valid at the snapshot", async () => {
      // At BEFORE, the bob→david edge is still valid (ends at EDGE_ENDED).
      const historical = await store.algorithms.degree(temporalIds.bob, {
        edges: ["knows"],
        direction: "out",
        temporalMode: "asOf",
        asOf: BEFORE,
      });
      expect(historical).toBe(1);
    });

    it("includeTombstones counts soft-deleted edges", async () => {
      // Alice has one deleted edge (alice→ghost). Under default current,
      // direction: "out" reports 2 (alice→bob, alice→eve — the alice→ghost
      // edge is soft-deleted; eve's future validity doesn't matter for degree
      // since degree only scans the edges table, not endpoint validity).
      const current = await store.algorithms.degree(temporalIds.alice, {
        edges: ["knows"],
        direction: "out",
      });
      expect(current).toBe(2);

      // With tombstones included, the alice→ghost edge surfaces too.
      const tombstones = await store.algorithms.degree(temporalIds.alice, {
        edges: ["knows"],
        direction: "out",
        temporalMode: "includeTombstones",
      });
      expect(tombstones).toBe(3);
    });
  });

  describe("validation", () => {
    it("throws when temporalMode is 'asOf' but asOf is not supplied", async () => {
      // compileTemporalFilter enforces this at query compile time. Algorithms
      // and subgraph should all surface the same error uniformly.
      await expect(
        store.algorithms.reachable(temporalIds.alice, {
          edges: ["knows"],
          temporalMode: "asOf",
        }),
      ).rejects.toThrow(/asOf/);

      await expect(
        store.algorithms.shortestPath(temporalIds.alice, temporalIds.bob, {
          edges: ["knows"],
          temporalMode: "asOf",
        }),
      ).rejects.toThrow(/asOf/);

      await expect(
        store.algorithms.canReach(temporalIds.alice, temporalIds.bob, {
          edges: ["knows"],
          temporalMode: "asOf",
        }),
      ).rejects.toThrow(/asOf/);

      await expect(
        store.algorithms.degree(temporalIds.alice, {
          edges: ["knows"],
          temporalMode: "asOf",
        }),
      ).rejects.toThrow(/asOf/);
    });

    it("rejects non-canonical asOf timestamps across algorithms", async () => {
      const nonCanonical = "2021-01-01T00:00:00Z";

      await expect(
        store.algorithms.reachable(temporalIds.alice, {
          edges: ["knows"],
          temporalMode: "asOf",
          asOf: nonCanonical,
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        store.algorithms.shortestPath(temporalIds.alice, temporalIds.bob, {
          edges: ["knows"],
          temporalMode: "asOf",
          asOf: nonCanonical,
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        store.algorithms.canReach(temporalIds.alice, temporalIds.bob, {
          edges: ["knows"],
          temporalMode: "asOf",
          asOf: nonCanonical,
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        store.algorithms.degree(temporalIds.alice, {
          edges: ["knows"],
          temporalMode: "asOf",
          asOf: nonCanonical,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  // Regression: SQLite's raw `CURRENT_TIMESTAMP` returns `YYYY-MM-DD HH:MM:SS`,
  // while `valid_from` / `valid_to` are stored as ISO-8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`).
  // Because `T` > space lexicographically, same-day ISO timestamps sort *above*
  // raw `CURRENT_TIMESTAMP`, so `valid_from <= CURRENT_TIMESTAMP` is spuriously
  // false for rows that started earlier today. Every current-mode path must
  // use the dialect's ISO-aligned timestamp instead.
  describe("same-day current-mode boundary (SQLite format regression)", () => {
    it("includes rows whose valid_from is earlier today across all algorithms", async () => {
      const freshBackend = createTestBackend();
      const freshStore = createStore(testGraph, freshBackend);

      const recentValidFrom = new Date(Date.now() - 60_000).toISOString();
      const [alice, bob] = await Promise.all([
        freshStore.nodes.Person.create(
          { name: "Alice" },
          { validFrom: recentValidFrom },
        ),
        freshStore.nodes.Person.create(
          { name: "Bob" },
          { validFrom: recentValidFrom },
        ),
      ]);
      await freshStore.edges.knows.create(
        alice,
        bob,
        {},
        { validFrom: recentValidFrom },
      );

      // buildReachableCte: reachable/canReach/neighbors/shortestPath all share
      // the same CTE — one assertion exercises the recursive path.
      const reached = await freshStore.algorithms.reachable(alice.id, {
        edges: ["knows"],
        excludeSource: true,
      });
      expect(reached.map((row) => row.id)).toContain(bob.id);

      // resolveTemporalFilter: shortestPath(a, a) fast path.
      const selfPath = await freshStore.algorithms.shortestPath(
        alice.id,
        alice.id,
        { edges: ["knows"] },
      );
      expect(selfPath?.nodes[0]?.id).toBe(alice.id);

      // resolveTemporalFilter: degree scans the edges table directly.
      const outDegree = await freshStore.algorithms.degree(alice.id, {
        edges: ["knows"],
        direction: "out",
      });
      expect(outDegree).toBe(1);

      // fetchSubgraphEdges: subgraph hydrates edges via compileTemporalFilter.
      const sub = await freshStore.subgraph(alice.id, { edges: ["knows"] });
      expect(collectAllEdges(sub.adjacency)).toHaveLength(1);
    });

    it("excludes rows whose valid_to was earlier today", async () => {
      const freshBackend = createTestBackend();
      const freshStore = createStore(testGraph, freshBackend);

      const now = Date.now();
      const earlierToday = new Date(now - 60_000).toISOString();
      const muchEarlierToday = new Date(now - 120_000).toISOString();
      const [alice, bob] = await Promise.all([
        freshStore.nodes.Person.create({ name: "Alice" }),
        freshStore.nodes.Person.create({ name: "Bob" }),
      ]);
      await freshStore.edges.knows.create(
        alice,
        bob,
        {},
        { validFrom: muchEarlierToday, validTo: earlierToday },
      );

      const reached = await freshStore.algorithms.reachable(alice.id, {
        edges: ["knows"],
        excludeSource: true,
      });
      expect(reached.map((row) => row.id)).not.toContain(bob.id);

      const outDegree = await freshStore.algorithms.degree(alice.id, {
        edges: ["knows"],
        direction: "out",
      });
      expect(outDegree).toBe(0);
    });
  });

  describe("per-graph default temporal mode", () => {
    it("respects graph.defaults.temporalMode when no per-call override", async () => {
      // Build a separate graph with default "includeEnded" and verify algorithms
      // pick it up without any per-call option.
      const endedGraph = defineGraph({
        id: "algorithms_temporal_ended",
        nodes: { Person: { type: Person } },
        edges: { knows: { type: knows, from: [Person], to: [Person] } },
        defaults: { temporalMode: "includeEnded" },
      });
      const endedBackend = createTestBackend();
      const endedStore = createStore(endedGraph, endedBackend);

      const a = await endedStore.nodes.Person.create({ name: "A" });
      const b = await endedStore.nodes.Person.create({ name: "B" });
      await endedStore.edges.knows.create(a, b, {}, { validTo: EDGE_ENDED });

      // Edge is ended, but graph default is "includeEnded" → b is reachable.
      const reached = await endedStore.algorithms.reachable(a.id, {
        edges: ["knows"],
        excludeSource: true,
      });
      expect(reached.map((row) => row.id)).toContain(b.id);
    });
  });
});
