/**
 * Opt-in ontology type reconciliation (design §6 / §7, T10).
 *
 * When entity resolution (T8) collapses fork nodes into one cluster, those nodes
 * may carry DIFFERING `node.kind` values across branches — e.g. one branch staged
 * a `Doctor` while another staged the more-specific `SpecialistDoctor` for what is
 * really the same person. With `reconcileTypes: "ontology"` enabled, this module
 * uses the PUBLIC-closure glue (T2a, `closures.ts`) to decide whether those kinds
 * are subClassOf-compatible and, if so, collapses the cluster to the
 * MOST-SPECIFIC common type, recording a {@link TypeReconciliation}. Genuinely
 * incompatible kinds (siblings, disjoint trees) are FLAGGED — never silently
 * collapsed — and surfaced as a {@link DroppedItem}.
 *
 * MOST-SPECIFIC = the unique minimum of the subclass partial order restricted to
 * the cluster's distinct kinds: the kind `T` such that every OTHER kind in the
 * cluster is a (transitive) ancestor of `T` (`isReachable(closure, T, other)`),
 * or is EQUIVALENT to `T` (mutual reachability, from folded `equivalentTo`
 * relations). If several mutually-equivalent kinds tie for the minimum, the
 * lexicographically-smallest representative is chosen so the outcome is
 * deterministic. If no single minimum exists, the kinds are incompatible.
 *
 * This module is a PURE decision function — no I/O, no store access. The
 * orchestrator (T11) builds the {@link ReconcileClusterInput}s from the resolved
 * clusters + the staged nodes' kinds, then applies the returned
 * {@link TypeReconcileResult.retypeMap} to the canonical node's `kind` and to the
 * repointed edges' `fromKind` / `toKind` annotations while keeping endpoint ids
 * stable (the cascade described in step 2). `mode: "off"` is a guaranteed no-op.
 */

import type { SubClassClosure } from "./closures";
import { isReachable } from "./closures";
import { compareStrings, idOf, type MergeKey } from "./node-key";
import type { NodeId, NodeType } from "./typegraph-internal";
import type {
  DroppedItem,
  ReconcileTypesMode,
  TypeReconciliation,
} from "./types";

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/**
 * Reason recorded on a {@link DroppedItem} when a cluster's mixed kinds are
 * neither subClassOf-comparable nor equivalent and therefore CANNOT be collapsed.
 * The cluster is left untouched (its members keep their original kinds); this
 * record only flags the incompatibility for the {@link MergeReport}.
 */
export const INCOMPATIBLE_TYPES_FLAG_REASON =
  "type-reconcile:incompatible-kinds" as const;

/**
 * One resolved cluster fed into type reconciliation: the canonical survivor id
 * (from T8 `pickCanonical`) and the DISTINCT kinds present across the cluster's
 * members. Single-kind clusters (one distinct kind) are no-ops and may be omitted
 * by the caller, but are handled defensively here too.
 */
export type ReconcileClusterInput = Readonly<{
  /** The canonical survivor IDENTITY (`(kind, id)`), so the retype keys on the same
   * composite identity the commit looks it up by — never a bare id shared across
   * kinds. */
  canonicalId: MergeKey;
  /** The distinct member kinds in the cluster. Order does not affect the result. */
  memberKinds: readonly string[];
}>;

/**
 * The outcome of reconciling every cluster's kinds.
 *
 * - `reconciliations`: one {@link TypeReconciliation} per multi-kind cluster that
 *   collapsed to a single most-specific type.
 * - `retypeMap`: `canonicalId → toType` for exactly those reconciled clusters, so
 *   the commit (T11) can cascade the retype onto the canonical node and the
 *   repointed edges' endpoint-kind annotations.
 * - `dropped`: one `{ kind: "node" }` {@link DroppedItem} per cluster whose kinds
 *   were incompatible (flagged, NOT collapsed) — its `id` is the canonical id and
 *   its `reason` is {@link INCOMPATIBLE_TYPES_FLAG_REASON}.
 */
export type TypeReconcileResult = Readonly<{
  reconciliations: readonly TypeReconciliation[];
  /** `canonical (kind, id) → toType` for each reconciled cluster, keyed by the
   * composite identity so the commit cascade resolves a retype unambiguously even
   * when an id is shared across kinds. */
  retypeMap: ReadonlyMap<MergeKey, string>;
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

/** Distinct, lexicographically-sorted kinds — the canonical kind set. */
function distinctKinds(kinds: readonly string[]): readonly string[] {
  return [...new Set(kinds)].sort((left, right) => compareStrings(left, right));
}

/**
 * Reports whether two kinds are EQUIVALENT under the closure — distinct names
 * that fold to the same `equivalentTo` class, hence mutually reachable. (A kind is
 * not equivalent to itself here; identical names are handled by the caller.)
 */
function areEquivalent(
  closure: SubClassClosure,
  left: string,
  right: string,
): boolean {
  return (
    left !== right &&
    isReachable(closure, left, right) &&
    isReachable(closure, right, left)
  );
}

/**
 * Reports whether `candidate` is "at or below" `other` in the subclass order:
 * either it is a (transitive) subclass of `other`, or the two are equivalent. This
 * is the predicate the most-specific kind must satisfy against every OTHER kind in
 * the cluster.
 */
function isAtOrBelow(
  closure: SubClassClosure,
  candidate: string,
  other: string,
): boolean {
  if (candidate === other) {
    return true;
  }
  return (
    isReachable(closure, candidate, other) ||
    areEquivalent(closure, candidate, other)
  );
}

/**
 * Finds the MOST-SPECIFIC common kind among `kinds`, or `undefined` if the kinds
 * are incompatible (no single minimum of the subclass order).
 *
 * A kind qualifies as the minimum when every OTHER kind is at-or-above it
 * ({@link isAtOrBelow}). Several mutually-equivalent kinds can all qualify; the
 * lexicographically-smallest qualifier is returned so the choice is deterministic.
 * Siblings (e.g. two leaves under a shared parent) and disjoint trees yield no
 * qualifier → `undefined` (incompatible).
 */
export function mostSpecificCommonKind(
  closure: SubClassClosure,
  kinds: readonly string[],
): string | undefined {
  const qualifiers = kinds.filter((candidate) =>
    kinds.every((other) => isAtOrBelow(closure, candidate, other)),
  );
  if (qualifiers.length === 0) {
    return undefined;
  }
  return [...qualifiers].sort((left, right) => compareStrings(left, right))[0]!;
}

/**
 * Reconciles the differing kinds of each resolved cluster against the subClassOf
 * closure.
 *
 * For `mode: "off"` (the default) this is a guaranteed no-op: it returns zero
 * reconciliations, an empty retype map, and zero dropped items, regardless of the
 * clusters.
 *
 * For `mode: "ontology"`, each cluster with more than one distinct kind is
 * reconciled:
 *
 *   - a single MOST-SPECIFIC common kind exists → the cluster collapses to it; a
 *     {@link TypeReconciliation} is recorded (`fromTypes` = the distinct kinds,
 *     `toType` = the chosen kind) and `canonicalId → toType` is added to
 *     `retypeMap`. When the most-specific kind already equals the cluster's full
 *     (single-element-after-collapse) intent — i.e. all kinds were equivalent and
 *     fold to the same chosen representative — the reconciliation is still
 *     recorded so the cascade can normalize the canonical node's kind.
 *   - no single most-specific kind (siblings / disjoint trees) → the cluster is
 *     FLAGGED incompatible: a `{ kind: "node" }` {@link DroppedItem} with reason
 *     {@link INCOMPATIBLE_TYPES_FLAG_REASON} is recorded and the cluster is NOT
 *     collapsed (no retype entry).
 *
 * Single-kind clusters never appear in the output. All output collections are
 * sorted by stable keys (`canonicalId`) so the result is a pure function of the
 * unordered cluster set.
 *
 * @param clusters The resolved clusters with their distinct member kinds.
 * @param closure The subClassOf closure from {@link buildSubClassClosure} (T2a).
 * @param mode `"off"` (no-op) or `"ontology"` (reconcile).
 */
export function reconcileTypes(
  clusters: readonly ReconcileClusterInput[],
  closure: SubClassClosure,
  mode: ReconcileTypesMode,
): TypeReconcileResult {
  if (mode === "off") {
    return {
      reconciliations: [],
      retypeMap: new Map<MergeKey, string>(),
      dropped: [],
    };
  }

  const reconciliations: TypeReconciliation[] = [];
  const retypeMap = new Map<MergeKey, string>();
  const dropped: DroppedItem[] = [];

  for (const cluster of clusters) {
    const kinds = distinctKinds(cluster.memberKinds);
    if (kinds.length <= 1) {
      continue;
    }

    // The PUBLIC report fields (`entityId`, dropped `id`) carry the bare node id;
    // the internal retype keys on the full `(kind, id)` identity.
    const entityId = idOf(cluster.canonicalId);
    const toType = mostSpecificCommonKind(closure, kinds);
    if (toType === undefined) {
      dropped.push({
        kind: "node",
        id: entityId,
        reason: INCOMPATIBLE_TYPES_FLAG_REASON,
      });
      continue;
    }

    reconciliations.push({
      entityId,
      fromTypes: kinds,
      toType,
    });
    retypeMap.set(cluster.canonicalId, toType);
  }

  return {
    reconciliations: reconciliations.sort((left, right) =>
      compareIds(left.entityId, right.entityId),
    ),
    retypeMap,
    dropped: dropped.sort((left, right) =>
      compareIds(left.id as AnyNodeId, right.id as AnyNodeId),
    ),
  };
}
