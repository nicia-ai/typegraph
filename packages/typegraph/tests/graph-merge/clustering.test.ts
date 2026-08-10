import { generateId } from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";

import type { CandidateEdge } from "../../src/graph-merge/candidate-gen";
import type { ClusterResult } from "../../src/graph-merge/clustering";
import {
  connectedComponents,
  decisiveEdgesForCluster,
  enforceDiameter,
  enforceDiameterWithEdges,
} from "../../src/graph-merge/clustering";
import { entityRef } from "../../src/graph-merge/evidence";
import type { MergeKey } from "../../src/graph-merge/node-key";
import { requireDefined } from "../../src/utils/presence";

/**
 * Brands a plain string as a node-identity key for pure clustering tests. These tests
 * exercise the generic key-graph logic over opaque ids; a NUL-free string compares
 * id-first identically to a real `(kind, id)` key, so the single-token form is exact.
 */
function nodeId(value: string): MergeKey {
  return value as MergeKey;
}

/** Builds an undirected candidate edge with endpoints in canonical `(a, b)` order. */
function edge(a: string, b: string, score: number): CandidateEdge {
  const left = nodeId(a);
  const right = nodeId(b);
  const endpoints =
    left < right ? { a: left, b: right } : { a: right, b: left };
  return {
    ...endpoints,
    score,
    evidence: {
      a: entityRef(endpoints.a),
      b: entityRef(endpoints.b),
      sources: [{ kind: "block", sourceId: "test" }],
      decision: "scored",
      strategy: { kind: "fulltext", fields: ["name"] },
      score,
      threshold: 0.5,
    },
  };
}

/** A stable, comparable view of a cluster partition for deep-equal assertions. */
function partitionOf(clusters: readonly ClusterResult[]): string[][] {
  return clusters.map((cluster) => [...cluster.members].map((id) => id));
}

/** Deterministically shuffles a copy of an array via a seeded LCG. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    const swapWith = state % (index + 1);
    const temporary = requireDefined(copy[index]);
    copy[index] = requireDefined(copy[swapWith]);
    copy[swapWith] = temporary;
  }
  return copy;
}

describe("connectedComponents", () => {
  const ids = ["A", "B", "C"].map((value) => nodeId(value));

  it("single-link clusters A~B, B~C into {A,B,C} even though A and C are not directly similar", () => {
    const edges: CandidateEdge[] = [edge("A", "B", 0.9), edge("B", "C", 0.88)];

    const clusters = connectedComponents(edges, ids);

    expect(partitionOf(clusters)).toEqual([["A", "B", "C"]]);
  });

  it("places nodes with no incident candidate edge into singleton clusters", () => {
    const edges: CandidateEdge[] = [edge("A", "B", 0.9)];
    const withIsolated = [...ids, nodeId("Z")];

    const clusters = connectedComponents(edges, withIsolated);

    expect(partitionOf(clusters)).toEqual([["A", "B"], ["C"], ["Z"]]);
  });

  it("is identical across shuffled edge-input order", () => {
    const edges: CandidateEdge[] = [
      edge("A", "B", 0.9),
      edge("B", "C", 0.88),
      edge("D", "E", 0.91),
    ];
    const allIds = ["A", "B", "C", "D", "E"].map((value) => nodeId(value));

    const natural = partitionOf(connectedComponents(edges, allIds));

    for (let seed = 1; seed <= 5; seed += 1) {
      const reordered = partitionOf(
        connectedComponents(shuffled(edges, seed), shuffled(allIds, seed * 7)),
      );
      expect(reordered).toEqual(natural);
    }
  });

  describe("diameter guard", () => {
    // The diameter guard is intentionally separate from connectedComponents (the
    // base guard must run on the raw components first), so callers compose
    // enforceDiameter over connectedComponents explicitly.
    it("keeps a within-bound chain intact (diameter 2 <= guard 2)", () => {
      // A-B-C chain has diameter 2; guard of 2 must NOT split it.
      const edges: CandidateEdge[] = [
        edge("A", "B", 0.9),
        edge("B", "C", 0.88),
      ];

      const clusters = enforceDiameter(
        connectedComponents(edges, ids),
        edges,
        2,
      );

      expect(partitionOf(clusters)).toEqual([["A", "B", "C"]]);
    });

    it("splits an over-diameter chain by dropping the weakest edge deterministically", () => {
      // A-B-C chain has diameter 2 > guard 1. The weakest edge (B-C, 0.86) is
      // dropped, leaving {A,B} (diameter 1) and {C} (singleton).
      const edges: CandidateEdge[] = [
        edge("A", "B", 0.95),
        edge("B", "C", 0.86),
      ];

      const clusters = enforceDiameter(
        connectedComponents(edges, ids),
        edges,
        1,
      );

      expect(partitionOf(clusters)).toEqual([["A", "B"], ["C"]]);
    });

    it("drop-weakest split is independent of edge-input order", () => {
      const edges: CandidateEdge[] = [
        edge("A", "B", 0.95),
        edge("B", "C", 0.86),
        edge("C", "D", 0.97),
      ];
      const allIds = ["A", "B", "C", "D"].map((value) => nodeId(value));

      const natural = partitionOf(
        enforceDiameter(connectedComponents(edges, allIds), edges, 1),
      );

      for (let seed = 1; seed <= 5; seed += 1) {
        const shuffledEdges = shuffled(edges, seed);
        const reordered = partitionOf(
          enforceDiameter(
            connectedComponents(shuffledEdges, allIds),
            shuffledEdges,
            1,
          ),
        );
        expect(reordered).toEqual(natural);
      }
    });

    it("drops the lowest-score edge (not the lowest-id edge) when scores differ", () => {
      // Both A-B (0.99) and B-C (0.80) exceed the chain's guard of 1, but only
      // the weaker B-C edge must be removed, isolating C.
      const edges: CandidateEdge[] = [
        edge("A", "B", 0.99),
        edge("B", "C", 0.8),
      ];

      const clusters = enforceDiameter(
        connectedComponents(edges, ids),
        edges,
        1,
      );

      expect(partitionOf(clusters)).toEqual([["A", "B"], ["C"]]);
    });

    it("builds the witness only from post-split surviving edges", () => {
      // A-B is a weak cycle edge: it is dropped first without disconnecting A/B.
      // C-D is then dropped to satisfy diameter 2. A/B remain together, proving a
      // witness selected from the original graph could incorrectly cite A-B.
      const edges = [
        edge("A", "B", 0.1),
        edge("A", "C", 0.9),
        edge("B", "C", 0.9),
        edge("C", "D", 0.2),
        edge("D", "E", 0.9),
      ];
      const allIds = ["A", "B", "C", "D", "E"].map((value) => nodeId(value));
      const guarded = enforceDiameterWithEdges(
        connectedComponents(edges, allIds),
        edges,
        2,
      );
      expect(partitionOf(guarded.clusters)).toEqual([
        ["A", "B", "C"],
        ["D", "E"],
      ]);
      expect(
        guarded.excludedEdges.map(({ edge: excluded }) => [
          excluded.a,
          excluded.b,
        ]),
      ).toEqual([
        ["A", "B"],
        ["C", "D"],
      ]);

      const abc = requireDefined(guarded.clusters[0]);
      const decisive = decisiveEdgesForCluster(abc, guarded.survivingEdges);
      expect(decisive).toHaveLength(2);
      expect(
        decisive.map((evidence) => [evidence.a.id, evidence.b.id]),
      ).toEqual([
        ["A", "C"],
        ["B", "C"],
      ]);
    });
  });

  it("treats real generated nanoid ids consistently regardless of creation order", () => {
    const first = generateId();
    const second = generateId();
    const third = generateId();
    const idList = [first, second, third].map((value) => nodeId(value));
    const edges: CandidateEdge[] = [
      edge(first, second, 0.9),
      edge(second, third, 0.9),
    ];

    const clusters = connectedComponents(edges, idList);

    expect(clusters).toHaveLength(1);
    expect([...requireDefined(clusters[0]).members].map((id) => id)).toEqual(
      [first, second, third].sort((left, right) =>
        left < right ? -1
        : left > right ? 1
        : 0,
      ),
    );
  });
});
