/**
 * Staging (design §6.4 rule 1, T7): run the state-diff (T3) for EVERY branch,
 * tag each diff item with its origin {@link BranchId}, and assemble the UNION
 * of all branches' diffs into a single {@link StagingSet}.
 *
 * Why union (not incremental):
 *   Downstream candidate-generation (T6) and clustering (T8) must be
 *   order-independent — shuffling the branch order MUST yield an identical
 *   merge. If staging folded branches one-at-a-time into a mutating cumulative
 *   state, the result could depend on fold order. Instead we COLLECT every
 *   branch's tagged items into flat arrays, then GROUP and SORT once at the end,
 *   so the {@link StagingSet} is a pure function of the unordered branch SET.
 *
 * Provenance tagging:
 *   Every staged item carries the {@link BranchId} of the branch whose diff
 *   produced it. An inherited node modified differently by two branches appears
 *   once per branch (each tagged), which is exactly what the conflict-detection
 *   phases (T8 / T8a) need. A new node introduced by one branch appears once,
 *   tagged by that branch.
 *
 * Determinism:
 *   - New nodes/edges are grouped by kind; the per-kind arrays are sorted by
 *     `(id, branchId)`.
 *   - Flat collections (modified / deleted) are sorted by `(kind, id, branchId)`.
 *   - Bucket maps iterate in lexicographic kind order.
 *   The `(…, branchId)` tail breaks ties when the same id is contributed by more
 *   than one branch, so the ordering is total and stable.
 */

import { compareStrings } from "./node-key";
import type {
  ChangedEdge,
  ChangedNode,
  DeletedEdge,
  DeletedNode,
  ModifiedEdge,
  ModifiedNode,
} from "./state-diff";
import { diffAgainstBase } from "./state-diff";
import type { GraphDef, Store } from "./typegraph-internal";
import type { BranchId, GraphBranch } from "./types";

/** A new fork node tagged with the branch that introduced it. */
export type StagedNewNode = Readonly<{
  branchId: BranchId;
  node: ChangedNode;
}>;

/** A modified inherited node tagged with the branch that modified it. */
export type StagedModifiedNode = Readonly<{
  branchId: BranchId;
  node: ModifiedNode;
}>;

/** A deleted inherited node tagged with the branch that deleted it. */
export type StagedDeletedNode = Readonly<{
  branchId: BranchId;
  node: DeletedNode;
}>;

/** A new fork edge tagged with the branch that introduced it. */
export type StagedNewEdge = Readonly<{
  branchId: BranchId;
  edge: ChangedEdge;
}>;

/** A modified inherited edge tagged with the branch that modified it. */
export type StagedModifiedEdge = Readonly<{
  branchId: BranchId;
  edge: ModifiedEdge;
}>;

/** A deleted inherited edge tagged with the branch that deleted it. */
export type StagedDeletedEdge = Readonly<{
  branchId: BranchId;
  edge: DeletedEdge;
}>;

/**
 * The provenance-tagged union of every branch's state-diff against the base.
 *
 * New items are bucketed by kind so downstream blocking/candidate-gen (T5/T6)
 * can iterate one kind at a time. Modified and deleted items are kept as flat,
 * fully-sorted arrays — conflict detection (T8/T8a) groups them by id itself.
 */
export type StagingSet = Readonly<{
  /** New fork nodes, bucketed by kind. Map iterates in lexicographic kind order. */
  newNodesByKind: ReadonlyMap<string, readonly StagedNewNode[]>;
  /** Modified inherited nodes (one entry per (id, branch) modification). */
  modifiedNodes: readonly StagedModifiedNode[];
  /** Deleted inherited nodes (one entry per (id, branch) deletion). */
  deletedNodes: readonly StagedDeletedNode[];
  /** New fork edges, bucketed by kind. Map iterates in lexicographic kind order. */
  newEdgesByKind: ReadonlyMap<string, readonly StagedNewEdge[]>;
  /** Modified inherited edges (one entry per (id, branch) modification). */
  modifiedEdges: readonly StagedModifiedEdge[];
  /** Deleted inherited edges (one entry per (id, branch) deletion). */
  deletedEdges: readonly StagedDeletedEdge[];
}>;

/**
 * Total order over `(id, branchId)`. Used for the new-node/new-edge per-kind
 * buckets, where every member already shares a kind so kind need not be keyed.
 */
function compareByIdThenBranch(
  left: Readonly<{ id: string; branchId: BranchId }>,
  right: Readonly<{ id: string; branchId: BranchId }>,
): number {
  const byId = compareStrings(left.id, right.id);
  return byId === 0 ? compareStrings(left.branchId, right.branchId) : byId;
}

/**
 * Total order over `(kind, id, branchId)`. Used for the flat modified/deleted
 * collections, which mix kinds.
 */
function compareByKindIdBranch(
  left: Readonly<{ kind: string; id: string; branchId: BranchId }>,
  right: Readonly<{ kind: string; id: string; branchId: BranchId }>,
): number {
  const byKind = compareStrings(left.kind, right.kind);
  if (byKind !== 0) {
    return byKind;
  }
  const byId = compareStrings(left.id, right.id);
  return byId === 0 ? compareStrings(left.branchId, right.branchId) : byId;
}

/**
 * Groups items carrying a `kind` into a kind-keyed map whose iteration order is
 * lexicographic by kind and whose per-kind lists are sorted by `(id, branchId)`.
 */
function groupByKind<
  T extends Readonly<{ kind: string; id: string; branchId: BranchId }>,
>(items: readonly T[]): ReadonlyMap<string, readonly T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const bucket = buckets.get(item.kind);
    if (bucket === undefined) {
      buckets.set(item.kind, [item]);
    } else {
      bucket.push(item);
    }
  }
  const ordered = new Map<string, readonly T[]>();
  for (const kind of [...buckets.keys()].sort((left, right) =>
    compareStrings(left, right),
  )) {
    ordered.set(
      kind,
      [...buckets.get(kind)!].sort((left, right) =>
        compareByIdThenBranch(left, right),
      ),
    );
  }
  return ordered;
}

/**
 * Stages the UNION of all branches' diffs against the base, provenance-tagged.
 *
 * Each branch is diffed against `baseStore` (the immutable reference — NEVER a
 * clone, per the Interchange `deletedAt` fidelity limitation), and every diff
 * item is tagged with that branch's id. All branches' tagged items are then
 * collected into flat arrays and grouped/sorted ONCE, so the result is a pure
 * function of the unordered branch set: passing the branches in any order yields
 * a structurally identical {@link StagingSet}.
 *
 * @param baseStore The immutable base store every branch is diffed against.
 * @param branches The branches to stage. Order does not affect the result.
 * @returns The provenance-tagged union staging set.
 */
export async function stageBranches<G extends GraphDef>(
  baseStore: Store<G>,
  branches: readonly GraphBranch<G>[],
): Promise<StagingSet> {
  const newNodes: (StagedNewNode & { kind: string; id: string })[] = [];
  const modifiedNodes: (StagedModifiedNode & { kind: string; id: string })[] = [];
  const deletedNodes: (StagedDeletedNode & { kind: string; id: string })[] =
    [];
  const newEdges: (StagedNewEdge & { kind: string; id: string })[] = [];
  const modifiedEdges: (StagedModifiedEdge & { kind: string; id: string })[] = [];
  const deletedEdges: (StagedDeletedEdge & { kind: string; id: string })[] =
    [];

  for (const branch of branches) {
    const diff = await diffAgainstBase(baseStore, branch.store);
    const branchId = branch.id;

    for (const node of diff.nodes.new) {
      newNodes.push({ branchId, node, kind: node.kind, id: node.id });
    }
    for (const node of diff.nodes.modified) {
      modifiedNodes.push({ branchId, node, kind: node.kind, id: node.id });
    }
    for (const node of diff.nodes.deleted) {
      deletedNodes.push({ branchId, node, kind: node.kind, id: node.id });
    }
    for (const edge of diff.edges.new) {
      newEdges.push({ branchId, edge, kind: edge.kind, id: edge.id });
    }
    for (const edge of diff.edges.modified) {
      modifiedEdges.push({ branchId, edge, kind: edge.kind, id: edge.id });
    }
    for (const edge of diff.edges.deleted) {
      deletedEdges.push({ branchId, edge, kind: edge.kind, id: edge.id });
    }
  }

  return {
    newNodesByKind: groupByKind(newNodes),
    modifiedNodes: [...modifiedNodes].sort((left, right) =>
      compareByKindIdBranch(left, right),
    ),
    deletedNodes: [...deletedNodes].sort((left, right) =>
      compareByKindIdBranch(left, right),
    ),
    newEdgesByKind: groupByKind(newEdges),
    modifiedEdges: [...modifiedEdges].sort((left, right) =>
      compareByKindIdBranch(left, right),
    ),
    deletedEdges: [...deletedEdges].sort((left, right) =>
      compareByKindIdBranch(left, right),
    ),
  };
}
