/**
 * The managed write state a transaction session carries
 * (`TransactionSession.managedWrite`, `operation-scope.ts`): the write session
 * of the `store.transaction` attempt that opened the session, and the schema
 * fences the session has leased.
 *
 * `write-transaction.ts` seeds and updates it. Every reader resolves it here,
 * through {@link managedWriteState}, from the operation it already holds: two
 * sessions over one transaction object (a second binding of the same
 * transaction, a target joining through a public signature) never share it,
 * and every operation of one session does.
 */
import { type OperationEntry, operationEntrySession } from "../operation-scope";
import type { GraphWriteLock } from "../recorded-capture/clock";

/**
 * Whether a transaction session may hand the fence evidence one managed write
 * acquired to the writes after it: the per-graph write fence and the schema
 * fence alike.
 *
 * PostgreSQL releases a lock taken after a savepoint, and undoes a fence-row
 * advance made after it, when the transaction rolls back to that savepoint.
 * A callback holding a raw SQL handle can issue that rollback between two
 * managed writes, so its session is `"per-write"`: every write that needs a
 * fence takes it again. A callback with no such handle cannot, and its
 * session is `"reusable"`. The Store decides which from the one raw handle a
 * transaction context can carry, `tx.sql`.
 */
export type WriteTransactionFenceEvidence = "reusable" | "per-write";

/**
 * The write session of one `store.transaction` attempt: what its nested typed
 * mutations share so the attempt advances its durable revision once and reuses
 * fence evidence where {@link WriteTransactionFenceEvidence} allows.
 *
 * Mutable by design: its frames update it as they run, and a savepoint unit
 * restores it (`write-transaction.ts` registers the checkpoint).
 */
export interface WriteTransactionSession {
  fenceEvidence: WriteTransactionFenceEvidence;
  lock: GraphWriteLock | undefined;
  wrote: boolean;
  aborted?: Readonly<{ error: unknown }>;
}

/**
 * What a transaction session holds for managed writes. Both slots are empty
 * when the session opens and are filled only for the extent of the scope that
 * owns them (`write-transaction.ts`).
 */
export interface ManagedWriteState {
  /** The attempt's write session while its callback runs. */
  writeSession: WriteTransactionSession | undefined;
  /**
   * Schema fences leased on this session, by graph id and expected version,
   * while a reusable write session or an adopted history callback runs.
   */
  schemaFenceLeases: Map<string, Promise<void>> | undefined;
}

/**
 * THE read of the managed write state: the state of the session `entry`
 * belongs to, or `undefined` for the root backend, which has none.
 */
export function managedWriteState(
  entry: OperationEntry,
): ManagedWriteState | undefined {
  return operationEntrySession(entry)?.managedWrite;
}
