/**
 * The inert description of a managed write: what makes it constrained, and
 * whether identity participates in it.
 *
 * A plan is built SYNCHRONOUSLY and reads nothing. That is the invariant this
 * module exists to make structural rather than reviewable: every builder here
 * takes plain data and returns a {@link WritePlan}, never a promise and never
 * a backend, so no decision a write depends on can be made before the write's
 * locks are held. Everything that reads runs inside the executor's row-work
 * callback, which by construction runs after positions 1-3 of the lock order.
 *
 * What a plan deliberately does NOT own is the lock decision. Whether the
 * per-graph write lock is taken is decided by `write-transaction.ts` from
 * `ctx.historyEnabled`, `ctx.revisionTrackingEnabled` and the constraint
 * probe — two of the three are store configuration, not plan input — and
 * whether the schema fence is taken is unconditional for a schema-managed
 * store. A `LockPlan` field could only re-spell a decision it does not own,
 * and would be silently ignored on a non-capture store: exactly the
 * "accepted, then dropped" failure this pipeline exists to prevent.
 */
import { type ConstraintFenceReason } from "../constraints";

/**
 * The row-work family, which DETERMINES the sidecar set a write owes. Not a
 * caller choice: a node write's sidecars are the node sidecars, whatever the
 * caller intended.
 *
 * `"identity"` names the third family for completeness of the taxonomy — an
 * identity assertion is neither a node nor an edge row and has no sidecars.
 * No builder produces it, because the two managed writes in that family
 * (`identity/service-facade.ts` and `store.rebuildIdentityClosure`) are
 * permanently allowlisted rather than migrated: they gain no session, no
 * fences and no sidecars from a plan.
 */
type RowWorkKind = "node" | "edge" | "identity";

/**
 * Why identity participates in this write. The executor acquires the identity
 * lock from `ctx.identityLock` when this is set; the reason is recorded
 * because the fold / detach / assert legs differ in what they do AFTER the row
 * work, and a reader of the plan should not have to find that out from the row
 * work.
 *
 * NOTE what this is not: a lock ORDER. There is no `LockPlan`. Positions 1, 2
 * and 5 are decided and acquired by `write-transaction.ts` and the capture
 * overlay, which own the state those locks guard; the plan re-spells none of
 * them.
 */
export type IdentityParticipation = "fold" | "detach" | "assert" | "import";

export type WritePlan = Readonly<{
  entity: RowWorkKind;
  /**
   * The declared constraint that makes this a constrained write, or
   * `undefined`. Threaded verbatim into `runInWriteTransaction`'s existing
   * `fencesConstraintProbe` option — the same value today's call sites pass,
   * now carried as data instead of spelled at the call.
   */
  constraintProbe: ConstraintFenceReason | undefined;
  identity: IdentityParticipation | undefined;
}>;

/** The plan for one node write. */
export function nodeWritePlan(
  constraintProbe: ConstraintFenceReason | undefined,
  identity: IdentityParticipation | undefined,
): WritePlan {
  return { entity: "node", constraintProbe, identity };
}

/**
 * The plan for a batched node write.
 *
 * Owns one decision the single-write builder does not: **a batch is
 * constrained when ANY member is.** One transaction means one fence, so a
 * single constrained member makes the whole write constrained, and the first
 * such member names the class a refusal would report.
 *
 * `node-operations.ts`'s private `nodeBatchFencesConstraintProbe` is the
 * pre-migration spelling of this fold; it is replaced by this builder in the
 * batch that moves those call sites (B1), not left as a second owner.
 */
export function nodeBatchWritePlan(
  constraintProbes: readonly (ConstraintFenceReason | undefined)[],
  identity: IdentityParticipation | undefined,
): WritePlan {
  return {
    entity: "node",
    constraintProbe: constraintProbes.find((probe) => probe !== undefined),
    identity,
  };
}

/**
 * The plan for one edge write. Edge writes do not participate in identity —
 * identity folds node references, and an edge carries none of its own — so the
 * participation is not a parameter.
 */
export function edgeWritePlan(
  constraintProbe: ConstraintFenceReason | undefined,
): WritePlan {
  return { entity: "edge", constraintProbe, identity: undefined };
}
