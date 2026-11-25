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
 *   object) identifies the connection, not the transaction. A transaction the
 *   engine opens on such a connection is identified by a token of its own
 *   ({@link createNativeTransactionToken}): the opener records it on its own
 *   bind, and publishes it on the connection
 *   ({@link publishConnectionNativeTransaction}) only once the transaction has
 *   begun and only until it ends, so a bind on that connection in between
 *   records it. A BEGIN that fails never publishes. Bound outside such a span
 *   (a caller adopting the database object around a BEGIN of its own),
 *   nothing is recorded: the engine cannot tell one of those transactions
 *   from the next.
 *
 * The dialect decides which kind a handle is, and names the connection a
 * connection-level handle runs on, with the same brand check its adoption
 * boundary uses and the same connection identity its serialized-resource
 * audit uses.
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
 * Connection → the tokens of the transactions the engine has begun on it and
 * not yet ended, innermost last. An entry lives only for the span of
 * {@link publishConnectionNativeTransaction}.
 */
const OPEN_CONNECTION_TRANSACTIONS = new WeakMap<object, readonly object[]>();

/**
 * Records, once per bind, the native transaction `backend` runs on: `handle`
 * itself when it identifies one transaction (a driver transaction object, or
 * a token from {@link createNativeTransactionToken}), or the transaction the
 * engine has published on the connection `handle` names. Records nothing for
 * a connection with no published transaction.
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
 * A new identity for one transaction the engine is about to open on a
 * connection-level handle. Carries nothing but its identity.
 */
export function createNativeTransactionToken(): object {
  return Object.freeze({});
}

/**
 * Runs `run` with `token` published on `connection`: every backend bound on
 * the connection during the span records it. Call it once the transaction
 * `token` identifies has begun, around the work that runs inside it; the
 * token is withdrawn when `run` settles, so a backend bound on the
 * connection afterwards does not inherit the transaction that ended.
 */
export async function publishConnectionNativeTransaction<T>(
  connection: object,
  token: object,
  run: () => Promise<T>,
): Promise<T> {
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
