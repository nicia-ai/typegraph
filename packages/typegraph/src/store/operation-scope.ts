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
  AdapterBackend,
  AdoptedSchemaWriteTransaction,
  BackendIdentity,
  GraphBackend,
  SchemaCommitPreflightBackend,
  SchemaWriteTransactionBackend,
  SqlCompilationBackend,
  TransactionBackend,
} from "../backend/types";

// Declared only and never exported: the brand cannot be spelled outside this
// module. The ratchet test asserts both properties.
declare const OPERATION_SCOPED: unique symbol;

// Declared only and never exported, like the brand key: the phantom that
// records a specialised Store transaction's engine type cannot be read,
// spelled or produced outside this module.
declare const ENGINE_TRANSACTION: unique symbol;

/**
 * `T` as handed out by an operation mint. A handle to a specialised engine
 * transaction also carries its {@link EngineRecord}, so the specialisation
 * stays a privilege at the handle too: an ordinary handle is not assignable
 * to `OperationScoped<SchemaCommitPreflightBackend>` even though, member for
 * member, the preflight target is an ordinary transaction.
 */
export type OperationScoped<T extends object> = T &
  Readonly<{ [OPERATION_SCOPED]: "operation" }> &
  EngineRecordOf<T>;

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
 * assignable to the plain form, so a transaction a backend hands the Store
 * narrows to it without a conversion. The reverse direction exists only as
 * this module's mints.
 *
 * `Engine` names a SPECIALISED engine transaction: one with members the plain
 * transaction lacks, such as the schema-write transaction
 * ({@link SchemaWriteTransactionBackend}) or the schema-commit preflight
 * target ({@link SchemaCommitPreflightBackend}). A mint hands back a handle to
 * THAT type, so a specialisation is a privilege: it reaches DDL. It is
 * therefore recorded in a REQUIRED phantom ({@link EngineRecordOf}) under a
 * module-private key that no value has and no other module can spell. No
 * engine transaction is assignable to a specialised form, so annotating an
 * ordinary transaction callback with one is a type error. The only callbacks
 * that receive one are those passed to the members this module's boundary
 * mints return ({@link storeSchemaWriteTransaction},
 * {@link storeCommitSchemaVersionWithPreflight},
 * {@link storeSetActiveVersionWithPreflight}), and the transaction
 * {@link storeAdoptSchemaWriteTransaction}'s member adopts: the engine members
 * that actually open the specialised transaction.
 */
export type StoreTransactionBackend<
  Engine extends TransactionBackend = TransactionBackend,
> = Readonly<BackendIdentity & SqlCompilationBackend & EngineRecordOf<Engine>>;

/**
 * The phantom a specialised {@link StoreTransactionBackend}, or a handle to a
 * specialised engine transaction, carries: the engine transaction it is.
 * Required, so no value lacking it — every value outside this module's mints
 * — satisfies it.
 */
type EngineRecord<Engine extends TransactionBackend> = Readonly<{
  [ENGINE_TRANSACTION]: Engine;
}>;

/**
 * The {@link EngineRecord} `T` carries: one when `T` is an engine
 * transaction with members the plain {@link TransactionBackend} lacks,
 * nothing for the plain transaction, the root, or a statement fragment.
 */
type EngineRecordOf<T> =
  [T] extends [GraphBackend] ? unknown
  : [T] extends [TransactionBackend] ?
    [Exclude<keyof T, keyof TransactionBackend>] extends [never] ?
      unknown
    : EngineRecord<T>
  : unknown;

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
  : T extends EngineRecord<infer Engine extends TransactionBackend> ?
    OperationScoped<Engine>
  : T extends StoreTransactionBackend ? OperationBackend
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

// ---------------------------------------------------------------------------
// Boundary mints: the engine members that open a specialised transaction
// ---------------------------------------------------------------------------

/**
 * The engine's schema-write opener as Store code calls it: the same function,
 * whose callback receives the Store form of the schema-write transaction.
 */
export type StoreSchemaWriteTransaction = <T>(
  graphId: string,
  fn: (
    transaction: StoreTransactionBackend<SchemaWriteTransactionBackend>,
  ) => Promise<T>,
  options?: Parameters<NonNullable<GraphBackend["schemaWriteTransaction"]>>[2],
) => Promise<T>;

/**
 * An engine member that runs a preflight inside the schema-write transaction
 * it opens, as Store code calls it: the same function, whose preflight
 * receives the Store form of the preflight target.
 */
type StoreSchemaPreflightMember<Params, Result> = (
  params: Params,
  preflight: (
    transaction: StoreTransactionBackend<SchemaCommitPreflightBackend>,
  ) => Promise<void>,
) => Promise<Result>;

/** {@link storeCommitSchemaVersionWithPreflight}'s member, as Store code calls it. */
export type StoreCommitSchemaVersionWithPreflight = StoreSchemaPreflightMember<
  Parameters<NonNullable<GraphBackend["commitSchemaVersionWithPreflight"]>>[0],
  Awaited<
    ReturnType<NonNullable<GraphBackend["commitSchemaVersionWithPreflight"]>>
  >
>;

/** {@link storeSetActiveVersionWithPreflight}'s member, as Store code calls it. */
export type StoreSetActiveVersionWithPreflight = StoreSchemaPreflightMember<
  Parameters<NonNullable<GraphBackend["setActiveVersionWithPreflight"]>>[0],
  Awaited<
    ReturnType<NonNullable<GraphBackend["setActiveVersionWithPreflight"]>>
  >
>;

/**
 * The boundary mint for the schema-write transaction: the engine's own
 * `schemaWriteTransaction`, or `undefined` when the backend has none. Its
 * callback is the one place a {@link StoreTransactionBackend} specialised to
 * {@link SchemaWriteTransactionBackend} exists.
 *
 * It takes the member as the call site reads it off the backend
 * (`storeX(backend.member)`), so every engine member read stays where it is
 * written, and returns that same function. `tests/operation-scope-ratchet.test.ts`
 * checks that every argument of a boundary mint is a read of its own member:
 * a function the Store wrote itself could call the callback with an ordinary
 * transaction, and for the preflight target no type can tell the two apart.
 */
export function storeSchemaWriteTransaction(
  open: GraphBackend["schemaWriteTransaction"],
): StoreSchemaWriteTransaction | undefined {
  /* eslint-disable no-restricted-syntax -- This module is the mint: the schema-write specialisation is granted here, at the engine member that opens that transaction, and nowhere else. */
  return open as StoreSchemaWriteTransaction | undefined;
  /* eslint-enable no-restricted-syntax */
}

/**
 * The boundary mint for a schema commit's preflight: the engine's own
 * `commitSchemaVersionWithPreflight`, or `undefined` when the backend has
 * none. Its preflight is one of the two places a
 * {@link StoreTransactionBackend} specialised to
 * {@link SchemaCommitPreflightBackend} exists. Member for member that target
 * IS an ordinary transaction (each extra member is optional), so no type can
 * tell the two apart where a callback is written; only the engine member that
 * runs the preflight can.
 *
 * It takes the member as the call site reads it off the backend
 * (`storeX(backend.member)`), so every engine member read stays where it is
 * written, and returns that same function. `tests/operation-scope-ratchet.test.ts`
 * checks that every argument of a boundary mint is a read of its own member:
 * a function the Store wrote itself could call the callback with an ordinary
 * transaction, and for the preflight target no type can tell the two apart.
 */
export function storeCommitSchemaVersionWithPreflight(
  commit: GraphBackend["commitSchemaVersionWithPreflight"],
): StoreCommitSchemaVersionWithPreflight | undefined {
  /* eslint-disable no-restricted-syntax -- This module is the mint: the preflight specialisation is granted here, at the engine member that runs the preflight, and nowhere else. */
  return commit as StoreCommitSchemaVersionWithPreflight | undefined;
  /* eslint-enable no-restricted-syntax */
}

/**
 * The boundary mint for a reactivation's preflight: the engine's own
 * `setActiveVersionWithPreflight`, or `undefined` when the backend has
 * none. The other place a preflight-specialised
 * {@link StoreTransactionBackend} exists.
 *
 * It takes the member as the call site reads it off the backend
 * (`storeX(backend.member)`), so every engine member read stays where it is
 * written, and returns that same function. `tests/operation-scope-ratchet.test.ts`
 * checks that every argument of a boundary mint is a read of its own member:
 * a function the Store wrote itself could call the callback with an ordinary
 * transaction, and for the preflight target no type can tell the two apart.
 */
export function storeSetActiveVersionWithPreflight(
  activate: GraphBackend["setActiveVersionWithPreflight"],
): StoreSetActiveVersionWithPreflight | undefined {
  /* eslint-disable no-restricted-syntax -- This module is the mint: the preflight specialisation is granted here, at the engine member that runs the preflight, and nowhere else. */
  return activate as StoreSetActiveVersionWithPreflight | undefined;
  /* eslint-enable no-restricted-syntax */
}

/**
 * A schema-write transaction the engine adopted, as Store code receives it:
 * the Store form of the adopted transaction, and the schema it found active.
 */
type StoreAdoptedSchemaWriteTransaction = Readonly<{
  backend: StoreTransactionBackend<AdoptedSchemaWriteTransaction["backend"]>;
  activeSchema: AdoptedSchemaWriteTransaction["activeSchema"];
}>;

/** {@link storeAdoptSchemaWriteTransaction}'s member, as Store code calls it. */
export type StoreAdoptSchemaWriteTransaction<TNativeTransaction> = (
  ...args: Parameters<
    NonNullable<
      AdapterBackend<TNativeTransaction>["adoptSchemaWriteTransaction"]
    >
  >
) => Promise<StoreAdoptedSchemaWriteTransaction>;

/**
 * The boundary mint for an adopted schema-write transaction: the adapter
 * backend's own `adoptSchemaWriteTransaction`, or `undefined` when there
 * is none. The transaction it resolves to is the one place a
 * {@link StoreTransactionBackend} specialised to the adopted schema-write
 * transaction exists.
 *
 * It takes the member as the call site reads it off the backend
 * (`storeX(backend.member)`), so every engine member read stays where it is
 * written, and returns that same function. `tests/operation-scope-ratchet.test.ts`
 * checks that every argument of a boundary mint is a read of its own member:
 * a function the Store wrote itself could call the callback with an ordinary
 * transaction, and for the preflight target no type can tell the two apart.
 */
export function storeAdoptSchemaWriteTransaction<TNativeTransaction>(
  adopt: AdapterBackend<TNativeTransaction>["adoptSchemaWriteTransaction"],
): StoreAdoptSchemaWriteTransaction<TNativeTransaction> | undefined {
  /* eslint-disable no-restricted-syntax -- This module is the mint: the adopted schema-write specialisation is granted here, at the engine member that adopts that transaction, and nowhere else. */
  return adopt as
    StoreAdoptSchemaWriteTransaction<TNativeTransaction> | undefined;
  /* eslint-enable no-restricted-syntax */
}
