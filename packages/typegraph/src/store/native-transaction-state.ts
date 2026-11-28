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
 * The one piece of state it holds so far is which handles of the transaction
 * have an engine savepoint unit open on them (`root-savepoint-units.ts`).
 */
import {
  type NativeHandle,
  resolveNativeTransactionHandle,
  resolveNativeTransactionOfHandle,
} from "../backend/native-transaction-handle";

// Module-private: only this module builds a state, so no other value (a
// session, an operation, an empty literal) is assignable to one.
const NATIVE_TRANSACTION_STATE: unique symbol = Symbol(
  "typegraph.nativeTransactionState",
);

/** State every session of one native transaction shares. */
export type NativeTransactionState = Readonly<{
  [NATIVE_TRANSACTION_STATE]: true;
  /**
   * The handles of this transaction (the caller's transaction object, or a
   * savepoint of it) on which an engine built over that handle holds a
   * savepoint unit open, one entry per open unit. Written only by
   * `root-savepoint-units.ts`.
   */
  engineSavepointLevels: object[];
}>;

function createNativeTransactionState(): NativeTransactionState {
  return { [NATIVE_TRANSACTION_STATE]: true, engineSavepointLevels: [] };
}

/** The engine's identity of a native transaction → its sessions' state. */
const nativeTransactionStates = new WeakMap<object, NativeTransactionState>();

/** The state of `nativeTransaction`, or a state of its own without one. */
function stateOfNativeTransaction(
  nativeTransaction: object | undefined,
): NativeTransactionState {
  if (nativeTransaction === undefined) return createNativeTransactionState();
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
  return stateOfNativeTransaction(resolveNativeTransactionHandle(transaction));
}

/**
 * The state of the native transaction the driver handle `handle` runs in, as
 * its dialect classified it: for an engine built over a caller's transaction
 * handle. A state of its own when the handle proves no native transaction.
 */
export function resolveNativeTransactionStateOfHandle(
  handle: NativeHandle,
): NativeTransactionState {
  return stateOfNativeTransaction(resolveNativeTransactionOfHandle(handle));
}
