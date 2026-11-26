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
 * Statements on one view reach the driver one at a time, in the order they
 * were admitted: a statement admitted while another is in flight starts once
 * that one has settled. The connection runs them one at a time anyway; the
 * order is what makes the next fact enforceable.
 *
 * A transaction can also end before its boundary: on SQLite a failing
 * statement can take the transaction with it (a trigger's `RAISE(ROLLBACK)`),
 * and a callback that catches the failure and carries on would otherwise run
 * its next statement in autocommit. Where the view is given a state probe,
 * it asks right after an admitted statement fails, and no later statement
 * starts until the answer is in — a sibling submitted in the same turn as
 * the failing one included. Unless the answer is that the transaction is
 * still open, every later statement is refused with a
 * {@link TransactionRolledBackError} — distinct from the
 * {@link TransactionClosedError} of a statement issued after the boundary —
 * and `drainAndClose` hands that error to the runner as the transaction's
 * outcome, so no `COMMIT` is sent. An answer of "unknown" ends the view as
 * "ended" does: no proof the transaction is open is no permission to run in
 * it.
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
   * running it, and once a failure ended the transaction (see
   * {@link TransactionViewOptions.transactionState}) a
   * {@link TransactionRolledBackError} rejection. On an idle view `task`
   * starts synchronously, exactly as an unwrapped call (a synchronous throw
   * is rethrown); while another admitted task is in flight, or a failure's
   * probe is still being answered, it starts after that settles.
   */
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * Refuses every later statement, then waits until every admitted one has
   * settled. Never rejects: a statement's outcome belongs to its own caller.
   * Resolves to the transaction's outcome when a failure ended the
   * transaction before the boundary — a {@link TransactionRolledBackError}
   * the runner rejects with instead of committing — and to `undefined`
   * otherwise. Idempotent.
   */
  drainAndClose: () => Promise<TransactionRolledBackError | undefined>;
}>;

/**
 * What a probe knows about the transaction a view runs in: still open, ended,
 * or `"unknown"` where the probe cannot tell (a driver flag that reports a
 * stream or handle rather than the engine's transaction, a read that failed).
 * The view treats `"unknown"` as `"ended"`.
 */
export type TransactionState = "open" | "ended" | "unknown";

export type TransactionViewOptions = Readonly<{
  /**
   * Asks whether the transaction this view runs in is still open, right
   * after an admitted statement fails and before any later statement
   * starts. A failing statement can end the transaction in the engine
   * itself (on SQLite a trigger's `RAISE(ROLLBACK)`, or an error SQLite
   * answers by rolling back), and a statement admitted afterwards would run
   * in autocommit. Unless the answer is `"open"`, every later statement is
   * refused with {@link TransactionRolledBackError}; a probe that throws
   * answers `"unknown"`. Omitted on PostgreSQL, where the server itself
   * refuses every statement of an aborted transaction, so a failure never
   * ends the view there.
   */
  transactionState?: () => TransactionState | Promise<TransactionState>;
}>;

/**
 * Swallows an admitted statement's outcome: its caller owns the result, and
 * the queue and the drain only need to know it settled.
 */
function ignoreOutcome(): void {
  // Intentionally empty: see above.
}

/** The outcome of a transaction a failure ended when `failure` failed. */
function engineEndedTransaction(failure: unknown): TransactionRolledBackError {
  return new TransactionRolledBackError(
    { conflict: false, detectedBy: "statement-failure", causeObserved: true },
    { cause: failure },
  );
}

export function createTransactionView(
  options: TransactionViewOptions = {},
): TransactionView {
  const { transactionState } = options;
  let closed = false;
  // The statement failure that ended the transaction, once a probe said so.
  let engineEnd: Readonly<{ failure: unknown }> | undefined;
  // Settles once every admitted task has settled and every probe a failure
  // started has answered; `pending` counts what it still waits for.
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  /** Waits for `step` before anything admitted later starts. */
  function enqueueStep(step: Promise<unknown>): void {
    pending += 1;
    tail = step.then(ignoreOutcome, ignoreOutcome).then(() => {
      pending -= 1;
    });
  }

  /** Asks the probe after `failure`, recording an end unless it is open. */
  async function observeFailure(failure: unknown): Promise<void> {
    if (engineEnd !== undefined || transactionState === undefined) return;
    let state: TransactionState;
    try {
      state = await transactionState();
    } catch {
      state = "unknown";
    }
    if (state !== "open") engineEnd ??= { failure };
  }

  /**
   * Starts `task` in its turn, refusing it if a failure ended the
   * transaction meanwhile. A failure is observed before the returned
   * promise settles, so a caller that catches it and carries on is refused
   * on its next statement.
   */
  function runTurn<T>(task: () => Promise<T>): Promise<T> {
    if (engineEnd !== undefined) {
      return Promise.reject(engineEndedTransaction(engineEnd.failure));
    }
    return task().catch(async (error: unknown) => {
      await observeFailure(error);
      throw error;
    });
  }

  return {
    admit<T>(task: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new TransactionClosedError());
      if (engineEnd !== undefined) {
        return Promise.reject(engineEndedTransaction(engineEnd.failure));
      }
      if (pending > 0) {
        // Started from a promise callback, where a synchronous throw becomes
        // a rejection once observed. `runTurn` handles the task's own
        // promise in the turn it is created: a driver that rejects at once
        // (Durable Object storage) never leaves it unhandled.
        const result = tail.then(() => {
          try {
            return runTurn(task);
          } catch (error) {
            return observeFailure(error).then(() => {
              throw error;
            });
          }
        });
        enqueueStep(result);
        return result;
      }
      let result: Promise<T>;
      try {
        result = runTurn(task);
      } catch (error) {
        // A synchronous driver (better-sqlite3) can throw from the call
        // itself rather than reject: nothing later starts until the probe
        // has answered, and the failure is rethrown as the unwrapped call
        // would.
        enqueueStep(observeFailure(error));
        throw error;
      }
      enqueueStep(result);
      return result;
    },

    async drainAndClose(): Promise<TransactionRolledBackError | undefined> {
      closed = true;
      // Nothing is admitted once closed, so `pending` only falls from here.
      while (pending > 0) {
        await tail;
      }
      return engineEnd === undefined ? undefined : (
          engineEndedTransaction(engineEnd.failure)
        );
    },
  };
}
