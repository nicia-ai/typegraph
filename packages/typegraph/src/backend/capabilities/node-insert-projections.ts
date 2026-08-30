import type {
  BackendIdentity,
  GraphBackend,
  ManagedNodeCreatePlan,
  NodeInsertClaim,
  NodeInsertProjection,
} from "../types";
import {
  type AtomicNodeClaimSupport,
  supportsAtomicNodeClaims,
} from "./atomic-mutation-program";

export type NodeProjectionInsertTarget = BackendIdentity &
  Pick<GraphBackend, "commands">;

export type NodeInsertProjectionRequirements = Readonly<{
  fulltext: boolean;
  embedding: boolean;
}>;

export function supportsNodeInsertProjectionRequirements(
  target: NodeProjectionInsertTarget,
  requirements: NodeInsertProjectionRequirements,
): boolean {
  return (
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
 * command port is also used for projection-only
 * autocommit writes, but a claim refusal must roll back the node and any
 * claims it touched together.
 */
function supportsNodeInsertClaims(target: NodeProjectionInsertTarget): boolean {
  return (
    !("transaction" in target) &&
    target.capabilities.atomicNodeInsertClaims === true
  );
}

/**
 * The only claim shape that is safe to execute on a root backend without a
 * rollback boundary. A generated id cannot collide with a different node, so
 * the claim is the sole conflict source; same-kind uniqueness has no legacy
 * axis or cross-kind/disjoint probe to consult. Rephasing it before the node
 * insert makes a conflict prevent the node row from being written at all.
 */
function supportsNonTransactionalNodeClaimPlan(
  plan: Pick<
    ManagedNodeCreatePlan,
    "idGenerated" | "mode" | "params" | "claims" | "projections"
  >,
): boolean {
  return (
    plan.idGenerated &&
    plan.mode.kind === "ordinary" &&
    plan.projections.length === 0 &&
    plan.claims.length === 1 &&
    plan.claims.every(
      (claim) =>
        claim.verdict.kind === "uniqueness" &&
        claim.axis === plan.params.kind &&
        claim.verdict.probeAxes.length === 1 &&
        claim.verdict.probeAxes[0] === claim.axis,
    )
  );
}

/** Rephases the safe root claim shape so a conflict gates the node insert. */
export function rephaseNonTransactionalNodeClaimPlan(
  plan: ManagedNodeCreatePlan,
): ManagedNodeCreatePlan | undefined {
  if (!supportsNonTransactionalNodeClaimPlan(plan)) return;
  return {
    ...plan,
    claims: plan.claims.map((claim) => ({
      ...claim,
      placement: "pre-insert",
    })),
  };
}

/**
 * Normalizes the one-claim envelope accepted by an atomic node program.
 *
 * Unlike the ordinary root insert seam, a closed program can also prove a
 * disjoint claim because it carries the legacy live-node probe and cleanup in
 * the same atomic transport submission. The executor's advertised support is
 * authoritative; an omitted family remains on the portable path.
 */
export function rephaseAtomicNodeClaimPlan(
  plan: ManagedNodeCreatePlan,
  support: AtomicNodeClaimSupport | undefined,
): ManagedNodeCreatePlan | undefined {
  if (
    plan.mode.kind !== "ordinary" ||
    plan.projections.length > 0 ||
    plan.claims.length !== 1 ||
    !supportsAtomicNodeClaims(support, plan.claims)
  ) {
    return;
  }
  const claim = plan.claims[0];
  if (claim === undefined) return;
  const uniquenessSupported =
    plan.idGenerated &&
    claim.verdict.kind === "uniqueness" &&
    claim.axis === plan.params.kind &&
    claim.verdict.probeAxes.length === 1 &&
    claim.verdict.probeAxes[0] === claim.axis;
  const disjointnessSupported =
    claim.verdict.kind === "disjointness" &&
    claim.key === plan.params.id &&
    claim.verdict.conflictingKinds.length === 1;
  if (!uniquenessSupported && !disjointnessSupported) return;
  return {
    ...plan,
    claims: [{ ...claim, placement: "pre-insert" }],
  };
}

/** Whether the receiver can lower this complete insert plan atomically. */
export function supportsNodeCreatePlan(
  target: NodeProjectionInsertTarget,
  input: Readonly<{
    params?: ManagedNodeCreatePlan["params"];
    idGenerated?: ManagedNodeCreatePlan["idGenerated"];
    mode?: ManagedNodeCreatePlan["mode"];
    claims: readonly NodeInsertClaim[];
    projections: readonly NodeInsertProjection[];
    /** Store-side proof that no identity/history/revision side effect exists. */
    allowNonTransactionalClaims?: boolean | undefined;
  }>,
): boolean {
  if (input.claims.length === 0) {
    return supportsNodeInsertProjections(target, input.projections);
  }
  // A claim refusal is discovered from the data-modifying statement's result,
  // so the caller-owned transaction is the rollback boundary. Root graph
  // backends expose `transaction`; transaction-scoped operation backends do
  // not. Keep this exported predicate aligned with the execution contract.
  const ordinaryPlan =
    (
      input.params === undefined ||
      input.mode === undefined ||
      input.idGenerated === undefined
    ) ?
      undefined
    : {
        entity: "node" as const,
        params: input.params,
        idGenerated: input.idGenerated,
        mode: input.mode,
        claims: input.claims,
        projections: input.projections,
      };
  const rootClaimFusion =
    input.allowNonTransactionalClaims === true &&
    target.capabilities.atomicNodeInsertClaims === true &&
    ordinaryPlan !== undefined &&
    supportsNonTransactionalNodeClaimPlan(ordinaryPlan);
  return (
    (supportsNodeInsertClaims(target) ||
      ("transaction" in target && rootClaimFusion)) &&
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
