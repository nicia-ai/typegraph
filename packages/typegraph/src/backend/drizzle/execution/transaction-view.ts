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
 * A transaction can also end before its boundary: on SQLite a failing
 * statement can take the transaction with it (a trigger's `RAISE(ROLLBACK)`),
 * and a callback that catches the failure and carries on would otherwise run
 * its next statement in autocommit. Where the driver reports transaction
 * state, the view asks it right after an admitted statement fails; once it
 * reports no transaction, every later statement is refused with a
 * {@link TransactionRolledBackError} — distinct from the
 * {@link TransactionClosedError} of a statement issued after the boundary —
 * and `drainAndClose` hands that error to the runner as the transaction's
 * outcome, so no `COMMIT` is sent.
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
import {
  TransactionClosedError,
  TransactionRolledBackError,
} from "../../../errors";

export type TransactionView = Readonly<{
  /**
   * Runs `task` if the view is open, remembering it until it settles; once
   * closed, returns a {@link TransactionClosedError} rejection without
   * running it, and once the engine ended the transaction (see
   * {@link TransactionViewOptions.isTransactionOpen}) a
   * {@link TransactionRolledBackError} rejection. `task` starts
   * synchronously, exactly as an unwrapped call.
   */
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * Refuses every later statement, then waits until every admitted one has
   * settled. Never rejects: a statement's outcome belongs to its own caller.
   * Resolves to the transaction's outcome when the engine ended it before
   * the boundary — a {@link TransactionRolledBackError} the runner rejects
   * with instead of committing — and to `undefined` otherwise. Idempotent.
   */
  drainAndClose: () => Promise<TransactionRolledBackError | undefined>;
}>;

export type TransactionViewOptions = Readonly<{
  /**
   * How the driver reports whether the transaction this view runs in is
   * still open, read once right after an admitted statement fails. A
   * failing statement can end the transaction in the engine itself (on
   * SQLite a trigger's `RAISE(ROLLBACK)`, or an error SQLite answers by
   * rolling back), and a statement admitted afterwards would run in
   * autocommit. Once the probe reports no transaction, every later
   * statement is refused with {@link TransactionRolledBackError}.
   * Omitted where the driver reports no transaction state, and on
   * PostgreSQL, where the server itself refuses every statement of an
   * aborted transaction.
   */
  isTransactionOpen?: () => boolean;
}>;

/**
 * Swallows an admitted statement's outcome: its caller owns the result, and
 * the drain only needs to know it settled.
 */
function ignoreOutcome(): void {
  // Intentionally empty: see above.
}

/** The outcome of a transaction the engine ended when `failure` failed. */
function engineEndedTransaction(failure: unknown): TransactionRolledBackError {
  return new TransactionRolledBackError(
    { conflict: false, detectedBy: "statement-failure", causeObserved: true },
    { cause: failure },
  );
}

export function createTransactionView(
  options: TransactionViewOptions = {},
): TransactionView {
  const { isTransactionOpen } = options;
  let closed = false;
  // The statement failure the engine ended the transaction with, once seen.
  let engineEnd: Readonly<{ failure: unknown }> | undefined;
  const inFlight = new Set<Promise<void>>();

  function observeFailure(failure: unknown): void {
    if (engineEnd !== undefined || isTransactionOpen === undefined) return;
    if (!isTransactionOpen()) engineEnd = { failure };
  }

  /**
   * Starts `task`. A synchronous driver (better-sqlite3) can throw from the
   * call itself rather than reject: that failure is observed too, and
   * rethrown as the unwrapped call would.
   */
  function startObserved<T>(task: () => Promise<T>): Promise<T> {
    try {
      return task();
    } catch (error) {
      observeFailure(error);
      throw error;
    }
  }

  return {
    admit<T>(task: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new TransactionClosedError());
      if (engineEnd !== undefined) {
        return Promise.reject(engineEndedTransaction(engineEnd.failure));
      }
      const started = startObserved(task);
      // The probe is read before the caller sees the failure, so a caller
      // that catches it and carries on is refused on its next statement.
      const result =
        isTransactionOpen === undefined ? started : (
          started.catch((error: unknown) => {
            observeFailure(error);
            throw error;
          })
        );
      const settled = result.then(ignoreOutcome, ignoreOutcome);
      inFlight.add(settled);
      void settled.then(() => inFlight.delete(settled));
      return result;
    },

    async drainAndClose(): Promise<TransactionRolledBackError | undefined> {
      closed = true;
      // An admitted statement cannot admit another once closed, so the set
      // only shrinks from here.
      while (inFlight.size > 0) {
        await Promise.all(inFlight);
      }
      return engineEnd === undefined ? undefined : (
          engineEndedTransaction(engineEnd.failure)
        );
    },
  };
}
