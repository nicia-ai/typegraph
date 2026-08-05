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
    validFrom?: string;
    validTo?: string;
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
    ...(args.validFrom === undefined ? {} : { validFrom: args.validFrom }),
    ...(args.validTo === undefined ? {} : { validTo: args.validTo }),
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
  validFrom: string | undefined;
  validTo: string | undefined;
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
    validFrom: edge.validFrom,
    validTo: edge.validTo,
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

/**
 * The fold's SCOPE (issue #393): only a collision repointing INDUCED is folded.
 * Staged edges that already shared their endpoints are ordinary multigraph
 * multiplicity — `create()` makes a parallel edge and nothing enforces uniqueness on
 * `(from, type, to)`, so a merge must commit them as parallel rows to produce what
 * the branch's operation would have produced applied straight to the target.
 *
 * Every case below pins one half of that line: what still folds, what no longer does,
 * and that EDGE ID (not props equality) decides which.
 */
describe("repointEdges fold scope (#393)", () => {
  // No clustering at all: every endpoint maps to itself, so nothing is repointed.
  const noRepoint = new Map<MergeKey, MergeKey>();
  // {a, b} collapse to canonical "a" (min id) — the repoint-induced case.
  const collapse = buildCanonicalMap([clusterOf("a", "b")], (cluster) =>
    minIdCanonical(cluster),
  );

  it("keeps two same-endpoint edges with DIFFERING props as parallel edges", () => {
    // On main these folded onto the min-id survivor and raised a bogus property
    // conflict between two rows that were never the same row.
    const staged = [
      stagedEdge({
        id: "edge-inherited",
        from: "x",
        to: "y",
        props: { weight: 1 },
        branchId: BRANCH_A,
      }),
      stagedEdge({
        id: "edge-new",
        from: "x",
        to: "y",
        props: { weight: 2 },
        branchId: BRANCH_B,
      }),
    ];

    const result = repointEdges(
      staged,
      noRepoint,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(result.edges).toHaveLength(2);
    expect(
      result.edges.map((edge) => ({
        id: edge.id,
        weight: edge.props["weight"],
        mergedIds: edge.mergedIds.map((id) => id as string),
      })),
    ).toEqual([
      { id: "edge-inherited", weight: 1, mergedIds: ["edge-inherited"] },
      { id: "edge-new", weight: 2, mergedIds: ["edge-new"] },
    ]);
    // Two distinct rows never disagree about a property — the disagreement the old
    // fold reported was an artifact of merging them.
    expect(result.conflicts).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps two same-endpoint edges with IDENTICAL props as parallel edges", () => {
    // The id-keyed ruling: a distinct id is a distinct row even when its props
    // coincide, because `create()` on the target would have made a second row.
    const staged = [
      stagedEdge({ id: "edge-inherited", from: "x", to: "y", props: { n: 1 } }),
      stagedEdge({
        id: "edge-new",
        from: "x",
        to: "y",
        props: { n: 1 },
        branchId: BRANCH_B,
      }),
    ];

    const result = repointEdges(
      staged,
      noRepoint,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(result.edges.map((edge) => edge.id as string)).toEqual([
      "edge-inherited",
      "edge-new",
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it("folds the SAME edge id staged by several branches into one row", () => {
    // The other half of the id-keyed ruling: one inherited row modified by two
    // branches is still ONE row, so it must fold and its property disagreement
    // must be reconciled rather than committed twice.
    const staged = [
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "y",
        props: { weight: 1 },
        branchId: BRANCH_A,
      }),
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "y",
        props: { weight: 2 },
        branchId: BRANCH_B,
      }),
    ];

    const result = repointEdges(
      staged,
      noRepoint,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(result.edges).toHaveLength(1);
    const edge = requireDefined(result.edges[0]);
    expect(edge.id).toBe("edge-1");
    expect(edge.props["weight"]).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(`${result.conflicts[0]?.entityId}`).toBe("edge-1");
    expect(result.conflicts[0]?.property).toBe("weight");
  });

  it("still folds a group repointing INDUCED even when a parallel edge is in it", () => {
    // A repointed member (x→b, with {a,b} collapsed) joins a group that already
    // held two parallel x→a edges. Repointing defines this group's identity, so the
    // documented §6.3 set-collapse applies to the whole group — the conservative
    // reading, and the only one under which the collapsed relationship is a set.
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "a", props: { weight: 1 } }),
      stagedEdge({ id: "edge-2", from: "x", to: "a", props: { weight: 1 } }),
      stagedEdge({
        id: "edge-3",
        from: "x",
        to: "b",
        props: { weight: 1 },
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

    expect(result.edges).toHaveLength(1);
    const edge = requireDefined(result.edges[0]);
    expect(edge.id).toBe("edge-1");
    expect(edge.mergedIds.map((id) => id as string)).toEqual([
      "edge-1",
      "edge-2",
      "edge-3",
    ]);
  });

  it("gives each parallel edge its own valid-time window", () => {
    // The window-landing consequence: an end claimed on one row stays on that row
    // instead of migrating to an unrelated min-id survivor.
    const staged = [
      stagedEdge({
        id: "edge-inherited",
        from: "x",
        to: "y",
        validTo: "2100-06-01T00:00:00.000Z",
      }),
      stagedEdge({
        id: "edge-new",
        from: "x",
        to: "y",
        branchId: BRANCH_B,
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2100-01-01T00:00:00.000Z",
      }),
    ];

    const result = repointEdges(
      staged,
      noRepoint,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(
      result.edges.map((edge) => ({
        id: edge.id,
        validFrom: edge.validFrom,
        validTo: edge.validTo,
      })),
    ).toEqual([
      {
        id: "edge-inherited",
        validFrom: undefined,
        validTo: "2100-06-01T00:00:00.000Z",
      },
      {
        id: "edge-new",
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2100-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("takes the EARLIEST end across a repoint-induced fold (#383)", () => {
    // The window fold still applies where the fold itself does: the end claimed on
    // the folded-away x→b must not be lost to the arbitrary min-id survivor pick.
    const staged = [
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "a",
        validTo: "2100-06-01T00:00:00.000Z",
      }),
      stagedEdge({
        id: "edge-2",
        from: "x",
        to: "b",
        branchId: BRANCH_B,
        validTo: "2100-01-01T00:00:00.000Z",
      }),
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
    expect(edge.id).toBe("edge-1");
    expect(edge.validTo).toBe("2100-01-01T00:00:00.000Z");
  });

  it("lets a preferred-branch survivor of a repoint-induced fold keep its own end", () => {
    // The incremental rule: the preferred branch IS the committed target, and a
    // user branch never re-windows a row the target already ended.
    const staged = [
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "a",
        branchId: BRANCH_A,
        validTo: "2100-06-01T00:00:00.000Z",
      }),
      stagedEdge({
        id: "edge-2",
        from: "x",
        to: "b",
        branchId: BRANCH_B,
        validTo: "2100-01-01T00:00:00.000Z",
      }),
    ];

    const result = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
      undefined,
      BRANCH_A,
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.validTo).toBe("2100-06-01T00:00:00.000Z");
  });

  it("produces an identical result across shuffled input for parallel edges", () => {
    // Parallel edges agree on endpoints, type AND props, so the output sort must
    // break the tie on edge id — a stable sort over a non-total key would leak
    // input order into the result.
    const staged = [
      stagedEdge({ id: "edge-3", from: "x", to: "y", props: { n: 1 } }),
      stagedEdge({ id: "edge-1", from: "x", to: "y", props: { n: 1 } }),
      stagedEdge({
        id: "edge-2",
        from: "x",
        to: "y",
        props: { n: 1 },
        branchId: BRANCH_B,
      }),
    ];

    const reference = projectEdges(
      repointEdges(staged, noRepoint, new Set<MergeKey>(), "flag", rank())
        .edges,
    );
    expect(reference.map((edge) => edge.id)).toEqual([
      "edge-1",
      "edge-2",
      "edge-3",
    ]);

    for (let seed = 1; seed <= 6; seed += 1) {
      const result = repointEdges(
        shuffled(staged, seed),
        noRepoint,
        new Set<MergeKey>(),
        "flag",
        rank(),
      );
      expect(projectEdges(result.edges)).toEqual(reference);
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
