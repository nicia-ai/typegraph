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
  connectionReadOnlyScopeGraph,
  engineTransactionConnection,
  holdConnectionReadOnlyScope,
  isEngineTransactionToken,
  resolveNativeTransactionConnection,
  resolveNativeTransactionHandle,
} from "../backend/native-transaction-handle";
import { UnsupportedBackendCapabilityError } from "../errors";

// Module-private: only this module builds a state, so no other value (a
// session, an operation, an empty literal) is assignable to one.
const NATIVE_TRANSACTION_STATE: unique symbol = Symbol(
  "typegraph.nativeTransactionState",
);

// Module-private: only `openReadOnlyScope` writes it and only
// `nativeTransactionReadOnlyScopeGraph` reads it.
const READ_ONLY_SCOPES: unique symbol = Symbol(
  "typegraph.nativeTransactionReadOnlyScopes",
);

// Module-private: only `resolveNativeTransactionState` writes it, and only
// `openReadOnlyScope` and `nativeTransactionReadOnlyScopeGraph` read it.
const CONNECTION: unique symbol = Symbol(
  "typegraph.nativeTransactionConnection",
);

// Module-private: only `createNativeTransactionState` writes it, and only
// `nativeTransactionReadOnlyScopeGraph` reads it.
const ENGINE_OPENED: unique symbol = Symbol(
  "typegraph.nativeTransactionEngineOpened",
);

/** State every session of one native transaction shares. */
export type NativeTransactionState = Readonly<{
  [NATIVE_TRANSACTION_STATE]: true;
}> & {
  /**
   * The graph of each read-only scope TypeGraph has open on the transaction,
   * innermost last ({@link openReadOnlyScope}). Written only by this module.
   */
  [READ_ONLY_SCOPES]: readonly string[];
  /**
   * The driver connection the transaction's sessions run on, once a binding
   * that names one resolves the state. Written only by this module.
   */
  [CONNECTION]: object | undefined;
  /**
   * Whether the transaction is one the engine opened and minted a token for
   * (`isEngineTransactionToken`): every session of it is proven to run in it,
   * so its own scopes answer the read-only question and the connection is
   * not consulted.
   */
  readonly [ENGINE_OPENED]: boolean;
};

function createNativeTransactionState(
  connection: object | undefined,
  engineOpened: boolean,
): NativeTransactionState {
  return {
    [NATIVE_TRANSACTION_STATE]: true,
    [READ_ONLY_SCOPES]: [],
    [CONNECTION]: connection,
    [ENGINE_OPENED]: engineOpened,
  };
}

/**
 * How many read-only scopes are open in this process, on any transaction
 * ({@link openReadOnlyScope}): while none is, no backend or session is
 * read-only, and {@link backendReadOnlyScopeGraph} answers without resolving
 * anything. The read-only write gate asks it on every write member call.
 */
const openScopes = { count: 0 };

/** The engine's identity of a native transaction → its sessions' state. */
const nativeTransactionStates = new WeakMap<object, NativeTransactionState>();

/**
 * The state of the native transaction the engine identified, created once.
 * A transaction the engine opened knows its connection from its token; a
 * state first resolved by a binding that names no connection learns it from
 * the first one that does, so a scope opened after that holds the connection.
 */
function stateOfNativeTransaction(
  nativeTransaction: object,
  connection: object | undefined,
): NativeTransactionState {
  const existing = nativeTransactionStates.get(nativeTransaction);
  if (existing !== undefined) {
    existing[CONNECTION] ??= connection;
    return existing;
  }
  const engineOpened = isEngineTransactionToken(nativeTransaction);
  const created = createNativeTransactionState(
    engineOpened ? engineTransactionConnection(nativeTransaction) : connection,
    engineOpened,
  );
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
      createNativeTransactionState(connection, false)
    : stateOfNativeTransaction(nativeTransaction, connection);
}

/**
 * The state of the caller's native transaction a Store's own backend runs
 * inside (a backend built over a transaction handle, such as
 * `createPostgresTransactionBackend(tx.sql)`), or `undefined` for a backend
 * the engine recorded no native transaction for (one over a database or a
 * pool).
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
 * THE read-only question of a backend object: the graph of the innermost
 * read-only scope TypeGraph has open on what `backend` runs its statements
 * in, or `undefined` when there is none. That is the native transaction the
 * engine recorded for `backend` (a transaction backend, a backend built over
 * a caller's transaction handle, or one built over a connection while a
 * transaction the engine opened is published on it), and otherwise, for a
 * bind of a handle nothing proved, the driver connection the handle runs on,
 * since a connection runs one transaction at a time. A root backend over a
 * database or a pool is neither: it is never read-only here, whatever its
 * connection runs.
 */
export function backendReadOnlyScopeGraph(backend: object): string | undefined {
  if (openScopes.count === 0) return undefined;
  const native = resolveBackendNativeTransactionState(backend);
  if (native !== undefined) return nativeTransactionReadOnlyScopeGraph(native);
  const connection = resolveNativeTransactionConnection(backend);
  return connection === undefined ? undefined : (
      connectionReadOnlyScopeGraph(connection)
    );
}

/**
 * Whether `backend` runs inside a read-only scope TypeGraph opened
 * ({@link backendReadOnlyScopeGraph}).
 */
export function isBackendNativeTransactionReadOnly(backend: object): boolean {
  return backendReadOnlyScopeGraph(backend) !== undefined;
}

/**
 * Opens a read-only scope for the graph `graphId` on the native transaction
 * `state` belongs to, until the returned release is called (a second call
 * does nothing). The opener of
 * `store.transaction(fn, { accessMode: "read_only" })` opens one once its
 * attempt's session exists and releases it once the backend's transaction
 * call has settled, after its `COMMIT`, `ROLLBACK` or `RELEASE`, so every
 * session over the same native transaction (the opener's own context, a
 * context adopted over `tx.sql`, a Store over a backend built on that handle,
 * a savepoint the engine opened in it) reads the transaction as read-only
 * through {@link isNativeTransactionReadOnly}, and every backend object over
 * it refuses its write members (`read-only-write-gate.ts`), for as long as
 * anything can still reach it, a write left floating after the callback
 * settled included. The connection the transaction runs on holds the scope
 * too, for as long, for a bind of a handle nothing proved.
 *
 * The fact is a scope, not a property set for the transaction's life: a
 * read-only `store.transaction` on a backend built over a caller's
 * transaction runs as a savepoint of that transaction, which is read-write
 * again once the savepoint is released. That savepoint is read-write at the
 * engine (the caller's transaction keeps its own access mode), so the scope
 * is what refuses TypeGraph's writes there, and it is opened only by the
 * `store.transaction` a caller asked to be read-only: TypeGraph's own
 * read-only units (an export's snapshot, a confirm read, an algorithm's
 * working table) open none. Scopes nest; the transaction reads as read-only
 * until the last one is released.
 */
export function openReadOnlyScope(
  state: NativeTransactionState,
  graphId: string,
): () => void {
  const connection = state[CONNECTION];
  state[READ_ONLY_SCOPES] = [...state[READ_ONLY_SCOPES], graphId];
  openScopes.count += 1;
  const releaseConnection =
    connection === undefined ? undefined : (
      holdConnectionReadOnlyScope(connection, graphId)
    );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openScopes.count -= 1;
    const scopes = state[READ_ONLY_SCOPES];
    const index = scopes.lastIndexOf(graphId);
    if (index !== -1) state[READ_ONLY_SCOPES] = scopes.toSpliced(index, 1);
    releaseConnection?.();
  };
}

/**
 * The graph of the innermost read-only scope TypeGraph opened on the native
 * transaction `state` belongs to, or, for a transaction the engine did not
 * open, on the driver connection it runs on; `undefined` when there is none.
 * A transaction the engine opened is proven by its token, so another
 * transaction's scope on the same connection never applies to it.
 */
function nativeTransactionReadOnlyScopeGraph(
  state: NativeTransactionState,
): string | undefined {
  const own = state[READ_ONLY_SCOPES].at(-1);
  if (own !== undefined || state[ENGINE_OPENED]) return own;
  const connection = state[CONNECTION];
  return connection === undefined ? undefined : (
      connectionReadOnlyScopeGraph(connection)
    );
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
 * on a driver that reports no transaction state, or a caller savepoint on the
 * same pooled client. A session of a transaction the engine opened is proven
 * by its token and reads only its own transaction's scopes.
 */
export function isNativeTransactionReadOnly(
  state: NativeTransactionState,
): boolean {
  return nativeTransactionReadOnlyScopeGraph(state) !== undefined;
}

/**
 * The one refusal for an operation that needs write access inside
 * `store.transaction(fn, { accessMode: "read_only" })`. Callers raise it
 * before the operation issues any statement, so the engine never reports its
 * own read-only error and the caller's transaction stays usable.
 */
export function refuseReadOnlyTransactionWrite(
  operation: string,
  graphId: string,
  suggestion: string,
): never {
  throw new UnsupportedBackendCapabilityError(
    operation,
    "write transaction access",
    { graphId, accessMode: "read_only" },
    suggestion,
  );
}
