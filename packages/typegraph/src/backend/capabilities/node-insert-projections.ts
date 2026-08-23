import type {
  BackendIdentity,
  GraphBackend,
  NodeInsertClaim,
  NodeInsertProjection,
} from "../types";

export type NodeProjectionInsertTarget = BackendIdentity &
  Pick<GraphBackend, "executeNodeCreatePlan">;

export type NodeInsertProjectionRequirements = Readonly<{
  fulltext: boolean;
  embedding: boolean;
}>;

export function supportsNodeInsertProjectionRequirements(
  target: NodeProjectionInsertTarget,
  requirements: NodeInsertProjectionRequirements,
): boolean {
  return (
    target.executeNodeCreatePlan !== undefined &&
    (!requirements.fulltext ||
      target.fulltextStrategy?.buildSyncFromInsertedNode !== undefined) &&
    (!requirements.embedding ||
      target.vectorStrategy?.buildUpsertFromInsertedNode !== undefined)
  );
}

/**
 * The single owner of projection-fusion eligibility.
 *
 * A projection plan is all-or-nothing: every requested projection must have
 * an inserted-node builder on the active strategy, and the receiver must
 * expose the atomic executor. Callers use this same predicate before choosing
 * root autocommit and again on the actual transaction callback target.
 */
export function supportsNodeInsertProjections(
  target: NodeProjectionInsertTarget,
  projections: readonly NodeInsertProjection[],
): boolean {
  if (projections.length === 0) return false;
  return supportsNodeInsertProjectionRequirements(target, {
    fulltext: projections.some((projection) => projection.kind === "fulltext"),
    embedding: projections.some(
      (projection) => projection.kind === "embedding",
    ),
  });
}

/**
 * Whether the receiver can make uniqueness/disjointness claims authoritative
 * inside the planned node statement.
 *
 * Claims are reported by the statement as a verdict, so the caller must have a
 * transaction boundary around the statement before it can safely defer the
 * application probes. A root backend is deliberately excluded: its
 * `executeNodeCreatePlan` member is also used for projection-only
 * autocommit writes, but a claim refusal must roll back the node and any
 * claims it touched together.
 */
export function supportsNodeInsertClaims(
  target: NodeProjectionInsertTarget,
): boolean {
  return (
    target.executeNodeCreatePlan !== undefined &&
    !("transaction" in target) &&
    target.capabilities.atomicNodeInsertClaims === true
  );
}

/** Whether the receiver can lower this complete insert plan atomically. */
export function supportsNodeCreatePlan(
  target: NodeProjectionInsertTarget,
  input: Readonly<{
    claims: readonly NodeInsertClaim[];
    projections: readonly NodeInsertProjection[];
  }>,
): boolean {
  if (input.claims.length === 0) {
    return supportsNodeInsertProjections(target, input.projections);
  }
  // A claim refusal is discovered from the data-modifying statement's result,
  // so the caller-owned transaction is the rollback boundary. Root graph
  // backends expose `transaction`; transaction-scoped operation backends do
  // not. Keep this exported predicate aligned with the execution contract.
  return (
    supportsNodeInsertClaims(target) &&
    supportsNodeInsertProjectionRequirements(target, {
      fulltext: input.projections.some(
        (projection) => projection.kind === "fulltext",
      ),
      embedding: input.projections.some(
        (projection) => projection.kind === "embedding",
      ),
    })
  );
}
