/**
 * The one owner of "the native transaction handle is leaving TypeGraph's
 * hands".
 *
 * A transaction TypeGraph opens is ended or replaced behind its back only by
 * statements sent through the adapter-native handle (`tx.sql`, the second
 * argument of a `transactionWithNative` callback): TypeGraph issues no
 * `COMMIT`, `ROLLBACK` or `BEGIN` of its own inside the transaction. The
 * backend that opened the transaction therefore needs to know the moment the
 * handle escapes, and no earlier: a transaction whose handle never escaped
 * pays nothing for evidence it cannot need (see
 * `drizzle/execution/postgres-commit-outcome.ts`).
 *
 * Every path that hands the native handle of a TypeGraph-opened transaction
 * to code TypeGraph does not own returns it through
 * {@link releaseNativeTransaction}, which runs whatever the opening backend
 * registered for that handle — synchronously, before the caller can send
 * anything through it. A handle nothing registered (a SQLite transaction, an
 * adopted caller-owned transaction, a savepoint on an enclosing transaction)
 * is returned unchanged.
 */

import {
  INTERNAL_DEFERRED_NATIVE_HANDLE,
  type InternalTransactionOptions,
} from "./types";

/** Runs, synchronously, when the native handle it is registered for is released. */
export type NativeTransactionRelease = () => void;

const RELEASES = new WeakMap<object, NativeTransactionRelease>();

/** Registers what releasing `nativeTransaction` must do first. */
export function registerNativeTransactionRelease(
  nativeTransaction: object,
  release: NativeTransactionRelease,
): void {
  RELEASES.set(nativeTransaction, release);
}

/**
 * Returns `nativeTransaction` to code TypeGraph does not own, after running
 * the release its opening backend registered.
 */
export function releaseNativeTransaction<T>(nativeTransaction: T): T {
  if (
    (typeof nativeTransaction === "object" && nativeTransaction !== null) ||
    typeof nativeTransaction === "function"
  ) {
    RELEASES.get(nativeTransaction)?.();
  }
  return nativeTransaction;
}

/**
 * `options` for a `transactionWithNative` call whose caller keeps the native
 * handle to itself and releases it only if and when it hands it on.
 */
export function deferNativeHandle(
  options: InternalTransactionOptions | undefined,
): InternalTransactionOptions {
  return { ...options, nativeHandle: INTERNAL_DEFERRED_NATIVE_HANDLE };
}

/**
 * The native handle a `transactionWithNative` callback receives: released
 * now, unless the caller deferred the release ({@link deferNativeHandle}).
 */
export function nativeHandleForCallback<T>(
  nativeTransaction: T,
  options: InternalTransactionOptions | undefined,
): T {
  return options?.nativeHandle === INTERNAL_DEFERRED_NATIVE_HANDLE ?
      nativeTransaction
    : releaseNativeTransaction(nativeTransaction);
}
