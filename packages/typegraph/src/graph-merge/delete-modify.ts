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
import type { ProvenanceWeights, ResolutionContext } from "./conflict-policy";
import {
  collectConflictingValues,
  resolvePropertyUnion,
} from "./conflict-policy";
import { compareStrings, type MergeKey, mergeKey } from "./node-key";
import type {
  StagedModifiedEdge,
  StagedModifiedNode,
  StagingSet,
} from "./staging";
import type { DeletedEdge, DeletedNode } from "./state-diff";
import type {
  EdgeId,
  GraphDef,
  JsonValue,
  NodeId,
  NodeType,
} from "./typegraph-internal";
import type {
  BranchId,
  DeleteModifyConflict,
  DeleteModifyPolicy,
  DroppedItem,
  PropertyConflict,
  PropertyConflictPolicy,
} from "./types";

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;
type BranchTagged = Readonly<{ branchId: BranchId }>;

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
      (candidateRank === chosenRank && compareStrings(candidate, chosen) < 0)
    ) {
      chosen = candidate;
      chosenRank = candidateRank;
    }
  }
  return chosen;
}

function effectiveDeleteModifyPolicy(
  policy: DeleteModifyPolicy,
  deletions: readonly BranchTagged[],
  modifications: readonly BranchTagged[],
  preferredBranchId: BranchId | undefined,
): DeleteModifyPolicy {
  if (
    preferredBranchId !== undefined &&
    deletions.some((deletion) => deletion.branchId === preferredBranchId)
  ) {
    return "deleteWins";
  }
  if (
    policy === "deleteWins" &&
    preferredBranchId !== undefined &&
    modifications.some(
      (modification) => modification.branchId === preferredBranchId,
    )
  ) {
    return "modifyWins";
  }
  return policy;
}

/**
 * Groups staged items by the `(kind, id)` IDENTITY of the entity `entityOf` extracts
 * (a node or an edge), preserving the per-identity arrays so callers can inspect every
 * contributing branch. Keying on the composite identity (not bare id) keeps an
 * inherited `Patient` and an inherited `Encounter` that share an id string from being
 * reconciled/deleted as if they were one entity.
 */
function groupByEntity<T>(
  items: readonly T[],
  entityOf: (item: T) => Readonly<{ id: string; kind: string }>,
): ReadonlyMap<MergeKey, readonly T[]> {
  const grouped = new Map<MergeKey, T[]>();
  for (const item of items) {
    const entity = entityOf(item);
    const key = mergeKey(entity.kind, entity.id);
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
 * The shared node/edge DELETE-MODIFY resolver — the single control flow behind
 * {@link resolveDeleteModify} (nodes) and {@link resolveEdgeDeleteModify} (edges).
 * `modifiedEntity`/`deletedEntity` extract each staged item's `(id, kind)` (its
 * `.node` or `.edge`), and `droppedKind` tags the {@link DroppedItem}; everything
 * else — conflict detection, policy application, pure-deletion/pure-modification
 * passthrough, and the canonical output sort — is identical for both.
 */
function resolveDeleteModifyOver<
  ModifiedItem extends BranchTagged,
  DeletedItem extends BranchTagged,
  Id extends AnyNodeId | EdgeId,
>(
  modified: readonly ModifiedItem[],
  deleted: readonly DeletedItem[],
  modifiedEntity: (item: ModifiedItem) => Readonly<{ id: Id; kind: string }>,
  deletedEntity: (item: DeletedItem) => Readonly<{ id: Id; kind: string }>,
  droppedKind: "node" | "edge",
  policy: DeleteModifyPolicy,
  branchRank: ReadonlyMap<BranchId, number>,
  preferredBranchId: BranchId | undefined,
): Readonly<{
  survivingModifications: readonly ModifiedItem[];
  deletions: readonly Readonly<{ id: Id; kind: string }>[];
  conflicts: readonly DeleteModifyConflict[];
  dropped: readonly DroppedItem[];
}> {
  const modifiedByKey = groupByEntity(modified, modifiedEntity);
  const deletedByKey = groupByEntity(deleted, deletedEntity);

  const survivingModifications: ModifiedItem[] = [];
  const deletions: Readonly<{ id: Id; kind: string }>[] = [];
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

    const deletionsForKey = deletedByKey.get(key)!;
    const { id, kind } = modifiedEntity(modifications[0]!);
    const deletedBy = pickHighestPriorityBranch(
      deletionsForKey.map((deletion) => deletion.branchId),
      branchRank,
    );
    const modifiedBy = pickHighestPriorityBranch(
      modifications.map((modification) => modification.branchId),
      branchRank,
    );
    const effectivePolicy = effectiveDeleteModifyPolicy(
      policy,
      deletionsForKey,
      modifications,
      preferredBranchId,
    );

    conflicts.push({
      entityId: id,
      kind,
      deletedBy,
      modifiedBy,
      resolution: effectivePolicy,
    });

    if (effectivePolicy === "deleteWins") {
      deletions.push({ id, kind });
      dropped.push({ kind: droppedKind, id, reason: DELETED_NODE_DROP_REASON });
      continue;
    }

    // "modifyWins" and "flag" both KEEP the modification (resurrect the entity);
    // "flag" additionally leaves the recorded conflict unresolved for review.
    for (const modification of modifications) {
      survivingModifications.push(modification);
    }
  }

  for (const [key, deletionsForKey] of deletedByKey) {
    if (conflictedKeys.has(key)) {
      continue;
    }
    const { id, kind } = deletedEntity(deletionsForKey[0]!);
    deletions.push({ id, kind });
  }

  return {
    survivingModifications: [...survivingModifications].sort((left, right) => {
      const byId = compareStrings(
        modifiedEntity(left).id,
        modifiedEntity(right).id,
      );
      return byId === 0 ? compareStrings(left.branchId, right.branchId) : byId;
    }),
    deletions: [...deletions].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    conflicts: [...conflicts].sort((left, right) =>
      compareStrings(left.entityId, right.entityId),
    ),
    dropped: [...dropped].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
  };
}

/**
 * The shared node/edge MODIFICATION reconciler — the single control flow behind
 * {@link reconcileModifications} (nodes) and {@link reconcileEdgeModifications}
 * (edges). Groups by `(kind, id)`, 3-way merges every multi-branch modification via
 * {@link threeWayMergeProps}, and rebuilds ONE surviving record per id via `rebuild`
 * (carrying the highest-priority contributor's branch + the merged props).
 */
function reconcileOver<Item extends BranchTagged>(
  survivingModifications: readonly Item[],
  entityOf: (item: Item) => Readonly<{
    id: AnyNodeId | EdgeId;
    kind: string;
    baseProps: Readonly<Record<string, unknown>>;
    forkProps: Readonly<Record<string, unknown>>;
  }>,
  rebuild: (
    representative: Item,
    chosenBranch: BranchId,
    mergedProps: Record<string, JsonValue>,
  ) => Item,
  policy: PropertyConflictPolicy,
  branchRank: ReadonlyMap<BranchId, number>,
  weights: ProvenanceWeights | undefined,
  preferredBranchId: BranchId | undefined,
): Readonly<{
  survivingModifications: readonly Item[];
  conflicts: readonly PropertyConflict[];
}> {
  const context: ResolutionContext<GraphDef> = {
    policy,
    ...(weights === undefined ? {} : { weights }),
  };

  const grouped = groupByEntity(survivingModifications, entityOf);
  const out: Item[] = [];
  const conflicts: PropertyConflict[] = [];

  for (const modifications of grouped.values()) {
    if (modifications.length === 1) {
      out.push(modifications[0]!);
      continue;
    }
    const first = entityOf(modifications[0]!);
    const { props, conflicts: propertyConflicts } = threeWayMergeProps(
      first.id,
      first.kind,
      first.baseProps as Readonly<Record<string, JsonValue>>,
      modifications.map((modification) => ({
        branchId: modification.branchId,
        forkProps: entityOf(modification).forkProps as Readonly<
          Record<string, JsonValue>
        >,
      })),
      context,
      branchRank,
      preferredBranchId,
    );
    const chosenBranch = pickHighestPriorityBranch(
      modifications.map((modification) => modification.branchId),
      branchRank,
    );
    const representative =
      modifications.find(
        (modification) => modification.branchId === chosenBranch,
      ) ?? modifications[0]!;
    out.push(rebuild(representative, chosenBranch, props));
    for (const conflict of propertyConflicts) {
      conflicts.push(conflict);
    }
  }

  return {
    survivingModifications: [...out].sort((left, right) => {
      const byId = compareStrings(entityOf(left).id, entityOf(right).id);
      return byId === 0 ? compareStrings(left.branchId, right.branchId) : byId;
    }),
    conflicts: conflicts.sort((left, right) =>
      compareStrings(
        `${left.entityId}|${left.property}`,
        `${right.entityId}|${right.property}`,
      ),
    ),
  };
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
  preferredBranchId?: BranchId,
): DeleteModifyResolution {
  const resolved = resolveDeleteModifyOver(
    staging.modifiedNodes,
    staging.deletedNodes,
    (item) => item.node,
    (item) => item.node,
    "node",
    policy,
    branchRank,
    preferredBranchId,
  );
  return {
    survivingModifications: resolved.survivingModifications,
    nodeDeletions: resolved.deletions,
    conflicts: resolved.conflicts,
    dropped: resolved.dropped,
  };
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

/** A single branch's full fork props for an inherited entity (node or edge). */
type ForkContribution = Readonly<{
  branchId: BranchId;
  forkProps: Readonly<Record<string, JsonValue>>;
}>;

/**
 * 3-WAY merges one inherited entity (node OR edge) modified by 2+ branches against
 * the SHARED base.
 *
 * Per property: a branch whose fork value equals base contributed no change; a
 * property exactly one branch changed takes that change; a property multiple
 * branches changed to DIFFERING values is a genuine conflict, resolved by the
 * captured policy on the stable `branchRank` and recorded as a
 * {@link PropertyConflict}. Property DELETIONS (a base key absent from a fork) are
 * treated conservatively as "unchanged" so an unrelated branch's edit is never
 * lost. `baseProps` is identical across the contributions (same base, same id).
 *
 * Shared by node modification reconciliation ({@link reconcileModifications}) and
 * edge modification reconciliation ({@link reconcileEdgeModifications}), so both
 * apply identical base-aware semantics — without this, disjoint edits to the same
 * entity by different branches would false-conflict and one edit could be lost.
 */
function threeWayMergeProps(
  entityId: AnyNodeId | EdgeId,
  kind: string,
  baseProps: Readonly<Record<string, JsonValue>>,
  contributions: readonly ForkContribution[],
  context: ResolutionContext<GraphDef>,
  branchRank: ReadonlyMap<BranchId, number>,
  preferredBranchId?: BranchId,
): Readonly<{
  props: Record<string, JsonValue>;
  conflicts: PropertyConflict[];
}> {
  const merged: Record<string, JsonValue> = {};
  const conflicts: PropertyConflict[] = [];

  // Every property the base OR any fork carries. Base keys are included so a key
  // that EVERY fork dropped is still seen here (a fork's `forkProps` is its full
  // bag, so a missing base key is an intentional deletion, not an omission).
  const propertyNames = new Set<string>(Object.keys(baseProps));
  for (const contribution of contributions) {
    for (const name of Object.keys(contribution.forkProps)) {
      propertyNames.add(name);
    }
  }

  for (const property of [...propertyNames].sort(compareStrings)) {
    const baseHas = property in baseProps;
    const baseKey =
      baseHas ? canonicalValueKey(baseProps[property]!) : undefined;

    // Contributions from branches that actually CHANGED this property (present and
    // differing from base). Reuse the shared collector so the distinct-(branch,value)
    // dedupe + ordering match the node/edge property unions exactly — one definition
    // of conflict gathering, with the canonical NUL-separated dedupe key.
    const changed = contributions
      .filter((contribution) => {
        if (!(property in contribution.forkProps)) {
          return false; // absent — a deletion (handled below), never a change
        }
        const value = contribution.forkProps[property] as JsonValue;
        return !baseHas || canonicalValueKey(value) !== baseKey;
      })
      .map((contribution) => ({
        branchId: contribution.branchId,
        props: contribution.forkProps,
      }));
    const values = collectConflictingValues(property, changed);

    if (values.length === 0) {
      // No fork CHANGED the value. A fork's `forkProps` is its FULL bag, so a base
      // property a fork OMITS was DELETED by it; honor that deletion by leaving the
      // key out of `merged`. Otherwise every fork kept the base value, so it stands.
      const deletedByFork =
        baseHas &&
        contributions.some(
          (contribution) => !(property in contribution.forkProps),
        );
      if (baseHas && !deletedByFork) {
        merged[property] = baseProps[property]!;
      }
      continue;
    }

    const distinctValues = new Set(
      values.map((candidate) => canonicalValueKey(candidate.value)),
    );
    if (distinctValues.size === 1) {
      merged[property] = values[0]!.value; // a single, agreed-upon change
      continue;
    }

    const preferredValue = values.find(
      (value) => value.branchId === preferredBranchId,
    )?.value;
    const canonicalValue =
      preferredValue ?? (baseHas ? baseProps[property]! : values[0]!.value);
    const reportedValues =
      preferredBranchId === undefined ? values : (
        values.filter((value) => value.branchId !== preferredBranchId)
      );
    const { value, conflict } = resolvePropertyUnion(
      { entityId, kind, property, values, reportedValues, canonicalValue },
      context,
      branchRank,
    );
    merged[property] = value;
    if (conflict !== undefined) {
      conflicts.push(conflict);
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
  preferredBranchId?: BranchId,
): ModificationReconciliation {
  return reconcileOver(
    survivingModifications,
    (item) => item.node,
    (representative, chosenBranch, mergedProps) => ({
      branchId: chosenBranch,
      node: { ...representative.node, forkProps: mergedProps },
    }),
    policy,
    branchRank,
    weights,
    preferredBranchId,
  );
}

// ============================================================
// Inherited EDGE delete/modify resolution (the edge analogue of the node path
// above). Edges carry fixed endpoints, so a "modified" edge only changes props;
// the delete/modify and 3-way merge logic is otherwise identical to nodes, and
// reuses the same {@link pickHighestPriorityBranch} + {@link threeWayMergeProps}
// cores so node and edge behavior can never drift.
// ============================================================

/**
 * The outcome of delete/modify resolution over the staged inherited EDGES.
 * Mirrors {@link DeleteModifyResolution}: `edgeDeletions` is the authoritative set
 * of finally-deleted inherited edges (pure deletions plus `"deleteWins"` conflict
 * resolutions); `survivingModifications` is every modification the merge still
 * applies; `conflicts`/`dropped` mirror the node fields.
 */
export type EdgeDeleteModifyResolution = Readonly<{
  survivingModifications: readonly StagedModifiedEdge[];
  edgeDeletions: readonly DeletedEdge[];
  conflicts: readonly DeleteModifyConflict[];
  dropped: readonly DroppedItem[];
}>;

/**
 * Resolves every inherited EDGE simultaneously deleted by one+ branches and
 * modified by one+ (other) branches, per the {@link DeleteModifyPolicy} — the
 * edge analogue of {@link resolveDeleteModify}. Pure deletions flow to
 * `edgeDeletions`; pure modifications flow to `survivingModifications`. Without
 * this, inherited edge deletions were staged but never applied, so a branch's
 * edge deletion was silently dropped and the edge stayed live. Shares
 * {@link resolveDeleteModifyOver} with the node path so the two can never drift.
 */
export function resolveEdgeDeleteModify(
  staging: StagingSet,
  policy: DeleteModifyPolicy,
  branchRank: ReadonlyMap<BranchId, number>,
  preferredBranchId?: BranchId,
): EdgeDeleteModifyResolution {
  const resolved = resolveDeleteModifyOver(
    staging.modifiedEdges,
    staging.deletedEdges,
    (item) => item.edge,
    (item) => item.edge,
    "edge",
    policy,
    branchRank,
    preferredBranchId,
  );
  return {
    survivingModifications: resolved.survivingModifications,
    edgeDeletions: resolved.deletions,
    conflicts: resolved.conflicts,
    dropped: resolved.dropped,
  };
}

/**
 * The edge analogue of {@link reconcileModifications}: ONE merged record per edge
 * id, carrying the 3-way-merged props the commit applies, plus every
 * {@link PropertyConflict} a multi-branch edge modification surfaced. Edge
 * endpoints are immutable, so only props are merged; the representative's
 * endpoints/kind are kept.
 */
export function reconcileEdgeModifications(
  survivingModifications: readonly StagedModifiedEdge[],
  policy: PropertyConflictPolicy,
  branchRank: ReadonlyMap<BranchId, number>,
  weights?: ProvenanceWeights,
  preferredBranchId?: BranchId,
): Readonly<{
  survivingModifications: readonly StagedModifiedEdge[];
  conflicts: readonly PropertyConflict[];
}> {
  return reconcileOver(
    survivingModifications,
    (item) => item.edge,
    (representative, chosenBranch, mergedProps) => ({
      branchId: chosenBranch,
      edge: { ...representative.edge, forkProps: mergedProps },
    }),
    policy,
    branchRank,
    weights,
    preferredBranchId,
  );
}
