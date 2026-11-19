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
 * Exclusivity is hierarchical. A unit started from inside a holder — a write
 * a savepoint scope makes, a scope a write frame opens, the embedding and
 * fulltext sync a node write issues — is part of the holder and does not wait
 * for it; such nested units take turns among themselves under their holder
 * instead. Nesting is read from the async call graph through
 * `AsyncLocalStorage` (loaded by {@link createAsyncContextLoader}). On a
 * runtime without it, nested and overlapping units cannot be told apart, and
 * waiting on an indistinguishable nested unit would deadlock it, so units run
 * without turn-taking there, as they did before this module existed.
 *
 * The session is identified by the root of the backend's derivation chain, so
 * every decoration of one transaction backend — recorded capture, mutation
 * witnesses, scoped receipt contexts, test overlays — shares one turn order.
 */
import { createAsyncContextLoader } from "./async-context";
import { backendDerivationRoot } from "./derive-backend";

/** One holder's FIFO turn order for the units nested directly inside it. */
interface TurnOrder { tail: Promise<void> }

/** The innermost holder, per session, of the current async execution. */
type HeldSessions = ReadonlyMap<object, TurnOrder>;

const heldSessionsLoader = createAsyncContextLoader<HeldSessions>();

/** Top-level turn order of each session, for units no holder encloses. */
const sessionTurnOrders = new WeakMap<object, TurnOrder>();

function topLevelTurnOrder(session: object): TurnOrder {
  const existing = sessionTurnOrders.get(session);
  if (existing !== undefined) return existing;
  const created: TurnOrder = { tail: Promise.resolve() };
  sessionTurnOrders.set(session, created);
  return created;
}

function ignoreOutcome(): void {
  // The tail only tracks completion; the caller owns the unit's outcome.
}

/**
 * Runs `unit` with exclusive use of the transaction session `target` executes
 * on. A unit nested inside another holder of the same session runs inside
 * that holder's turn, after the holder's earlier nested units.
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

  const session = backendDerivationRoot(target);
  const held = context.getStore();
  const turnOrder = held?.get(session) ?? topLevelTurnOrder(session);
  const nested: TurnOrder = { tail: Promise.resolve() };
  const heldInside = new Map(held);
  heldInside.set(session, nested);

  const turn = turnOrder.tail.then(() => context.run(heldInside, unit));
  turnOrder.tail = turn.then(ignoreOutcome, ignoreOutcome);
  return turn;
}
