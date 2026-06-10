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

/** SQLSTATEs that mean "transaction aborted, safe to re-run verbatim". */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);

/**
 * Driver-message fallback for errors whose SQLSTATE was lost in wrapping.
 * Matches the fixed Postgres texts for serialization failure and deadlock.
 */
const RETRYABLE_MESSAGE_PATTERN =
  /could not serialize access|deadlock detected/i;

/** Bounded number of commit attempts before giving up with a typed error. */
export const MAX_COMMIT_ATTEMPTS = 3;

/**
 * Whether `error` (or anything in its cause chain) is a retryable transaction
 * conflict — a Postgres serialization failure (40001) or deadlock (40P01).
 * Walks the `cause` chain because drivers and wrappers (pg → Drizzle →
 * TypeGraph) re-wrap the original error; a visited set guards against cyclic
 * cause chains.
 */
export function isRetryableTxConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (
    current !== undefined &&
    current !== null &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    const candidate = current as Readonly<{
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    }>;
    if (
      typeof candidate.code === "string" &&
      RETRYABLE_SQLSTATES.has(candidate.code)
    ) {
      return true;
    }
    if (
      typeof candidate.message === "string" &&
      RETRYABLE_MESSAGE_PATTERN.test(candidate.message)
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * Runs `commit` (a function that opens and completes ONE transaction attempt),
 * retrying up to {@link MAX_COMMIT_ATTEMPTS} times on retryable conflicts.
 * Non-retryable errors propagate immediately; exhaustion raises a
 * {@link MergeError} carrying the final conflict as its cause.
 */
export async function withTxConflictRetry<T>(
  commit: () => Promise<T>,
): Promise<T> {
  let lastConflict: unknown;
  for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
    try {
      return await commit();
    } catch (error) {
      if (!isRetryableTxConflict(error)) {
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
