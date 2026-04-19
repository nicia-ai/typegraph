/**
 * Graph algorithm tests.
 *
 * Exercises `store.algorithms.{shortestPath, reachable, canReach,
 * neighbors, degree}` against the SQLite backend with a fixture that
 * includes branching paths, cycles, self-loops, and disconnected regions.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
import type { NodeId } from "../src/core/types";
import { ConfigurationError } from "../src/errors";
import { createStore, type Store } from "../src/store";
import { createTestBackend } from "./test-utils";

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
