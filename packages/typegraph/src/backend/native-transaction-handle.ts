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
 *   ({@link publishConnectionNativeTransaction}) from the moment its BEGIN
 *   has succeeded until its COMMIT or ROLLBACK has finished, so a bind on
 *   that connection in between records it. A BEGIN that fails never
 *   publishes. Bound outside such a span (a caller adopting the database
 *   object around a BEGIN of its own), nothing is recorded: the engine cannot
 *   tell one of those transactions from the next.
 * - A transaction the engine has published on a connection is the one every
 *   handle on that connection runs in, a transaction object included: a
 *   connection runs one transaction at a time, so a Drizzle transaction
 *   object bound on it during the span is that transaction or a savepoint
 *   inside it.
 *
 * A backend built over a caller's transaction object
 * (`createPostgresTransactionBackend`, or `createSqliteBackend` over a
 * Drizzle transaction object) is recorded the same way when it is built:
 * every statement it runs, and every savepoint it opens, is in that object's
 * native transaction, so a Store over it can reach the transaction's state
 * before a write of its own opens a savepoint. A backend over a connection is
 * not recorded.
 *
 * A savepoint is never recorded as a transaction of its own when the engine
 * can tell which transaction it is in. Where a nested handle comes from, and
 * what a bind on it records:
 *
 * - The engine opens a savepoint on a transaction handle (the
 *   `transaction()` of a PostgreSQL backend built over a transaction by
 *   `createPostgresTransactionBackend`, or of a SQLite backend in
 *   `transactionMode: "drizzle"` over a transaction object): the enclosing
 *   transaction ({@link recordEngineSavepoint}).
 * - A caller's own nested `transaction()` on a connection where the engine
 *   has published a transaction (better-sqlite3 inside a TypeGraph-owned
 *   transaction): the published transaction, as above.
 * - A caller's own nested `transaction()` on a Drizzle transaction object
 *   (PostgreSQL, libsql, or a caller-opened better-sqlite3 transaction):
 *   Drizzle gives the savepoint a new object and keeps no link to the
 *   enclosing one, and the engine never saw it opened, so the savepoint
 *   object is recorded as itself. Its sessions share one state, distinct
 *   from the enclosing transaction's.
 *
 * The dialect decides which kind a handle is, and names the connection it
 * runs on, with the one transaction-object classifier its adoption
 * boundaries use and the same connection identity its serialized-resource
 * audit uses.
 *
 * A backend nothing recorded (a hand-written backend, or one bound by another
 * copy of this package) resolves to `undefined`, and the Store keeps its
 * state per binding, as it did before the record existed.
 */
import { backendDerivationChain } from "./derive-backend";

/**
 * A bound backend's native handle, as its dialect classifies it: a driver
 * transaction object (one per BEGIN or savepoint), or the connection itself.
 * `connection` names the connection either runs on, where the dialect can.
 */
export type NativeHandle =
  | Readonly<{
      kind: "transaction";
      transaction: object;
      connection?: object | undefined;
    }>
  | Readonly<{ kind: "connection"; connection: object }>;

/** Bound transaction backend → the native transaction it runs on. */
const BOUND_NATIVE_TRANSACTIONS = new WeakMap<object, object>();

/** Savepoint handle the engine opened → the native transaction it is in. */
const ENGINE_SAVEPOINTS = new WeakMap<object, object>();

/**
 * Connection → the tokens of the transactions the engine has begun on it and
 * not yet ended, innermost last. An entry lives only for the span of
 * {@link publishConnectionNativeTransaction}.
 */
const OPEN_CONNECTION_TRANSACTIONS = new WeakMap<object, readonly object[]>();

/**
 * The native transaction `handle` runs in: the transaction the engine has
 * published on its connection; else, for a transaction object, the
 * transaction the engine opened it as a savepoint in, or the object itself;
 * else none.
 */
function identifyNativeTransaction(handle: NativeHandle): object | undefined {
  const published =
    handle.connection === undefined ?
      undefined
    : OPEN_CONNECTION_TRANSACTIONS.get(handle.connection)?.at(-1);
  if (published !== undefined) return published;
  if (handle.kind === "connection") return undefined;
  return ENGINE_SAVEPOINTS.get(handle.transaction) ?? handle.transaction;
}

/**
 * Records, once per bind, the native transaction `backend` runs on (see
 * {@link identifyNativeTransaction}). Records nothing for a connection with
 * no published transaction.
 */
export function recordNativeTransactionHandle(
  backend: object,
  handle: NativeHandle,
): void {
  const nativeTransaction = identifyNativeTransaction(handle);
  if (nativeTransaction !== undefined) {
    BOUND_NATIVE_TRANSACTIONS.set(backend, nativeTransaction);
  }
}

/**
 * Records that the engine opened the savepoint `savepoint` on `enclosing`, so
 * a bind on the savepoint's handle records the native transaction
 * `enclosing` runs in. Call it as Drizzle hands the engine the savepoint's
 * handle, before anything is bound on it.
 */
export function recordEngineSavepoint(
  savepoint: object,
  enclosing: NativeHandle,
): void {
  const nativeTransaction = identifyNativeTransaction(enclosing);
  if (nativeTransaction !== undefined) {
    ENGINE_SAVEPOINTS.set(savepoint, nativeTransaction);
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
 * `token` identifies has begun, around the work that runs inside it AND the
 * COMMIT or ROLLBACK that ends it; the token is withdrawn when `run` settles,
 * so a backend bound on the connection afterwards does not inherit the
 * transaction that ended.
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
