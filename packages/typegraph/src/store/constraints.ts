/**
 * Constraint Checking for Store Operations
 *
 * Handles checking disjointness and cardinality constraints.
 *
 * ## The invariant these probes depend on
 *
 * **A declared constraint's probe and the write it guards commit under one
 * per-graph mutual exclusion, on every backend.** Every check in this module is
 * an APPLICATION probe: it reads, decides, and returns, and the caller then
 * writes. Nothing in the schema re-decides at write time, because for each of
 * these constraints the available key covers a different axis than the
 * constraint declares:
 *
 * - edge cardinality `one` / `unique` / `oneActive` is a predicate over
 *   `(kind, from)` or `(kind, from, to)`, while the edges table's only
 *   uniqueness is its `(graph_id, id)` primary key;
 * - disjointness is a predicate over `(graph_id, id)` ACROSS kinds, while the
 *   nodes primary key is `(graph_id, kind, id)` — the same id under a disjoint
 *   kind is a different row by construction;
 * - `scope: "kindWithSubClasses"` uniqueness probes the root kind and every
 *   descendant, while `insertUniquenessEntries` reserves one row under the
 *   node's OWN kind and the uniques primary key is
 *   `(graph_id, node_kind, constraint_name, key)` — sibling kinds are distinct
 *   rows that can never collide (see {@link file://./uniqueness.ts}).
 *
 * So the probe is only as good as the serialization around it. SQLite supplies
 * that for free (`BEGIN IMMEDIATE` admits one writer per database). PostgreSQL
 * supplied it only when history or revision tracking was enabled, because only
 * those took the per-graph advisory lock — leaving a default PostgreSQL store
 * open to two writers that both read "no conflict" and both commit.
 * {@link edgeWriteNeedsConstraintFence} / {@link nodeWriteNeedsConstraintFence}
 * are what the write paths ask so they take that same per-graph lock whenever
 * one of these probes is in play, and only then.
 */
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import {
  checkCardinality,
  checkDisjointness,
  checkUniqueEdge,
  getKindsForUniquenessCheck,
} from "../constraints";
import { type Cardinality, type UniqueConstraint } from "../core/types";
import { type KindRegistry } from "../registry/kind-registry";

/**
 * Context for constraint operations.
 */
export type ConstraintContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  backend: GraphBackend | TransactionBackend;
}>;

/**
 * WHICH declared constraint makes a write constrained.
 *
 * The classification names the reason rather than answering yes/no, because
 * the reason is load-bearing twice over: it is what the fence is taken FOR, and
 * — on a backend that cannot hold the fence — it is what the refusal has to
 * tell the caller. "This backend cannot fence constrained writes" is unusable
 * advice; "your `cardinality: 'one'` edge cannot be enforced here" is
 * actionable, and only the classifier knows which it was.
 */
export type ConstraintFenceReason =
  /** Edge cardinality `one` / `unique` / `oneActive`. */
  | "edgeCardinality"
  /** `getOrCreateByEndpoints` converging on a match key no key backs. */
  | "edgeMatchKeyConvergence"
  /** A `disjointWith` axiom, probed across kinds the node PK cannot span. */
  | "nodeDisjointness"
  /** A unique constraint whose scope spans more than the node's own kind. */
  | "nodeUniquenessScope";

/**
 * The constraint that makes an edge write of this cardinality constrained, or
 * `undefined` when it is not.
 *
 * `many` declares no constraint, so its create runs no cardinality probe and
 * must NOT pay for the lock — the fence is for writes that check something, not
 * for writes in general. Every other cardinality counts or existence-tests
 * sibling edges before inserting, and nothing in the schema repeats that test.
 *
 * The one owner of this classification: `checkCardinalityConstraint`'s `many`
 * arm and this predicate are the same decision seen from two sides, and a
 * second inline `!== "many"` at a write path would be the copy that drifts.
 */
export function edgeWriteNeedsConstraintFence(
  cardinality: Cardinality,
): ConstraintFenceReason | undefined {
  return cardinality === "many" ? undefined : "edgeCardinality";
}

/**
 * The constraint that makes a node write of this kind constrained, or
 * `undefined` when it is not. A kind can qualify on both counts; the reason
 * reported is the first that applies, which is enough to name the class in a
 * refusal.
 *
 * Two probe families qualify, and they are reached by different operations:
 *
 * - **Disjointness** is probed only where a node comes into existence under a
 *   kind — the create/resurrect preparation. An in-place update cannot change a
 *   node's kind, so it re-derives no cross-kind verdict and needs no fence for
 *   this reason.
 * - **Shared-scope uniqueness** is probed by create AND update. It qualifies
 *   only when the constraint's scope actually spans more than the node's own
 *   kind: a single-kind scope probes exactly the `(graph_id, node_kind,
 *   constraint_name, key)` row that `insertUnique` then reserves, so the
 *   uniques primary key IS the fence and the write needs no other. Deciding
 *   this by expanding the scope — rather than by testing `scope !== "kind"` —
 *   keeps the answer true for a `kindWithSubClasses` constraint on a kind that
 *   has no hierarchy, which is backed by its own key exactly like a `kind`
 *   scope.
 */
export function nodeWriteNeedsConstraintFence(
  registry: KindRegistry,
  kind: string,
  uniqueConstraints: readonly UniqueConstraint[],
  operation: "create" | "update",
): ConstraintFenceReason | undefined {
  if (operation === "create" && registry.getDisjointKinds(kind).length > 0) {
    return "nodeDisjointness";
  }
  const sharedScope = uniqueConstraints.some(
    (constraint) =>
      getKindsForUniquenessCheck(kind, constraint.scope, registry).length > 1,
  );
  return sharedScope ? "nodeUniquenessScope" : undefined;
}

/**
 * Checks disjointness constraints for a node.
 *
 * Ensures that a node with a given ID doesn't exist in any disjoint kinds.
 *
 * @throws ValidationError if disjointness constraint is violated
 */
export async function checkDisjointnessConstraint(
  ctx: ConstraintContext,
  kind: string,
  id: string,
): Promise<void> {
  // Get all kinds that are disjoint with this kind
  const disjointKinds = ctx.registry.getDisjointKinds(kind);

  // For each disjoint kind, check if a node with this ID exists
  for (const disjointKind of disjointKinds) {
    const existing = await ctx.backend.getNode(ctx.graphId, disjointKind, id);
    if (existing && !existing.deleted_at) {
      const error = checkDisjointness(id, kind, [disjointKind], ctx.registry);
      if (error) throw error;
    }
  }
}

/**
 * Checks cardinality constraints for an edge.
 *
 * @throws CardinalityError if cardinality constraint is violated
 */
export async function checkCardinalityConstraint(
  ctx: ConstraintContext,
  edgeKind: string,
  cardinality: "many" | "one" | "unique" | "oneActive",
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  validTo: string | undefined,
): Promise<void> {
  switch (cardinality) {
    case "many": {
      // No constraint - allow any number of edges
      return;
    }

    case "one": {
      // At most one edge of this kind from this source
      const count = await ctx.backend.countEdgesFrom({
        graphId: ctx.graphId,
        edgeKind,
        fromKind,
        fromId,
      });
      const error = checkCardinality(
        edgeKind,
        fromKind,
        fromId,
        "one",
        count,
        false,
      );
      if (error) throw error;
      return;
    }

    case "unique": {
      // At most one edge between this specific source-target pair
      const exists = await ctx.backend.edgeExistsBetween({
        graphId: ctx.graphId,
        edgeKind,
        fromKind,
        fromId,
        toKind,
        toId,
      });
      const error = checkUniqueEdge(
        edgeKind,
        fromKind,
        fromId,
        toKind,
        toId,
        exists ? 1 : 0,
      );
      if (error) throw error;
      return;
    }

    case "oneActive": {
      // At most one active edge (valid_to IS NULL) from this source
      // Only check if the new edge will be active (validTo is not set)
      if (validTo !== undefined) {
        // New edge is already ended, no active constraint to check
        return;
      }
      const count = await ctx.backend.countEdgesFrom({
        graphId: ctx.graphId,
        edgeKind,
        fromKind,
        fromId,
        activeOnly: true,
      });
      const error = checkCardinality(
        edgeKind,
        fromKind,
        fromId,
        "oneActive",
        count,
        count > 0,
      );
      if (error) throw error;
      return;
    }
  }
}
