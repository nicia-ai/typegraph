/**
 * Operation-scoped statement targets.
 *
 * A Store function that issues statements on the target it is given can
 * declare that target as {@link StatementBackend} instead of
 * `GraphBackend | TransactionBackend`. What the type guarantees today is one
 * thing: such a function cannot be called with a raw `TransactionBackend`. A
 * transaction backend reaches it only after passing through one of this
 * module's two mints — {@link enterOperation} at a public Store member, or
 * {@link scopeWriteFrameTarget} where the write executor hands row work its
 * target — so every call path into it is visible at a mint.
 *
 * The brand is a phantom: a minted value is the SAME object it was minted
 * from, and minting has no runtime effect. That is deliberate. Store state is
 * keyed by the target object's identity (`writeTransactionSessions`,
 * `heldGraphWriteLocks`, the savepoint-state registry, schema fence leases),
 * and the layers above discriminate a root from a transaction with
 * `"transaction" in target`; a derived object per operation would change both.
 *
 * Only this module may produce an {@link OperationScoped} value. ESLint bans
 * a type assertion to any of these types elsewhere in `src`, and
 * `tests/operation-scope-ratchet.test.ts` pins the assertion sites to the two
 * mints below.
 */
import type { GraphBackend, TransactionBackend } from "../backend/types";

declare const OPERATION_SCOPED: unique symbol;

/** `T` as handed out by an operation mint. */
export type OperationScoped<T extends object> = T &
  Readonly<{ [OPERATION_SCOPED]: "operation" }>;

/** A transaction backend that has passed through an operation mint. */
export type OperationBackend = OperationScoped<TransactionBackend>;

/**
 * What a statement-issuing Store function accepts: a pooled root backend, or
 * a transaction backend that has passed through an operation mint.
 */
export type StatementBackend = GraphBackend | OperationBackend;

/**
 * The mint at a public Store member. A root backend is returned as is; a
 * transaction backend is returned as an {@link OperationBackend}. Both are the
 * same object.
 */
export function enterOperation(
  backend: GraphBackend | TransactionBackend,
): StatementBackend {
  // eslint-disable-next-line no-restricted-syntax -- This module is the mint: the one place a backend may be asserted to the operation brand.
  return backend as StatementBackend;
}

/**
 * The executor's mint for the target it hands row work: the transaction it
 * opened for this write, the root a non-interactive write runs on, or the
 * operation-scoped target it was given. Returns the same object.
 */
export function scopeWriteFrameTarget<T extends object>(
  target: T,
): OperationScoped<T> {
  // eslint-disable-next-line no-restricted-syntax -- This module is the mint: the one place a target may be asserted to the operation brand.
  return target as OperationScoped<T>;
}
