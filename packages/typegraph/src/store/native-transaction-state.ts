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
 * from async context. A transaction whose backend recorded nothing (a
 * hand-written backend, one bound by another copy of this package, or a
 * caller-opened transaction on a connection-level handle such as
 * better-sqlite3's database object) gives every session a state of its own:
 * the evidence that two bindings share a transaction is not there, so they
 * are not joined.
 *
 * Lifetime: the registry is keyed by the engine's identity of the native
 * transaction, which is never a connection (a per-BEGIN driver transaction
 * object, or the engine's per-transaction token on a connection-level
 * handle), and holds it weakly. A state is therefore dropped once the
 * transaction's identity and its last session are, and a later transaction
 * on the same connection never resolves an earlier one's state.
 *
 * What it holds: whether TypeGraph has a read-only scope open on the
 * transaction ({@link runInReadOnlyScope}, {@link isNativeTransactionReadOnly}).
 */
import { resolveNativeTransactionHandle } from "../backend/native-transaction-handle";

// Module-private: only this module builds a state, so no other value (a
// session, an operation, an empty literal) is assignable to one.
const NATIVE_TRANSACTION_STATE: unique symbol = Symbol(
  "typegraph.nativeTransactionState",
);

// Module-private: only `runInReadOnlyScope` writes it and only
// `isNativeTransactionReadOnly` reads it.
const READ_ONLY_SCOPES: unique symbol = Symbol(
  "typegraph.nativeTransactionReadOnlyScopes",
);

/** State every session of one native transaction shares. */
export type NativeTransactionState = Readonly<{
  [NATIVE_TRANSACTION_STATE]: true;
}> & {
  /**
   * How many read-only scopes TypeGraph has open on the transaction
   * ({@link runInReadOnlyScope}). Written only by this module.
   */
  [READ_ONLY_SCOPES]: number;
};

function createNativeTransactionState(): NativeTransactionState {
  return { [NATIVE_TRANSACTION_STATE]: true, [READ_ONLY_SCOPES]: 0 };
}

/** The engine's identity of a native transaction → its sessions' state. */
const nativeTransactionStates = new WeakMap<object, NativeTransactionState>();

/** The state of the native transaction the engine identified, created once. */
function stateOfNativeTransaction(
  nativeTransaction: object,
): NativeTransactionState {
  const existing = nativeTransactionStates.get(nativeTransaction);
  if (existing !== undefined) return existing;
  const created = createNativeTransactionState();
  nativeTransactionStates.set(nativeTransaction, created);
  return created;
}

/**
 * The state of the native transaction `transaction` runs on, created by the
 * first session that asks; a state of its own when the engine recorded no
 * native transaction for `transaction` or any backend it derives from.
 */
export function resolveNativeTransactionState(
  transaction: object,
): NativeTransactionState {
  const nativeTransaction = resolveNativeTransactionHandle(transaction);
  return nativeTransaction === undefined ?
      createNativeTransactionState()
    : stateOfNativeTransaction(nativeTransaction);
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
      stateOfNativeTransaction(nativeTransaction)
    );
}

/**
 * Runs `run` as a read-only scope of the native transaction `state` belongs
 * to. The opener of `store.transaction(fn, { accessMode: "read_only" })`
 * runs its attempt here, so every session over the same native transaction
 * (the opener's own context, a context adopted over `tx.sql`, a Store over a
 * backend built on that handle, a savepoint the engine opened in it) reads
 * the transaction as read-only through {@link isNativeTransactionReadOnly}
 * until `run` settles.
 *
 * The fact is a scope, not a property set for the transaction's life: a
 * read-only `store.transaction` on a backend built over a caller's
 * transaction runs as a savepoint of that transaction, which is read-write
 * again once the savepoint's callback settles. Scopes nest; the transaction
 * reads as read-only until the last one settles.
 */
export async function runInReadOnlyScope<T>(
  state: NativeTransactionState,
  run: () => Promise<T>,
): Promise<T> {
  state[READ_ONLY_SCOPES] += 1;
  try {
    return await run();
  } finally {
    state[READ_ONLY_SCOPES] -= 1;
  }
}

/**
 * THE read-only predicate of a transaction session: whether the native
 * transaction `state` belongs to runs inside a read-only scope TypeGraph
 * opened ({@link runInReadOnlyScope}). Every write that refuses for read-only
 * access (`refuseReadOnlyTransactionWrite`) asks it at the write, so the
 * answer follows the transaction, not the moment a context was built. A
 * native read-only transaction TypeGraph did not open has no scope here: the
 * engine decides.
 */
export function isNativeTransactionReadOnly(
  state: NativeTransactionState,
): boolean {
  return state[READ_ONLY_SCOPES] > 0;
}
