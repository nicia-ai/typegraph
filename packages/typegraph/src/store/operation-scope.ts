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
 * Only this module may produce an {@link OperationScoped} value. The brand key
 * is a declared-only unique symbol that is not exported, so no other module
 * can spell it: building a branded value from an object literal, a computed
 * key, `satisfies` or a module augmentation is a type error. TypeScript
 * cannot refuse an assertion to a subtype, so the remaining routes (`as`,
 * `as never`, a generic instantiated to the brand, a type predicate, an
 * overload, `declare`, a widened consumer) are found by the checker-backed
 * scan in `tests/operation-scope-ratchet.test.ts`, which identifies the brand
 * by this key rather than by a type name and pins its sites in `src` to the
 * two mints below. ESLint's `OPERATION_BRAND_RESTRICTIONS` reports the
 * spellings a selector can see before the test runs.
 */
import type { GraphBackend, TransactionBackend } from "../backend/types";

// Declared only and never exported: the brand cannot be spelled outside this
// module. The ratchet test asserts both properties.
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
