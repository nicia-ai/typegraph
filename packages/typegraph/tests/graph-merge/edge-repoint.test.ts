import type { EdgeId, JsonValue, NodeId, NodeType } from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";

import type { ClusterResult } from "../../src/graph-merge/clustering";
import { buildBranchRank } from "../../src/graph-merge/conflict-policy";
import type {
  MergedEdge,
  StagedEdge,
} from "../../src/graph-merge/edge-repoint";
import {
  buildCanonicalMap,
  ENDPOINT_DELETED_DROP_REASON,
  repointEdges,
} from "../../src/graph-merge/edge-repoint";
import {
  compareMergeKeys,
  type MergeKey,
  mergeKey,
} from "../../src/graph-merge/node-key";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";

type AnyNodeId = NodeId<NodeType>;

function nodeId(value: string): AnyNodeId {
  return value as AnyNodeId;
}

/**
 * The composite `(kind, id)` identity of a test node. Every edge endpoint in this
 * suite is kind "Doc", so the cluster keys and the canonical map key on that pair —
 * matching what `repointEdges` derives from each staged edge's `fromKind`/`toKind`.
 */
function key(id: string): MergeKey {
  return mergeKey("Doc", id);
}

function edgeId(value: string): EdgeId {
  return value as EdgeId;
}

function lexicographic(left: string, right: string): number {
  return (
    left < right ? -1
    : left > right ? 1
    : 0
  );
}

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

/** The fixed graph-wide branch order for these tests: [branchA, branchB]. */
function rank(): ReadonlyMap<typeof BRANCH_A, number> {
  return buildBranchRank([BRANCH_A, BRANCH_B], [BRANCH_A, BRANCH_B]);
}

/** Builds a staged edge with parsed props; defaults keep the call sites terse. */
function stagedEdge(
  args: Readonly<{
    id: string;
    from: string;
    to: string;
    kind?: string;
    props?: Readonly<Record<string, JsonValue>>;
    branchId?: typeof BRANCH_A;
  }>,
): StagedEdge {
  return {
    id: edgeId(args.id),
    kind: args.kind ?? "references",
    fromId: nodeId(args.from),
    toId: nodeId(args.to),
    fromKind: "Doc",
    toKind: "Doc",
    props: args.props ?? {},
    branchId: args.branchId ?? BRANCH_A,
  };
}

/** A cluster whose composite-key members are id-sorted, mirroring what T8 emits. */
function clusterOf(...ids: readonly string[]): ClusterResult {
  return {
    members: [...ids]
      .map((value) => key(value))
      .sort((left, right) => compareMergeKeys(left, right)),
  };
}

/** Min-id canonical selector — the merge-wide default — over composite keys. */
function minIdCanonical(cluster: ClusterResult): MergeKey {
  return requireDefined(
    [...cluster.members].sort((left, right) =>
      compareMergeKeys(left, right),
    )[0],
  );
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

/**
 * A plain, fully-comparable projection of a merged edge (drops `props` key order
 * by canonicalizing via JSON over a sorted shape is unnecessary here since props
 * are simple) used to deep-equal compare results across shuffled input order.
 */
type MergedEdgeShape = Readonly<{
  id: string;
  kind: string;
  fromId: string;
  toId: string;
  props: Readonly<Record<string, JsonValue>>;
  mergedIds: readonly string[];
}>;

function projectEdges(
  edges: readonly MergedEdge[],
): readonly MergedEdgeShape[] {
  return edges.map((edge) => ({
    id: edge.id,
    kind: edge.kind,
    fromId: edge.fromId,
    toId: edge.toId,
    props: edge.props,
    mergedIds: edge.mergedIds.map((id) => id as string),
  }));
}

describe("buildCanonicalMap", () => {
  it("maps every cluster member to its canonical and omits singletons", () => {
    const map = buildCanonicalMap(
      [clusterOf("node-a", "node-b"), clusterOf("node-x")],
      (cluster) => minIdCanonical(cluster),
    );

    // {a, b} collapse to a (min id); both members rewrite to its composite key.
    expect(map.get(key("node-a"))).toBe(key("node-a"));
    expect(map.get(key("node-b"))).toBe(key("node-a"));
    // Singleton x maps to itself.
    expect(map.get(key("node-x"))).toBe(key("node-x"));
    // An identity in no cluster is simply absent (callers default it to itself).
    expect(map.has(key("node-z"))).toBe(false);
  });
});

describe("repointEdges", () => {
  // The headline §6.3 case: a and b collapse to canonical c* (= "a", min id).
  // Two distinct edges x→a and x→b both repoint to x→a and, with equal props,
  // must dedupe to a SINGLE merged edge.
  const collapse = buildCanonicalMap([clusterOf("a", "b")], (cluster) =>
    minIdCanonical(cluster),
  );

  it("dedupes x→a and x→b to a single x→c* when {a,b} collapse", () => {
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "a" }),
      stagedEdge({ id: "edge-2", from: "x", to: "b" }),
    ];

    const result = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(result.edges).toHaveLength(1);
    const edge = requireDefined(result.edges[0]);
    expect(edge.fromId).toBe("x");
    // Canonical of {a, b} is "a" (lexicographic min).
    expect(edge.toId).toBe("a");
    // Survivor id is the lexicographically-minimal contributing edge id, and
    // BOTH source ids are recorded as merged.
    expect(edge.id).toBe("edge-1");
    expect(edge.mergedIds.map((id) => id).sort()).toEqual(["edge-1", "edge-2"]);
    // Equal props → no conflict.
    expect(result.conflicts).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it("surfaces an edge PropertyConflict when collapsed edges carry differing props", () => {
    const staged = [
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "a",
        props: { weight: 1 },
        branchId: BRANCH_A,
      }),
      stagedEdge({
        id: "edge-2",
        from: "x",
        to: "b",
        props: { weight: 2 },
        branchId: BRANCH_B,
      }),
    ];

    const result = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    // Still a single edge (same from'/type/to'), but props differ → conflict.
    expect(result.edges).toHaveLength(1);
    const edge = requireDefined(result.edges[0]);
    expect(edge.id).toBe("edge-1");

    expect(result.conflicts).toHaveLength(1);
    const conflict = requireDefined(result.conflicts[0]);
    expect(`${conflict.entityId}`).toBe("edge-1");
    expect(conflict.property).toBe("weight");
    // "flag" keeps the survivor's (edge-1, branchA) value.
    expect(conflict.resolution).toBe(1);
    expect(edge.props["weight"]).toBe(1);
    // Both contributing values are recorded, tagged by branch.
    expect(
      conflict.values
        .map((value) => ({
          branchId: value.branchId,
          value: value.value,
        }))
        .sort((left, right) => lexicographic(left.branchId, right.branchId)),
    ).toEqual([
      { branchId: "branch-a", value: 1 },
      { branchId: "branch-b", value: 2 },
    ]);
  });

  it("resolves an edge property conflict via lastWriteWins on the stable branch order", () => {
    const staged = [
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "a",
        props: { weight: 1 },
        branchId: BRANCH_A,
      }),
      stagedEdge({
        id: "edge-2",
        from: "x",
        to: "b",
        props: { weight: 2 },
        branchId: BRANCH_B,
      }),
    ];

    // branchOrder [branchB, branchA] makes branchB highest-priority → weight 2.
    const branchRank = buildBranchRank(
      [BRANCH_B, BRANCH_A],
      [BRANCH_A, BRANCH_B],
    );
    const result = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "lastWriteWins",
      branchRank,
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.props["weight"]).toBe(2);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.resolution).toBe(2);
  });

  it("drops an edge whose repointed endpoint is finally deleted", () => {
    // a and b collapse to a; node a is then finally deleted (T8a deleteWins).
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "a" }),
      stagedEdge({ id: "edge-2", from: "y", to: "b" }),
      stagedEdge({ id: "edge-3", from: "x", to: "y" }),
    ];
    const deleted = new Set<MergeKey>([key("a")]);

    const result = repointEdges(staged, collapse, deleted, "flag", rank());

    // edge-1 (x→a) and edge-2 (y→b, repointed to y→a) both touch the deleted a.
    expect(result.dropped.map((item) => item.id).sort()).toEqual([
      "edge-1",
      "edge-2",
    ]);
    for (const item of result.dropped) {
      expect(item.kind).toBe("edge");
      expect(item.reason).toBe(ENDPOINT_DELETED_DROP_REASON);
    }
    // edge-3 (x→y) survives untouched.
    expect(result.edges).toHaveLength(1);
    expect(`${result.edges[0]?.id}`).toBe("edge-3");
  });

  it("drops an edge whose repointed SOURCE is finally deleted", () => {
    const staged = [stagedEdge({ id: "edge-1", from: "a", to: "x" })];
    const deleted = new Set<MergeKey>([key("a")]);

    const result = repointEdges(staged, collapse, deleted, "flag", rank());

    expect(result.edges).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(`${result.dropped[0]?.id}`).toBe("edge-1");
    expect(result.dropped[0]?.reason).toBe(ENDPOINT_DELETED_DROP_REASON);
  });

  it("does NOT dedupe edges of differing type or differing endpoints", () => {
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "a", kind: "references" }),
      // Same repointed endpoints but a DIFFERENT type → distinct edge.
      stagedEdge({ id: "edge-2", from: "x", to: "b", kind: "cites" }),
      // Different source → distinct edge.
      stagedEdge({ id: "edge-3", from: "y", to: "a", kind: "references" }),
    ];

    const result = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(result.edges).toHaveLength(3);
    expect(result.conflicts).toHaveLength(0);
    expect(
      result.edges
        .map((edge) => `${edge.fromId}|${edge.kind}|${edge.toId}`)
        .sort(),
    ).toEqual(["x|cites|a", "x|references|a", "y|references|a"]);
  });

  it("collapses three edges x→a, x→b, x→a' into one with all three merged ids", () => {
    // a, b, and a-prime all collapse to canonical "a".
    const triple = buildCanonicalMap(
      [clusterOf("a", "a-prime", "b")],
      (cluster) => minIdCanonical(cluster),
    );
    const staged = [
      stagedEdge({ id: "edge-3", from: "x", to: "b" }),
      stagedEdge({ id: "edge-1", from: "x", to: "a" }),
      stagedEdge({ id: "edge-2", from: "x", to: "a-prime" }),
    ];

    const result = repointEdges(
      staged,
      triple,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(result.edges).toHaveLength(1);
    const edge = requireDefined(result.edges[0]);
    expect(edge.toId).toBe("a");
    expect(edge.id).toBe("edge-1");
    expect(edge.mergedIds.map((id) => id)).toEqual([
      "edge-1",
      "edge-2",
      "edge-3",
    ]);
  });

  it("repoints an INTRA-cluster edge a→b to a kept self-edge c*→c*", () => {
    // An edge BETWEEN two cluster members: both endpoints repoint to the same
    // canonical, producing a self-edge. The contract is that the relationship
    // SURVIVES as c*→c* — it is not dropped (only edges to finally-deleted
    // endpoints drop), so no merged relationship silently vanishes.
    const staged = [stagedEdge({ id: "edge-1", from: "a", to: "b" })];

    const result = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(result.dropped).toEqual([]);
    expect(result.edges).toHaveLength(1);
    const edge = requireDefined(result.edges[0]);
    expect(edge.fromId).toBe("a");
    expect(edge.toId).toBe("a");
    expect(edge.id).toBe("edge-1");
  });

  it("dedupes the reversed intra-cluster pair a→b and b→a into ONE self-edge", () => {
    // Once {a, b} collapse, BOTH directions repoint to the same (c*, type, c*)
    // identity, so with equal props the pair dedupes to a single self-edge —
    // the original direction is deliberately unrecoverable after the collapse.
    const staged = [
      stagedEdge({ id: "edge-1", from: "a", to: "b", branchId: BRANCH_A }),
      stagedEdge({ id: "edge-2", from: "b", to: "a", branchId: BRANCH_B }),
    ];

    const result = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(result.dropped).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.edges).toHaveLength(1);
    const edge = requireDefined(result.edges[0]);
    expect(edge.fromId).toBe("a");
    expect(edge.toId).toBe("a");
    expect(edge.id).toBe("edge-1");
    expect(edge.mergedIds.map((id) => id as string).sort()).toEqual([
      "edge-1",
      "edge-2",
    ]);
  });

  it("produces an identical result across shuffled input-edge order", () => {
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "a", props: { weight: 1 } }),
      stagedEdge({
        id: "edge-2",
        from: "x",
        to: "b",
        props: { weight: 2 },
        branchId: BRANCH_B,
      }),
      stagedEdge({ id: "edge-3", from: "y", to: "x" }),
      stagedEdge({ id: "edge-4", from: "a", to: "x" }),
      stagedEdge({ id: "edge-5", from: "b", to: "x" }),
    ];

    const reference = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );
    const referenceShape = {
      edges: projectEdges(reference.edges),
      dropped: reference.dropped.map((item) => ({
        id: item.id,
        reason: item.reason,
      })),
      conflicts: reference.conflicts.map((conflict) => ({
        entityId: conflict.entityId,
        property: conflict.property,
        resolution: conflict.resolution,
      })),
    };

    for (let seed = 1; seed <= 6; seed += 1) {
      const result = repointEdges(
        shuffled(staged, seed),
        collapse,
        new Set<MergeKey>(),
        "flag",
        rank(),
      );
      const shape = {
        edges: projectEdges(result.edges),
        dropped: result.dropped.map((item) => ({
          id: item.id,
          reason: item.reason,
        })),
        conflicts: result.conflicts.map((conflict) => ({
          entityId: conflict.entityId,
          property: conflict.property,
          resolution: conflict.resolution,
        })),
      };
      expect(shape).toEqual(referenceShape);
    }
  });
});

describe("repointEdges dedupe-key delimiter safety (F13)", () => {
  it("does not collapse distinct edges whose type/endpoint contains the separator", () => {
    // Under the old `${from}|${type}|${to}|${props}` key, BOTH of these produced
    // the ambiguous string "x|a|b|c|{}" and one edge was silently dropped. The
    // JSON-encoded key keeps them distinct.
    const edges = [
      stagedEdge({ id: "e1", from: "x", to: "c", kind: "a|b" }),
      stagedEdge({ id: "e2", from: "x", to: "b|c", kind: "a" }),
    ];
    const result = repointEdges(
      edges,
      new Map(), // no repointing — endpoints map to themselves
      new Set(), // no deleted endpoints
      "flag",
      rank(),
    );
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((edge) => edge.id as string).sort()).toEqual([
      "e1",
      "e2",
    ]);
    expect(result.dropped).toEqual([]);
  });
});
