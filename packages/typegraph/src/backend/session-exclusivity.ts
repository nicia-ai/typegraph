/**
 * Turn-taking for TypeGraph work on one open transaction session.
 *
 * A savepoint's rollback undoes every statement issued on its session since
 * the savepoint was taken, whoever issued it. Calls made inside one
 * `store.transaction()` callback may overlap (`Promise.all`), so without a
 * rule a call that rolls its savepoint back after a caught failure would also
 * undo a sibling call's completed, successfully reported writes. This module
 * is the one owner of that rule: a unit of work that holds a session's
 * exclusivity has the session to itself, and an overlapping unit on the same
 * session waits for it to finish.
 *
 * A unit is a whole public call — a collection method, a heterogeneous
 * upsert batch, a merge apply — not only its statements: everything the call
 * decides from session state (a lookup with an early return, a pristine
 * check, a capture or lock-memo checkpoint) is read inside its turn, so no
 * sibling can change that state between the read and the write it decides.
 *
 * Exclusivity is hierarchical. A unit started from inside a live holder — a
 * write a savepoint scope makes, a scope a write frame opens, the embedding
 * and fulltext sync a node write issues — is part of the holder and does not
 * wait for it; such nested units take turns among themselves under their
 * holder instead. A holder stays live, and keeps the session, until its own
 * work and every unit nested in it have finished. A continuation that outlives
 * its holder (a callback scheduled inside it that runs later) no longer
 * qualifies as nested: it takes its turn at the nearest enclosing holder that
 * is still live, or at the session's top level.
 *
 * Nesting is read from the async call graph through `AsyncLocalStorage`
 * (loaded by {@link createAsyncContextLoader}). On a runtime without it,
 * nested and overlapping units cannot be told apart, and waiting on an
 * indistinguishable nested unit would deadlock it, so units run without
 * turn-taking there, as they did before this module existed.
 *
 * The session is the native transaction the backend executes on, registered
 * by the dialect when it binds a transaction backend
 * ({@link registerNativeTransactionSession}). Two bindings of one native
 * transaction — the context `store.transaction()` hands its callback and
 * `store.withTransaction(tx.sql)` adopting that same handle — therefore share
 * one turn order, as does every decoration of either (recorded capture,
 * mutation witnesses, scoped receipt contexts, test overlays), found through
 * the backend's derivation chain. A backend no dialect registered is its own
 * session, identified by the root of its derivation chain.
 */
import { createAsyncContextLoader } from "./async-context";
import { statementExecutionVerdict } from "./capabilities/resolve";
import {
  backendDerivationChain,
  backendDerivationRoot,
} from "./derive-backend";
import { type GraphBackend, type TransactionBackend } from "./types";

/** A FIFO turn order: one holder's nested units, or a session's top level. */
interface TurnOrder {
  tail: Promise<void>;
  /** Units queued on or running in this order and not yet finished. */
  pending: number;
  /** The unit whose turn it is, until it is released. */
  running: Holder | undefined;
}

/** One unit's hold on a session while it runs. */
interface Holder {
  /** The turn order of the units nested directly inside this holder. */
  readonly nested: TurnOrder;
  readonly parent: Holder | undefined;
  /** Set once the unit and every unit nested in it have finished. */
  released: boolean;
}

/** The innermost holder, per session, of the current async execution. */
type HeldSessions = ReadonlyMap<object, Holder>;

const heldSessionsLoader = createAsyncContextLoader<HeldSessions>();

/** Top-level turn order of each session, for units no live holder encloses. */
const sessionTurnOrders = new WeakMap<object, TurnOrder>();

/** The native transaction each dialect-bound transaction backend runs on. */
const nativeTransactionSessions = new WeakMap<object, object>();

/** Waiters for {@link nextParkedSessionUnit}, per session. */
const parkedUnitWaiters = new WeakMap<object, (() => void)[]>();

/**
 * Records that `backend` executes on the native transaction `native`, so every
 * binding of that transaction takes turns in one order. Called by a dialect
 * where it binds a transaction backend to its driver's transaction handle.
 */
export function registerNativeTransactionSession(
  backend: object,
  native: object,
): void {
  nativeTransactionSessions.set(backend, native);
}

/** The session `target` executes on: its native transaction when registered. */
function transactionSessionOf(target: object): object {
  for (const link of backendDerivationChain(target)) {
    const native = nativeTransactionSessions.get(link);
    if (native !== undefined) return native;
  }
  return backendDerivationRoot(target);
}

function topLevelTurnOrder(session: object): TurnOrder {
  const existing = sessionTurnOrders.get(session);
  if (existing !== undefined) return existing;
  const created: TurnOrder = {
    tail: Promise.resolve(),
    pending: 0,
    running: undefined,
  };
  sessionTurnOrders.set(session, created);
  return created;
}

/** The innermost holder of `session` in `held` that has not been released. */
function liveHolder(
  held: HeldSessions | undefined,
  session: object,
): Holder | undefined {
  let holder = held?.get(session);
  while (holder?.released === true) holder = holder.parent;
  return holder;
}

function ignoreOutcome(): void {
  // The tail only tracks completion; the caller owns the unit's outcome.
}

function notifyParkedUnit(session: object): void {
  const waiters = parkedUnitWaiters.get(session);
  if (waiters === undefined) return;
  parkedUnitWaiters.delete(session);
  for (const notify of waiters) notify();
}

/**
 * @internal Test seam: resolves the next time a unit on the session `target`
 * executes on is queued behind an unfinished unit — that is, provably parked
 * rather than running. Lets a test establish that an overlapping call is
 * waiting for its turn without guessing how long reaching SQL would take.
 */
export function nextParkedSessionUnit(target: object): Promise<void> {
  const session = transactionSessionOf(target);
  return new Promise((resolve) => {
    const waiters = parkedUnitWaiters.get(session) ?? [];
    waiters.push(resolve);
    parkedUnitWaiters.set(session, waiters);
  });
}

/**
 * Runs `unit` with exclusive use of the transaction session `target` executes
 * on. A unit nested inside a live holder of the same session runs inside that
 * holder's turn, after the holder's earlier nested units; any other unit
 * waits for the session's earlier top-level units.
 */
export async function withExclusiveSessionUse<T>(
  target: object,
  unit: () => Promise<T>,
): Promise<T> {
  if (heldSessionsLoader.current() === undefined) {
    await heldSessionsLoader.ready();
  }
  const context = heldSessionsLoader.current();
  if (context === undefined) return unit();

  const session = transactionSessionOf(target);
  const held = context.getStore();
  const enclosing = liveHolder(held, session);
  const turnOrder = enclosing?.nested ?? topLevelTurnOrder(session);
  const holder: Holder = {
    nested: { tail: Promise.resolve(), pending: 0, running: undefined },
    parent: enclosing,
    released: false,
  };
  const heldInside = new Map(held);
  heldInside.set(session, holder);

  const parked = turnOrder.pending > 0;
  turnOrder.pending += 1;
  const turn = turnOrder.tail.then(() => {
    turnOrder.running = holder;
    return context.run(heldInside, unit);
  });
  // The turn ends when the unit has finished AND every unit queued inside it
  // has: a nested unit the holder started without awaiting still runs on
  // the session the holder was given, so the next unit waits for it too.
  turnOrder.tail = turn
    .then(ignoreOutcome, ignoreOutcome)
    .then(() => releaseWhenDrained(holder, turnOrder));
  if (parked) notifyParkedUnit(session);
  return turn;
}

/**
 * Releases `holder` once no unit is left queued inside it. The release and the
 * check that the nested order is drained happen in one synchronous step, so a
 * unit cannot join the nested order after the check and then run released.
 */
async function releaseWhenDrained(
  holder: Holder,
  turnOrder: TurnOrder,
): Promise<void> {
  for (;;) {
    const observed = holder.nested.tail;
    await observed;
    if (observed === holder.nested.tail) {
      holder.released = true;
      turnOrder.pending -= 1;
      if (turnOrder.running === holder) turnOrder.running = undefined;
      return;
    }
  }
}

/**
 * Whether a unit the current execution is not part of holds the session
 * `target` executes on right now. Synchronous session state a caller changes
 * outside any turn — a request a later commit honors — would be erased if that
 * unit rolled back a savepoint; such a change is refused while this answers
 * `true`.
 */
export function isSessionHeldByAnotherUnit(target: object): boolean {
  const context = heldSessionsLoader.current();
  if (context === undefined) return false;
  const session = transactionSessionOf(target);
  const enclosing = liveHolder(context.getStore(), session);
  const turnOrder =
    enclosing === undefined ? sessionTurnOrders.get(session) : enclosing.nested;
  return turnOrder?.running !== undefined;
}

/**
 * Whether `backend` is an open transaction session a TypeGraph savepoint can
 * be taken on, and so a session its units take turns on.
 *
 * A backend with `transaction` is a root: it opens a transaction per unit and
 * shares no session. A session without statement execution takes no
 * TypeGraph savepoint, so there is no rollback to guard against.
 */
export function takesSessionTurns(
  backend: GraphBackend | TransactionBackend,
): boolean {
  return (
    !("transaction" in backend) &&
    statementExecutionVerdict(backend as GraphBackend).supported
  );
}

/**
 * Runs one public call's `unit` in its turn on `backend`'s session when
 * {@link takesSessionTurns} says the backend is one, and directly otherwise.
 * The one gate every entry point on a caller-owned transaction goes through.
 */
export function withSessionTurn<T>(
  backend: GraphBackend | TransactionBackend,
  unit: () => Promise<T>,
): Promise<T> {
  if (!takesSessionTurns(backend)) return unit();
  return withExclusiveSessionUse(backend, unit);
}

/**
 * Runs `unit` as one turn on the native transaction `native` a caller
 * handed TypeGraph to adopt — the same turn order every backend bound to that
 * transaction takes turns in ({@link registerNativeTransactionSession}). For
 * work that issues statements on the adopted transaction before any context
 * exists for it, and after its callback returns. A handle that is not an
 * object identifies no session and takes no turn.
 */
export function withNativeTransactionTurn<T>(
  native: unknown,
  unit: () => Promise<T>,
): Promise<T> {
  if (typeof native !== "object" || native === null) return unit();
  return withExclusiveSessionUse(native, unit);
}
