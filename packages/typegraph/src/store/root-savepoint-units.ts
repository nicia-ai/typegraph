/**
 * The savepoint units of an engine built over a caller's transaction.
 *
 * A backend built over a transaction the caller owns
 * (`createPostgresTransactionBackend(tx)`, or a SQLite backend over a Drizzle
 * transaction handle) cannot BEGIN: every transaction it opens for a Store
 * call is a savepoint on the caller's transaction handle. Every Store call on
 * such a backend that writes opens one, and each call opens its own
 * transaction session, so the refusals a session enforces between its own
 * calls (`operation-scope.ts`) never see two such calls side by side.
 *
 * The savepoint is still a unit of the caller's native transaction: anything
 * issued on the same handle while it is open runs inside it, and is rolled
 * back with it. A second call's savepoint nests inside the first; a read
 * reads the first call's uncommitted writes. So while one call holds an
 * engine savepoint open on a handle, another call on that handle is refused
 * before it issues any statement, with a {@link TransactionCallRefusedError}
 * (`"savepoint-open"`): when it would open its own savepoint, and when it
 * would issue a statement of its own on the handle. Nothing is queued: the
 * call that holds the unit may be awaiting the refused one.
 *
 * The bookkeeping belongs to the native transaction
 * ({@link NativeTransactionState.engineSavepointLevels}), so every backend
 * built over the same handle sees the same units. It is kept per handle: the
 * work a unit composes on its own savepoint handle (an engine built over the
 * savepoint, a savepoint nested in it) runs inside the unit and is not
 * refused. A handle that proves no native transaction gets a state of its
 * own, and its units refuse nothing.
 *
 * Statements the caller issues on its own transaction handle are not
 * TypeGraph calls and pass through no TypeGraph code, so they are never
 * refused: one issued while a unit is open runs inside its savepoint.
 */
import type { NativeHandle } from "../backend/native-transaction-handle";
import { TransactionCallRefusedError } from "../errors";
import { resolveNativeTransactionStateOfHandle } from "./native-transaction-state";

/**
 * THE decision of whether an engine built over `handle` may start a
 * statement or a savepoint on it now: refused while a unit is open on that
 * handle.
 */
function engineSavepointRefusal(
  levels: readonly object[],
  handle: NativeHandle,
): TransactionCallRefusedError | undefined {
  return levels.includes(handle.handle) ?
      new TransactionCallRefusedError("savepoint-open")
    : undefined;
}

/**
 * The refusal of a statement an engine built over `handle` is about to issue
 * on it directly (not through a savepoint of its own): a
 * {@link TransactionCallRefusedError} (`"savepoint-open"`) while another
 * call's savepoint unit is open on the handle, `undefined` otherwise.
 */
export function rootStatementRefusal(
  handle: NativeHandle,
): TransactionCallRefusedError | undefined {
  return engineSavepointRefusal(
    resolveNativeTransactionStateOfHandle(handle).engineSavepointLevels,
    handle,
  );
}

/**
 * Runs `open`, which opens one savepoint on `handle` and runs a Store call's
 * work in it, as a unit of the handle's native transaction. Refused with a
 * {@link TransactionCallRefusedError} (`"savepoint-open"`), before `open` is
 * called, while another unit is open on the handle. The check and the
 * registration happen synchronously, at the call, so of two calls started
 * side by side exactly one opens its savepoint.
 */
export async function runRootSavepointUnit<T>(
  handle: NativeHandle,
  open: () => Promise<T>,
): Promise<T> {
  const levels =
    resolveNativeTransactionStateOfHandle(handle).engineSavepointLevels;
  const refusal = engineSavepointRefusal(levels, handle);
  if (refusal !== undefined) throw refusal;
  levels.push(handle.handle);
  try {
    return await open();
  } finally {
    levels.splice(levels.lastIndexOf(handle.handle), 1);
  }
}
