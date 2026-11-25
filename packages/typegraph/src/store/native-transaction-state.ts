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
 * It holds nothing yet: state moves onto it in later changes.
 */
import { resolveNativeTransactionHandle } from "../backend/native-transaction-handle";

// Module-private: only this module builds a state, so no other value (a
// session, an operation, an empty literal) is assignable to one.
const NATIVE_TRANSACTION_STATE: unique symbol = Symbol(
  "typegraph.nativeTransactionState",
);

/** State every session of one native transaction shares. Empty so far. */
export type NativeTransactionState = Readonly<{
  [NATIVE_TRANSACTION_STATE]: true;
}>;

function createNativeTransactionState(): NativeTransactionState {
  return { [NATIVE_TRANSACTION_STATE]: true };
}

/** The engine's identity of a native transaction → its sessions' state. */
const nativeTransactionStates = new WeakMap<object, NativeTransactionState>();

/**
 * The state of the native transaction `transaction` runs on, created by the
 * first session that asks; a state of its own when the engine recorded no
 * native transaction for `transaction` or any backend it derives from.
 */
export function resolveNativeTransactionState(
  transaction: object,
): NativeTransactionState {
  const nativeTransaction = resolveNativeTransactionHandle(transaction);
  if (nativeTransaction === undefined) return createNativeTransactionState();
  const existing = nativeTransactionStates.get(nativeTransaction);
  if (existing !== undefined) return existing;
  const created = createNativeTransactionState();
  nativeTransactionStates.set(nativeTransaction, created);
  return created;
}
