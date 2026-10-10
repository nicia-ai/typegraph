/**
 * The store's acyclicity verdict must equal an in-memory DFS reachability
 * oracle over a random DAG plus a random candidate edge — the case that
 * catches an off-by-one in the reflexive seed or a wrong join direction,
 * which no hand-written case reaches reliably.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../src";
import { EdgeAcyclicityError } from "../../src/errors";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";

const Node = defineNode("Node", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "property_edge_acyclicity",
  nodes: { Node: { type: Node } },
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Node],
      to: [Node],
      acyclic: true,
    },
  },
});

/** A random DAG over node indices 0..nodeCount-1: every edge goes low -> high, so it is acyclic by construction. */
const dagArbitrary = fc.integer({ min: 2, max: 12 }).chain((nodeCount) =>
  fc.record({
    nodeCount: fc.constant(nodeCount),
    edges: fc.uniqueArray(
      fc
        .tuple(
          fc.integer({ min: 0, max: nodeCount - 1 }),
          fc.integer({ min: 0, max: nodeCount - 1 }),
        )
        .filter(([from, to]) => from < to)
        .map(([from, to]) => ({ from, to })),
      { selector: (edge) => `${edge.from}\0${edge.to}` },
    ),
    candidate: fc.tuple(
      fc.integer({ min: 0, max: nodeCount - 1 }),
      fc.integer({ min: 0, max: nodeCount - 1 }),
    ),
  }),
);

/** DFS reachability oracle: does `to` reach `from` over the DAG's edges? */
function reachesOracle(
  edges: readonly Readonly<{ from: number; to: number }>[],
  from: number,
  to: number,
): boolean {
  if (from === to) return true;
  const adjacency = new Map<number, number[]>();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const stack = [to];
  const seen = new Set<number>([to]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current === from) return true;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

describe("edge acyclicity: property", () => {
  it("agrees with a DFS reachability oracle over random DAGs and candidate edges", async () => {
    await fc.assert(
      fc.asyncProperty(
        dagArbitrary,
        async ({ nodeCount, edges, candidate }) => {
          const backend = createTestBackend();
          const store = createStore(graph, backend);
          const nodes = await store.nodes.Node.bulkCreate(
            Array.from({ length: nodeCount }, () => ({ props: {} })),
          );
          await store.edges.dependsOn.bulkCreate(
            edges.map((edge) => ({
              from: requireDefined(nodes[edge.from]),
              to: requireDefined(nodes[edge.to]),
            })),
          );

          const [candidateFrom, candidateTo] = candidate;
          const expectRefusal = reachesOracle(
            edges,
            candidateFrom,
            candidateTo,
          );

          let refused = false;
          try {
            await store.edges.dependsOn.create(
              requireDefined(nodes[candidateFrom]),
              requireDefined(nodes[candidateTo]),
            );
          } catch (error) {
            if (!(error instanceof EdgeAcyclicityError)) throw error;
            refused = true;
          }

          expect(refused).toBe(expectRefusal);
        },
      ),
      { numRuns: 200 },
    );
  }, 60_000);
});
