/**
 * The read-only fact of a transaction TypeGraph opened with
 * `accessMode: "read_only"`, bound to the native database session that
 * carries the transaction rather than to any object TypeGraph built over it.
 *
 * `store.transaction(fn, { accessMode: "read_only" })` refuses every write its
 * own context offers (`refuseReadOnlyTransactionWrite`). The same transaction
 * can be reached again through its native handle: `tx.sql` handed to
 * `store.withTransaction()`, `withRecordedTransaction()` or
 * `withEvolvedTransaction()`, or to `createPostgresTransactionBackend()` for a
 * second Store. Each of those builds a NEW context, so a flag held by the
 * first context does not reach it. This module records the fact where every
 * one of those paths can find it: the session object of the native handle.
 *
 * A Drizzle transaction handle is a thin object over a driver session; a
 * savepoint handle (`tx.transaction(...)`) and the handle a SQLite backend
 * hands out for a raw `BEGIN` frame (the root database) share that session.
 * Keying on the session, not on the handle, is what makes every one of those
 * handles answer the same way. A handle with no inspectable session is its own
 * key.
 *
 * The fact lives exactly as long as the transaction: the Store registers it
 * around the transaction callback and removes it when the callback settles,
 * and every reader asks at the moment of the write, so a context retained past
 * its transaction does not keep refusing, and a context built over the
 * session before the read-only transaction opened is refused inside it.
 *
 * A native transaction TypeGraph did not open carries no fact here: a caller's
 * own `db.transaction(fn, { accessMode: "read only" })` adopted through
 * `withTransaction` behaves as before (the engine refuses the write on
 * PostgreSQL, SQLite has no read-only transaction to refuse it).
 */

import { backendDerivationChain } from "./derive-backend";

const readOnlySessionHolds = new WeakMap<object, number>();

type SessionCarrier = Readonly<{
  session?: unknown;
  _?: Readonly<{ session?: unknown }>;
}>;

function isReference(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

/**
 * The native session a transaction handle executes on: the Drizzle handle's
 * session when it exposes one, else the handle itself. `undefined` for a
 * value that cannot key anything.
 */
function nativeTransactionSession(handle: unknown): object | undefined {
  if (!isReference(handle)) return undefined;
  const carrier = handle as SessionCarrier;
  const session = carrier.session ?? carrier._?.session;
  return isReference(session) ? session : handle;
}

/**
 * Runs `run` with the session behind `nativeTransaction` marked read-only, and
 * removes the mark when `run` settles. Holds nest: the mark stays until the
 * last holder settles. With no handle there is nothing another path could
 * adopt, so nothing is marked.
 */
export async function runWithReadOnlySession<T>(
  nativeTransaction: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const session = nativeTransactionSession(nativeTransaction);
  if (session === undefined) return run();
  readOnlySessionHolds.set(
    session,
    (readOnlySessionHolds.get(session) ?? 0) + 1,
  );
  try {
    return await run();
  } finally {
    const remaining = (readOnlySessionHolds.get(session) ?? 1) - 1;
    if (remaining === 0) {
      readOnlySessionHolds.delete(session);
    } else {
      readOnlySessionHolds.set(session, remaining);
    }
  }
}

/**
 * THE read-only decision of a transaction context: read-only when the
 * context's own transaction was opened with `accessMode: "read_only"`
 * (`requested`), or when the native session behind any of
 * `nativeTransactions` belongs to such a transaction right now. A context
 * names every handle it runs inside: its own, and the caller's transaction
 * its Store's backend was built over ({@link backendNativeTransaction}),
 * since a driver may open a savepoint on a session object of its own
 * (postgres-js does). Returned as a question asked at each write, so the
 * answer follows the session's transaction, not the moment the context was
 * built.
 */
export function transactionReadOnlyAccess(
  nativeTransactions: readonly unknown[],
  requested = false,
): () => boolean {
  if (requested) return () => true;
  const sessions = nativeTransactions.flatMap((nativeTransaction) => {
    const session = nativeTransactionSession(nativeTransaction);
    return session === undefined ? [] : [session];
  });
  return () => sessions.some((session) => readOnlySessionHolds.has(session));
}

const backendNativeTransactions = new WeakMap<object, object>();

/**
 * Records that `backend` executes every statement inside `nativeTransaction`,
 * a transaction its caller opened (`createPostgresTransactionBackend`). Every
 * backend derived from it through `derive-backend.ts` resolves to the same
 * handle ({@link backendNativeTransaction}).
 */
export function bindBackendToNativeTransaction(
  backend: object,
  nativeTransaction: object,
): void {
  backendNativeTransactions.set(backend, nativeTransaction);
}

/**
 * The caller's native transaction `backend` was built over
 * ({@link bindBackendToNativeTransaction}), found along its derivation chain;
 * `undefined` for a backend built over a database rather than a transaction.
 * A Store passes it to {@link transactionReadOnlyAccess} for its own writes.
 */
export function backendNativeTransaction(backend: object): object | undefined {
  for (const link of backendDerivationChain(backend)) {
    const nativeTransaction = backendNativeTransactions.get(link);
    if (nativeTransaction !== undefined) return nativeTransaction;
  }
  return undefined;
}

/**
 * THE read-only decision for writes a Store makes on its own backend (its
 * collections, its identity facade, an import into it): read-only exactly
 * while the caller's transaction the backend was built over is one TypeGraph
 * opened read-only. `undefined` for a backend over a database, which no
 * read-only transaction governs.
 */
export function backendOwnWriteReadOnlyAccess(
  backend: object,
): (() => boolean) | undefined {
  const nativeTransaction = backendNativeTransaction(backend);
  return nativeTransaction === undefined ? undefined : (
      transactionReadOnlyAccess([nativeTransaction])
    );
}
