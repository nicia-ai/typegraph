/**
 * Property-Based Tests for Subgraph Extraction
 *
 * Verifies structural invariants of store.subgraph() results
 * using randomly generated graph topologies.
 */
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { asNodeId, defineEdge, defineGraph, defineNode } from "../../src";
import type { GraphBackend } from "../../src/backend/types";
import { createStore, type Store } from "../../src/store";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";

// ============================================================
// Test Schema: simple chain/tree graph
// ============================================================

const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});

const link = defineEdge("link", { schema: z.object({}) });

const propertyGraph = defineGraph({
  id: "prop_subgraph",
  nodes: { Item: { type: Item } },
  edges: {
    link: { type: link, from: [Item], to: [Item] },
  },
});

type PropertyGraph = typeof propertyGraph;

// ============================================================
// Helpers
// ============================================================

function itemRef(id: string) {
  return { kind: "Item" as const, id: asNodeId<typeof Item>(id) };
}

/**
 * Builds a chain of N items: item0 → item1 → ... → itemN-1
 * Returns all created node IDs.
 */
async function buildChain(
  store: Store<PropertyGraph>,
  length: number,
): Promise<string[]> {
  const nodeIds: string[] = [];
  for (let index = 0; index < length; index++) {
    const node = await store.nodes.Item.create({ label: `item-${index}` });
    nodeIds.push(node.id);
  }
  for (let index = 0; index < length - 1; index++) {
    await store.edges.link.create(
      { kind: "Item", id: requireDefined(nodeIds[index]) },
      { kind: "Item", id: requireDefined(nodeIds[index + 1]) },
    );
  }
  return nodeIds;
}

/**
 * Builds a star graph: center → spoke0, center → spoke1, ...
 * Returns [centerId, ...spokeIds].
 */
async function buildStar(
  store: Store<PropertyGraph>,
  spokeCount: number,
): Promise<string[]> {
  const center = await store.nodes.Item.create({ label: "center" });
  const spokeIds: string[] = [];
  for (let index = 0; index < spokeCount; index++) {
    const spoke = await store.nodes.Item.create({ label: `spoke-${index}` });
    spokeIds.push(spoke.id);
    await store.edges.link.create(center, spoke);
  }
  return [center.id, ...spokeIds];
}

// ============================================================
// Property Tests
// ============================================================

describe("subgraph property tests", () => {
  let backend: GraphBackend;
  let store: Store<PropertyGraph>;

  beforeEach(() => {
    backend = createTestBackend();
    store = createStore(propertyGraph, backend);
  });

  describe("chain graph invariants", () => {
    it("reachable count is min(depth+1, chainLength) from the start", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 15 }),
          fc.integer({ min: 0, max: 20 }),
          async (chainLength, maxDepth) => {
            // Fresh store per run
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const nodeIds = await buildChain(store, chainLength);
            const result = await store.subgraph(
              itemRef(requireDefined(nodeIds[0])),
              {
                edges: ["link"],
                maxDepth,
              },
            );

            const expected = Math.min(maxDepth + 1, chainLength);
            expect(result.nodes.length).toBe(expected);
          },
        ),
        { numRuns: 30 },
      );
    });

    it("all returned edges connect nodes in the result set", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 12 }),
          fc.integer({ min: 1, max: 15 }),
          async (chainLength, maxDepth) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const nodeIds = await buildChain(store, chainLength);
            const result = await store.subgraph(
              itemRef(requireDefined(nodeIds[0])),
              {
                edges: ["link"],
                maxDepth,
              },
            );

            for (const edge of result.edges) {
              expect(
                result.node({ kind: edge.fromKind, id: edge.fromId }),
              ).toBeDefined();
              expect(
                result.node({ kind: edge.toKind, id: edge.toId }),
              ).toBeDefined();
            }
          },
        ),
        { numRuns: 30 },
      );
    });

    it("edge count equals node count - 1 for connected chain subsets", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 12 }),
          fc.integer({ min: 1, max: 15 }),
          async (chainLength, maxDepth) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const nodeIds = await buildChain(store, chainLength);
            const result = await store.subgraph(
              itemRef(requireDefined(nodeIds[0])),
              {
                edges: ["link"],
                maxDepth,
              },
            );

            // In a chain, edges = nodes - 1 (when all nodes are connected)
            // With maxDepth >= 1, root is always included so size > 0
            expect(result.nodes.length).toBeGreaterThan(0);
            expect(result.edges).toHaveLength(result.nodes.length - 1);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  describe("star graph invariants", () => {
    it("reachable count is spokeCount+1 with sufficient depth", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 20 }),
          async (spokeCount) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const allIds = await buildStar(store, spokeCount);
            const centerId = requireDefined(allIds[0]);
            const result = await store.subgraph(itemRef(centerId), {
              edges: ["link"],
              maxDepth: 1,
            });

            expect(result.nodes.length).toBe(spokeCount + 1);
          },
        ),
        { numRuns: 20 },
      );
    });

    it("no duplicate node IDs in result", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 15 }),
          fc.integer({ min: 1, max: 5 }),
          async (spokeCount, maxDepth) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const allIds = await buildStar(store, spokeCount);
            const centerId = requireDefined(allIds[0]);
            const result = await store.subgraph(itemRef(centerId), {
              edges: ["link"],
              maxDepth,
            });

            const nodeIds = result.nodes.map((node) => node.id);
            expect(new Set(nodeIds).size).toBe(nodeIds.length);
            expect(result.nodes.length).toBeLessThanOrEqual(spokeCount + 1);
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  describe("excludeRoot invariant", () => {
    it("excludeRoot always removes exactly the root from the result", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 5 }),
          async (spokeCount, maxDepth) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const allIds = await buildStar(store, spokeCount);
            const centerId = requireDefined(allIds[0]);

            const withRoot = await store.subgraph(itemRef(centerId), {
              edges: ["link"],
              maxDepth,
            });
            const withoutRoot = await store.subgraph(itemRef(centerId), {
              edges: ["link"],
              maxDepth,
              excludeRoot: true,
            });

            // Without root should have exactly one fewer node
            expect(withoutRoot.nodes.length).toBe(withRoot.nodes.length - 1);
            // And that missing node is the root
            expect(withoutRoot.node(itemRef(centerId))).toBeUndefined();
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  describe("cycle safety invariant", () => {
    it("subgraph always terminates even with cycles", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 8 }),
          async (chainLength) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const nodeIds = await buildChain(store, chainLength);
            // Close the chain into a cycle
            await store.edges.link.create(
              { kind: "Item", id: requireDefined(nodeIds[chainLength - 1]) },
              { kind: "Item", id: requireDefined(nodeIds[0]) },
            );

            const result = await store.subgraph(
              itemRef(requireDefined(nodeIds[0])),
              {
                edges: ["link"],
                maxDepth: chainLength * 2,
              },
            );

            // All nodes in the cycle should be reachable, each exactly once
            expect(result.nodes.length).toBe(chainLength);
          },
        ),
        { numRuns: 20 },
      );
    });
  });
});
