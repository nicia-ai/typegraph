/**
 * The one owner of when a transaction-scoped view of a connection stops
 * accepting statements.
 *
 * Every transaction TypeGraph opens hands its callback a backend bound to the
 * transaction's connection. That backend can outlive the callback: a
 * `Promise.all` that rejects orphans its siblings, a call started without being
 * awaited is still running, a prepared query or stream can be kept and used
 * later. When the transaction ends, the driver (or TypeGraph's own frame) issues
 * `COMMIT` / `ROLLBACK` on the connection, and a statement arriving afterwards
 * would run outside the transaction that issued it: in autocommit, or inside the
 * next transaction on the same connection.
 *
 * A view settles every statement admitted before the boundary, then refuses
 * every later one with a {@link TransactionClosedError}. Both dialects decide
 * "closed" here: PostgreSQL's statement queue admits through a view, and every
 * SQLite transaction wraps its execution adapter in one. A fresh view is made
 * per transaction attempt, so a retry never inherits a closed one.
 *
 * This is the driver-level guard: no statement reaches a transaction that has
 * ended. The open/closed fact lives here, in the closure of the one view the
 * engine builds per transaction it opens, and is carried to every statement
 * member by that binding's execution adapter: no registry, no lookup by
 * object. It is deliberately not on the Store's per-native-transaction state
 * (`session.native`, `src/store/native-transaction-state.ts`) and is not
 * reached from it. That state is the Store's; a hand-written backend has no
 * view, an adopted transaction's view is never closed (its caller ends it),
 * and a statement can reach the view without passing through any session (a
 * kept engine backend, prepared query, stream or trusted-import session). A
 * session-level rule — refusing a late Store call before any statement with
 * its own error, after waiting for calls already in flight — belongs on
 * `session.native`, runs before this guard, and needs nothing from it; this
 * guard stays the backstop beneath it.
 *
 * Edge-safe: no `node:*` imports.
 */
import { TransactionClosedError } from "../../../errors";

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
   * Idempotent.
   */
  drainAndClose: () => Promise<void>;
}>;

/**
 * Swallows an admitted statement's outcome: its caller owns the result, and
 * the drain only needs to know it settled.
 */
function ignoreOutcome(): void {
  // Intentionally empty: see above.
}

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
