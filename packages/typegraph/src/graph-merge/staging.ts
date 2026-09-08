import { requireDefined } from "../utils/presence";
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
 *
 * Pruning:
 *   Each branch's diff is bounded, when possible, by {@link branchPruneTo} — a
 *   lineage delta naming exactly the rows that changed on either side since
 *   the branch forked (see `state-diff.ts`'s `diffAgainstBase`). This changes
 *   which rows are READ, never the result: a row absent from the delta is
 *   guaranteed unchanged on both sides, so the staged `StagingSet` is
 *   identical to what a full enumeration would have produced.
 */
import { lineageDeltaSinceAnchor } from "./base-version";
import { compareStrings, type MergeKey, mergeKey } from "./node-key";
import type {
  ChangedEdge,
  ChangedNode,
  DeletedEdge,
  DeletedNode,
  ModifiedEdge,
  ModifiedNode,
  RetractionCause,
  WindowedEdge,
  WindowedNode,
} from "./state-diff";
import { diffAgainstBase } from "./state-diff";
import type {
  EntityKey,
  GraphDef,
  IdentityTransferAssertion,
  LineageDelta,
  Store,
} from "./typegraph-internal";
import { resolveLineage, storeRuntime } from "./typegraph-internal";
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
type StagedDeletedNode = Readonly<{
  branchId: BranchId;
  node: DeletedNode;
}>;

/** An inherited node whose valid-time window one branch changed. */
export type StagedWindowedNode = Readonly<{
  branchId: BranchId;
  node: WindowedNode;
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
type StagedDeletedEdge = Readonly<{
  branchId: BranchId;
  edge: DeletedEdge;
}>;

/** An inherited edge whose valid-time window one branch changed. */
export type StagedWindowedEdge = Readonly<{
  branchId: BranchId;
  edge: WindowedEdge;
}>;

export type StagedIdentityAssertion = Readonly<{
  branchId: BranchId;
  assertion: IdentityTransferAssertion;
}>;

/**
 * A retracted assertion tagged with the branch that stopped asserting it AND
 * with WHY it stopped ({@link RetractionCause}).
 *
 * A `cascade` entry is the staged form of "branch X's deletion of node N ended
 * this assertion" — its fate belongs to that deletion, so delete/modify
 * resolution decides it: applied when the deletion survives, dropped with the
 * deletion when it is overruled. An `explicit` entry is the branch's own intent
 * and outlives any deletion decision.
 */
export type StagedRetraction = StagedIdentityAssertion &
  Readonly<{ cause: RetractionCause }>;

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
  /**
   * Inherited nodes whose valid-time window a branch changed (one entry per
   * (id, branch) change). Disjoint from {@link StagingSet.modifiedNodes} in
   * MEANING, not in membership: a branch that edits props AND moves the end
   * appears in both, and a window-only change appears here alone — which is
   * exactly what keeps it out of delete/modify resolution.
   */
  windowedNodes: readonly StagedWindowedNode[];
  /** New fork edges, bucketed by kind. Map iterates in lexicographic kind order. */
  newEdgesByKind: ReadonlyMap<string, readonly StagedNewEdge[]>;
  /** Modified inherited edges (one entry per (id, branch) modification). */
  modifiedEdges: readonly StagedModifiedEdge[];
  /** Deleted inherited edges (one entry per (id, branch) deletion). */
  deletedEdges: readonly StagedDeletedEdge[];
  /** The edge analogue of {@link StagingSet.windowedNodes}. */
  windowedEdges: readonly StagedWindowedEdge[];
  newIdentityAssertions: readonly StagedIdentityAssertion[];
  retractedIdentityAssertions: readonly StagedRetraction[];
  /**
   * Every assertion CURRENT in the base store at staging time — the inherited
   * truth the branches forked from. Untagged (it belongs to no branch). The
   * planner needs it because a merge can only decide whether the branches'
   * assertions contradict each other by evaluating them against the assertions
   * that survive the merge unchanged: a staged `different` pair can contradict a
   * `same` pair no branch touched (see the contradiction check in `merge.ts`).
   */
  baseIdentityAssertions: readonly IdentityTransferAssertion[];
  /**
   * `(kind, id) -> version` for the nodes of the branch named by
   * `stageBranches`' `captureTargetStateFor` argument, observed by that
   * branch's diff enumeration. Empty when no branch was requested. The
   * incremental merge captures the committed target branch here to use as the
   * plan-time baseline for its commit-time lost-update guard.
   */
  targetNodeVersions: ReadonlyMap<MergeKey, number>;
  /**
   * `(kind, id) -> edge content signature` for the edges of the same captured
   * branch. The edge-half analogue of {@link targetNodeVersions} (edges carry no
   * version, so the guard fingerprints their content). Empty when no branch was
   * requested.
   */
  targetEdgeSignatures: ReadonlyMap<MergeKey, string>;
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
      [...requireDefined(buckets.get(kind))].sort((left, right) =>
        compareByIdThenBranch(left, right),
      ),
    );
  }
  return ordered;
}

/**
 * Deduplicates a lineage delta's mixed-kind key list by `(kind, id)` — the
 * fork's and the base's own `changesSince` results can both name the same
 * row (e.g. one the fork inherited unmodified but the base itself later
 * changed), and a duplicate id costs an extra bind in the pruned batch read
 * `diffAgainstBase` issues for it.
 */
function dedupeEntityKeys(keys: readonly EntityKey[]): EntityKey[] {
  const byMergeKey = new Map<MergeKey, EntityKey>();
  for (const key of keys) {
    byMergeKey.set(mergeKey(key.kind, key.id), key);
  }
  return [...byMergeKey.values()];
}

/**
 * THE one owner of per-branch pruning: the union of what changed on the
 * FORK since it was branched (`branch.forkRevision`, resolved through the
 * fork's own lineage) and what changed on the BASE since the branch's `base`
 * anchor was minted (`lineageDeltaSinceAnchor`, resolved through the base's
 * own lineage for whichever anchor form `base` carries). A key absent from
 * BOTH deltas never moved on either side since the fork point, so restricting
 * `diffAgainstBase`'s reads to this union cannot miss a change — see the
 * property test in `tests/property/lineage-pruned-diff.test.ts`, which is the
 * load-bearing proof that the pruned diff deep-equals the full one.
 *
 * `undefined` — no pruning; `diffAgainstBase` runs its full enumeration —
 * whenever EITHER side cannot supply a bounded delta: the branch was not
 * produced by `branch()` (no `forkRevision`, e.g. `mergeIncremental`'s
 * hand-built committed-target branch), the fork's own store resolves no
 * `lineage` at diff time, the fork's `changesSince` answers `unbounded`, the
 * base-side counterpart of any of those, or either `changesSince` call
 * itself REJECTING (a transient engine error, an unhealthy connection).
 * Pruning is a pure optimization over the full diff, never a precondition
 * for one: a rejection here must fall back to the full comparison rather
 * than fail a merge the full diff would otherwise have completed, so both
 * lineage calls below run through {@link safeLineageDelta}.
 */
export async function branchPruneTo<G extends GraphDef>(
  baseStore: Store<G>,
  branch: GraphBranch<G>,
): Promise<LineageDelta | undefined> {
  if (branch.forkRevision === undefined) return undefined;
  const forkLineage = resolveLineage(branch.store);
  if (forkLineage === undefined) return undefined;
  const forkRevision = branch.forkRevision;
  const forkDelta = await safeLineageDelta(() =>
    forkLineage.changesSince(forkRevision, branch.store.graphId),
  );
  if (forkDelta?.kind !== "keys") return undefined;
  const baseDelta = await safeLineageDelta(() =>
    lineageDeltaSinceAnchor(baseStore, branch.base),
  );
  if (baseDelta?.kind !== "keys") return undefined;
  return {
    kind: "keys",
    nodes: dedupeEntityKeys([...forkDelta.nodes, ...baseDelta.nodes]),
    edges: dedupeEntityKeys([...forkDelta.edges, ...baseDelta.edges]),
  };
}

/**
 * Runs one lineage delta call, treating a REJECTION the same as an
 * `undefined`/`unbounded` answer: {@link branchPruneTo}'s own doc comment is
 * the "one owner" of why a rejection must fall back to the full diff rather
 * than propagate and fail a merge the full diff would have completed.
 */
async function safeLineageDelta(
  fetch: () => Promise<LineageDelta | undefined>,
): Promise<LineageDelta | undefined> {
  try {
    return await fetch();
  } catch {
    return undefined;
  }
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
  captureTargetStateFor?: BranchId,
): Promise<StagingSet> {
  const newNodes: (StagedNewNode & { kind: string; id: string })[] = [];
  const modifiedNodes: (StagedModifiedNode & { kind: string; id: string })[] =
    [];
  const deletedNodes: (StagedDeletedNode & { kind: string; id: string })[] = [];
  const newEdges: (StagedNewEdge & { kind: string; id: string })[] = [];
  const modifiedEdges: (StagedModifiedEdge & { kind: string; id: string })[] =
    [];
  const deletedEdges: (StagedDeletedEdge & { kind: string; id: string })[] = [];
  const windowedNodes: (StagedWindowedNode & { kind: string; id: string })[] =
    [];
  const windowedEdges: (StagedWindowedEdge & { kind: string; id: string })[] =
    [];
  const newIdentityAssertions: StagedIdentityAssertion[] = [];
  const retractedIdentityAssertions: StagedRetraction[] = [];

  const baseIdentityAssertions =
    await storeRuntime(baseStore).readCurrentIdentityAssertions("state");

  let targetNodeVersions: ReadonlyMap<MergeKey, number> = new Map();
  let targetEdgeSignatures: ReadonlyMap<MergeKey, string> = new Map();
  for (const branch of branches) {
    const branchId = branch.id;
    const pruneTo = await branchPruneTo(baseStore, branch);
    const diff = await diffAgainstBase(
      baseStore,
      branch.store,
      branchId === captureTargetStateFor,
      pruneTo,
    );
    if (branchId === captureTargetStateFor) {
      targetNodeVersions = diff.forkNodeVersions;
      targetEdgeSignatures = diff.forkEdgeSignatures;
    }

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
    for (const node of diff.nodes.windowed) {
      windowedNodes.push({ branchId, node, kind: node.kind, id: node.id });
    }
    for (const edge of diff.edges.windowed) {
      windowedEdges.push({ branchId, edge, kind: edge.kind, id: edge.id });
    }
    for (const assertion of diff.identity.new) {
      newIdentityAssertions.push({ branchId, assertion });
    }
    for (const retraction of diff.identity.retracted) {
      retractedIdentityAssertions.push({
        branchId,
        assertion: retraction.assertion,
        cause: retraction.cause,
      });
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
    windowedNodes: [...windowedNodes].sort((left, right) =>
      compareByKindIdBranch(left, right),
    ),
    windowedEdges: [...windowedEdges].sort((left, right) =>
      compareByKindIdBranch(left, right),
    ),
    newIdentityAssertions: newIdentityAssertions.toSorted((left, right) => {
      const byId = compareStrings(left.assertion.id, right.assertion.id);
      return byId === 0 ? compareStrings(left.branchId, right.branchId) : byId;
    }),
    retractedIdentityAssertions: retractedIdentityAssertions.toSorted(
      (left, right) => {
        const byId = compareStrings(left.assertion.id, right.assertion.id);
        return byId === 0 ?
            compareStrings(left.branchId, right.branchId)
          : byId;
      },
    ),
    baseIdentityAssertions: baseIdentityAssertions.toSorted((left, right) =>
      compareStrings(left.id, right.id),
    ),
    targetNodeVersions,
    targetEdgeSignatures,
  };
}
