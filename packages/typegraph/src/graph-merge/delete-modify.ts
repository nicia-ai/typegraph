/**
 * Node-level delete/modify conflict resolution (design §6.2, T8a).
 *
 * The §6.2 case the draft omitted: an INHERITED node that one fork DELETES while
 * another fork MODIFIES is neither a pure deletion nor a pure modification — it
 * is a delete/modify conflict whose outcome is governed by the
 * {@link DeleteModifyPolicy} (`"deleteWins"` | `"modifyWins"` | `"flag"`) and
 * surfaced in the {@link MergeReport}.
 *
 * This module is a PURE decision function over the staging set (T7) plus the
 * captured stable branch order (T8). It runs BEFORE clustering/canonicalize feed
 * the surviving modifications into the property union, and BEFORE edge repoint
 * (T9), to which it hands the authoritative FINAL LIVENESS of every inherited
 * endpoint:
 *
 *   - a node finally deleted (`"deleteWins"`) → it is in {@link nodeDeletions};
 *     T9 drops every edge touching it.
 *   - a node kept/resurrected (`"modifyWins"` / `"flag"`, or never deleted) →
 *     its modifications are in {@link survivingModifications}; T9 keeps its edges.
 *
 * DETERMINISM CONTRACT (inherited from the merge-wide invariant):
 *   The keep-vs-delete decision is a function ONLY of the policy and the
 *   (unordered) set of contributing branches — it NEVER consults wall-clock
 *   arrival. The captured `branchRank` is used solely to TIE-BREAK which
 *   modification survives under `"modifyWins"` / `"flag"` (and which branch ids
 *   are recorded as `deletedBy` / `modifiedBy`), so two merges of the same branch
 *   set in any order resolve every delete/modify conflict identically.
 */

import { canonicalValueKey } from "./canonical-props";
import type {
  ConflictInput,
  ProvenanceWeights,
  ResolutionContext,
} from "./conflict-policy";
import { resolveConflictValue } from "./conflict-policy";
import { compareStrings, type MergeKey, mergeKeyOf } from "./node-key";
import type { StagedModifiedNode, StagingSet } from "./staging";
import type { DeletedNode } from "./state-diff";
import type {
  GraphDef,
  JsonValue,
  NodeId,
  NodeType,
} from "./typegraph-internal";
import type {
  BranchId,
  ConflictingValue,
  DeleteModifyConflict,
  DeleteModifyPolicy,
  DroppedItem,
  PropertyConflict,
  PropertyConflictPolicy,
} from "./types";

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/** Reason recorded on a {@link DroppedItem} for a finally-deleted node. */
export const DELETED_NODE_DROP_REASON = "delete-modify:deleteWins" as const;

/**
 * The outcome of delete/modify resolution over the whole staging set.
 *
 * - `survivingModifications`: every staged inherited-node modification that the
 *   merge will still apply — i.e. all modifications NOT overridden by a
 *   `"deleteWins"` resolution. A node modified by several branches contributes
 *   several entries here (one per branch), so T8's property union still sees the
 *   full cross-branch disagreement.
 * - `nodeDeletions`: the AUTHORITATIVE set of inherited nodes that are finally
 *   deleted — pure deletions (no branch modified them) plus delete/modify
 *   conflicts resolved `"deleteWins"`. T9 reads this as the endpoint liveness.
 * - `conflicts`: one {@link DeleteModifyConflict} per inherited node that was
 *   both deleted and modified.
 * - `dropped`: a `{ kind: "node" }` {@link DroppedItem} for every finally-deleted
 *   node, so the report can enumerate exactly what left the merged graph.
 */
export type DeleteModifyResolution = Readonly<{
  survivingModifications: readonly StagedModifiedNode[];
  nodeDeletions: readonly DeletedNode[];
  conflicts: readonly DeleteModifyConflict[];
  dropped: readonly DroppedItem[];
}>;

/** Lexicographic comparator over two node ids. */
function compareIds(left: AnyNodeId, right: AnyNodeId): number {
  return (
    left < right ? -1
    : left > right ? 1
    : 0
  );
}

/** Lexicographic comparator over two branch ids. */
function compareBranchIds(left: BranchId, right: BranchId): number {
  return (
    left < right ? -1
    : left > right ? 1
    : 0
  );
}

/**
 * Picks the HIGHEST-PRIORITY branch from a set — the one with the lowest
 * `branchRank` (earliest in the captured stable order). Ties on rank fall back to
 * lexicographic branch-id order, so the choice is total and deterministic. Used
 * to record `deletedBy` / `modifiedBy` and to select which modification survives.
 */
function pickHighestPriorityBranch(
  branchIds: readonly BranchId[],
  branchRank: ReadonlyMap<BranchId, number>,
): BranchId {
  let chosen = branchIds[0]!;
  let chosenRank = branchRank.get(chosen) ?? Number.MAX_SAFE_INTEGER;
  for (const candidate of branchIds.slice(1)) {
    const candidateRank = branchRank.get(candidate) ?? Number.MAX_SAFE_INTEGER;
    if (
      candidateRank < chosenRank ||
      (candidateRank === chosenRank && compareBranchIds(candidate, chosen) < 0)
    ) {
      chosen = candidate;
      chosenRank = candidateRank;
    }
  }
  return chosen;
}

/**
 * Groups staged items by their node IDENTITY (`(kind, id)`, not bare id), preserving
 * the per-identity arrays so callers can inspect every contributing branch. Keying on
 * the composite identity keeps an inherited `Patient` and an inherited `Encounter`
 * that share an id string from being reconciled/deleted as if they were one node.
 */
function groupByKey<
  T extends Readonly<{ node: Readonly<{ id: AnyNodeId; kind: string }> }>,
>(items: readonly T[]): ReadonlyMap<MergeKey, readonly T[]> {
  const grouped = new Map<MergeKey, T[]>();
  for (const item of items) {
    const key = mergeKeyOf(item.node);
    const bucket = grouped.get(key);
    if (bucket === undefined) {
      grouped.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }
  return grouped;
}

/**
 * Resolves every inherited node that is simultaneously DELETED by one or more
 * branches and MODIFIED by one or more (other) branches, per the
 * {@link DeleteModifyPolicy}:
 *
 *   - `"deleteWins"` → the node is finally deleted (its modifications are
 *     discarded). A {@link DeleteModifyConflict} with `resolution: "deleteWins"`
 *     is recorded and a `{ kind: "node" }` {@link DroppedItem} is emitted.
 *   - `"modifyWins"` → the node is RESURRECTED: its modifications survive (the
 *     deletion is ignored). A conflict with `resolution: "modifyWins"` is
 *     recorded; the node is NOT deleted.
 *   - `"flag"` → the modifications survive (as with `"modifyWins"`) but the
 *     conflict is recorded UNRESOLVED (`resolution: "flag"`) for human review.
 *
 * Pure deletions (no branch modified the node) pass straight through to
 * {@link nodeDeletions}; pure modifications (no branch deleted the node) pass
 * straight through to {@link survivingModifications}. Both unconflicted paths
 * carry NO {@link DeleteModifyConflict}.
 *
 * The result is order-independent: the keep-vs-delete decision depends only on
 * the policy and the contributing branch SET; `branchRank` is consulted solely to
 * tie-break which modification survives and which branch ids are recorded.
 *
 * @param staging The provenance-tagged union staging set (T7).
 * @param policy The delete/modify-conflict policy.
 * @param branchRank The captured stable branch rank (built once via
 *   `buildBranchRank`, shared across phases). Used ONLY for deterministic
 *   tie-breaking — never for the keep-vs-delete decision itself.
 */
export function resolveDeleteModify(
  staging: StagingSet,
  policy: DeleteModifyPolicy,
  branchRank: ReadonlyMap<BranchId, number>,
): DeleteModifyResolution {
  const modifiedByKey = groupByKey(staging.modifiedNodes);
  const deletedByKey = groupByKey(staging.deletedNodes);

  const survivingModifications: StagedModifiedNode[] = [];
  const nodeDeletions: DeletedNode[] = [];
  const conflicts: DeleteModifyConflict[] = [];
  const dropped: DroppedItem[] = [];

  const conflictedKeys = new Set<MergeKey>();
  for (const key of deletedByKey.keys()) {
    if (modifiedByKey.has(key)) {
      conflictedKeys.add(key);
    }
  }

  for (const [key, modifications] of modifiedByKey) {
    if (!conflictedKeys.has(key)) {
      for (const modification of modifications) {
        survivingModifications.push(modification);
      }
      continue;
    }

    const deletions = deletedByKey.get(key)!;
    const id = modifications[0]!.node.id;
    const kind = modifications[0]!.node.kind;
    const deletedBy = pickHighestPriorityBranch(
      deletions.map((deletion) => deletion.branchId),
      branchRank,
    );
    const modifiedBy = pickHighestPriorityBranch(
      modifications.map((modification) => modification.branchId),
      branchRank,
    );

    conflicts.push({
      entityId: id,
      kind,
      deletedBy,
      modifiedBy,
      resolution: policy,
    });

    if (policy === "deleteWins") {
      nodeDeletions.push({ id, kind });
      dropped.push({ kind: "node", id, reason: DELETED_NODE_DROP_REASON });
      continue;
    }

    // "modifyWins" and "flag" both KEEP the modification (resurrect the node);
    // "flag" additionally leaves the recorded conflict unresolved for review.
    for (const modification of modifications) {
      survivingModifications.push(modification);
    }
  }

  for (const [key, deletions] of deletedByKey) {
    if (conflictedKeys.has(key)) {
      continue;
    }
    nodeDeletions.push({
      id: deletions[0]!.node.id,
      kind: deletions[0]!.node.kind,
    });
  }

  return {
    survivingModifications: sortModifications(survivingModifications),
    nodeDeletions: sortDeletions(nodeDeletions),
    conflicts: sortConflicts(conflicts),
    dropped: sortDropped(dropped),
  };
}

/** Sorts surviving modifications by `(id, branchId)` for a canonical output. */
function sortModifications(
  modifications: readonly StagedModifiedNode[],
): readonly StagedModifiedNode[] {
  return [...modifications].sort((left, right) => {
    const byId = compareIds(left.node.id, right.node.id);
    return byId === 0 ? compareBranchIds(left.branchId, right.branchId) : byId;
  });
}

/** Sorts final node deletions by id. */
function sortDeletions(
  deletions: readonly DeletedNode[],
): readonly DeletedNode[] {
  return [...deletions].sort((left, right) => compareIds(left.id, right.id));
}

/** Sorts delete/modify conflicts by `entityId`. */
function sortConflicts(
  conflicts: readonly DeleteModifyConflict[],
): readonly DeleteModifyConflict[] {
  return [...conflicts].sort((left, right) =>
    compareIds(left.entityId, right.entityId),
  );
}

/** Sorts dropped items by id (every entry here is a `"node"`). */
function sortDropped(dropped: readonly DroppedItem[]): readonly DroppedItem[] {
  return [...dropped].sort((left, right) =>
    compareIds(left.id as AnyNodeId, right.id as AnyNodeId),
  );
}

/**
 * The outcome of reconciling the surviving inherited modifications: ONE merged
 * record per node id (carrying the 3-way-merged props the commit applies) plus
 * every {@link PropertyConflict} that a multi-branch modification surfaced.
 */
export type ModificationReconciliation = Readonly<{
  survivingModifications: readonly StagedModifiedNode[];
  conflicts: readonly PropertyConflict[];
}>;

/**
 * 3-WAY merges one inherited node modified by 2+ branches against the SHARED base.
 *
 * Per property: a branch whose fork value equals base contributed no change; a
 * property exactly one branch changed takes that change; a property multiple
 * branches changed to DIFFERING values is a genuine conflict, resolved by the
 * captured policy on the stable `branchRank` and recorded as a
 * {@link PropertyConflict}. Property DELETIONS (a base key absent from a fork) are
 * treated conservatively as "unchanged" so an unrelated branch's edit is never
 * lost. `baseProps` is identical across the modifications (same base, same id).
 */
function mergeModifiedProps(
  id: AnyNodeId,
  modifications: readonly StagedModifiedNode[],
  context: ResolutionContext<GraphDef>,
  branchRank: ReadonlyMap<BranchId, number>,
): Readonly<{
  props: Record<string, JsonValue>;
  conflicts: PropertyConflict[];
}> {
  const kind = modifications[0]!.node.kind;
  const baseProps = modifications[0]!.node.baseProps as Readonly<
    Record<string, JsonValue>
  >;
  const merged: Record<string, JsonValue> = { ...baseProps };
  const conflicts: PropertyConflict[] = [];

  const propertyNames = new Set<string>();
  for (const modification of modifications) {
    for (const name of Object.keys(modification.node.forkProps)) {
      propertyNames.add(name);
    }
  }

  for (const property of [...propertyNames].sort(compareStrings)) {
    const baseHas = property in baseProps;
    const baseKey =
      baseHas ? canonicalValueKey(baseProps[property]!) : undefined;

    const seen = new Set<string>();
    const changed: ConflictingValue[] = [];
    for (const modification of modifications) {
      if (!(property in modification.node.forkProps)) {
        continue; // conservative: a fork omitting the key did not change it
      }
      const value = modification.node.forkProps[property] as JsonValue;
      const valueKey = canonicalValueKey(value);
      if (baseHas && valueKey === baseKey) {
        continue; // unchanged by this branch
      }
      const dedupe = `${modification.branchId} ${valueKey}`;
      if (seen.has(dedupe)) {
        continue;
      }
      seen.add(dedupe);
      changed.push({ branchId: modification.branchId, value });
    }

    if (changed.length === 0) {
      continue; // every branch left it at base; keep base value
    }

    const distinctValues = new Set(
      changed.map((candidate) => canonicalValueKey(candidate.value)),
    );
    if (distinctValues.size === 1) {
      merged[property] = changed[0]!.value; // a single, agreed-upon change
      continue;
    }

    const values = [...changed].sort((left, right) => {
      const byBranch = compareBranchIds(left.branchId, right.branchId);
      return byBranch === 0 ? (
          compareStrings(
            canonicalValueKey(left.value),
            canonicalValueKey(right.value),
          )
        ) : byBranch;
    });
    const canonicalValue = baseHas ? baseProps[property]! : values[0]!.value;
    const input: ConflictInput = { property, values, canonicalValue };
    const resolved = resolveConflictValue(
      input,
      context,
      branchRank,
      (resolution) => ({ entityId: id, kind, property, values, resolution }),
    );
    merged[property] = resolved.value;
    if (resolved.conflicted) {
      conflicts.push({
        entityId: id,
        kind,
        property,
        values,
        resolution: resolved.value,
      });
    }
  }

  return { props: merged, conflicts };
}

/**
 * Reconciles the post-delete/modify surviving modifications into the records the
 * commit applies. An inherited node modified by a SINGLE branch passes through
 * unchanged; a node modified by TWO OR MORE branches is 3-way merged against the
 * base ({@link mergeModifiedProps}) into one record carrying the merged props,
 * surfacing any genuine cross-branch disagreement as a {@link PropertyConflict}.
 *
 * Without this, each per-branch modification was committed by id in turn, so the
 * lexicographically-largest branchId silently overwrote the others with NO
 * conflict recorded and the configured `onPropertyConflict` / `branchOrder`
 * bypassed (the §6.2 gap). The synthetic record's `branchId` is the highest
 * -priority contributor — cosmetic, since the commit reads only `node.id` / kind /
 * `forkProps`, and provenance for every contributing branch is recorded upstream.
 *
 * Order-independent: groups by id (the staging input is already `(id, branchId)`
 * sorted), merges per the stable `branchRank`, and sorts both outputs by stable
 * keys, so shuffling the branch set yields an identical result.
 *
 * @param survivingModifications The surviving modifications from
 *   {@link resolveDeleteModify} (one entry per `(id, branch)`).
 * @param policy The property-conflict policy (shared with the cluster union, T8).
 * @param branchRank The captured stable branch rank.
 * @param weights Optional per-branch weights for `"provenanceWeighted"`.
 */
export function reconcileModifications(
  survivingModifications: readonly StagedModifiedNode[],
  policy: PropertyConflictPolicy,
  branchRank: ReadonlyMap<BranchId, number>,
  weights?: ProvenanceWeights,
): ModificationReconciliation {
  const context: ResolutionContext<GraphDef> = {
    policy,
    ...(weights === undefined ? {} : { weights }),
  };

  const grouped = groupByKey(survivingModifications);
  const out: StagedModifiedNode[] = [];
  const conflicts: PropertyConflict[] = [];

  for (const modifications of grouped.values()) {
    if (modifications.length === 1) {
      out.push(modifications[0]!);
      continue;
    }
    const id = modifications[0]!.node.id;
    const { props, conflicts: propertyConflicts } = mergeModifiedProps(
      id,
      modifications,
      context,
      branchRank,
    );
    const chosenBranch = pickHighestPriorityBranch(
      modifications.map((modification) => modification.branchId),
      branchRank,
    );
    const representative =
      modifications.find(
        (modification) => modification.branchId === chosenBranch,
      ) ?? modifications[0]!;
    out.push({
      branchId: chosenBranch,
      node: { ...representative.node, forkProps: props },
    });
    for (const conflict of propertyConflicts) {
      conflicts.push(conflict);
    }
  }

  return {
    survivingModifications: sortModifications(out),
    conflicts: conflicts.sort((left, right) =>
      compareStrings(
        `${left.entityId}|${left.property}`,
        `${right.entityId}|${right.property}`,
      ),
    ),
  };
}
