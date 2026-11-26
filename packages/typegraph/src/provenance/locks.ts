/**
 * The retraction capability's lock discipline.
 *
 * The store's canonical lock order is the schema-version fence first and the
 * per-graph write lock second. Taking the graph lock alone and writing
 * afterwards would take the schema fence second, the reverse order, and could
 * form a cycle with a schema commit that holds the schema fence and waits for
 * the graph lock. So every lock the capability takes on a transaction that
 * can write is both, in that order, before its first read:
 *
 * - a retraction transition and the commit-time assert take them
 *   unconditionally and refuse a read-only transaction
 *   ({@link acquireCapabilityWriteLocks});
 * - `holding(tx)` reads in the caller's transaction, which may write after it,
 *   so it takes them too — unless that transaction is read-only, where it can
 *   never write and takes the graph lock alone
 *   ({@link acquireCallerTransactionReadLocks}).
 *
 * `holding()` with no argument reads in a transaction of its own that never
 * writes, so it takes the graph lock alone ({@link acquireCapabilityReadLock})
 * and stays usable under a role that may only `SELECT`.
 *
 * Re-acquiring either lock in a transaction that already holds it reuses the
 * held lock.
 */
import type { GraphDef } from "../core/define-graph";
import { type Operation } from "../store/operation-scope";
import {
  lockRecordedGraphWrite,
  recordedGraphLockMemoOf,
} from "../store/recorded-capture";
import {
  transactionAcquireReadFences,
  transactionAcquireWriteFences,
} from "../store/runtime-port";
import { type TransactionContext } from "../store/types";

const READ_ONLY_TRANSACTION_SUGGESTION =
  'Call provenance.holding(tx) to read the believed set in a read-only transaction, or remove accessMode: "read_only" so the transaction can take its write locks.';

/**
 * Takes the capability's write locks through the transaction's own managed
 * write frame: the schema-version fence, then the per-graph write lock.
 * Refuses a read-only transaction before any statement, naming `operation`.
 */
export function acquireCapabilityWriteLocks<G extends GraphDef>(
  tx: TransactionContext<G>,
  operation: string,
): Promise<void> {
  return transactionAcquireWriteFences(tx, {
    operation,
    suggestion: READ_ONLY_TRANSACTION_SUGGESTION,
  });
}

/**
 * Takes the locks a read of the believed set needs in a transaction the
 * caller supplied: the write locks, in their canonical order, when the
 * transaction can write, or the per-graph write lock alone when it was opened
 * read-only. The transaction decides which, from its own read-only flag.
 */
export function acquireCallerTransactionReadLocks<G extends GraphDef>(
  tx: TransactionContext<G>,
): Promise<void> {
  return transactionAcquireReadFences(tx);
}

/**
 * Takes the per-graph write lock and nothing else, for a read in a
 * transaction the capability opened and never writes in. The support
 * computation reads several relations, and PostgreSQL's READ COMMITTED gives
 * each statement its own snapshot — without the lock a concurrent transition
 * could commit between those reads and tear the view.
 *
 * Taken through `operation`'s handle: the operation the read it guards
 * entered.
 */
export async function acquireCapabilityReadLock(
  operation: Operation,
  graphId: string,
): Promise<void> {
  await lockRecordedGraphWrite(
    operation.backend,
    graphId,
    recordedGraphLockMemoOf(operation),
  );
}
