/**
 * Operation-scoped statement targets: how a statement reaches a transaction.
 *
 * Store code (everything outside `src/backend`, the engine) never holds the
 * engine's transaction type. Where a transaction is opened or joined it
 * receives a {@link StoreTransactionBackend}: identity and SQL compilation,
 * no statement member. A statement inside a transaction is issued only
 * through an {@link OperationBackend}, and a Store function that issues
 * statements declares its target as one (or as {@link StatementBackend},
 * which also admits the pooled root).
 *
 * The path has two steps, each a value handed down explicitly and never
 * looked up from the object a caller happens to hold:
 *
 * - **Session.** Where a Store opens or joins a transaction it opens a
 *   {@link TransactionSession}: that transaction as this binding holds it
 *   ({@link openTransactionSession}, or {@link openBoundTransactionSession}
 *   where the binding builds a statement surface over the transaction).
 *   Where it opens a transaction on a root, {@link openRootTransaction}
 *   hands it the one session of that transaction: the session a backend
 *   layer opened itself (recorded capture's overlay, bound over the capture
 *   surface), or one opened over what the root handed out. A transaction
 *   context carries its session to privileged internals on its runtime
 *   ({@link transactionRuntimeSession}).
 * - **Operation.** Each public Store call inside the transaction enters one
 *   {@link Operation} of that session when it executes: {@link enterOperation}
 *   from a session the caller holds, {@link enterTransactionOperation} from a
 *   transaction context, {@link enterTargetOperation} for a target arriving
 *   through a public signature (a transaction there joins as a binding of
 *   its own). The operation carries the handle its statements go through;
 *   work the call composes runs under the same operation.
 *
 * The other mints are narrower: {@link decorateOperation} replaces an
 * operation's handle with a derivation of it, {@link scopeWriteFrameTarget}
 * is the write executor's mint for the target it hands row work, and the
 * boundary mints ({@link storeSchemaWriteTransaction},
 * {@link storeCommitSchemaVersionWithPreflight},
 * {@link storeSetActiveVersionWithPreflight},
 * {@link storeAdoptSchemaWriteTransaction}) grant a specialised
 * (schema-write or preflight) transaction at the engine member that opens
 * it. No other function produces a handle, so every call path into
 * statement work is visible at a mint. `tests/operation-scope-ratchet.test.ts`
 * also scans Store code for any value still typed as the engine transaction:
 * the declarations whose type the public API spells are listed there, and
 * nothing else may appear.
 *
 * The backend brand is a phantom: a minted backend is the SAME object it was
 * minted from. That is deliberate. Store state not carried by a session is
 * keyed by the target object's identity (the savepoint-state registry), and
 * the layers above
 * discriminate a root from a transaction with `"transaction" in target`; a
 * derived object per operation would change both. An {@link Operation} is
 * therefore a separate small value that CARRIES the handle and its session,
 * not a replacement for the handle.
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
import {
  backendDerivationChain,
  isBackendDerivedFrom,
} from "../backend/derive-backend";
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
import {
  type TransactionCallRefusalReason,
  TransactionCallRefusedError,
} from "../errors";
import {
  type NativeTransactionState,
  resolveNativeTransactionState,
} from "./native-transaction-state";
import type { ManagedWriteState } from "./operations/managed-write-state";
import type { GraphWriteLock } from "./recorded-capture/clock";
import type { RecordedSessionState } from "./recorded-capture/session-state";
import { TRANSACTION_RUNTIME } from "./types";

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
 * therefore recorded in a REQUIRED phantom ({@link EngineEvidence}) under a
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
> = Readonly<BackendIdentity & SqlCompilationBackend & EngineEvidence<Engine>>;

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
 * The {@link EngineRecord} a Store transaction must carry to be named as
 * `Engine`: none for the plain {@link TransactionBackend} alone, and one for
 * every other engine type — one with a member the plain transaction lacks,
 * one that only narrows a member, and the pooled root's type, whose
 * `transaction` member no transaction has. Every session and operation
 * specialisation is opened from a Store transaction of its engine type
 * ({@link openTransactionSession}), so an engine type exempt here could be
 * named onto an ordinary transaction through that mint's type argument.
 * Stricter than {@link EngineRecordOf}, which describes a handle, where the
 * root (or a root-or-handle union) is honestly what the value is.
 */
type EngineEvidence<Engine extends TransactionBackend> =
  [TransactionBackend] extends [Engine] ?
    [Exclude<keyof Engine, keyof TransactionBackend>] extends [never] ?
      unknown
    : EngineRecord<Engine>
  : EngineRecord<Engine>;

// ---------------------------------------------------------------------------
// Sessions and operations
// ---------------------------------------------------------------------------

// Module-private runtime keys: no other module can read a session's
// transaction, build a session or an operation from a literal, or tell an
// operation from a root backend except through the functions below.
const SESSION_TRANSACTION: unique symbol = Symbol("typegraph.session");
const OPERATION_SESSION: unique symbol = Symbol("typegraph.operation");
const SESSION_CONTROL: unique symbol = Symbol("typegraph.sessionControl");
const SESSION_CALLS: unique symbol = Symbol("typegraph.sessionCalls");
const OPERATION_ROOT: unique symbol = Symbol("typegraph.operationRoot");
const OPERATION_PARENT: unique symbol = Symbol("typegraph.operationParent");
const OPERATION_IN_FLIGHT: unique symbol = Symbol(
  "typegraph.operationInFlight",
);

/**
 * One native transaction as one Store binding opened or joined it: the value
 * every public write inside that transaction enters its {@link Operation}
 * from. Opened by {@link openTransactionSession} where the Store opens the
 * transaction (`store.transaction`, a write that opens its own) or joins one
 * (an adopted, recorded or evolved transaction), and handed down from there
 * as a value.
 *
 * Two Stores on one native transaction hold two sessions, one per binding:
 * every piece of state a session carries is state about the transaction
 * together with one Store's graph, tables and configuration, and pooling it
 * across Stores changes outcomes (`shared-native-transaction.ts`).
 *
 * What it carries today is the write executor's per-binding state: the graph
 * write locks its frames hold or are acquiring
 * ({@link GraphWriteLock}, see `write-transaction.ts`), and the managed
 * write state of the `store.transaction` attempt that opened it with the
 * schema fences it leased (`managed-write-state.ts`), and the recorded
 * capture scope or engine-native mutation witness bound to it
 * (`recorded-capture/session-state.ts`). It never hands out its
 * transaction; an operation entered from it does, as its statement surface
 * (`Operation.backend`) and as the undecorated holding beneath it
 * (`Operation.control`).
 *
 * State about the native transaction alone, shared by every binding of it,
 * is on {@link TransactionSession.native}, not on the session.
 */
export type TransactionSession<
  Engine extends TransactionBackend = TransactionBackend,
> = OperationScoped<
  {
    /**
     * What the session's operations hand out: the transaction, or the
     * statement surface {@link openBoundTransactionSession} bound over it.
     * Written only by this module (the key is module-private), and only
     * before the session reaches anyone but its binder.
     */
    [SESSION_TRANSACTION]: OperationScoped<Engine>;
  } & Readonly<{
    /**
     * The transaction as the session holds it, undecorated: what
     * {@link Operation.control} hands out. The same object as what the
     * session's operations hand out, unless the session was bound over a
     * statement surface.
     */
    [SESSION_CONTROL]: OperationScoped<Engine>;
    /**
     * Which calls of the session are running and whether one of them holds
     * a savepoint unit open: what the refusals of {@link enterOperation} and
     * {@link openOperationUnit} read. Written only by this module.
     */
    [SESSION_CALLS]: {
      /**
       * Root calls running on the session: those {@link enterCall} counted
       * that {@link exitCall} has not released, and root reads
       * {@link enterReadCall} or {@link countReadCall} counted that
       * {@link exitReadCall} has not released.
       */
      inFlight: number;
      /** Savepoint units open on the session, nested ones included. */
      unitDepth: number;
      /** The root call whose units are open, while `unitDepth` is above 0. */
      unitRoot: Operation | undefined;
    };
    /**
     * Graph write locks a still-running write frame on this session holds or
     * is still acquiring, by graph id: owned by `write-transaction.ts`.
     */
    heldGraphWriteLocks: Map<string, Promise<GraphWriteLock>>;
    /**
     * The managed write session and the schema-fence leases of this session,
     * read through `managedWriteState` from the operation a reader holds:
     * owned by `write-transaction.ts`.
     */
    managedWrite: ManagedWriteState;
    /**
     * The state every session of this session's native transaction shares
     * (`native-transaction-state.ts`): the same object for every binding
     * the engine recorded as running on that transaction, and one of the
     * session's own when it recorded none.
     */
    native: NativeTransactionState;
    /**
     * The recorded-capture scope or engine-native mutation witness bound to
     * this session, read through `recordedSessionBinding` from the operation
     * a reader holds: owned by `recorded-capture.ts`.
     */
    recorded: RecordedSessionState;
  }>
>;

/**
 * One public Store call inside a transaction, a read or a write: the session
 * it belongs to and the operation-scoped handle its statements go through.
 * Entered by {@link enterOperation}, once per public call, when the call
 * executes; work the call composes (a nested write frame, a mutation set's
 * legs, a query's selective attempt and its fallback) runs under the same
 * operation rather than entering another.
 *
 * A call that another call composes through a public surface of its own
 * (merge apply's collection writes, say) is a CHILD: it is entered with its
 * parent operation, passed explicitly, and belongs to the parent's root call.
 * A savepoint unit is held by a root call, and a call of any other root is
 * refused while it is open ({@link enterOperation}).
 */
export type Operation<Engine extends TransactionBackend = TransactionBackend> =
  OperationScoped<
    {
      /**
       * On a root call: whether {@link enterCall} counted it as running on
       * its session and {@link exitCall} has not yet released it.
       */
      [OPERATION_IN_FLIGHT]: boolean;
    } & Readonly<{
      [OPERATION_SESSION]: TransactionSession<Engine>;
      /**
       * The root call this operation belongs to: itself when it was entered
       * without a parent, its parent's root otherwise.
       */
      [OPERATION_ROOT]: Operation;
      /** The operation this one was entered as a child of, if any. */
      [OPERATION_PARENT]: Operation | undefined;
      backend: OperationScoped<Engine>;
      /**
       * The session's undecorated holding, as this operation holds it: the
       * transaction beneath the statement surface `backend` hands out, or
       * `backend` itself when the session was bound over none. The Store's
       * own control statements (a savepoint, a fence that bypasses row
       * capture, a recorded identity write) go through it, in the operation
       * the call entered.
       */
      control: OperationScoped<Engine>;
    }>
  >;

/**
 * Where a public Store call enters, a write (into the write executor) or a
 * read (a query terminal, a read member): the pooled root backend itself (a
 * root call allocates nothing), or an {@link Operation} of a transaction
 * session.
 */
export type OperationEntry = GraphBackend | Operation;

/**
 * Where a Store surface's calls enter from: the root backend, or the session
 * of the transaction the surface belongs to.
 */
export type EntryScope = GraphBackend | TransactionSession;

/**
 * The mint where a Store opens or joins a transaction: a new session for
 * `transaction` as this binding holds it.
 *
 * `Engine` names a specialised engine transaction (the schema-write
 * transaction, say) when `transaction` is the Store form of one; the
 * session's operations then hand out a handle to that type. Only the boundary
 * mints below produce such a Store form, so naming the specialisation here
 * grants nothing the caller did not already hold.
 */
export function openTransactionSession<
  Engine extends TransactionBackend = TransactionBackend,
>(transaction: StoreTransactionBackend<Engine>): TransactionSession<Engine> {
  /* eslint-disable no-restricted-syntax -- This module is the mint: a session over a transaction the Store opened or joined is built here and nowhere else. */
  return {
    [SESSION_TRANSACTION]: transaction,
    [SESSION_CONTROL]: transaction,
    [SESSION_CALLS]: { inFlight: 0, unitDepth: 0, unitRoot: undefined },
    heldGraphWriteLocks: new Map<string, Promise<GraphWriteLock>>(),
    managedWrite: { writeSession: undefined, schemaFenceLeases: undefined },
    native: resolveNativeTransactionState(transaction),
    recorded: { binding: undefined },
  } as TransactionSession<Engine>;
  /* eslint-enable no-restricted-syntax */
}

/**
 * What a binder hands {@link openBoundTransactionSession}: the statement
 * surface the session's later operations hand out, and whatever else the
 * binder built while binding, returned to its caller untouched.
 */
export type TransactionSessionBinding<
  Binding,
  Engine extends TransactionBackend = TransactionBackend,
> = Readonly<{
  statements: OperationScoped<Engine>;
  binding: Binding;
}>;

/**
 * Where a Store opens or joins a transaction whose writes go through a
 * statement surface it builds over that transaction (recorded capture's write
 * decorator, the engine-native mutation witness, an evolved transaction's
 * execution lifetime): the session, opened ONCE, for the transaction as this
 * binding holds it.
 *
 * `bind` receives the new session and the transaction the session holds.
 * An operation it enters hands out the transaction itself, so the opener's
 * own statements (those that must precede the surface, such as an isolation
 * check or a lock, and those it issues later on the undecorated transaction,
 * such as a capture flush or a pre-commit hook) go through that operation of
 * THIS session. It builds the surface over `transaction` — the session's
 * own holding, not an operation's handle, so a later operation's
 * statements go through that operation alone — and returns it; from then on
 * every operation entered from the session hands out that surface. The
 * session reaches no one but `bind` before it is bound, and is rebound
 * only by narrowing ({@link narrowSessionSurface}).
 *
 * `Engine` is as for {@link openTransactionSession}: the session it opens is
 * that mint's, specialised only when `transaction` carries the evidence of
 * its specialisation, and the surface `bind` returns is a handle to the same
 * engine type.
 */
export async function openBoundTransactionSession<
  Binding,
  Engine extends TransactionBackend = TransactionBackend,
>(
  transaction: StoreTransactionBackend<Engine>,
  bind: (
    session: TransactionSession<Engine>,
    transaction: OperationScoped<Engine>,
  ) =>
    | TransactionSessionBinding<Binding, Engine>
    | Promise<TransactionSessionBinding<Binding, Engine>>,
): Promise<
  Readonly<{ session: TransactionSession<Engine>; binding: Binding }>
> {
  const session = openTransactionSession(transaction);
  const bound = await bind(session, session[SESSION_TRANSACTION]);
  session[SESSION_TRANSACTION] = bound.statements;
  return { session, binding: bound.binding };
}

// Module-private: only `withSessionOpener` puts an opener on a backend's
// `transaction` member, and only `openRootTransaction` reads one back.
const SESSION_OPENER: unique symbol = Symbol("typegraph.sessionOpener");

/**
 * A backend layer's own way to open a transaction for a Store: it opens the
 * transaction, opens the one session over it, and hands the Store that
 * session, bound over whatever statement surface the layer builds.
 */
export type SessionTransactionOpener = <T>(
  fn: (session: TransactionSession) => Promise<T>,
  options?: Parameters<GraphBackend["transaction"]>[1],
) => Promise<T>;

type SessionOpeningTransaction = GraphBackend["transaction"] &
  Readonly<{ [SESSION_OPENER]?: SessionTransactionOpener }>;

/**
 * Marks `transaction`, a backend layer's `transaction` member, as one whose
 * layer opens the session for the transaction it opens (recorded capture's
 * overlay): {@link openRootTransaction} then hands the Store that session
 * instead of opening a second one over the surface the member hands out.
 * Carried by the member function itself, so a derivation that overrides
 * `transaction` (and so opens its transaction some other way) carries none.
 */
export function withSessionOpener(
  transaction: GraphBackend["transaction"],
  opener: SessionTransactionOpener,
): GraphBackend["transaction"] {
  Object.defineProperty(transaction, SESSION_OPENER, { value: opener });
  return transaction;
}

/**
 * Narrows the statement surface `session`'s later operations hand out to
 * `surface`, a derivation of the surface it hands out now, and returns the
 * session. For a backend layer that opened the transaction with its session
 * ({@link openRootTransaction}) and guards the statements its caller issues
 * (the recorded read overlay's origin checks) before it hands the session on
 * through its own opener ({@link withSessionOpener}): the caller runs in that
 * one session, not in a second one opened over the guarded surface.
 * Operations entered before the narrowing keep the surface they hold; the
 * undecorated holding ({@link Operation.control}) is unchanged.
 *
 * Refuses a `surface` that is not derived from the current one through
 * `src/backend/derive-backend.ts`: anything else would drop the layers
 * beneath it, a capture surface among them.
 */
export function narrowSessionSurface<Engine extends TransactionBackend>(
  session: TransactionSession<Engine>,
  surface: OperationScoped<Engine>,
): TransactionSession<Engine> {
  if (!isBackendDerivedFrom(surface, session[SESSION_TRANSACTION])) {
    throw new TypeError(
      "A session's statement surface can only be narrowed to a derivation of it.",
    );
  }
  session[SESSION_TRANSACTION] = surface;
  return session;
}

/**
 * The mint where a Store opens a transaction on a root backend: `fn`
 * receives the one session of the transaction `root` opens. When `root`'s
 * `transaction` member opens a session of its own (recorded capture's
 * overlay, {@link withSessionOpener}), that session is the one; otherwise
 * the session opens here, over what the member hands out.
 */
export function openRootTransaction<T>(
  root: Pick<GraphBackend, "transaction">,
  fn: (session: TransactionSession) => Promise<T>,
  options?: Parameters<GraphBackend["transaction"]>[1],
): Promise<T> {
  const member: SessionOpeningTransaction = root.transaction;
  const opener = member[SESSION_OPENER];
  if (opener !== undefined) return opener(fn, options);
  return root.transaction(
    (transaction: StoreTransactionBackend) =>
      fn(openTransactionSession(transaction)),
    options,
  );
}

/**
 * The mint at a public Store member: the root backend as itself, or a new
 * {@link Operation} of the session.
 *
 * `parent` is the operation of the call that composes this one, passed
 * explicitly by that call and never looked up: the new operation is its
 * child and belongs to its root call. Without one, the operation is a root
 * call of its own.
 *
 * A call that starts while a call of another root holds a savepoint unit open
 * on the session ({@link openOperationUnit}) is refused here, before it can
 * issue any statement, with a {@link TransactionCallRefusedError}
 * (`"savepoint-open"`): its writes would run inside that savepoint and be
 * lost if the unit rolled back.
 *
 * The operation is not counted as running: a call that brackets its extent
 * hands it to {@link enterCall}, so a unit opening beside it is refused.
 */
export function enterOperation<Engine extends TransactionBackend>(
  scope: TransactionSession<Engine>,
  parent?: Operation,
): Operation<Engine>;
export function enterOperation(
  scope: EntryScope,
  parent?: Operation,
): OperationEntry;
export function enterOperation(
  scope: EntryScope,
  parent?: Operation,
): OperationEntry {
  if (!(SESSION_TRANSACTION in scope)) {
    if (parent !== undefined) {
      throw new TypeError(
        "A call on the root backend cannot be the child of an operation of a transaction session.",
      );
    }
    return scope;
  }
  if (parent !== undefined && parent[OPERATION_SESSION] !== scope) {
    throw new TypeError(
      "A child operation must be entered on its parent's session.",
    );
  }
  const refusal = callRefusal(scope[SESSION_CALLS], parent?.[OPERATION_ROOT]);
  if (refusal !== undefined) throw new TransactionCallRefusedError(refusal);
  // This module is the mint: an operation of a session is built here and
  // nowhere else. Its root is set once the object exists, so a root call's
  // root is the operation itself.
  const operation = {
    [OPERATION_SESSION]: scope,
    [OPERATION_ROOT]: undefined,
    [OPERATION_PARENT]: parent,
    [OPERATION_IN_FLIGHT]: false,
    backend: scope[SESSION_TRANSACTION],
    control: scope[SESSION_CONTROL],
  } as unknown as MintedOperation;
  operation[OPERATION_ROOT] = parent?.[OPERATION_ROOT] ?? operation;
  return operation;
}

/** An operation as its mint builds it, before its root is set. */
type MintedOperation = { -readonly [Key in keyof Operation]: Operation[Key] };

/**
 * Counts `entry`, the operation a call just entered ({@link enterOperation}),
 * as running on its session until {@link exitCall} releases it, so a
 * savepoint unit another root call tries to open meanwhile is refused
 * (`"siblings-in-flight"`), and returns it. For a call whose extent the
 * caller brackets: call {@link exitCall} in a `finally` once the call's work
 * has settled. A child (entered with a `parent`) is not counted: it runs
 * within its root call's extent. The pooled root has no session to count on.
 */
export function enterCall<Entry extends OperationEntry>(entry: Entry): Entry {
  if (!(OPERATION_SESSION in entry) || entry[OPERATION_PARENT] !== undefined) {
    return entry;
  }
  const root = entry[OPERATION_ROOT];
  if (!root[OPERATION_IN_FLIGHT]) {
    root[OPERATION_IN_FLIGHT] = true;
    entry[OPERATION_SESSION][SESSION_CALLS].inFlight += 1;
  }
  return entry;
}

/** Releases a call {@link enterCall} counted as running; idempotent. */
export function exitCall(entry: OperationEntry): void {
  if (!(OPERATION_SESSION in entry) || entry[OPERATION_PARENT] !== undefined) {
    return;
  }
  const root = entry[OPERATION_ROOT];
  if (!root[OPERATION_IN_FLIGHT]) return;
  root[OPERATION_IN_FLIGHT] = false;
  entry[OPERATION_SESSION][SESSION_CALLS].inFlight -= 1;
}

/**
 * Admits a read call on `scope` and returns what its statements go through:
 * the root backend as itself, or the session's transaction handle. A read is
 * a call like any other: it is refused here, before any statement, while a
 * savepoint unit of another root call is open (`"savepoint-open"`, the
 * decision {@link enterOperation} makes), and a root read is counted as
 * running on the session until {@link exitReadCall} releases it, so a unit
 * another call tries to open meanwhile is refused (`"siblings-in-flight"`).
 *
 * No operation is minted: for a read whose statements go through the
 * session's transaction handle as it already holds it (a collection's point
 * and list reads), admission costs a counter update. A read that routes its
 * statements through an operation's handle enters one and is counted with
 * {@link countReadCall} instead, by the same decision. A read with a `parent` (merge apply's own
 * collection reads) is that call's child: checked against the parent's root,
 * and not counted, as it runs within its root call's extent. Call
 * {@link exitReadCall} with the same arguments in a `finally` once the read
 * has settled; a stream admits each page on its own.
 */
export function enterReadCall<Engine extends TransactionBackend>(
  scope: TransactionSession<Engine>,
  parent?: Operation,
): OperationScoped<Engine>;
export function enterReadCall(
  scope: EntryScope,
  parent?: Operation,
): StatementBackend;
export function enterReadCall(
  scope: EntryScope,
  parent?: Operation,
): StatementBackend {
  if (!(SESSION_TRANSACTION in scope)) {
    if (parent !== undefined) {
      throw new TypeError(
        "A call on the root backend cannot be the child of an operation of a transaction session.",
      );
    }
    return scope;
  }
  if (parent !== undefined && parent[OPERATION_SESSION] !== scope) {
    throw new TypeError(
      "A child operation must be entered on its parent's session.",
    );
  }
  const calls = scope[SESSION_CALLS];
  const refusal = callRefusal(calls, parent?.[OPERATION_ROOT]);
  if (refusal !== undefined) throw new TransactionCallRefusedError(refusal);
  if (parent === undefined) calls.inFlight += 1;
  return scope[SESSION_TRANSACTION];
}

/**
 * Counts a read call that entered `entry` ({@link enterOperation}, whose
 * refusal it has passed) as running on its session until
 * {@link exitReadCall} releases it with `entry`'s session: for a read whose
 * statements go through an operation's handle (a query terminal, a
 * `tx.backend` member), admitted by the same decision as
 * {@link enterReadCall}. A child, or the pooled root, is not counted.
 */
export function countReadCall(entry: OperationEntry): void {
  if (!(OPERATION_SESSION in entry) || entry[OPERATION_PARENT] !== undefined) {
    return;
  }
  entry[OPERATION_SESSION][SESSION_CALLS].inFlight += 1;
}

/**
 * Releases a read {@link enterReadCall} admitted with the same arguments, or
 * one {@link countReadCall} counted on `scope` (its entry's session, no
 * parent).
 */
export function exitReadCall(scope: EntryScope, parent?: Operation): void {
  if (!(SESSION_TRANSACTION in scope) || parent !== undefined) return;
  scope[SESSION_CALLS].inFlight -= 1;
}

/**
 * THE decision of whether an operation of root call `root` (`undefined` for
 * a new root call) may run on a session with `calls`: refused while a unit of
 * another root call is open.
 */
function callRefusal(
  calls: TransactionSession[typeof SESSION_CALLS],
  root: Operation | undefined,
): TransactionCallRefusalReason | undefined {
  return calls.unitDepth > 0 && root !== calls.unitRoot ?
      "savepoint-open"
    : undefined;
}

/**
 * Opens a savepoint unit of `entry`'s root call on its session, before the
 * unit's first statement. Refused with a {@link TransactionCallRefusedError}
 * while a unit of another root call is open (`"savepoint-open"`), and while a
 * root call other than `entry`'s own is running on the session
 * (`"siblings-in-flight"`), whose statements would otherwise land inside the
 * savepoint. A unit the same root call already holds open nests. Pair with
 * {@link closeOperationUnit} in a `finally`. The pooled root has no session
 * and opens nothing.
 */
export function openOperationUnit(entry: OperationEntry): void {
  if (!(OPERATION_SESSION in entry)) return;
  const calls = entry[OPERATION_SESSION][SESSION_CALLS];
  const root = entry[OPERATION_ROOT];
  const refusal =
    callRefusal(calls, root) ??
    ((
      calls.unitDepth === 0 &&
      calls.inFlight > (root[OPERATION_IN_FLIGHT] ? 1 : 0)
    ) ?
      "siblings-in-flight"
    : undefined);
  if (refusal !== undefined) throw new TransactionCallRefusedError(refusal);
  calls.unitDepth += 1;
  calls.unitRoot = root;
}

/**
 * Runs `run`, the whole of a call that takes a savepoint unit on its session,
 * holding that unit open from before the call's first statement: the call is
 * refused before any statement beside running sibling calls, and a call
 * started while it runs (its pre-savepoint reads included) is refused before
 * any statement of its own. The savepoints the call takes inside nest in it.
 */
export async function runOperationUnit<T>(
  entry: OperationEntry,
  run: () => Promise<T>,
): Promise<T> {
  openOperationUnit(entry);
  try {
    return await run();
  } finally {
    closeOperationUnit(entry);
  }
}

/** Closes the unit {@link openOperationUnit} opened for `entry`. */
export function closeOperationUnit(entry: OperationEntry): void {
  if (!(OPERATION_SESSION in entry)) return;
  const calls = entry[OPERATION_SESSION][SESSION_CALLS];
  calls.unitDepth -= 1;
  if (calls.unitDepth === 0) calls.unitRoot = undefined;
}

/**
 * The mint where an outside target enters through a public signature
 * (`executeOn`, which `store.batch()` also goes through), or where a Store
 * opener receives a bare target from `runOptionallyInTransaction`: the
 * root backend as itself, or the first {@link Operation} of a NEW session for
 * a transaction. The Store runtime port never enters here: its members take
 * the caller's {@link OperationEntry} and run in that operation.
 * The public type carries no session and none is looked up from the object,
 * so whatever transaction the caller holds — one of this Store's, another
 * Store's, or one built on the engine directly — joins as a binding of its
 * own.
 */
export function enterTargetOperation(
  target: GraphBackend | StoreTransactionBackend,
): OperationEntry {
  return isRootBackend(target) ? target : (
      enterOperation(openTransactionSession(target))
    );
}

/**
 * THE one owner of the root-or-transaction decision for a value held as a
 * backend or an entry: only the pooled root has a `transaction` member.
 */
function isRootBackend(
  target: GraphBackend | StoreTransactionBackend | OperationEntry,
): target is GraphBackend {
  return "transaction" in target;
}

// ---------------------------------------------------------------------------
// The session a transaction context carries
// ---------------------------------------------------------------------------

// Module-private: only `transactionRuntimeSession` puts a session on a
// transaction context's runtime, and only `enterTransactionOperation` reads
// one back.
const RUNTIME_SESSION: unique symbol = Symbol("typegraph.runtimeSession");

/**
 * THE refusal of a transaction context that carries no runtime port: a
 * context this copy of TypeGraph cannot read at all.
 */
export function requireTransactionRuntime<Runtime>(
  transaction: Readonly<{ [TRANSACTION_RUNTIME]?: Runtime }>,
): Runtime {
  const runtime = transaction[TRANSACTION_RUNTIME];
  if (runtime === undefined) {
    throw new TypeError(
      "Cannot access this transaction's runtime port. The transaction may come from an incompatible TypeGraph version.",
    );
  }
  return runtime;
}

/**
 * What a transaction context's runtime carries for its session, spread into
 * the runtime where the context is built: `session`, under a module-private
 * key. The runtime's public type names one `backend` and is spelled by the
 * API report, so the session travels beside it the way a query's operation
 * source travels beside its configuration; nothing is looked up from the
 * object.
 */
export function transactionRuntimeSession(
  session: TransactionSession,
): Readonly<{ [RUNTIME_SESSION]: TransactionSession }> {
  return { [RUNTIME_SESSION]: session };
}

/**
 * A transaction context as {@link enterTransactionOperation} reads it: its
 * runtime's transaction, in the Store form, and the session the runtime
 * carries when this module's carrier put one there.
 */
type SessionCarryingContext = Readonly<{
  [TRANSACTION_RUNTIME]?: Readonly<{
    backend: StoreTransactionBackend;
    [RUNTIME_SESSION]?: TransactionSession;
  }>;
}>;

/**
 * The mint where a privileged internal holding a transaction context
 * (provenance, a working copy's durable operation) enters: a new
 * {@link Operation} of the session the context's runtime carries. Enter it
 * once per public call, after the call's refusals, and hand it to everything
 * the call itself sends; a collection or runtime member the call invokes
 * enters its own.
 *
 * A runtime without a session is not one this copy of TypeGraph built: its
 * transaction joins as a binding of its own, as a transaction arriving
 * through {@link enterTargetOperation} does.
 */
export function enterTransactionOperation(
  transaction: SessionCarryingContext,
): Operation {
  const runtime = requireTransactionRuntime(transaction);
  return enterOperation(
    runtime[RUNTIME_SESSION] ?? openTransactionSession(runtime.backend),
  );
}

/**
 * The mint where an operation's own work decorates its handle (recorded
 * capture's overlay over a schema-commit preflight's transaction): the same
 * call's operation, of the same session, whose statements go through
 * `decorated`. Refuses a `decorated` that is not derived from the operation's
 * handle through `src/backend/derive-backend.ts`, since its statements would
 * be attributed to a session that does not hold their transaction.
 */
export function decorateOperation<Engine extends TransactionBackend>(
  operation: Operation<Engine>,
  decorated: OperationBackend,
): Operation {
  if (!isBackendDerivedFrom(decorated, operation.backend)) {
    throw new TypeError(
      "An operation's handle can only be replaced by a derivation of it.",
    );
  }
  const session: TransactionSession = operation[OPERATION_SESSION];
  const control: OperationBackend = operation.control;
  /* eslint-disable no-restricted-syntax -- This module is the mint: an operation of a session is built here and nowhere else. */
  return {
    [OPERATION_SESSION]: session,
    [OPERATION_ROOT]: operation[OPERATION_ROOT],
    [OPERATION_PARENT]: operation[OPERATION_PARENT],
    [OPERATION_IN_FLIGHT]: false,
    backend: decorated,
    control,
  } as Operation;
  /* eslint-enable no-restricted-syntax */
}

/**
 * The entry a Store runtime port member runs in, for the entry its caller
 * handed it: the root itself, or the caller's {@link Operation}, unchanged.
 *
 * An operation another copy of TypeGraph minted (the same release loaded as
 * both an ES module and a CommonJS build) reaches this copy's Store through
 * the port's global symbol but carries that copy's private keys, so its own
 * session is invisible here. When it was opened over a surface this copy
 * built for one of its sessions ({@link sessionSurfaceMembers}: a Store's
 * recorded capture overlay its importer opened a transaction through), it
 * becomes an operation of that session, keeping its handle: the member runs
 * under the session's recorded binding and graph-lock memo, and its recorded
 * control statements go through the session's undecorated holding. Otherwise
 * its handle joins as a binding of its own ({@link enterTargetOperation}),
 * exactly as a bare transaction handed across the port did. Read off the
 * value handed in; nothing is looked up.
 *
 * A bare transaction handle ({@link PortEntry}) is still accepted: the call
 * shape of a copy whose import members took the transaction itself. It is
 * read as such a foreign operation whose handle and holding are both that
 * transaction.
 */
export function portOperationEntry(entry: PortEntry): OperationEntry {
  if (isRootBackend(entry)) return entry;
  // Every backend states its dialect; an operation is not one.
  if ("dialect" in entry) {
    return foreignOperationEntry({ backend: entry, control: entry });
  }
  if (isOwnOperation(entry)) return entry;
  return foreignOperationEntry(entry);
}

/**
 * What a Store runtime port member accepts as its caller's entry: an
 * {@link OperationEntry}, or a bare transaction handle. Another copy of
 * TypeGraph whose import members took the transaction itself under the same
 * port version still calls them that way, and
 * {@link portOperationEntry} normalises either shape.
 */
export type PortEntry = OperationEntry | StoreTransactionBackend;

/**
 * An operation another copy of TypeGraph minted, as this copy enters it: an
 * operation of the session its holding is a surface of, keeping its handle,
 * or its handle joined as a binding of its own.
 */
function foreignOperationEntry(
  entry: Readonly<{
    backend: StoreTransactionBackend;
    control: SessionCarryingSurface;
  }>,
): OperationEntry {
  const session = surfaceSession(entry.control);
  if (session === undefined) return enterTargetOperation(entry.backend);
  // This module is the mint: an operation of a session is built here and
  // nowhere else. A foreign operation is a root call of its own.
  const operation = {
    [OPERATION_SESSION]: session,
    [OPERATION_ROOT]: undefined,
    [OPERATION_PARENT]: undefined,
    [OPERATION_IN_FLIGHT]: false,
    backend: entry.backend,
    control: session[SESSION_CONTROL],
  } as unknown as MintedOperation;
  operation[OPERATION_ROOT] = operation;
  return operation;
}

// Module-private: only `sessionSurfaceMembers` puts a session on a statement
// surface's members, and only `portOperationEntry` reads one back.
const SURFACE_SESSION: unique symbol = Symbol("typegraph.surfaceSession");

/**
 * Marks `members`, the overlay members of a statement surface a backend layer
 * builds for `session` alone (recorded capture's overlay, an engine-native
 * mutation witness), as that session's, and returns them: the surface
 * `deriveBackend` builds from them, and every derivation of it, carries the
 * session. An operation another copy of TypeGraph opened over that surface
 * hands it back as its undecorated holding, and {@link portOperationEntry}
 * re-enters it as an operation of `session`, so a runtime port member it
 * calls runs under the session's recorded binding and graph-lock memo. The
 * key is non-enumerable and module-private: no backend member lists or copies
 * it, and nothing else reads it.
 */
export function sessionSurfaceMembers<Members extends object>(
  session: TransactionSession,
  members: Members,
): Members {
  Object.defineProperty(members, SURFACE_SESSION, { value: session });
  return members;
}

/** A statement surface as {@link surfaceSession} reads it. */
type SessionCarryingSurface = Pick<OperationBackend, "dialect"> &
  Readonly<{ [SURFACE_SESSION]?: TransactionSession }>;

/** The session `surface` was built for ({@link sessionSurfaceMembers}), if any. */
function surfaceSession(
  surface: SessionCarryingSurface,
): TransactionSession | undefined {
  return surface[SURFACE_SESSION];
}

/**
 * THE test of whether `target` is a statement surface of `session`: what the
 * session holds or hands out, a backend derived from either through
 * `src/backend/derive-backend.ts`, or a surface a backend layer built for the
 * session ({@link sessionSurfaceMembers}), which carries the session through
 * every derivation of it, another copy of TypeGraph's included. Evidence the
 * session's operations earned (a recorded graph-lock memo) serves a statement
 * on `target` only when this holds. It reads which backend `target` is and
 * was derived from, never a value off one of its members.
 */
export function isSessionStatementSurface(
  session: TransactionSession,
  target: Pick<OperationBackend, "dialect">,
): boolean {
  if (surfaceSession(target) === session) return true;
  const chain: readonly object[] = backendDerivationChain(target);
  return (
    chain.includes(session[SESSION_CONTROL]) ||
    chain.includes(session[SESSION_TRANSACTION])
  );
}

/** Whether `operation` was minted by this copy of the module. */
function isOwnOperation(operation: Operation): boolean {
  return OPERATION_SESSION in operation;
}

/** The session `operation` belongs to. */
export function operationSession<Engine extends TransactionBackend>(
  operation: Operation<Engine>,
): TransactionSession {
  return operation[OPERATION_SESSION];
}

/** The session `entry` belongs to, or `undefined` for the root backend. */
export function operationEntrySession(
  entry: OperationEntry,
): TransactionSession | undefined {
  return OPERATION_SESSION in entry ? entry[OPERATION_SESSION] : undefined;
}

/** What `entry`'s statements go through: the root, or the operation's handle. */
export function operationEntryBackend(entry: OperationEntry): StatementBackend {
  return OPERATION_SESSION in entry ? entry.backend : entry;
}

/**
 * What `entry`'s control statements go through: the root, or the
 * operation's {@link Operation.control}.
 */
export function operationEntryControl(entry: OperationEntry): StatementBackend {
  return OPERATION_SESSION in entry ? entry.control : entry;
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
