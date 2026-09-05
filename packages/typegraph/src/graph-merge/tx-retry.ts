/**
 * Bounded retry for the merge commit transaction.
 *
 * The commit runs at `SERIALIZABLE` isolation (see `commitPlan` /
 * `commitIncrementalPlan`): under Postgres SSI a concurrent write that
 * invalidates the transaction's reads aborts one side with SQLSTATE 40001
 * (serialization failure); lock ordering between concurrent merges can also
 * surface 40P01 (deadlock). Both are TRANSIENT — the transaction did not
 * commit, and re-running it is the documented client protocol — so the commit
 * is retried a bounded number of times. The in-transaction `base@V`
 * re-validation runs on every attempt, so a retry that lands after a REAL
 * divergence fails deterministically with `BaseVersionMismatchError` instead
 * of committing a stale plan.
 *
 * SQLite and PGlite serialize writers (single connection), so retryable
 * conflicts cannot occur there and the wrapper is pass-through in practice.
 */

import { MergeError } from "./errors";
import { isSerializationFailure } from "./typegraph-internal";

/** Bounded number of commit attempts before giving up with a typed error. */
export const MAX_COMMIT_ATTEMPTS = 3;

/**
 * Runs `commit` (a function that opens and completes ONE transaction attempt),
 * retrying up to {@link MAX_COMMIT_ATTEMPTS} times on a transaction conflict
 * ({@link isSerializationFailure}). Non-retryable errors propagate
 * immediately; exhaustion raises a {@link MergeError} carrying the final
 * conflict as its cause.
 */
export async function withTxConflictRetry<T>(
  commit: () => Promise<T>,
): Promise<T> {
  let lastConflict: unknown;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      return await commit();
    } catch (error) {
      if (!isSerializationFailure(error)) {
        throw error;
      }
      lastConflict = error;
    }
  }
  throw new MergeError(
    `Merge commit aborted by transaction conflicts (serialization failure or deadlock) on ${MAX_COMMIT_ATTEMPTS} consecutive attempts; giving up.`,
    {
      cause: lastConflict,
      details: { attempts: MAX_COMMIT_ATTEMPTS },
      suggestion:
        "Reduce concurrent writes to the merge target, or serialize merges against it.",
    },
  );
}
