/**
 * Opt-in ontology type reconciliation (design §6 / §7, T10).
 *
 * When entity resolution (T8) collapses fork nodes into one cluster, those nodes
 * may carry DIFFERING `node.kind` values across branches — e.g. one branch staged
 * a `Doctor` while another staged the more-specific `SpecialistDoctor` for what is
 * really the same person. With `reconcileTypes: "ontology"` enabled, this module
 * uses the store's own validated `KindRegistry` to decide whether those kinds are
 * subClassOf-compatible and, if so, collapses the cluster to the MOST-SPECIFIC
 * common type, recording a {@link TypeReconciliation}. Genuinely incompatible
 * kinds (siblings, disjoint trees) are FLAGGED — never silently collapsed — and
 * surfaced as a {@link DroppedItem}.
 *
 * `equivalentTo` is mutual subsumption (D1): the registry folds an equivalence
 * class into `subClassAncestors`/`subClassDescendants` before its transitive
 * closure, so `registry.isAssignableTo` is already true both ways for two
 * equivalent kinds. That is what makes "most specific" a single predicate
 * (`isAssignableTo`) rather than a subsumption check plus a separate equivalence
 * check: reconciling against a private closure and reconciling against the
 * registry a query runs on can no longer disagree about which kinds are the same
 * class.
 *
 * MOST-SPECIFIC = the unique minimum of `registry.isAssignableTo` restricted to
 * the cluster's distinct kinds: the kind `T` such that every OTHER kind in the
 * cluster is assignable to `T` — equal, a (transitive) subclass, or in `T`'s
 * folded equivalence class. If several mutually-equivalent kinds tie for the
 * minimum, the code-point-smallest representative is chosen so the outcome is
 * deterministic. If no single minimum exists, the kinds are incompatible.
 *
 * This module is a PURE decision function — no I/O, no store access. The
 * orchestrator (T11) builds the {@link ReconcileClusterInput}s from the resolved
 * clusters + the staged nodes' kinds, then applies the returned
 * {@link TypeReconcileResult.retypeMap} to the canonical node's `kind` and to the
 * repointed edges' `fromKind` / `toKind` annotations while keeping endpoint ids
 * stable (the cascade described in step 2). `mode: "off"` is a guaranteed no-op.
 */
import { compareStrings, idOf, type MergeKey } from "./node-key";
import { compareCodePoints, type KindRegistry } from "./typegraph-internal";
import type {
  DroppedItem,
  ReconcileTypesMode,
  TypeReconciliation,
} from "./types";

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
 * (from T8 `pickClusterSurvivor`) and the DISTINCT kinds present across the cluster's
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

/** Distinct kinds in code-point order — the canonical kind set. */
function distinctKinds(kinds: readonly string[]): readonly string[] {
  return [...new Set(kinds)].toSorted((left, right) =>
    compareCodePoints(left, right),
  );
}

/**
 * Finds the MOST-SPECIFIC common kind among `kinds`, or `undefined` if the kinds
 * are incompatible (no single minimum under `registry.isAssignableTo`).
 *
 * A kind qualifies as the minimum when it is assignable to every OTHER kind
 * (`registry.isAssignableTo(candidate, other)` — equal, a transitive subclass
 * of `other`, or in `other`'s folded `equivalentTo` class). Several
 * mutually-equivalent kinds can all qualify; the code-point-smallest
 * qualifier is returned so the choice is deterministic. Siblings (e.g. two
 * leaves under a shared parent) and disjoint trees yield no qualifier →
 * `undefined` (incompatible).
 */
export function mostSpecificCommonKind(
  registry: KindRegistry,
  kinds: readonly string[],
): string | undefined {
  const qualifiers = kinds.filter((candidate) =>
    kinds.every((other) => registry.isAssignableTo(candidate, other)),
  );
  return qualifiers.toSorted((left, right) =>
    compareCodePoints(left, right),
  )[0];
}

/**
 * Reconciles the differing kinds of each resolved cluster against the store's
 * validated `KindRegistry`.
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
 * @param registry The store's validated `KindRegistry`.
 * @param mode `"off"` (no-op) or `"ontology"` (reconcile).
 */
export function reconcileTypes(
  clusters: readonly ReconcileClusterInput[],
  registry: KindRegistry,
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
    const toType = mostSpecificCommonKind(registry, kinds);
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
      compareStrings(left.entityId, right.entityId),
    ),
    retypeMap,
    dropped: dropped.sort((left, right) => compareStrings(left.id, right.id)),
  };
}
