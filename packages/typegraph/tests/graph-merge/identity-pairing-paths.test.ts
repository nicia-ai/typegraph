/**
 * `identityAssertionsOnPaths` — which identity pairings a `"flag"` policy drops
 * for one conflict: the assertions on some simple path between the entities
 * the conflict names, over the cluster's non-identity components.
 */
import { describe, expect, it } from "vitest";

import { entityRef } from "../../src/graph-merge/evidence";
import {
  connectedWithoutIdentity,
  identityAssertionsOnPaths,
} from "../../src/graph-merge/identity-pairing-paths";
import { type MergeKey, mergeKey } from "../../src/graph-merge/node-key";
import type { CandidateEdge } from "../../src/graph-merge/scoring";

function key(id: string): MergeKey {
  return mergeKey("Person", id);
}

function identityEdge(
  a: string,
  b: string,
  assertionId: string,
): CandidateEdge {
  return {
    a: key(a),
    b: key(b),
    score: 1,
    evidence: {
      a: entityRef(key(a)),
      b: entityRef(key(b)),
      sources: [
        { kind: "identity", sourceId: "identity", assertionIds: [assertionId] },
      ],
      decision: "definitional",
    },
  };
}

function similarityEdge(a: string, b: string): CandidateEdge {
  return {
    a: key(a),
    b: key(b),
    score: 0.9,
    evidence: {
      a: entityRef(key(a)),
      b: entityRef(key(b)),
      sources: [{ kind: "block", sourceId: "exactKey" }],
      decision: "scored",
      strategy: { kind: "fulltext", fields: ["name"] },
      score: 0.9,
      threshold: 0.5,
    },
  };
}

describe("identityAssertionsOnPaths", () => {
  it("drops the chain between the named pair and keeps a pendant assertion", () => {
    const cluster = {
      members: ["x", "y", "z", "w"].map((id) => key(id)),
      identityEdges: [
        identityEdge("x", "y", "A1"),
        identityEdge("y", "z", "A2"),
        identityEdge("z", "w", "A3"),
      ],
      nonIdentityEdges: [],
    };
    expect(identityAssertionsOnPaths(cluster, [key("x"), key("z")])).toEqual([
      "A1",
      "A2",
    ]);
    // Naming every member names every assertion.
    expect(identityAssertionsOnPaths(cluster, cluster.members)).toEqual([
      "A1",
      "A2",
      "A3",
    ]);
  });

  it("keeps a cycle attached at one articulation point off the path", () => {
    // x — y — z, plus a triangle y — p — q — y hanging off y.
    const cluster = {
      members: ["x", "y", "z", "p", "q"].map((id) => key(id)),
      identityEdges: [
        identityEdge("x", "y", "A1"),
        identityEdge("y", "z", "A2"),
        identityEdge("y", "p", "C1"),
        identityEdge("p", "q", "C2"),
        identityEdge("q", "y", "C3"),
      ],
      nonIdentityEdges: [],
    };
    expect(identityAssertionsOnPaths(cluster, [key("x"), key("z")])).toEqual([
      "A1",
      "A2",
    ]);
    // A cycle ON the path contributes every edge of its block: both routes
    // from x to z through the square x — y — z — v — x are simple paths.
    const square = {
      members: ["x", "y", "z", "v"].map((id) => key(id)),
      identityEdges: [
        identityEdge("x", "y", "S1"),
        identityEdge("y", "z", "S2"),
        identityEdge("z", "v", "S3"),
        identityEdge("v", "x", "S4"),
      ],
      nonIdentityEdges: [],
    };
    expect(identityAssertionsOnPaths(square, [key("x"), key("z")])).toEqual([
      "S1",
      "S2",
      "S3",
      "S4",
    ]);
  });

  it("contracts similarity-connected members and reads pairs through the contraction", () => {
    // x ~ y by similarity; y = z by identity: the x–z path is the one assertion.
    const cluster = {
      members: ["x", "y", "z"].map((id) => key(id)),
      identityEdges: [identityEdge("y", "z", "A1")],
      nonIdentityEdges: [similarityEdge("x", "y")],
    };
    expect(connectedWithoutIdentity(cluster, key("x"), key("y"))).toBe(true);
    expect(connectedWithoutIdentity(cluster, key("x"), key("z"))).toBe(false);
    expect(identityAssertionsOnPaths(cluster, [key("x"), key("z")])).toEqual([
      "A1",
    ]);
    // An assertion inside one similarity component is on no path between
    // distinct components.
    const redundant = {
      ...cluster,
      identityEdges: [
        identityEdge("x", "y", "R1"),
        identityEdge("y", "z", "A1"),
      ],
    };
    expect(identityAssertionsOnPaths(redundant, [key("x"), key("z")])).toEqual([
      "A1",
    ]);
  });
  // MUTATION CHECK: replace `edgesOnSimplePaths`' block walk with "every edge
  // in the source's connected component" — the pendant `A3` and the hanging
  // triangle `C1`–`C3` are then dropped too, failing the first two cases.
});
