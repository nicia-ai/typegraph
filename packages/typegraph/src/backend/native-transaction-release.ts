/**
 * The one owner of "the native transaction handle is leaving TypeGraph's
 * hands".
 *
 * A transaction TypeGraph opens is ended or replaced behind its back only by
 * statements TypeGraph does not issue: those sent through the adapter-native
 * handle (`tx.sql`, the second argument of a `transactionWithNative`
 * callback) and any other port that forwards a caller's SQL text verbatim
 * (a schema write's `executeSchemaDdl`, handed to a preflight or to the
 * callback of the public `schemaWriteTransaction`). TypeGraph issues no `COMMIT`,
 * `ROLLBACK` or `BEGIN` of its own inside the transaction. The backend that
 * opened the transaction therefore needs to know the moment control escapes,
 * and no earlier: a transaction whose handle never escaped pays nothing for
 * evidence it cannot need (see `drizzle/execution/postgres-commit-outcome.ts`).
 *
 * Once control has escaped, the attempt is never retried automatically: an
 * aborted PostgreSQL transaction cannot be queried, so nothing TypeGraph can
 * read proves that the transaction which failed is the one it opened rather
 * than one the caller began after committing it.
 *
 * Every path that hands the native handle of a TypeGraph-opened transaction
 * to code TypeGraph does not own returns it through
 * {@link releaseNativeTransaction}, which runs whatever the opening backend
 * registered for that handle — synchronously, before the caller can send
 * anything through it. A handle nothing registered (a SQLite transaction, an
 * adopted caller-owned transaction, a savepoint on an enclosing transaction)
 * is returned unchanged.
 *
 * The registration is a non-enumerable property under a process-wide symbol
 * on the native transaction object itself, the mechanism the Store's runtime
 * ports use: a Store loaded from one copy of this package and an adapter
 * loaded from another must agree on it, exactly as they already agree on
 * the deferral token ({@link INTERNAL_DEFERRED_NATIVE_HANDLE}).
 */

import { typeGraphGlobalSymbol } from "../utils/global-symbol";
import {
  INTERNAL_DEFERRED_NATIVE_HANDLE,
  type InternalSchemaWriteTransactionOptions,
  type InternalTransactionOptions,
} from "./types";

/**
 * What the backend that opened a transaction does when control of it
 * escapes. A cross-instance contract: every member is called by whichever
 * copy of this package holds the handle, so it may only grow.
 */
export type NativeTransactionReleasePort = Readonly<{
  /** Runs, synchronously, when the native handle is released. */
  release: () => void;
  /**
   * Called with the `SAVEPOINT` statement of a savepoint of TypeGraph's own
   * as TypeGraph is about to send it on the transaction. Returns what to run
   * right after TypeGraph rolls back to that savepoint: evidence the release
   * placed inside the savepoint is undone by the rollback, and is restored
   * there.
   */
  guardSavepoint: (savepointStatement: string) => () => void;
}>;

const NATIVE_TRANSACTION_RELEASE: unique symbol = typeGraphGlobalSymbol(
  "native-transaction-release-v1",
);

function isObjectLike(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function releasePortOf(
  nativeTransaction: unknown,
): NativeTransactionReleasePort | undefined {
  if (!isObjectLike(nativeTransaction)) return undefined;
  const port: unknown = Reflect.get(
    nativeTransaction,
    NATIVE_TRANSACTION_RELEASE,
  );
  return isObjectLike(port) ?
      (port as NativeTransactionReleasePort)
    : undefined;
}

/**
 * Registers what releasing `nativeTransaction` must do first. Returns `false`
 * when the object cannot carry the registration (it is frozen or already
 * registered); the caller must then treat control as released from the
 * start, since nothing would tell it when the handle escapes.
 */
export function registerNativeTransactionRelease(
  nativeTransaction: object,
  port: NativeTransactionReleasePort,
): boolean {
  return Reflect.defineProperty(nativeTransaction, NATIVE_TRANSACTION_RELEASE, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: port,
  });
}

/**
 * Returns `nativeTransaction` to code TypeGraph does not own, after running
 * the release its opening backend registered.
 */
export function releaseNativeTransaction<T>(nativeTransaction: T): T {
  releasePortOf(nativeTransaction)?.release();
  return nativeTransaction;
}

/**
 * What to run right after TypeGraph rolls back a savepoint it is opening now
 * on `nativeTransaction`; `undefined` when nothing registered for it.
 */
export function guardNativeTransactionSavepoint(
  nativeTransaction: unknown,
  savepointStatement: string,
): (() => void) | undefined {
  return releasePortOf(nativeTransaction)?.guardSavepoint(savepointStatement);
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

/**
 * `schemaWriteTransaction` options for a TypeGraph-owned callback that sends
 * only DDL TypeGraph generated: its `executeSchemaDdl` releases nothing.
 */
export function ownSchemaDdl(): InternalSchemaWriteTransactionOptions {
  return { nativeHandle: INTERNAL_DEFERRED_NATIVE_HANDLE };
}

/** Whether a `schemaWriteTransaction` caller sends only TypeGraph's own DDL. */
export function sendsOwnSchemaDdl(
  options: InternalSchemaWriteTransactionOptions | undefined,
): boolean {
  return options?.nativeHandle === INTERNAL_DEFERRED_NATIVE_HANDLE;
}
