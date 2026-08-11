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
 * The row-work family, which determines the session surface handed to row
 * work. A node plan can call only node session methods, an edge plan only edge
 * methods, and the deliberately mixed import plan can call both.
 *
 * `"mixed"` is explicit rather than pretending a frame that writes both node
 * and edge rows belongs to one family. Interchange import is its sole caller.
 */
export type RowWorkKind = "node" | "edge" | "mixed";

/**
 * Whether identity participates in this write. The executor owns only the lock
 * requirement; fold, detach, and assertion behavior remains typed row work and
 * is deliberately not encoded as inert plan data the executor would ignore.
 *
 * NOTE what this is not: a lock ORDER. There is no `LockPlan`. Positions 1, 2
 * and 5 are decided and acquired by `write-transaction.ts` and the capture
 * overlay, which own the state those locks guard; the plan re-spells none of
 * them.
 */
export type WritePlan<K extends RowWorkKind = RowWorkKind> = Readonly<{
  entity: K;
  /**
   * The declared constraint that makes this a constrained write, or
   * `undefined`. Threaded verbatim into `runInWriteTransaction`'s existing
   * `fencesConstraintProbe` option — the same value today's call sites pass,
   * now carried as data instead of spelled at the call.
   */
  constraintProbe: ConstraintFenceReason | undefined;
  requiresIdentityLock: boolean;
}>;

/** The plan for one node write. */
export function nodeWritePlan(
  constraintProbe: ConstraintFenceReason | undefined,
  requiresIdentityLock: boolean,
): WritePlan<"node"> {
  return { entity: "node", constraintProbe, requiresIdentityLock };
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
  requiresIdentityLock: boolean,
): WritePlan<"node"> {
  return {
    entity: "node",
    constraintProbe: constraintProbes.find((probe) => probe !== undefined),
    requiresIdentityLock,
  };
}

/**
 * The plan for one edge write. Edge writes do not participate in identity —
 * identity folds node references, and an edge carries none of its own — so the
 * participation is not a parameter.
 */
export function edgeWritePlan(
  constraintProbe: ConstraintFenceReason | undefined,
): WritePlan<"edge"> {
  return { entity: "edge", constraintProbe, requiresIdentityLock: false };
}

/** A single frame that deliberately coordinates node and edge writes. */
export function mixedWritePlan(
  constraintProbe: ConstraintFenceReason | undefined,
  requiresIdentityLock: boolean,
): WritePlan<"mixed"> {
  return { entity: "mixed", constraintProbe, requiresIdentityLock };
}
