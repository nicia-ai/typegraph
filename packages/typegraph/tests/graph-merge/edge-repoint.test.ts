import type { EdgeId, JsonValue, NodeId, NodeType } from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";

import type { ClusterResult } from "../../src/graph-merge/clustering";
import { buildBranchRank } from "../../src/graph-merge/conflict-policy";
import type {
  MergedEdge,
  StagedEdge,
} from "../../src/graph-merge/edge-repoint";
import {
  BRANCH_CREATED_EDGE_ORIGIN,
  buildCanonicalMap,
  ENDPOINT_DELETED_DROP_REASON,
  INHERITED_EDGE_ORIGIN,
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

/**
 * Builds a staged edge with parsed props; defaults keep the call sites terse. The
 * origin defaults to BRANCH-CREATED, so a case says `inherited: true` exactly when the
 * committed-row survivor rule is what it is about.
 *
 * `baseProps` is what the merge base holds for an INHERITED row, so a case supplies it
 * exactly when it is about which values the property union treats as AUTHORED. A
 * branch-created edge never carries one.
 */
function stagedEdge(
  args: Readonly<{
    id: string;
    from: string;
    to: string;
    kind?: string;
    props?: Readonly<Record<string, JsonValue>>;
    baseProps?: Readonly<Record<string, JsonValue>>;
    branchId?: typeof BRANCH_A;
    inherited?: boolean;
    validFrom?: string;
    validTo?: string;
  }>,
): StagedEdge {
  return {
    id: edgeId(args.id),
    kind: args.kind ?? "references",
    origin:
      args.inherited === true ?
        INHERITED_EDGE_ORIGIN
      : BRANCH_CREATED_EDGE_ORIGIN,
    fromId: nodeId(args.from),
    toId: nodeId(args.to),
    fromKind: "Doc",
    toKind: "Doc",
    props: args.props ?? {},
    ...(args.baseProps === undefined ? {} : { baseProps: args.baseProps }),
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

  it("folds a repointed member into ONE row of a pair that has parallel rows", () => {
    // A repointed member (x→b, with {a,b} collapsed) joins a group that already held
    // two parallel x→a rows. The collapse is ACROSS the pre-repoint pairs — x→b and
    // x→a became one relationship — and says nothing about the two rows that were
    // already there, so it folds into the first of them and the second still commits.
    // Folding the pair's own rows together would destroy the authored multiplicity
    // this module exists to stop destroying (and would silently drop `edge-2`'s
    // property edit, since a folded-away committed row is never rewritten).
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "a", props: { weight: 1 } }),
      stagedEdge({ id: "edge-2", from: "x", to: "a", props: { weight: 2 } }),
      stagedEdge({
        id: "edge-3",
        from: "x",
        to: "b",
        props: { weight: 3 },
        branchId: BRANCH_B,
      }),
    ];

    const reference = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(
      reference.edges.map((edge) => ({
        id: edge.id,
        toId: edge.toId,
        weight: edge.props["weight"],
        mergedIds: edge.mergedIds.map((id) => id as string),
      })),
    ).toEqual([
      // "flag" keeps the survivor's value, so the collapse reports its disagreement
      // with the repointed member rather than resolving it.
      {
        id: "edge-1",
        toId: "a",
        weight: 1,
        mergedIds: ["edge-1", "edge-3"],
      },
      { id: "edge-2", toId: "a", weight: 2, mergedIds: ["edge-2"] },
    ]);
    // The only reported disagreement is between the two rows the collapse merged.
    expect(
      reference.conflicts.map((conflict) => ({
        entityId: conflict.entityId,
        values: conflict.values.map((value) => value.value),
      })),
    ).toEqual([{ entityId: "edge-1", values: [1, 3] }]);

    // Which row the repointed member joins is derived from the ids and the
    // pre-repoint pairs, never from input order.
    for (let seed = 1; seed <= 6; seed += 1) {
      const result = repointEdges(
        shuffled(staged, seed),
        collapse,
        new Set<MergeKey>(),
        "flag",
        rank(),
      );
      expect(projectEdges(result.edges)).toEqual(projectEdges(reference.edges));
    }
  });

  it("keeps ONE row for an edge id two branches staged from different endpoints", () => {
    // A chosen-id import can have two branches create the SAME edge id; if they name
    // different endpoints that repointing then unifies, it is still one row and must
    // commit once — emitting the id twice would plan two conflicting writes for it.
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "a", props: { weight: 1 } }),
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "b",
        props: { weight: 2 },
        branchId: BRANCH_B,
      }),
      stagedEdge({ id: "edge-2", from: "x", to: "a", props: { weight: 3 } }),
    ];

    const result = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(
      result.edges.map((edge) => ({
        id: edge.id,
        mergedIds: edge.mergedIds.map((id) => id as string),
      })),
    ).toEqual([
      { id: "edge-1", mergedIds: ["edge-1", "edge-1"] },
      { id: "edge-2", mergedIds: ["edge-2"] },
    ]);
  });

  it("drops EVERY parallel edge to a deleted endpoint, not just one", () => {
    // The drop is per staged edge and runs before any grouping, so parallel rows are
    // each recorded — a group representative standing in for the rest would leave a
    // dangling row behind.
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "y", props: { n: 1 } }),
      stagedEdge({ id: "edge-2", from: "x", to: "y", props: { n: 1 } }),
    ];

    const result = repointEdges(
      staged,
      noRepoint,
      new Set<MergeKey>([key("y")]),
      "flag",
      rank(),
    );

    expect(result.edges).toEqual([]);
    expect(result.dropped).toEqual([
      { kind: "edge", id: "edge-1", reason: ENDPOINT_DELETED_DROP_REASON },
      { kind: "edge", id: "edge-2", reason: ENDPOINT_DELETED_DROP_REASON },
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

  it("takes the preferred branch's EARLIEST end when a fold merged several of its rows", () => {
    // The survivor is the preferred branch's row but claims no end, so the fold
    // resolves across the set — and the preferred branch itself claimed two ends, on
    // two rows the collapse merged. The least-claim rule decides, not whichever of
    // its rows sorts first: an end nobody withdrew must not be discarded.
    const staged = [
      stagedEdge({ id: "edge-1", from: "x", to: "a", branchId: BRANCH_A }),
      stagedEdge({
        id: "edge-2",
        from: "x",
        to: "b",
        branchId: BRANCH_A,
        validTo: "2100-06-01T00:00:00.000Z",
      }),
      stagedEdge({
        id: "edge-3",
        from: "x",
        to: "c",
        branchId: BRANCH_A,
        validTo: "2100-01-01T00:00:00.000Z",
      }),
    ];

    const result = repointEdges(
      staged,
      buildCanonicalMap([clusterOf("a", "b", "c")], (cluster) =>
        minIdCanonical(cluster),
      ),
      new Set<MergeKey>(),
      "flag",
      rank(),
      undefined,
      BRANCH_A,
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.id).toBe("edge-1");
    expect(result.edges[0]?.validTo).toBe("2100-01-01T00:00:00.000Z");
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

/**
 * The survivor rule (issue #395): a fold lands on the row the merge TARGET already
 * holds. A fold rewrites its survivor and ends none of the members that folded into
 * it, so a survivor the target does not hold leaves every committed member live beside
 * the row meant to replace it, still carrying its pre-merge props.
 */
describe("repointEdges survivor rule (#395)", () => {
  // {a, b} collapse to canonical "a" (min id): the repoint-induced fold.
  const collapse = buildCanonicalMap([clusterOf("a", "b")], (cluster) =>
    minIdCanonical(cluster),
  );

  // Both orderings of the branch-created id against the inherited one. The min-id rule
  // agreed with inherited-wins only in the second, so the LOW case is the regression
  // and the HIGH case pins that the two orders now produce the same survivor.
  describe.each([
    { position: "BELOW", inheritedId: "edge-5", createdId: "edge-1" },
    { position: "ABOVE", inheritedId: "edge-1", createdId: "edge-9" },
  ])(
    "a branch-created member whose id sorts $position the inherited one",
    ({ inheritedId, createdId }) => {
      it("folds onto the inherited row", () => {
        const staged = [
          stagedEdge({
            id: inheritedId,
            from: "x",
            to: "a",
            props: { weight: 1 },
            inherited: true,
          }),
          stagedEdge({
            id: createdId,
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

        expect(
          result.edges.map((edge) => ({
            id: edge.id,
            weight: edge.props["weight"],
            mergedIds: edge.mergedIds.map((id) => id as string),
          })),
        ).toEqual([
          {
            id: inheritedId,
            // "flag" keeps the survivor's value — now the committed row's edit.
            weight: 1,
            mergedIds: [inheritedId, createdId].sort((left, right) =>
              lexicographic(left, right),
            ),
          },
        ]);
        // The report names the row that actually persists.
        expect(
          result.conflicts.map((conflict) => ({
            entityId: conflict.entityId,
            values: conflict.values.map((value) => value.value),
          })),
        ).toEqual([{ entityId: inheritedId, values: [1, 2] }]);
      });
    },
  );

  it("prefers an inherited row over the PREFERRED branch's own new row", () => {
    // The incremental target's new row is live too, so the preferred-branch pick was
    // never wrong about liveness — but it can only ever protect ONE of the two rows,
    // and choosing it strands the committed one WITH the edit staged for it. So
    // inherited-wins outranks it; the target's row folds in and keeps existing.
    const staged = [
      stagedEdge({
        id: "edge-5",
        from: "x",
        to: "a",
        props: { weight: 1 },
        branchId: BRANCH_B,
        inherited: true,
      }),
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "b",
        props: { weight: 2 },
        branchId: BRANCH_A,
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

    expect(result.edges.map((edge) => edge.id)).toEqual(["edge-5"]);
    // The preferred branch still wins the PROPERTY it disagrees on: survivorship
    // decides which row is written, the conflict policy what is written to it.
    expect(result.edges[0]?.props["weight"]).toBe(2);
  });

  it("picks the minimum-id INHERITED member when the repoint folded several committed rows", () => {
    // Three pre-repoint pairs, two of them committed rows. Only one row can be written
    // per folded set, so the other committed row stays live — the residual the node
    // path has too (§6.4-A keeps a cluster to ≤1 base member for exactly this reason).
    // What the rule fixes is that the survivor is never the row nobody holds yet.
    const staged = [
      stagedEdge({
        id: "edge-5",
        from: "x",
        to: "a",
        props: { weight: 1 },
        inherited: true,
      }),
      stagedEdge({
        id: "edge-3",
        from: "x",
        to: "b",
        props: { weight: 2 },
        inherited: true,
      }),
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "c",
        props: { weight: 3 },
        branchId: BRANCH_B,
      }),
    ];

    const result = repointEdges(
      staged,
      buildCanonicalMap([clusterOf("a", "b", "c")], (cluster) =>
        minIdCanonical(cluster),
      ),
      new Set<MergeKey>(),
      "flag",
      rank(),
    );

    expect(
      result.edges.map((edge) => ({
        id: edge.id,
        mergedIds: edge.mergedIds.map((id) => id as string),
      })),
    ).toEqual([{ id: "edge-3", mergedIds: ["edge-1", "edge-3", "edge-5"] }]);
  });

  it("keeps the minimum edge id when NO member is inherited", () => {
    // Nothing committed is at stake, so the fallback is the unchanged min-id rule.
    const staged = [
      stagedEdge({ id: "edge-9", from: "x", to: "a", props: { weight: 1 } }),
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

    expect(result.edges.map((edge) => edge.id)).toEqual(["edge-2"]);
    expect(result.conflicts.map((conflict) => conflict.entityId)).toEqual([
      "edge-2",
    ]);
  });

  it("lands a folded END on the inherited survivor and leaves its own start alone", () => {
    // The end is a monotone claim and folds across the set either way; what changes is
    // WHERE it lands. A branch-created member's authored START does not travel with it:
    // the committed row already has the correct `validFrom` and a merge never restates
    // one (the previous survivor, being a fresh row, needed it written).
    const staged = [
      stagedEdge({
        id: "edge-5",
        from: "x",
        to: "a",
        props: { weight: 1 },
        inherited: true,
      }),
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "b",
        props: { weight: 1 },
        branchId: BRANCH_B,
        validFrom: "2020-01-01T00:00:00.000Z",
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
    expect(result.edges[0]?.id).toBe("edge-5");
    expect(result.edges[0]?.validFrom).toBeUndefined();
    expect(result.edges[0]?.validTo).toBe("2100-01-01T00:00:00.000Z");
  });

  it("produces an identical result across shuffled input for mixed-origin groups", () => {
    // Origin is intrinsic to the staged set, so a group holding both buckets — folded
    // and parallel, one row staged by two branches — resolves identically whatever
    // order the edges arrive in.
    const staged = [
      // One INHERITED row staged by both branches — the same row seen twice.
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "a",
        props: { weight: 1 },
        inherited: true,
      }),
      stagedEdge({
        id: "edge-1",
        from: "x",
        to: "a",
        props: { weight: 9 },
        branchId: BRANCH_B,
        inherited: true,
      }),
      // A branch-created parallel row on the same pair: multiplicity, not a fold.
      stagedEdge({ id: "edge-4", from: "x", to: "a", props: { weight: 4 } }),
      // A branch-created row the repoint brought onto those endpoints: this is the
      // fold, and it lands on the inherited row.
      stagedEdge({
        id: "edge-2",
        from: "x",
        to: "b",
        props: { weight: 2 },
        branchId: BRANCH_B,
      }),
    ];

    const reference = repointEdges(
      staged,
      collapse,
      new Set<MergeKey>(),
      "flag",
      rank(),
    );
    expect(
      reference.edges.map((edge) => ({
        id: edge.id,
        weight: edge.props["weight"],
        mergedIds: edge.mergedIds.map((id) => id as string),
      })),
    ).toEqual([
      {
        id: "edge-1",
        weight: 1,
        mergedIds: ["edge-1", "edge-1", "edge-2"],
      },
      { id: "edge-4", weight: 4, mergedIds: ["edge-4"] },
    ]);
    expect(
      reference.conflicts.map((conflict) => ({
        entityId: conflict.entityId,
        resolution: conflict.resolution,
      })),
    ).toEqual([{ entityId: "edge-1", resolution: 1 }]);

    for (let seed = 1; seed <= 6; seed += 1) {
      const result = repointEdges(
        shuffled(staged, seed),
        collapse,
        new Set<MergeKey>(),
        "flag",
        rank(),
      );
      expect(projectEdges(result.edges)).toEqual(projectEdges(reference.edges));
      expect(
        result.conflicts.map((conflict) => ({
          entityId: conflict.entityId,
          property: conflict.property,
          resolution: conflict.resolution,
        })),
      ).toEqual(
        reference.conflicts.map((conflict) => ({
          entityId: conflict.entityId,
          property: conflict.property,
          resolution: conflict.resolution,
        })),
      );
    }
  });
});

/**
 * The fold's property union is BASE-AWARE (issue #408): only a member that CHANGED a
 * property from its own base competes for it.
 *
 * Without that filter a staged copy of an inherited row contributed its whole fork
 * bag, so an UNTOUCHED base value entered the union as a first-class `(branch, value)`
 * claim. Under any rank-based policy the branch label riding on that untouched copy
 * then decided the committed value — and for a WINDOW-ONLY carrier, whose props are
 * the base's and whose label is merely whichever branch sorted first, that meant an
 * arbitrary label could outvote a real edit.
 *
 * These cases pin the filter and its edges: a real edit wins over an untouched value
 * whichever way the ranks fall, a genuine disagreement still conflicts over its REAL
 * values only, and a property nobody authored keeps the value it had rather than
 * disappearing with the claim.
 */
describe("repointEdges base-aware property union (#408)", () => {
  const collapse = buildCanonicalMap([clusterOf("a", "b", "c")], (cluster) =>
    minIdCanonical(cluster),
  );
  const BRANCH_C = asBranchId("branch-c");

  /** [a, b, c] — so branch-a outranks branch-b outranks branch-c. */
  function rankABC(): ReadonlyMap<typeof BRANCH_A, number> {
    return buildBranchRank(
      [BRANCH_A, BRANCH_B, BRANCH_C],
      [BRANCH_A, BRANCH_B, BRANCH_C],
    );
  }

  // The carrier's rank against the authoring branch's, both ways round. Ranked
  // BELOW, the old union happened to commit the authored value; ranked ABOVE, it
  // committed the base's stale one — the same fold with the same members, decided by
  // a label. Both orders must now agree.
  describe.each([
    { position: "BELOW", carrier: BRANCH_B, author: BRANCH_A },
    { position: "ABOVE", carrier: BRANCH_A, author: BRANCH_B },
  ])(
    "a window-only carrier ranked $position the authoring branch",
    ({ carrier, author }) => {
      it("contributes no claim, so the authored value is committed", () => {
        const result = repointEdges(
          [
            // The carrier: an inherited row staged ONLY to carry an ending, so its
            // props ARE its base props and it authored nothing.
            stagedEdge({
              id: "edge-1",
              from: "x",
              to: "a",
              inherited: true,
              props: { on: "base" },
              baseProps: { on: "base" },
              branchId: carrier,
              validTo: "2100-01-01T00:00:00.000Z",
            }),
            stagedEdge({
              id: "edge-2",
              from: "x",
              to: "b",
              props: { on: "authored" },
              branchId: author,
            }),
          ],
          collapse,
          new Set<MergeKey>(),
          "lastWriteWins",
          rankABC(),
        );

        expect(projectEdges(result.edges)).toEqual([
          {
            id: "edge-1",
            kind: "references",
            fromId: "x",
            toId: "a",
            props: { on: "authored" },
            mergedIds: ["edge-1", "edge-2"],
            validFrom: undefined,
            validTo: "2100-01-01T00:00:00.000Z",
          },
        ]);
        // One claim is not a disagreement: the carrier contributes no value, so
        // there is nothing for the authored one to conflict WITH.
        expect(result.conflicts).toEqual([]);
      });
    },
  );

  it("still conflicts over two genuinely changed values, naming only those", () => {
    const result = repointEdges(
      [
        stagedEdge({
          id: "edge-1",
          from: "x",
          to: "a",
          inherited: true,
          props: { on: "base" },
          baseProps: { on: "base" },
          branchId: BRANCH_A,
        }),
        stagedEdge({
          id: "edge-2",
          from: "x",
          to: "b",
          props: { on: "edit-b" },
          branchId: BRANCH_B,
        }),
        stagedEdge({
          id: "edge-3",
          from: "x",
          to: "c",
          props: { on: "edit-c" },
          branchId: BRANCH_C,
        }),
      ],
      collapse,
      new Set<MergeKey>(),
      "lastWriteWins",
      rankABC(),
    );

    // The disagreement is real and reported — over the two AUTHORED values alone.
    // The carrier's untouched "base" is absent from `values`, so the resolution can
    // only ever name a value some branch actually asked for.
    expect(
      result.conflicts.map((conflict) => ({
        entityId: conflict.entityId,
        property: conflict.property,
        values: conflict.values.map((value) => [
          value.branchId as string,
          value.value,
        ]),
        resolution: conflict.resolution,
      })),
    ).toEqual([
      {
        entityId: "edge-1",
        property: "on",
        values: [
          [BRANCH_B as string, "edit-b"],
          [BRANCH_C as string, "edit-c"],
        ],
        resolution: "edit-b",
      },
    ]);
    expect(requireDefined(result.edges[0]).props).toEqual({ on: "edit-b" });
  });

  it("keeps an unchanged inherited value that no member authored", () => {
    // Filtering out unauthored CLAIMS must not erase unauthored VALUES: the fold
    // still commits a full prop bag, so a property nobody touched keeps the value the
    // survivor holds.
    const result = repointEdges(
      [
        stagedEdge({
          id: "edge-1",
          from: "x",
          to: "a",
          inherited: true,
          props: { on: "base" },
          baseProps: { on: "base" },
          branchId: BRANCH_A,
        }),
        // A branch-created member that says nothing about `on` at all, so the two
        // members differ on content and the union (not the exact-equal collapse)
        // decides the result.
        stagedEdge({
          id: "edge-2",
          from: "x",
          to: "b",
          props: {},
          branchId: BRANCH_B,
        }),
      ],
      collapse,
      new Set<MergeKey>(),
      "lastWriteWins",
      rankABC(),
    );

    expect(requireDefined(result.edges[0]).props).toEqual({ on: "base" });
    expect(result.conflicts).toEqual([]);
  });

  /**
   * The property union asks each staged bag whether it CARRIES a property, and a
   * props bag is data: an edge schema may declare a field named after an
   * `Object.prototype` member, and such a field survives validation and the JSON
   * round-trip as ordinary data (issue #422). Membership must therefore be an
   * OWN-key question.
   *
   * Under `in`, the branch-created member below "carries" `toString` despite saying
   * nothing about it, so it is counted as having AUTHORED a value it never wrote. The
   * authored-claims filter this describe block exists to pin is defeated for exactly
   * these field names, and the fold's claim filter and the shared value collector must
   * agree that a member which does not carry a property has no claim on it: whichever
   * of the two asks with `in` reintroduces a phantom claimant.
   */
  it("does not treat a prototype-named property as authored by a member that lacks it", () => {
    const result = repointEdges(
      [
        stagedEdge({
          id: "edge-1",
          from: "x",
          to: "a",
          inherited: true,
          props: { on: "base", toString: "base-owned" },
          baseProps: { on: "base", toString: "base-owned" },
          branchId: BRANCH_A,
        }),
        // Authors `on` and says nothing whatsoever about `toString`.
        stagedEdge({
          id: "edge-2",
          from: "x",
          to: "b",
          props: { on: "authored" },
          branchId: BRANCH_B,
        }),
      ],
      collapse,
      new Set<MergeKey>(),
      "lastWriteWins",
      rankABC(),
    );

    expect(requireDefined(result.edges[0]).props).toEqual({
      on: "authored",
      toString: "base-owned",
    });
    // No member authored `toString`, so there is nothing for it to conflict over.
    expect(
      result.conflicts.filter((conflict) => conflict.property === "toString"),
    ).toEqual([]);
  });

  it("keeps an unauthored property the SURVIVOR's own bag lacks", () => {
    // Two committed rows the repoint folded together — the survivor is the min-id
    // inherited one, and the other member's untouched property has no claim behind
    // it. It is still part of the folded row's content, so the key survives with the
    // value that member carried.
    const result = repointEdges(
      [
        stagedEdge({
          id: "edge-1",
          from: "x",
          to: "a",
          inherited: true,
          props: { on: "base-a" },
          baseProps: { on: "base-a" },
          branchId: BRANCH_A,
        }),
        stagedEdge({
          id: "edge-2",
          from: "x",
          to: "b",
          inherited: true,
          props: { note: "base-b" },
          baseProps: { note: "base-b" },
          branchId: BRANCH_B,
        }),
      ],
      collapse,
      new Set<MergeKey>(),
      "lastWriteWins",
      rankABC(),
    );

    expect(requireDefined(result.edges[0]).id).toBe("edge-1");
    expect(requireDefined(result.edges[0]).props).toEqual({
      on: "base-a",
      note: "base-b",
    });
    expect(result.conflicts).toEqual([]);
  });

  /**
   * The same fold, with the carried key named after an `Object.prototype` member
   * (issue #422). This path asks the SURVIVOR's bag whether the fold already holds a
   * value for the key, and a props bag is data: under `in` a survivor that carries no
   * `toString` answers yes, so the committed row takes `Object.prototype.toString` — a
   * FUNCTION — as the property's value instead of the value the other member carries.
   */
  it("keeps a prototype-named unauthored property the SURVIVOR's own bag lacks", () => {
    const result = repointEdges(
      [
        stagedEdge({
          id: "edge-1",
          from: "x",
          to: "a",
          inherited: true,
          props: { on: "base-a" },
          baseProps: { on: "base-a" },
          branchId: BRANCH_A,
        }),
        stagedEdge({
          id: "edge-2",
          from: "x",
          to: "b",
          inherited: true,
          props: { toString: "base-b" },
          baseProps: { toString: "base-b" },
          branchId: BRANCH_B,
        }),
      ],
      collapse,
      new Set<MergeKey>(),
      "lastWriteWins",
      rankABC(),
    );

    expect(requireDefined(result.edges[0]).id).toBe("edge-1");
    expect(requireDefined(result.edges[0]).props).toEqual({
      on: "base-a",
      toString: "base-b",
    });
    expect(result.conflicts).toEqual([]);
  });

  /**
   * The survivor-lacks-the-key read on the CONTESTED path: `"flag"` commits the
   * canonical value, which for a key the survivor does not carry is the first real
   * claim. Under `in` the survivor's bag supplies `Object.prototype.toString` instead,
   * so a function is committed as the merged property value.
   *
   * The whole bag is compared rather than the one key because TypeScript resolves
   * `props["toString"]` to `Object`'s method signature, not the record's index
   * signature — the shadowing this file is about, one level up in the type system.
   */
  it("resolves a contested prototype-named property the SURVIVOR lacks from real claims", () => {
    const result = repointEdges(
      [
        stagedEdge({
          id: "edge-1",
          from: "x",
          to: "a",
          inherited: true,
          props: { on: "base-a" },
          baseProps: { on: "base-a" },
          branchId: BRANCH_A,
        }),
        stagedEdge({
          id: "edge-2",
          from: "x",
          to: "b",
          props: { toString: "from-b" },
          branchId: BRANCH_B,
        }),
        stagedEdge({
          id: "edge-3",
          from: "x",
          to: "c",
          props: { toString: "from-c" },
          branchId: BRANCH_C,
        }),
      ],
      collapse,
      new Set<MergeKey>(),
      "flag",
      rankABC(),
    );

    expect(requireDefined(result.edges[0]).props).toEqual({
      on: "base-a",
      toString: "from-b",
    });
  });

  // Which branch a staged copy of an inherited row belongs to is arbitrary, so the
  // value kept for a key nobody authored must come from the ROW, not the label. Both
  // assignments below hold the same three rows; only the labels on the two `note`
  // carriers swap. Ordering the carriers by branch id instead flips the committed
  // value between them, which is the label sensitivity #408 is about.
  describe.each([
    { labelling: "in id order", second: BRANCH_B, third: BRANCH_C },
    { labelling: "SWAPPED", second: BRANCH_C, third: BRANCH_B },
  ])(
    "two unauthored carriers of a key the survivor lacks, labelled $labelling",
    ({ second, third }) => {
      it("keeps the value of the minimum-id row", () => {
        const result = repointEdges(
          [
            // The survivor: min-id inherited, and it carries no `note` at all.
            stagedEdge({
              id: "edge-1",
              from: "x",
              to: "a",
              inherited: true,
              props: { on: "base-a" },
              baseProps: { on: "base-a" },
              branchId: BRANCH_A,
            }),
            stagedEdge({
              id: "edge-2",
              from: "x",
              to: "b",
              inherited: true,
              props: { note: "from-edge-2" },
              baseProps: { note: "from-edge-2" },
              branchId: second,
            }),
            stagedEdge({
              id: "edge-3",
              from: "x",
              to: "c",
              inherited: true,
              props: { note: "from-edge-3" },
              baseProps: { note: "from-edge-3" },
              branchId: third,
            }),
          ],
          collapse,
          new Set<MergeKey>(),
          "lastWriteWins",
          rankABC(),
        );

        expect(requireDefined(result.edges[0]).props).toEqual({
          on: "base-a",
          note: "from-edge-2",
        });
        expect(result.conflicts).toEqual([]);
      });
    },
  );
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
