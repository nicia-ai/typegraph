/**
 * The one sanctioned caller of `runInWriteTransaction` /
 * `runHookedWriteOperation`.
 *
 * What the executor owns is small and complete: thread the plan's constraint
 * probe into the option `write-transaction.ts` already owns, acquire the
 * identity lock when the plan declares participation, mint the session, and
 * hand row work the read projection. Everything else — whether the per-graph
 * write lock is taken, whether the schema fence is taken, the lock ORDER —
 * stays with the module that owns the state those locks guard. The executor
 * re-spells none of it.
 *
 * Row work therefore cannot run before the locks: `runInWriteTransaction`
 * takes positions 1-2, this takes position 3, and `rowWork` is called after
 * both.
 */
import { deriveBackend } from "../../backend/derive-backend";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { requireDefined } from "../../utils/presence";
import {
  type GraphWriteLock,
  uncapturedGraphWriteLock,
} from "../recorded-capture/clock";
import { type OperationHookContext } from "../types";
import { type RowWorkKind, type WritePlan } from "./write-plan";
import {
  createWriteSession,
  type WriteSession,
  type WriteSessionContext,
  type WriteSessionFor,
  type WriteTarget,
} from "./write-session";
import {
  type HookedWriteOperationContext,
  runHookedWriteOperation,
  runInWriteTransaction,
  type WriteTransactionContext,
  type WriteTransactionOptions,
} from "./write-transaction";

/**
 * What a plan-driven write needs beyond the transaction context: the graph's
 * kind registry (the session's step modules resolve schemas and constraints
 * through it) and HOW this caller acquires the identity lock.
 *
 * `identityLock` is absent when the graph has no identity configured — in
 * which case plan builders derive `requiresIdentityLock: false`, so a declared
 * participation with no acquirer is a wiring bug. The executor asserts on it
 * rather than silently skipping the lock: no user-stated option can produce
 * that state, so it is an internal invariant, not a public refusal.
 */
export type WritePlanContext = WriteTransactionContext &
  WriteSessionContext &
  Readonly<{
    identityLock?: (target: GraphBackend | TransactionBackend) => Promise<void>;
  }>;

/** The hooked variant's context: the above plus the hook wrapper. */
export type HookedWritePlanContext = WritePlanContext &
  HookedWriteOperationContext;

/**
 * The transaction options a plan caller may still state.
 *
 * `fencesConstraintProbe` is subtracted because the executor OWNS it — it
 * comes from `plan.constraintProbe` and nowhere else. Subtracting the key
 * makes a doubly-spelled probe a type error at the call site instead of a
 * value the executor's spread silently discards, which is the same
 * "accepted then dropped" failure that deleted the lock-plan field. Written as
 * an `Omit` of the existing options type rather than a fresh literal, so an
 * option added to `WriteTransactionOptions` reaches plan callers on its own;
 * today the residue is `didWrite` plus the private first-statement schema
 * fence marker used by the qualifying insert paths.
 */
export type WritePlanOptions<T> = Omit<
  WriteTransactionOptions<T>,
  "fencesConstraintProbe"
>;

/**
 * Mints a second session for THIS write frame over a READ OVERLAY of its
 * target: the frame's own handle, answering some reads from a pending-aware
 * cache and delegating everything else, which is what
 * `createNodeBatchValidationSeams` describes.
 *
 * It exists because a fused step reads and writes through ONE handle.
 * Interchange import's batched slice has to route the uniqueness pre-check
 * inside `reviseNode` through the overlay — so a key an unflushed create
 * earlier in the same slice already reserved degrades to a per-row error
 * instead of colliding at flush — while the write itself lands on the real
 * backend, which is precisely what that overlay does. Handing the leg the
 * frame's session over the raw target would silently drop the pending state,
 * and re-checking uniqueness outside the step would be a second spelling of a
 * decision the step owns.
 *
 * What this TAKES is the reads to answer, not a backend to write through. Row
 * work holds the read-only {@link WriteTarget}, so it cannot produce a
 * writable overlay without widening the very projection this seam exists to
 * keep narrow; the EXECUTOR owns the decoration, over the raw target it
 * already has. `Partial<WriteTarget>` is the exact bound that follows: an
 * overlay may redirect any read row work can see, and no write member at all.
 *
 * What this hands out is the CAPABILITY, not the evidence: the frame's
 * {@link GraphWriteLock} stays inside the executor, so row work still cannot
 * reach a step module directly. All it can obtain is another fused session,
 * whose methods apply the same sidecars and the same fences as the first.
 */
type WriteTargetReadOverlay = Partial<WriteTarget>;

export type OverlaidSessionMint<K extends RowWorkKind = RowWorkKind> = (
  reads: WriteTargetReadOverlay,
) => WriteSessionFor<K>;

/** Row work: the only place a plan-driven write may read or write rows. */
export type WriteRowWork<K extends RowWorkKind, T> = (
  session: WriteSessionFor<K>,
  target: WriteTarget,
  overlaidSession: OverlaidSessionMint<K>,
) => Promise<T>;

/**
 * The frame both entry points run: acquire position 3 when the plan declares
 * identity participation, then call row work with the session and the read
 * projection.
 *
 * ONE spelling, shared. A hooked write and a plain one differ only in what
 * wraps the transaction, so the identity decision — and the moment in the
 * frame it is taken at — must not be written twice.
 */
function planFrame<K extends RowWorkKind, T>(
  ctx: WritePlanContext,
  plan: WritePlan<K>,
  rowWork: WriteRowWork<K, T>,
) {
  return async (
    target: GraphBackend | TransactionBackend,
    lock: GraphWriteLock,
  ): Promise<T> => {
    if (plan.requiresIdentityLock) {
      const acquireIdentityLock = requireDefined(
        ctx.identityLock,
        "write plan declares identity participation with no acquirer",
      );
      await acquireIdentityLock(target);
    }
    // ONE spelling of "mint a session for this frame", used for the frame's own
    // session and for any overlaid one, so the two cannot be built from
    // different context or a different lock. The overlaid variant is that
    // spelling applied to a decorated target — the decoration is the ONLY
    // difference between them, and the frame's own session pays for no proxy.
    const mintSessionOver = (
      sessionTarget: GraphBackend | TransactionBackend,
    ): WriteSession => createWriteSession(ctx, sessionTarget, lock);
    const mintOverlaidSession: OverlaidSessionMint<K> = (reads) =>
      mintSessionOver(deriveBackend(target, reads)) as WriteSessionFor<K>;
    // The two handles are the SAME object: the session closes over the raw
    // target (its step modules probe optional members on it), while row work
    // sees it through the type-only `WriteTarget` projection. One value, two
    // static views.
    return rowWork(
      mintSessionOver(target) as WriteSessionFor<K>,
      target,
      mintOverlaidSession,
    );
  };
}

/**
 * The transaction options the executor hands down.
 *
 * `fencesConstraintProbe` is written LAST and from the plan alone, so no
 * caller-supplied residue can shadow it.
 */
function planTransactionOptions<K extends RowWorkKind, T>(
  plan: WritePlan<K>,
  options: WritePlanOptions<T> | undefined,
): WriteTransactionOptions<T> {
  return { ...options, fencesConstraintProbe: plan.constraintProbe };
}

/** Runs one managed write under its plan. */
export function runWritePlan<K extends RowWorkKind, T>(
  ctx: WritePlanContext,
  plan: WritePlan<K>,
  backend: GraphBackend | TransactionBackend,
  rowWork: WriteRowWork<K, T>,
  options?: WritePlanOptions<T>,
): Promise<T> {
  return runInWriteTransaction(
    ctx,
    backend,
    planFrame(ctx, plan, rowWork),
    planTransactionOptions(plan, options),
  );
}

/**
 * Hooked variant: operation hooks WRAP the plan, exactly as
 * `runHookedWriteOperation` wraps the transaction today, so `onOperationEnd`
 * observes a durably committed result.
 */
export function runHookedWritePlan<K extends RowWorkKind, T>(
  ctx: HookedWritePlanContext,
  opContext: OperationHookContext,
  plan: WritePlan<K>,
  backend: GraphBackend | TransactionBackend,
  rowWork: WriteRowWork<K, T>,
  options?: WritePlanOptions<T>,
): Promise<T> {
  return runHookedWriteOperation(
    ctx,
    opContext,
    backend,
    planFrame(ctx, plan, rowWork),
    planTransactionOptions(plan, options),
  );
}

/** Internal signal that a zero-row autocommit attempt needs portable recovery. */
export class AutocommitWriteRequiresTransaction extends Error {
  constructor() {
    super("The managed autocommit attempt requires transactional recovery.");
    this.name = "AutocommitWriteRequiresTransaction";
  }
}

/**
 * Runs a proven single-statement write directly on a bundled root backend.
 *
 * The eligibility classifier is deliberately outside this generic executor:
 * it owns the operation-specific proof that row work has no claim, sidecar,
 * identity, capture, revision, or recovery statement. This helper owns only
 * the resulting execution shape — no `BEGIN` / `COMMIT` and no transaction
 * target — while preserving the ordinary hook boundary. A completed SQL
 * statement is already durably committed, so `onOperationEnd` remains truthful.
 */
export function runAutocommitSingleStatementWritePlan<K extends RowWorkKind, T>(
  ctx: HookedWritePlanContext,
  opContext: OperationHookContext,
  plan: WritePlan<K>,
  backend: GraphBackend,
  rowWork: WriteRowWork<K, T>,
  fallbackOptions?: WritePlanOptions<T>,
): Promise<T> {
  return ctx.withOperationHooks(opContext, async () => {
    try {
      return await planFrame(
        ctx,
        plan,
        rowWork,
      )(backend, uncapturedGraphWriteLock());
    } catch (error) {
      if (!(error instanceof AutocommitWriteRequiresTransaction)) throw error;
      return runWritePlan(ctx, plan, backend, rowWork, fallbackOptions);
    }
  });
}
