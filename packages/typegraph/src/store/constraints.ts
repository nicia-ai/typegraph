/**
 * Constraint Checking for Store Operations
 *
 * Handles checking disjointness and cardinality constraints.
 */
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import {
  checkCardinality,
  checkDisjointness,
  checkUniqueEdge,
} from "../constraints";
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
