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
 * It holds the exclusive sections running on the transaction
 * ({@link runExclusiveSection}).
 */
import { resolveNativeTransactionHandle } from "../backend/native-transaction-handle";

// Module-private: only this module builds a state, so no other value (a
// session, an operation, an empty literal) is assignable to one.
const NATIVE_TRANSACTION_STATE: unique symbol = Symbol(
  "typegraph.nativeTransactionState",
);

/** State every session of one native transaction shares. */
export type NativeTransactionState = Readonly<{
  [NATIVE_TRANSACTION_STATE]: true;
  /**
   * The operation running each exclusive section on this transaction, by
   * section key: owned by {@link runExclusiveSection}.
   */
  exclusiveSections: Map<string, string>;
}>;

function createNativeTransactionState(): NativeTransactionState {
  return {
    [NATIVE_TRANSACTION_STATE]: true,
    exclusiveSections: new Map<string, string>(),
  };
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

/**
 * THE one owner of running `fn` as the only holder of section `key` on one
 * native transaction. Calls on one transaction share its connection and its
 * snapshot, and a lock the transaction holds excludes other transactions, not
 * other calls on this one: a section whose decision is read and then written
 * (a provenance transition) must not interleave with another holder of the
 * same section. A call that finds the section held is refused with
 * `refuse(runningOperation)` before `fn` runs, so the refused call issues no
 * statement and the transaction stays usable. Refusing rather than queueing
 * keeps a call made from inside a running section (an operation hook fired
 * immediately in an adopted context) from waiting on itself.
 */
export async function runExclusiveSection<T>(
  state: NativeTransactionState,
  section: Readonly<{ key: string; operation: string }>,
  refuse: (runningOperation: string) => Error,
  fn: () => Promise<T>,
): Promise<T> {
  const running = state.exclusiveSections.get(section.key);
  if (running !== undefined) throw refuse(running);
  state.exclusiveSections.set(section.key, section.operation);
  try {
    return await fn();
  } finally {
    state.exclusiveSections.delete(section.key);
  }
}
