/**
 * Which backend a transaction backend was opened on.
 *
 * A transaction backend is built from an operations fragment over the open
 * transaction, not derived from the backend that opened it, so its
 * `deriveBackend` lineage (`./derive-backend`) ends at itself: lineage alone
 * cannot tell a transaction of a backend's own database from one of any
 * other database. The backend that opens or adopts the transaction records
 * the fact here, once, before the transaction reaches any caller.
 *
 * Deliberately a separate relation from derivation lineage. A transaction is
 * NOT a derivation of its backend: lineage carries resource audits, command
 * port metadata and "built on exactly this target" provenance, and a
 * transaction inheriting those from the root would let a read built inside
 * the transaction run on the root after it ends.
 */
import { backendDerivationRoot } from "./derive-backend";

/** Transaction derivation root → derivation root of the backend that opened it. */
const TRANSACTION_ORIGINS = new WeakMap<object, object>();

/**
 * Records that `transaction` runs on a transaction `backend` opened or
 * adopted, and returns `transaction`.
 *
 * @internal Called by the engine assembly where it hands a transaction out.
 */
export function withTransactionOrigin<T extends object>(
  transaction: T,
  backend: object,
): T {
  TRANSACTION_ORIGINS.set(
    backendDerivationRoot(transaction),
    backendDerivationRoot(backend),
  );
  return transaction;
}

/**
 * Whether a read whose provenance names `executionTarget` — the derivation
 * root of the backend it was built on — may execute on `target`: the same
 * backend or a derivation of it, or a transaction that backend opened.
 * A read built inside a transaction names that transaction, so it runs only
 * on that transaction; one built on another database runs on neither.
 *
 * THE one owner of the "same database or transaction target" decision for a
 * target handed to a read at execution.
 */
export function executesOnExecutionTarget(
  target: object,
  executionTarget: object,
): boolean {
  const root = backendDerivationRoot(target);
  return (
    root === executionTarget ||
    TRANSACTION_ORIGINS.get(root) === executionTarget
  );
}
