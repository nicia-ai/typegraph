/**
 * The one owner of when a transaction-scoped view of a connection stops
 * accepting statements.
 *
 * Every transaction TypeGraph opens hands its callback a backend bound to the
 * transaction's connection. That backend can outlive the callback: a
 * `Promise.all` that rejects orphans its siblings, a call started without being
 * awaited is still running, a prepared query or stream can be kept and used
 * later, and a backend the callback adopted over the transaction's native
 * handle (`adoptTransaction(native)`) can be kept too. When the transaction
 * ends, the driver (or TypeGraph's own frame) issues `COMMIT` / `ROLLBACK` on
 * the connection, and a statement arriving afterwards would run outside the
 * transaction that issued it: in autocommit, or inside the next transaction
 * on the same connection.
 *
 * A view settles every statement admitted before the boundary, then refuses
 * every later one with a {@link TransactionClosedError}. Both dialects decide
 * "closed" here: PostgreSQL's statement queue admits through a view, and every
 * SQLite transaction wraps its execution adapter in one. A fresh view is made
 * per transaction attempt, so a retry never inherits a closed one.
 *
 * ONE VIEW PER NATIVE TRANSACTION. The open/closed fact belongs to the native
 * transaction, as the engine's record identifies it
 * (`src/backend/native-transaction-handle.ts`, the identity the Store's
 * per-native-transaction state is keyed by): the bind that opens a
 * transaction (its owner) creates the view and registers it under that
 * identity, and a bind that adopts a handle proven to run on the same
 * transaction admits through the same view
 * ({@link openTransactionView}). The owner's runner closes it, so its drain
 * waits for statements admitted through every view of the transaction and
 * refuses every later one, through the owner's backend or an adopted one.
 *
 * Where an adoption cannot be proven to run on a transaction TypeGraph
 * opened (no proof: a driver that cannot report its transaction state, such
 * as sql.js, `@libsql/client` before 0.18 and Durable Object storage; or a
 * transaction the caller opened), the adopted bind gets a view of its own
 * that is never closed: its statements reach the driver exactly as on a
 * backend without a view. A savepoint the engine opened runs in the
 * transaction that encloses it, which another bind owns: its own view closes
 * with the savepoint and is not registered for the enclosing transaction.
 *
 * Edge-safe: no `node:*` imports.
 */
import { TransactionClosedError } from "../../../errors";
import { isEngineSavepoint } from "../../native-transaction-handle";

export type TransactionView = Readonly<{
  /**
   * Runs `task` if the view is open, remembering it until it settles; once
   * closed, returns a {@link TransactionClosedError} rejection without
   * running it. `task` starts synchronously, exactly as an unwrapped call.
   */
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * Refuses every later statement, then waits until every admitted one has
   * settled. Never rejects: a statement's outcome belongs to its own caller.
   * Idempotent. Only the transaction's owner calls it.
   */
  drainAndClose: () => Promise<void>;
}>;

/**
 * Whether a bind opens the transaction it runs on and closes the view at the
 * transaction's end (`owner`), or adopts a handle on a transaction that is
 * already open (`adoption`) and never closes a view.
 */
export type TransactionViewRole = "adoption" | "owner";

/**
 * Swallows an admitted statement's outcome: its caller owns the result, and
 * the drain only needs to know it settled.
 */
function ignoreOutcome(): void {
  // Intentionally empty: see above.
}

/**
 * A fresh view no other bind reaches: what {@link openTransactionView} builds,
 * and a backend root statement queue, which no transaction boundary closes.
 */
export function createTransactionView(): TransactionView {
  let closed = false;
  const inFlight = new Set<Promise<void>>();

  return {
    admit<T>(task: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new TransactionClosedError());
      const result = task();
      const settled = result.then(ignoreOutcome, ignoreOutcome);
      inFlight.add(settled);
      void settled.then(() => inFlight.delete(settled));
      return result;
    },

    async drainAndClose(): Promise<void> {
      closed = true;
      // An admitted statement cannot admit another once closed, so the set
      // only shrinks from here.
      while (inFlight.size > 0) {
        await Promise.all(inFlight);
      }
    },
  };
}

/** A native transaction TypeGraph opened → the view its owner closes. */
const OWNED_TRANSACTION_VIEWS = new WeakMap<object, TransactionView>();

/**
 * The view one bind admits its statements through.
 *
 * `nativeTransaction` is the identity the bind recorded
 * (`identifyNativeTransaction`, or its opener's token); `handle` is the
 * driver handle it binds. An owner gets a fresh view, registered under
 * `nativeTransaction` unless `handle` is a savepoint the engine opened. An
 * adoption gets the view its transaction's owner registered, and a fresh
 * one, never closed, when no owner is proven.
 */
export function openTransactionView(
  role: TransactionViewRole,
  nativeTransaction: object | undefined,
  handle: object,
): TransactionView {
  if (role === "adoption") {
    const owned =
      nativeTransaction === undefined ? undefined : (
        OWNED_TRANSACTION_VIEWS.get(nativeTransaction)
      );
    return owned ?? createTransactionView();
  }
  const view = createTransactionView();
  if (nativeTransaction !== undefined && !isEngineSavepoint(handle)) {
    OWNED_TRANSACTION_VIEWS.set(nativeTransaction, view);
  }
  return view;
}
