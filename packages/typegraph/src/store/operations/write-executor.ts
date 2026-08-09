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
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { requireDefined } from "../../utils/presence";
import { type GraphWriteLock } from "../recorded-capture/clock";
import { type OperationHookContext } from "../types";
import { type WritePlan } from "./write-plan";
import {
  createWriteSession,
  type WriteSession,
  type WriteSessionContext,
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
 * which case plan builders derive `identity: undefined`, so a declared
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
 * today the residue is exactly `didWrite`.
 */
export type WritePlanOptions<T> = Omit<
  WriteTransactionOptions<T>,
  "fencesConstraintProbe"
>;

/** Row work: the only place a plan-driven write may read or write rows. */
export type WriteRowWork<T> = (
  session: WriteSession,
  target: WriteTarget,
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
function planFrame<T>(
  ctx: WritePlanContext,
  plan: WritePlan,
  rowWork: WriteRowWork<T>,
) {
  return async (
    target: GraphBackend | TransactionBackend,
    lock: GraphWriteLock,
  ): Promise<T> => {
    if (plan.identity !== undefined) {
      const acquireIdentityLock = requireDefined(
        ctx.identityLock,
        "write plan declares identity participation with no acquirer",
      );
      await acquireIdentityLock(target);
    }
    // The two handles are the SAME object: the session closes over the raw
    // target (its step modules probe optional members on it), while row work
    // sees it through the type-only `WriteTarget` projection. One value, two
    // static views.
    return rowWork(createWriteSession(ctx, target, lock), target);
  };
}

/**
 * The transaction options the executor hands down.
 *
 * `fencesConstraintProbe` is written LAST and from the plan alone, so no
 * caller-supplied residue can shadow it.
 */
function planTransactionOptions<T>(
  plan: WritePlan,
  options: WritePlanOptions<T> | undefined,
): WriteTransactionOptions<T> {
  return { ...options, fencesConstraintProbe: plan.constraintProbe };
}

/** Runs one managed write under its plan. */
export function runWritePlan<T>(
  ctx: WritePlanContext,
  plan: WritePlan,
  backend: GraphBackend | TransactionBackend,
  rowWork: WriteRowWork<T>,
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
export function runHookedWritePlan<T>(
  ctx: HookedWritePlanContext,
  opContext: OperationHookContext,
  plan: WritePlan,
  backend: GraphBackend | TransactionBackend,
  rowWork: WriteRowWork<T>,
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
