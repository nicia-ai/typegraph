import type {
  BackendIdentity,
  GraphBackend,
  NodeInsertProjection,
} from "../types";

export type NodeProjectionInsertTarget = BackendIdentity &
  Pick<GraphBackend, "insertNodeWithProjections">;

export type NodeInsertProjectionRequirements = Readonly<{
  fulltext: boolean;
  embedding: boolean;
}>;

export function supportsNodeInsertProjectionRequirements(
  target: NodeProjectionInsertTarget,
  requirements: NodeInsertProjectionRequirements,
): boolean {
  return (
    target.insertNodeWithProjections !== undefined &&
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
