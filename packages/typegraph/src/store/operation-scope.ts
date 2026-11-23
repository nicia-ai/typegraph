/**
 * Operation-scoped statement targets.
 *
 * Store code (everything outside `src/backend`, the engine) never holds the
 * engine's transaction type. Where a transaction is opened or joined it
 * receives a {@link StoreTransactionBackend}: identity and SQL compilation,
 * no statement member. A statement inside a transaction is issued only
 * through an {@link OperationBackend}, and a Store function that issues
 * statements declares its target as one (or as {@link StatementBackend},
 * which also admits the pooled root). A transaction backend becomes a handle
 * only by passing through one of this module's mints — {@link enterOperation}
 * at a public Store member, {@link scopeWriteFrameTarget} where the write
 * executor hands row work its target, or the transitional
 * {@link legacyTransactionOperation} — so every call path into statement work
 * is visible at a mint. `tests/operation-scope-ratchet.test.ts` also scans
 * Store code for any value still typed as the engine transaction: the
 * declarations whose type the public API spells are listed there, and
 * nothing else may appear.
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
 * mints below. ESLint's `OPERATION_BRAND_RESTRICTIONS` reports the
 * spellings a selector can see before the test runs.
 */
import type {
  BackendIdentity,
  GraphBackend,
  SqlCompilationBackend,
  TransactionBackend,
} from "../backend/types";

// Declared only and never exported: the brand cannot be spelled outside this
// module. The ratchet test asserts both properties.
declare const OPERATION_SCOPED: unique symbol;

// Declared only and never exported, like the brand key: the phantom that
// records a Store transaction's engine type cannot be read or spelled outside
// this module.
declare const ENGINE_TRANSACTION: unique symbol;

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
 * A transaction as Store code receives it where the transaction is opened or
 * joined: its identity and SQL compilation, and no statement member. Inside a
 * transaction, Store code issues a statement only through an
 * {@link OperationBackend}, so a statement sent on the raw transaction itself
 * is a type error.
 *
 * The engine's {@link TransactionBackend} (the public name, unchanged) is
 * assignable to this type, so a transaction a backend hands the Store narrows
 * to it without a conversion. The reverse direction exists only as this
 * module's mints.
 *
 * `Engine` records which engine transaction this is — the schema-write
 * transaction (`SchemaWriteTransactionBackend`) and the schema-commit
 * preflight target carry members the plain one lacks — so a mint hands back
 * a handle to THAT type. It is a phantom: an optional property under a
 * module-private key that no value ever has, so every engine transaction of
 * that type is assignable without a conversion, and no other module can read
 * it.
 */
export type StoreTransactionBackend<
  Engine extends TransactionBackend = TransactionBackend,
> = Readonly<
  BackendIdentity &
    SqlCompilationBackend & { readonly [ENGINE_TRANSACTION]?: Engine }
>;

/**
 * TRANSITIONAL: the handle for Store code not yet converted to mint one
 * operation per public call. It mints ONE handle for the whole native
 * transaction, which is how every statement in a transaction ran before
 * handles existed: no admission, no parentage, no per-call rollback unit. What
 * it adds is that each such site is visible and counted —
 * `tests/legacy-transaction-operation-ratchet.test.ts` pins its call sites by
 * the family that will remove them, and each family's conversion lowers that
 * count until this function is deleted.
 *
 * A target that may be the pooled root as well (`GraphBackend |
 * StoreTransactionBackend`) comes back as a {@link StatementBackend}: the
 * root passes through unchanged, the transaction becomes the handle — to its
 * engine type, so a schema-write transaction's handle keeps its DDL members.
 * Returns the same object it is given.
 */
export function legacyTransactionOperation<
  T extends GraphBackend | StoreTransactionBackend,
>(target: T): LegacyOperationTarget<T> {
  // eslint-disable-next-line no-restricted-syntax -- This module is the mint: the transitional whole-transaction handle is asserted here and nowhere else.
  return target as LegacyOperationTarget<T>;
}

/**
 * What {@link legacyTransactionOperation} returns for `T`: a root backend as
 * itself, a transaction as the operation-scoped form of its engine type.
 * Distributes over a union, so `GraphBackend | TransactionBackend` maps to
 * {@link StatementBackend}.
 */
export type LegacyOperationTarget<T> =
  T extends GraphBackend ? GraphBackend
  : T extends TransactionBackend ? OperationScoped<T>
  : T extends StoreTransactionBackend<infer Engine extends TransactionBackend> ?
    OperationScoped<Engine>
  : never;

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
