/**
 * State shared by every Store session of ONE native transaction.
 *
 * Each adoption of a native transaction binds a new engine transaction
 * backend, so one native transaction has several derivation roots and state
 * keyed by a root is per adoption. A {@link NativeTransactionState} is the one
 * place the sessions of a native transaction can share: the first session
 * opened over that transaction creates it, and every later session of the
 * same transaction resolves the same object (`session.native`).
 *
 * Which native transaction a session runs on is the engine's record
 * (`src/backend/native-transaction-handle.ts`), resolved along the
 * derivation chain of the transaction the session holds; nothing is looked up
 * from async context. State is shared only on the proof that record states:
 * a transaction whose backend recorded none (a hand-written backend, one bound
 * by another copy of this package, a caller-opened transaction on a
 * connection-level handle such as better-sqlite3's database object or a
 * transaction object over it), or whose engine token has ended, gives every
 * session a state of its own.
 *
 * Lifetime: the registry is keyed by the engine's identity of the native
 * transaction, which is never a connection (a per-transaction driver handle,
 * a per-BEGIN driver transaction object, or the engine's per-transaction token
 * on a connection-level handle), and holds it weakly. A state is therefore
 * dropped once the transaction's identity and its last session are, and a
 * token's state is never handed out once its transaction has ended.
 *
 * What it holds: whether TypeGraph has a read-only scope open on the
 * transaction ({@link openReadOnlyScope}, {@link isNativeTransactionReadOnly}),
 * and the driver connection its sessions run on, where the engine recorded
 * one (`resolveNativeTransactionConnection`). A read-only scope is also held
 * by that connection while it is open, so it fails closed for a session on
 * the same connection whose state nothing proved to be this one.
 */
import {
  holdConnectionReadOnlyScope,
  isConnectionInReadOnlyScope,
  resolveNativeTransactionConnection,
  resolveNativeTransactionHandle,
} from "../backend/native-transaction-handle";

// Module-private: only this module builds a state, so no other value (a
// session, an operation, an empty literal) is assignable to one.
const NATIVE_TRANSACTION_STATE: unique symbol = Symbol(
  "typegraph.nativeTransactionState",
);

// Module-private: only `openReadOnlyScope` writes it and only
// `isNativeTransactionReadOnly` reads it.
const READ_ONLY_SCOPES: unique symbol = Symbol(
  "typegraph.nativeTransactionReadOnlyScopes",
);

// Module-private: only `resolveNativeTransactionState` writes it, and only
// `openReadOnlyScope` and `isNativeTransactionReadOnly` read it.
const CONNECTION: unique symbol = Symbol(
  "typegraph.nativeTransactionConnection",
);

/** State every session of one native transaction shares. */
export type NativeTransactionState = Readonly<{
  [NATIVE_TRANSACTION_STATE]: true;
}> & {
  /**
   * How many read-only scopes TypeGraph has open on the transaction
   * ({@link openReadOnlyScope}). Written only by this module.
   */
  [READ_ONLY_SCOPES]: number;
  /**
   * The driver connection the transaction's sessions run on, once a binding
   * that names one resolves the state. Written only by this module.
   */
  [CONNECTION]: object | undefined;
};

function createNativeTransactionState(
  connection: object | undefined,
): NativeTransactionState {
  return {
    [NATIVE_TRANSACTION_STATE]: true,
    [READ_ONLY_SCOPES]: 0,
    [CONNECTION]: connection,
  };
}

/** The engine's identity of a native transaction → its sessions' state. */
const nativeTransactionStates = new WeakMap<object, NativeTransactionState>();

/** The state of the native transaction the engine identified, created once. */
function stateOfNativeTransaction(
  nativeTransaction: object,
  connection: object | undefined,
): NativeTransactionState {
  const existing = nativeTransactionStates.get(nativeTransaction);
  if (existing !== undefined) {
    existing[CONNECTION] ??= connection;
    return existing;
  }
  const created = createNativeTransactionState(connection);
  nativeTransactionStates.set(nativeTransaction, created);
  return created;
}

/**
 * The state of the native transaction `transaction` runs on, created by the
 * first session that asks; a state of its own when the engine recorded no
 * native transaction for `transaction` or any backend it derives from. Either
 * way it knows the driver connection `transaction` runs on, where the engine
 * recorded one, for {@link isNativeTransactionReadOnly} alone.
 */
export function resolveNativeTransactionState(
  transaction: object,
): NativeTransactionState {
  const nativeTransaction = resolveNativeTransactionHandle(transaction);
  const connection = resolveNativeTransactionConnection(transaction);
  return nativeTransaction === undefined ?
      createNativeTransactionState(connection)
    : stateOfNativeTransaction(nativeTransaction, connection);
}

/**
 * The state of the caller's native transaction a Store's own backend runs
 * inside (a backend built over a transaction handle, such as
 * `createPostgresTransactionBackend(tx.sql)`), or `undefined` for a backend
 * the engine recorded no native transaction for (one over a database or a
 * pool). The Store asks it before a write of its own opens the savepoint its
 * session would run in, so the write is refused before any statement.
 */
export function resolveBackendNativeTransactionState(
  backend: object,
): NativeTransactionState | undefined {
  const nativeTransaction = resolveNativeTransactionHandle(backend);
  return nativeTransaction === undefined ? undefined : (
      stateOfNativeTransaction(
        nativeTransaction,
        resolveNativeTransactionConnection(backend),
      )
    );
}

/**
 * Whether a Store's own backend runs inside a caller's native transaction
 * that is inside a read-only scope TypeGraph opened
 * ({@link resolveBackendNativeTransactionState},
 * {@link isNativeTransactionReadOnly}). `false` for a backend over a database
 * or a pool.
 */
export function isBackendNativeTransactionReadOnly(backend: object): boolean {
  const native = resolveBackendNativeTransactionState(backend);
  return native !== undefined && isNativeTransactionReadOnly(native);
}

/**
 * Opens a read-only scope on the native transaction `state` belongs to, until
 * the returned release is called (a second call does nothing). The opener of
 * `store.transaction(fn, { accessMode: "read_only" })` opens one once its
 * attempt's session exists and releases it once the backend's transaction
 * call has settled, after its `COMMIT`, `ROLLBACK` or `RELEASE`, so every
 * session over the same native transaction (the opener's own context, a
 * context adopted over `tx.sql`, a Store over a backend built on that handle,
 * a savepoint the engine opened in it) reads the transaction as read-only
 * through {@link isNativeTransactionReadOnly} for as long as anything can
 * still reach it, a write left floating after the callback settled included.
 * The connection the transaction runs on holds the scope too, for as long.
 *
 * The fact is a scope, not a property set for the transaction's life: a
 * read-only `store.transaction` on a backend built over a caller's
 * transaction runs as a savepoint of that transaction, which is read-write
 * again once the savepoint is released. Scopes nest; the transaction reads
 * as read-only until the last one is released.
 */
export function openReadOnlyScope(state: NativeTransactionState): () => void {
  const connection = state[CONNECTION];
  state[READ_ONLY_SCOPES] += 1;
  const releaseConnection =
    connection === undefined ? undefined : (
      holdConnectionReadOnlyScope(connection)
    );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state[READ_ONLY_SCOPES] -= 1;
    releaseConnection?.();
  };
}

/**
 * THE read-only predicate of a transaction session: whether the native
 * transaction `state` belongs to runs inside a read-only scope TypeGraph
 * opened ({@link openReadOnlyScope}). Every write that refuses for read-only
 * access (`refuseReadOnlyTransactionWrite`) asks it at the write, so the
 * answer follows the transaction, not the moment a context was built. A
 * native read-only transaction TypeGraph did not open has no scope here: the
 * engine decides.
 *
 * It fails closed where nothing proves the transaction: a session also reads
 * as read-only while a read-only scope is open on its driver connection. A
 * connection runs one transaction at a time, so the session's statements run
 * inside that scope's transaction whatever state the session holds: a handle
 * on a driver that reports no transaction state, a context bound in an
 * earlier transaction on the same connection, or a caller savepoint on the
 * same pooled client.
 */
export function isNativeTransactionReadOnly(
  state: NativeTransactionState,
): boolean {
  const connection = state[CONNECTION];
  return (
    state[READ_ONLY_SCOPES] > 0 ||
    (connection !== undefined && isConnectionInReadOnlyScope(connection))
  );
}
