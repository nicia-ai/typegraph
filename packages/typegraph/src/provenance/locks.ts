/**
 * The retraction capability's lock discipline.
 *
 * The store's canonical lock order is the schema-version fence first and the
 * per-graph write lock second. A caller that writes — a retraction
 * transition — or that guards a caller's writes — the commit-time assert —
 * takes both, in that order, before its first read
 * ({@link acquireCapabilityWriteLocks}). Taking the graph lock alone and
 * writing afterwards would take the schema fence second, the reverse order,
 * and could form a cycle with a schema commit that holds the schema fence and
 * waits for the graph lock.
 *
 * A caller that only reads the believed set takes the graph lock alone
 * ({@link acquireCapabilityReadLock}). It never writes, so it never takes the
 * schema fence and cannot be part of such a cycle, and it stays usable where
 * the schema fence is not: a read-only transaction, or a role that may only
 * `SELECT`.
 *
 * Re-acquiring either lock in a transaction that already holds it reuses the
 * held lock.
 */
import type { GraphDef } from "../core/define-graph";
import { lockRecordedGraphWrite } from "../store/recorded-capture";
import {
  transactionAcquireWriteFences,
  transactionBackend,
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
 * Takes the per-graph write lock and nothing else. The support computation
 * reads several relations, and PostgreSQL's READ COMMITTED gives each
 * statement its own snapshot — without the lock a concurrent transition could
 * commit between those reads and tear the view.
 */
export async function acquireCapabilityReadLock<G extends GraphDef>(
  tx: TransactionContext<G>,
  graphId: string,
): Promise<void> {
  await lockRecordedGraphWrite(transactionBackend(tx), graphId);
}
