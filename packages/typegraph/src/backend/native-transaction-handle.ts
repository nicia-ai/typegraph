/**
 * The one owner of "which native transaction does this transaction backend
 * run on".
 *
 * Every adoption of a native transaction binds a NEW engine transaction
 * backend (`bindTransactionBackend` in both dialects), so one native
 * transaction has as many derivation roots as it has bindings, and no backend
 * object identifies the transaction. The engine therefore records, once per
 * bind, the native transaction the bound backend runs on
 * ({@link recordNativeTransactionHandle}); the Store resolves it along the
 * derivation chain ({@link resolveNativeTransactionHandle}), so a derived
 * backend inherits the record of the backend it was derived from.
 *
 * What is recorded is an object that identifies ONE native transaction, never
 * a connection:
 *
 * - A driver transaction object (Drizzle's `PgTransaction`,
 *   `SQLiteTransaction`) is a new object per BEGIN, so it is recorded as
 *   itself.
 * - A handle that is the connection itself (better-sqlite3 and Durable Object
 *   storage hand every TypeGraph-owned transaction the long-lived database
 *   object) identifies the connection, not the transaction. It is recorded as
 *   the token of the transaction the engine holds open on that connection
 *   ({@link runConnectionNativeTransaction}), a new object per transaction
 *   that the engine drops when it ends. Bound outside such a transaction (a
 *   caller adopting the database object around a BEGIN of its own), nothing
 *   is recorded: the engine cannot tell one of those transactions from the
 *   next.
 *
 * A backend nothing recorded (a hand-written backend, or one bound by another
 * copy of this package) resolves to `undefined`, and the Store keeps its
 * state per binding, as it did before the record existed.
 */
import { backendDerivationChain } from "./derive-backend";

/**
 * What a bound backend's native handle identifies: one native transaction
 * (a driver transaction object, one per BEGIN), or the connection a
 * transaction runs on.
 */
export type NativeHandleScope = "transaction" | "connection";

/** Bound transaction backend → the native transaction it runs on. */
const BOUND_NATIVE_TRANSACTIONS = new WeakMap<object, object>();

/**
 * Connection → the tokens of the transactions the engine holds open on it,
 * innermost last. An entry lives only for the span of
 * {@link runConnectionNativeTransaction}.
 */
const OPEN_CONNECTION_TRANSACTIONS = new WeakMap<object, readonly object[]>();

/**
 * Records, once per bind, the native transaction `backend` runs on: `handle`
 * itself when it identifies one transaction, or the transaction the engine
 * holds open on the connection `handle` names. Records nothing for a
 * connection the engine holds no transaction open on.
 */
export function recordNativeTransactionHandle(
  backend: object,
  handle: object,
  scope: NativeHandleScope,
): void {
  const nativeTransaction =
    scope === "transaction" ? handle : (
      OPEN_CONNECTION_TRANSACTIONS.get(handle)?.at(-1)
    );
  if (nativeTransaction !== undefined) {
    BOUND_NATIVE_TRANSACTIONS.set(backend, nativeTransaction);
  }
}

/**
 * Runs `run`, the span of one transaction the engine opens on a
 * connection-level handle, with a new token identifying that transaction:
 * every backend bound on `connection` during the span records it. The token
 * is dropped when the span ends, so a backend bound on the connection
 * afterwards does not inherit the transaction that ended.
 */
export async function runConnectionNativeTransaction<T>(
  connection: object,
  run: () => Promise<T>,
): Promise<T> {
  // Carries nothing but its identity.
  const token = Object.freeze({});
  OPEN_CONNECTION_TRANSACTIONS.set(connection, [
    ...(OPEN_CONNECTION_TRANSACTIONS.get(connection) ?? []),
    token,
  ]);
  try {
    return await run();
  } finally {
    // Removes this span's own token wherever it sits, so a span that ends
    // out of order never reinstates a token whose transaction already ended.
    const remaining = (
      OPEN_CONNECTION_TRANSACTIONS.get(connection) ?? []
    ).filter((candidate) => candidate !== token);
    if (remaining.length === 0) {
      OPEN_CONNECTION_TRANSACTIONS.delete(connection);
    } else {
      OPEN_CONNECTION_TRANSACTIONS.set(connection, remaining);
    }
  }
}

/**
 * The native transaction `backend` runs on: the record of the nearest link of
 * its derivation chain that has one, or `undefined` when no link does.
 */
export function resolveNativeTransactionHandle(
  backend: object,
): object | undefined {
  for (const link of backendDerivationChain(backend)) {
    const nativeTransaction = BOUND_NATIVE_TRANSACTIONS.get(link);
    if (nativeTransaction !== undefined) return nativeTransaction;
  }
  return undefined;
}
