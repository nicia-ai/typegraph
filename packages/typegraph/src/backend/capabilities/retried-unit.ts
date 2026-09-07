/**
 * The retry owner for a unit of work run under the `"optimistic-retry"`
 * tier: a `row`-mechanism write fence with `conflict: "commit-time"` lets
 * two acquirers of one fence row both proceed, so the loser's COMMIT fails
 * and correctness comes from replaying the WHOLE unit from the top, never
 * from waiting.
 *
 * Lives under `backend/capabilities` — below the store, not inside it — so
 * a backend factory (`backend/drizzle/postgres.ts`,
 * `backend/drizzle/sqlite.ts`, `backend/drizzle/engine/create-sql-backend.ts`)
 * can wrap its own `db.transaction(...)` calls in {@link runRetriedUnit}
 * without importing upward into `store/`. `store/operations/write-transaction.ts`
 * imports these same exports for its store-owned units, so this stays the
 * ONE retry owner in the codebase: no caller — store or backend — runs a
 * second, parallel retry loop.
 */
import { ConfigurationError, TransactionConflictError } from "../../errors";
import { delay } from "../../utils/delay";
import { isSerializationFailure } from "../../utils/sql-errors";
import {
  type AsyncContextStore,
  createAsyncContextLoader,
} from "../async-context";
import { type BackendCapabilities } from "../types";

/**
 * Whether `backend`'s declared tier requires every unit of work it opens to
 * run as a retried unit: `capabilities.execution.unitOfWork` reads
 * `"optimistic-retry"` — a `row`-mechanism write fence with `conflict:
 * "commit-time"` (`src/backend/capabilities/write-fence.ts`), where two
 * acquirers of one fence row both proceed and the loser's COMMIT fails, so
 * correctness comes from replaying the whole unit from the top, never from
 * waiting.
 *
 * Takes just the `capabilities` a caller has in hand rather than a full
 * `GraphBackend | TransactionBackend`, so a caller holding only a
 * capabilities-bearing fence target (`WriteFenceTarget`, for one) reads the
 * SAME decision instead of re-spelling the `unitOfWork` comparison itself.
 */
export function isOptimisticRetryTier(
  backend: Readonly<{ capabilities: BackendCapabilities }>,
): boolean {
  return backend.capabilities.execution.unitOfWork === "optimistic-retry";
}

/**
 * The retry budget for every unit of work the `"optimistic-retry"` tier
 * routes through {@link runRetriedUnit}: `write-executor.ts`'s three plan
 * runners, `runIdentityMutation`, `rebuildIdentityClosureWithSchemaFence`,
 * `rebuildContribution`, and the index-materialization claim/record calls
 * (all store-owned, routed through `store/operations/write-transaction.ts`),
 * plus the two backend-owned units that acquire a fence row directly —
 * PostgreSQL's graph-template row-mechanism instantiation branch and
 * `runSchemaWriteTransaction` (`src/backend/drizzle/postgres.ts`). One
 * owner, the same role graph-merge's own `MERGE_COMMIT_ATTEMPTS`
 * (`src/graph-merge/merge.ts`) plays for its three commit sites — kept
 * separate because those units route through this module's helpers, never
 * graph-merge's.
 */
export const OPTIMISTIC_RETRY_ATTEMPTS = 3;

/**
 * Milliseconds the backoff schedule starts from once it begins growing (from
 * the third attempt on; see {@link retryBackoffDelayMs}). The only backoff
 * for transaction-conflict replay.
 */
const RETRY_BACKOFF_BASE_MS = 5;

/** Backoff never waits longer than this, no matter how many attempts failed. */
const RETRY_BACKOFF_CAP_MS = 50;

/**
 * Jitter applied symmetrically around the capped exponential delay, as a
 * fraction of it (0.5 means the delay actually used is anywhere from half to
 * one and a half times the capped value).
 */
const RETRY_BACKOFF_JITTER_RATIO = 0.5;

/**
 * Delay, in milliseconds, before running `attemptNumber` after the previous
 * attempt failed with a retryable conflict. Attempt 2 (run immediately after
 * attempt 1 fails) waits zero: a single lost race deserves an immediate
 * re-open, not a pause. From attempt 3 on, the delay grows exponentially from
 * {@link RETRY_BACKOFF_BASE_MS}, capped at {@link RETRY_BACKOFF_CAP_MS} and
 * jittered by {@link RETRY_BACKOFF_JITTER_RATIO} so that several transactions
 * retrying the same conflict do not all wake up and collide again together.
 */
function retryBackoffDelayMs(attemptNumber: number): number {
  if (attemptNumber <= 2) return 0;
  const exponential = RETRY_BACKOFF_BASE_MS * 2 ** (attemptNumber - 2);
  const capped = Math.min(RETRY_BACKOFF_CAP_MS, exponential);
  const jitterMultiplier =
    1 + (Math.random() * 2 - 1) * RETRY_BACKOFF_JITTER_RATIO;
  return capped * jitterMultiplier;
}

/**
 * How {@link runRetriedUnit} disposes of a failure one attempt raised:
 * whether it will re-run the unit, and — when it will not — the exact value
 * it raises to its own caller. `reported` is `undefined` while `retry` is
 * `true`; it is meaningless there and never read.
 */
type RetriedUnitFailureDisposition = Readonly<
  { retry: true; reported?: undefined } | { retry: false; reported: unknown }
>;

/**
 * An attempt that itself runs a nested unit of work through this same owner —
 * graph-merge's commit sites call `target.transaction(...)`, which is
 * `store.transaction()` run with no `retry` option — reports a
 * {@link TransactionConflictError} as its failure, not the driver error
 * underneath, whenever that inner `runRetriedUnit` call was NOT itself seen
 * as nested (the async-context detection below is unavailable, or resolved
 * too late to mark it — see `runRetriedUnit`'s own nesting doc). Classifying
 * the wrapper as-is would still work ({@link isSerializationFailure} walks
 * into its `cause`), but the exhaustion `TransactionConflictError` this loop
 * mints would then wrap the INNER `TransactionConflictError` instead of the
 * driver error it wraps in turn, chaining two conflict errors where the
 * replay contract promises one. Unwrapping first makes the classification,
 * and the eventual `cause`, the same regardless of whether an attempt calls
 * the driver directly, through a nested unit the async-context detection
 * caught (which never wraps in the first place), or through one it did not.
 */
function unwrapNestedConflict(error: unknown): unknown {
  return error instanceof TransactionConflictError ? error.cause : error;
}

/**
 * Marks "the current async execution is already inside a `runRetriedUnit`
 * attempt" so a `runRetriedUnit` call reached from further down the same
 * call graph — synchronously or through any number of intervening `await`s —
 * can tell it is NESTED rather than a second, independent owner. A loader
 * fully separate from {@link file://../serialized-execution-queue.ts}'s own
 * (a different concern, tracking reentrant queue submissions): the two never
 * share a context object, so one can never be mistaken for the other.
 */
const nestedRetriedUnitContext = createAsyncContextLoader<true>();

/**
 * @internal Test seam for `tests/transaction-retry.test.ts`: see
 * {@link createAsyncContextLoader}'s own `setForTesting` doc — the same
 * seam shape `tests/caller-serialized-queue.test.ts` uses for the queue's
 * loader, applied to this module's own nesting-detection instance. Not
 * reachable from published entrypoints.
 */
export function __setRetriedUnitAsyncContextForTesting(
  context: AsyncContextStore<true> | undefined,
  readyDelayMs = 0,
): void {
  nestedRetriedUnitContext.setForTesting(context, readyDelayMs);
}

/** @internal Restores the real loader after a test uses the seam above. */
export function __restoreRetriedUnitAsyncContextForTesting(): void {
  nestedRetriedUnitContext.restoreForTesting();
}

/**
 * The one classification a retryable failure gets, called both by the retry
 * loop itself and by {@link RetriedUnitFrame} so an attempt can learn — from
 * the very same decision, not a re-spelled copy of it — how its own failure
 * will be disposed of before the loop ever sees it.
 *
 * `options.target` — the backend or transaction object this unit is writing
 * through, when the caller has one to name — is passed to
 * {@link isSerializationFailure} so a profile-declared classifier
 * (`SqlExecutionAdapter.serializationFailure`) is consulted before the
 * SQLSTATE/message rules, for an engine whose commit-conflict shape is not
 * PostgreSQL's own.
 *
 * A failure {@link isSerializationFailure} does not recognize — after
 * {@link unwrapNestedConflict} — is never retried and is reported as the
 * ORIGINAL `error`, unchanged. A recognized failure retries while attempts
 * remain; once they don't, it is reported as the {@link TransactionConflictError}
 * the loop raises for it, whose `cause` is always the unwrapped failure, so
 * exhaustion is ever only one conflict error deep.
 */
function classifyRetriedUnitFailure(
  error: unknown,
  attemptNumber: number,
  options: RetriedUnitOptions,
): RetriedUnitFailureDisposition {
  const unwrapped = unwrapNestedConflict(error);
  if (!isSerializationFailure(unwrapped, options.target)) {
    return { retry: false, reported: error };
  }
  if (attemptNumber < options.attempts) return { retry: true };
  return {
    retry: false,
    reported: new TransactionConflictError(
      { operation: options.operation, attempts: options.attempts },
      { cause: unwrapped },
    ),
  };
}

/**
 * Wraps {@link classifyRetriedUnitFailure} in a one-slot memo keyed by
 * reference identity, so every call this attempt makes with the SAME error
 * object — from `frame.willRetry`/`frame.reportedFailure` inside the
 * attempt's own `catch`, and from the loop's `catch` once that same error
 * propagates out of it — resolves to the exact same disposition. That is
 * what lets an attempt report a value (to a hook, say) that is REFERENCE-
 * EQUAL to what `runRetriedUnit` goes on to raise, without minting the
 * `TransactionConflictError` twice: the attempt always rethrows the raw
 * error unchanged (never the disposition), so the loop's own classification
 * of it is the cache hit, not a second mint.
 */
function createMemoizedFailureClassifier(
  attemptNumber: number,
  options: RetriedUnitOptions,
): (error: unknown) => RetriedUnitFailureDisposition {
  let cache:
    | Readonly<{ error: unknown; disposition: RetriedUnitFailureDisposition }>
    | undefined;
  return (error) => {
    if (cache !== undefined && Object.is(cache.error, error)) {
      return cache.disposition;
    }
    const disposition = classifyRetriedUnitFailure(
      error,
      attemptNumber,
      options,
    );
    cache = { error, disposition };
    return disposition;
  };
}

/**
 * What {@link runRetriedUnit} needs beyond the `attempt` factory: the
 * operation name and attempt budget every existing caller already supplies,
 * plus an optional `target` — the backend or transaction object the unit
 * writes through — so {@link isSerializationFailure} can consult a
 * profile-declared classifier registered for that exact object. Absent
 * `target`, classification falls back to the SQLSTATE/message rules, exactly
 * as before this field existed.
 */
export type RetriedUnitOptions = Readonly<{
  operation: string;
  attempts: number;
  target?: object;
}>;

/**
 * The per-attempt handle {@link runRetriedUnit} passes to its `attempt`
 * factory.
 */
type RetriedUnitFrame = Readonly<{
  /** 1-based number of this attempt. */
  attempt: number;
  /**
   * Whether `runRetriedUnit` will re-run the unit if this attempt fails with
   * `error`. An attempt-scoped effect that must not survive a retry (a
   * buffered hook, say) reads this to decide whether to discard itself
   * instead of reporting.
   */
  willRetry: (error: unknown) => boolean;
  /**
   * The exact value `runRetriedUnit` raises to its caller when it does not
   * retry `error` — the driver error itself when `error` was never
   * retryable, or the {@link TransactionConflictError} the loop mints on
   * exhaustion. An attempt that reports its own failure to something other
   * than its return value (a hook, a log) uses this so that value always
   * matches what the eventual caller sees, never a second, independently
   * chosen error.
   */
  reportedFailure: (error: unknown) => unknown;
}>;

/**
 * One attempt of a unit of work run by {@link runRetriedUnit}: given a fresh
 * `frame`, performs the work and resolves with its result, or throws/rejects
 * to signal that the attempt did not commit.
 */
export type RetriedUnitAttempt<T> = (frame: RetriedUnitFrame) => Promise<T>;

/**
 * Runs `attempt` up to `options.attempts` times, re-running it from the top
 * whenever it fails with a transaction conflict
 * ({@link isSerializationFailure}), and raising a
 * {@link TransactionConflictError} — carrying `options.operation`,
 * `options.attempts`, and the last failure as `cause` — if every attempt is
 * exhausted. A failure `isSerializationFailure` does not recognize propagates
 * unchanged on the attempt that raised it; it is never retried.
 *
 * This is the one retry owner in the codebase: every unit of work that may
 * be replayed on a transaction conflict — store-owned or backend-owned —
 * runs through this function, never a second, parallel retry loop.
 *
 * When `attempt` itself fails with a `TransactionConflictError` — the shape a
 * nested single-attempt unit reports (e.g. graph-merge's commit sites call
 * `target.transaction(...)`, which is `store.transaction()` run with no
 * `retry` option) — this loop classifies, and on exhaustion wraps, that
 * error's OWN `cause` rather than the wrapper itself
 * ({@link unwrapNestedConflict}). Exhaustion is therefore always exactly one
 * `TransactionConflictError` deep, whose `cause` is the underlying driver
 * error, never a chain of two conflict errors.
 *
 * `options.attempts` must be a positive integer — the budget for a unit that
 * has not tried even once is a configuration mistake, not a valid zero-retry
 * request, so it is refused with {@link ConfigurationError} before `attempt`
 * is ever called. `options.target`, when supplied, is threaded to
 * {@link isSerializationFailure} so a profile-declared classifier is
 * consulted for that exact backend/transaction object — see
 * {@link RetriedUnitOptions}.
 *
 * ## Nesting is structural, not declared
 *
 * A `runRetriedUnit` call reached from inside another one's `attempt` — a
 * decision-driving read followed by a call into a SEPARATE function that
 * itself opens its own `runRetriedUnit` around a fenced transaction, e.g.
 * `rebuildContribution`'s pre-reads followed by `runSchemaWriteTransaction`
 * — is detected through async context, the same mechanism
 * `serialized-execution-queue.ts` uses to detect a reentrant submission,
 * rather than through any parameter the nested call passes. When detected,
 * the nested call runs `attempt` exactly ONCE, with a `frame` whose `attempt`
 * is always `1` and whose `willRetry` always returns `false`, and lets
 * whatever `attempt` throws propagate completely unchanged — no
 * classification, no `TransactionConflictError` minted here. The reasoning:
 * the reads that decided what the nested unit would do were taken by the
 * OUTER attempt, before it ever called in; replaying only the nested part on
 * its own budget would re-run stale decisions against a database a
 * concurrent committer may have already changed, while multiplying the
 * total attempts made (an outer budget of 3 wrapping an inner budget of 3
 * could attempt the same conflict up to 9 times through two owners). Letting
 * the nested failure propagate untouched hands it to the outermost owner,
 * which replays the WHOLE unit — reads included — from the top, so the total
 * number of attempts made for one logical unit of work is always exactly the
 * outermost owner's own budget, never a multiple of nested budgets.
 *
 * Detection requires the async-context loader to have finished loading, so
 * `runRetriedUnit` awaits its readiness before ever looking at it (mirroring
 * the queue's own `await` before its first reentrancy check) — at worst one
 * microtask of latency before the very first attempt of this process runs.
 * If the runtime has no `node:async_hooks` `AsyncLocalStorage` at all,
 * nesting can never be detected: every call, nested or not, runs its own
 * full, independent retry loop exactly as it did before this detection
 * existed, and {@link unwrapNestedConflict} is what keeps that degraded
 * case correctly classified when an inner single-attempt unit's mint
 * reaches an outer owner unpeeled.
 *
 * ## The replay contract
 *
 * `attempt` receives a fresh `frame` on every call and MUST satisfy:
 *
 * - **Await all of its work** before resolving or rejecting. A retried
 *   attempt that left a fire-and-forget side effect in flight from a
 *   previous, failed attempt could observe — or duplicate — work the caller
 *   never sees fail.
 * - **Use only the supplied `frame`, and values created fresh inside this
 *   call.** A failed attempt's transaction rolled back, so anything it left
 *   behind in memory (a counter, a buffer, an id set) is state no committed
 *   database agrees with; reading it on the next attempt would let a rolled
 *   back attempt leak into a committed one.
 * - **Perform no effect external to its own transaction.** The whole attempt
 *   re-runs on retry, so anything it does outside that transaction (a network
 *   call, a write to a different store) runs again too.
 * - **Tolerate being run up to `attempts` times.** The caller is supplying a
 *   callback willing to be invoked that many times, not exactly once.
 */
export async function runRetriedUnit<T>(
  options: RetriedUnitOptions,
  attempt: RetriedUnitAttempt<T>,
): Promise<T> {
  if (!Number.isInteger(options.attempts) || options.attempts < 1) {
    throw new ConfigurationError(
      `runRetriedUnit(${JSON.stringify(options.operation)}): options.attempts must be a positive integer, got ${options.attempts}.`,
      { operation: options.operation, attempts: options.attempts },
    );
  }
  // Awaited before the context is ever read, so a nested call reached a
  // microtask after this process's very first `runRetriedUnit` call still
  // observes the loader's FINAL value rather than a still-loading
  // `undefined` — see the "Nesting is structural" doc section above.
  await nestedRetriedUnitContext.ready();
  const context = nestedRetriedUnitContext.current();
  // Runs `body` marked as "inside a retried unit" for the duration of the
  // call, so any `runRetriedUnit` reached from further down `body`'s own
  // call graph — nested or sibling to this one — sees the marker. A no-op
  // wrapper when the context is unavailable: nesting simply cannot be
  // detected then, on this call or any further down.
  const runMarked = <R>(body: () => Promise<R>): Promise<R> =>
    context === undefined ? body() : context.run(true, body);

  if (context?.getStore() === true) {
    // Nested: this call's OWN budget is never spent. One call, one frame
    // pinned to attempt 1, no retry — the failure is the outermost owner's
    // to classify, retry, or mint on exhaustion.
    const nestedFrame: RetriedUnitFrame = {
      attempt: 1,
      willRetry: () => false,
      reportedFailure: (error) => error,
    };
    return runMarked(() => attempt(nestedFrame));
  }

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    await delay(retryBackoffDelayMs(attemptNumber));
    const classify = createMemoizedFailureClassifier(attemptNumber, options);
    const frame: RetriedUnitFrame = {
      attempt: attemptNumber,
      willRetry: (error) => classify(error).retry,
      reportedFailure: (error) => {
        const disposition = classify(error);
        return disposition.retry ? error : disposition.reported;
      },
    };
    try {
      return await runMarked(() => attempt(frame));
    } catch (error) {
      const disposition = classify(error);
      if (disposition.retry) continue;
      throw disposition.reported;
    }
  }
}
