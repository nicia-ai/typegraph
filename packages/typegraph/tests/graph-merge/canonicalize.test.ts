import type { JsonValue, NodeId, NodeType } from "@nicia-ai/typegraph";
import { generateId } from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";

import type { ClusterMember } from "../../src/graph-merge/canonicalize";
import {
  canonicalizeCluster,
  pickCanonical,
} from "../../src/graph-merge/canonicalize";
import type { ClusterResult } from "../../src/graph-merge/clustering";
import { buildBranchRank } from "../../src/graph-merge/conflict-policy";
import {
  compareMergeKeys,
  type MergeKey,
  mergeKey,
} from "../../src/graph-merge/node-key";
import type {
  BranchId,
  PropertyConflictPolicy,
  ResolvedCluster,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";

type AnyNodeId = NodeId<NodeType>;

/** A bare node id — for ClusterMember ids and the public bare-id ResolvedCluster. */
function nodeId(value: string): AnyNodeId {
  return value as AnyNodeId;
}

/** A composite `(kind, id)` cluster key; every member in these tests is a `Patient`. */
function memberKey(id: string): MergeKey {
  return mergeKey("Patient", id);
}

function lexicographic(left: string, right: string): number {
  return (
    left < right ? -1
    : left > right ? 1
    : 0
  );
}

/** The INTERNAL composite-key cluster shape T8 emits (members are `(kind, id)` keys). */
function clusterOf(...ids: readonly string[]): ClusterResult {
  return {
    members: [...ids]
      .map((value) => memberKey(value))
      .sort((left, right) => compareMergeKeys(left, right)),
  };
}

/** The PUBLIC bare-id cluster shape the `pickCanonical` / `canonical` hook sees. */
function bareCluster(...ids: readonly string[]): ResolvedCluster {
  return {
    members: [...ids]
      .map((value) => nodeId(value))
      .sort((left, right) => lexicographic(left, right)),
  };
}

function member(
  id: string,
  branchId: BranchId,
  props: Readonly<Record<string, JsonValue>>,
): ClusterMember {
  return { origin: "staged", id: nodeId(id), kind: "Patient", branchId, props };
}

/** Deterministically shuffles a copy of an array via a seeded LCG. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    const swapWith = state % (index + 1);
    const temporary = copy[index]!;
    copy[index] = copy[swapWith]!;
    copy[swapWith] = temporary;
  }
  return copy;
}

const b1 = asBranchId("branch-1");
const b2 = asBranchId("branch-2");
const b3 = asBranchId("branch-3");

describe("pickCanonical", () => {
  it("defaults to the lexicographically-minimal member id", () => {
    expect(pickCanonical(bareCluster("c", "a", "b"))).toBe("a");
  });

  it("honors an explicit canonical override", () => {
    const last = (cluster: ResolvedCluster): AnyNodeId =>
      [...cluster.members].sort((left, right) =>
        lexicographic(right, left),
      )[0]!;
    expect(pickCanonical(bareCluster("a", "b", "c"), last)).toBe("c");
  });
});

describe("canonicalizeCluster", () => {
  // A 3-node cluster, one member per branch, agreeing on birthDate but
  // disagreeing on name — the classic entity-resolution property conflict.
  const cluster = clusterOf("node-a", "node-b", "node-c");
  const members: readonly ClusterMember[] = [
    member("node-a", b1, { name: "Anna Rivera", birthDate: "1990-01-01" }),
    member("node-b", b2, { name: "Ana Rivera", birthDate: "1990-01-01" }),
    member("node-c", b3, { name: "A. Rivera", birthDate: "1990-01-01" }),
  ];

  function rank(order: readonly BranchId[]): ReadonlyMap<BranchId, number> {
    return buildBranchRank(order, [b1, b2, b3]);
  }

  it('"flag" keeps the canonical member value and records the conflict', () => {
    const entity = canonicalizeCluster(cluster, members, "flag", rank([]));

    // Canonical is node-a (min id), whose name is "Anna Rivera".
    expect(entity.canonicalId).toBe("node-a");
    expect(entity.props.name).toBe("Anna Rivera");
    // birthDate agreed → unioned, no conflict.
    expect(entity.props.birthDate).toBe("1990-01-01");

    expect(entity.conflicts).toHaveLength(1);
    const conflict = entity.conflicts[0]!;
    expect(conflict.property).toBe("name");
    expect(`${conflict.entityId}`).toBe("node-a");
    expect(conflict.resolution).toBe("Anna Rivera");
    expect(conflict.values.map((value) => value.value).sort()).toEqual([
      "A. Rivera",
      "Ana Rivera",
      "Anna Rivera",
    ]);
  });

  it('"lastWriteWins" with branchOrder [b3,b1,b2] picks b3\'s value regardless of member array order', () => {
    const order = [b3, b1, b2];

    const natural = canonicalizeCluster(
      cluster,
      members,
      "lastWriteWins",
      rank(order),
    );
    expect(natural.props.name).toBe("A. Rivera");

    // Shuffling the member array must not change the resolution.
    for (let seed = 1; seed <= 5; seed += 1) {
      const reordered = canonicalizeCluster(
        cluster,
        shuffled(members, seed),
        "lastWriteWins",
        rank(order),
      );
      expect(reordered.props.name).toBe("A. Rivera");
      // The canonical id is still the min member id, independent of order.
      expect(reordered.canonicalId).toBe("node-a");
    }
  });

  it('"lastWriteWins" picks a different branch when the order is reversed', () => {
    const entity = canonicalizeCluster(
      cluster,
      members,
      "lastWriteWins",
      rank([b2, b1, b3]),
    );
    // b2 is now highest priority → "Ana Rivera".
    expect(entity.props.name).toBe("Ana Rivera");
  });

  it('"provenanceWeighted" picks the highest-weight branch', () => {
    const weights = new Map<BranchId, number>([
      [b1, 1],
      [b2, 5],
      [b3, 2],
    ]);
    const entity = canonicalizeCluster(
      cluster,
      members,
      "provenanceWeighted",
      rank([]),
      weights,
    );
    expect(entity.props.name).toBe("Ana Rivera");
  });

  it("delegates to a function policy with a deterministic conflict record", () => {
    const longest: PropertyConflictPolicy = (conflict) => {
      const candidates = conflict.values.map((entry) => entry.value as string);
      return candidates.reduce((current, candidate) =>
        candidate.length > current.length ? candidate : current,
      );
    };
    const entity = canonicalizeCluster(cluster, members, longest, rank([]));
    expect(entity.props.name).toBe("Anna Rivera");
  });

  it("records no conflict when every member agrees on a property", () => {
    const agreeing = clusterOf("x", "y");
    const agreeingMembers: readonly ClusterMember[] = [
      member("x", b1, { name: "Same Name" }),
      member("y", b2, { name: "Same Name" }),
    ];
    const entity = canonicalizeCluster(
      agreeing,
      agreeingMembers,
      "flag",
      rank([]),
    );
    expect(entity.conflicts).toHaveLength(0);
    expect(entity.props.name).toBe("Same Name");
  });

  it("reports the full EntityResolution (canonical, sorted members, branch origins)", () => {
    const entity = canonicalizeCluster(cluster, members, "flag", rank([]));
    expect(entity.resolution.canonicalId).toBe("node-a");
    expect(entity.resolution.memberIds.map((id) => id)).toEqual([
      "node-a",
      "node-b",
      "node-c",
    ]);
    expect(entity.resolution.kind).toBe("Patient");
    expect(entity.resolution.branchOrigins).toEqual([b1, b2, b3]);
  });

  it("min-nodeId canonical selection is independent of creation order (nanoid ids)", () => {
    // generateId() is nanoid (random, NOT time-prefixed), so the min id is NOT
    // the first-created id. Create three, build a cluster, assert the canonical
    // is the lexicographic minimum — proving creation order does not leak in.
    const created = [generateId(), generateId(), generateId()];
    const sortedMin = [...created].sort((left, right) =>
      lexicographic(left, right),
    )[0]!;

    const nanoidCluster = clusterOf(...created);
    const nanoidMembers = created.map((id, index) =>
      member(id, [b1, b2, b3][index]!, { name: "Shared" }),
    );

    const entity = canonicalizeCluster(
      nanoidCluster,
      nanoidMembers,
      "flag",
      rank([]),
    );
    expect(entity.canonicalId).toBe(sortedMin);
  });
});

describe("ClusterMember origin discriminator (step 1)", () => {
  function rank(order: readonly BranchId[]): ReadonlyMap<BranchId, number> {
    return buildBranchRank(order, [b1, b2]);
  }

  it("tags staged contributions with origin 'staged'", () => {
    const staged = member("node-a", b1, { name: "Anna Rivera" });
    expect(staged.origin).toBe("staged");
  });

  it("makes a base-origin member the survivor even when its id is NOT the minimum (base-id-wins)", () => {
    // base-id-wins (§6.4-C): whenever a cluster holds a base member, the committed
    // identity is the canonical survivor regardless of the min-id rule. The base id
    // here ("z-base") is the lexicographic MAXIMUM, so this fails if survivor selection
    // ever regressed to plain min-id (the old fixture used a min base id and could not
    // catch that). The base member's extra property still gap-fills the union.
    const cluster = clusterOf("a-new", "z-base");
    const members: readonly ClusterMember[] = [
      {
        origin: "base",
        id: nodeId("z-base"),
        kind: "Patient",
        branchId: b1,
        props: { name: "Anna Rivera", mrn: "MRN-1" },
      },
      member("a-new", b2, { name: "Anna Rivera" }),
    ];

    const entity = canonicalizeCluster(
      cluster,
      members,
      "flag",
      rank([b1, b2]),
    );
    console.info(
      "[origin] survivor:",
      entity.canonicalId,
      "from",
      members.map((m) => `${m.id}:${m.origin}`),
    );
    expect(entity.canonicalId).toBe("z-base");
    expect(entity.resolution.canonicalId).toBe(nodeId("z-base"));
    expect(entity.props.name).toBe("Anna Rivera");
    expect(entity.props.mrn).toBe("MRN-1");
  });
});
