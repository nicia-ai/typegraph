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
 * Ordering belongs to the connection, not the view: an admitted statement is
 * enqueued at once on the one statement queue of the connection
 * (`./connection-statement-queue`), so statements reach the driver one at a
 * time in submission order across every view of that connection, and the
 * view only tracks what it enqueued for its drain.
 *
 * A transaction can also end before its boundary without TypeGraph's
 * `COMMIT` or `ROLLBACK`: on SQLite a failing statement can take the
 * transaction with it (a trigger's `RAISE(ROLLBACK)`, an `ON CONFLICT
 * ROLLBACK` constraint, an error SQLite answers by rolling back), and a
 * statement the view never sees can end it (one sent through the native
 * handle, a caller's own `COMMIT` / `ROLLBACK`). A statement admitted
 * afterwards would run in autocommit. Where the driver's own flag reflects
 * the engine, the view asks it before every statement starts and at the
 * boundary ({@link TransactionViewOptions.engineState}), so the end is found
 * whatever caused it. Where no flag can answer, the view asks right after an
 * SQL execution failure ({@link TransactionViewOptions.stateAfterFailure}),
 * and an answer other than "open" ends it. Once ended, every later statement
 * is refused with the ended outcome — a {@link TransactionRolledBackError}
 * when a failure the view observed ended it, a
 * {@link TransactionOutcomeUnknownError} (`"transaction-ended"`) when the
 * engine reports an end the view did not observe — and `drainAndClose`
 * hands that outcome to the runner, so no `COMMIT` is sent.
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
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
  TypeGraphError,
} from "../../../errors";
import {
  type ConnectionStatementQueue,
  createConnectionStatementQueue,
} from "./connection-statement-queue";

/**
 * How a view learned that its transaction ended before its boundary: a
 * statement it admitted failed and the engine then answered that the
 * transaction had ended, or the engine answered so with no failure the view
 * observed (a statement through the native handle, a caller's own
 * `COMMIT` / `ROLLBACK`).
 */
export type TransactionViewEndedOutcome =
  TransactionRolledBackError | TransactionOutcomeUnknownError;

export type TransactionView = Readonly<{
  /**
   * Admits `task` (one statement) if the view is open: it is enqueued on the
   * connection's statement queue at once, in submission order across every
   * view of that connection, and remembered until it settles. Once closed,
   * returns a {@link TransactionClosedError} rejection without running it;
   * once the transaction is known to have ended, the ended outcome
   * ({@link TransactionViewEndedOutcome}). On an idle queue `task` starts
   * synchronously, exactly as an unwrapped call (a synchronous throw is
   * rethrown).
   */
  admit: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * Refuses every later statement, then waits until every statement
   * submitted on the connection so far has settled. Never rejects: a
   * statement's outcome belongs to its own caller. Resolves to the
   * transaction's outcome when it ended before the boundary — the runner
   * rejects with it instead of committing — and to `undefined` otherwise.
   * Idempotent.
   */
  drainAndClose: () => Promise<TransactionViewEndedOutcome | undefined>;
}>;

/**
 * What a probe knows about the transaction a view runs in: still open, ended,
 * or `"unknown"` where the probe cannot tell (a driver flag that reports a
 * stream or handle rather than the engine's transaction, a read that failed).
 */
export type TransactionState = "open" | "ended" | "unknown";

export type TransactionViewOptions = Readonly<{
  /**
   * The statement queue of the connection the transaction runs on
   * (`connectionStatementQueue`), shared by every view of that connection;
   * a queue of the view's own when omitted.
   */
  queue?: ConnectionStatementQueue | undefined;
  /**
   * The engine's own answer, read synchronously on the pinned session,
   * whether the transaction is still open: given only where the driver's
   * flag reflects the engine (better-sqlite3 and bun:sqlite `inTransaction`,
   * a local libSQL transaction's `closed`). Read before every statement
   * starts and at the boundary; anything but `"open"` ends the view, so a
   * transaction that ended by any route — one the view never saw included —
   * runs nothing further and is not committed.
   */
  engineState?: (() => TransactionState) | undefined;
  /**
   * Where there is no {@link engineState}: asked right after an admitted
   * statement fails with an SQL execution failure
   * ({@link isSqlExecutionFailure}), before any later statement starts.
   * Unless the answer is `"open"`, every later statement is refused; a probe
   * that throws answers `"unknown"`. Omitted on PostgreSQL, where the server
   * itself refuses every statement of an aborted transaction.
   */
  stateAfterFailure?:
    (() => TransactionState | Promise<TransactionState>) | undefined;
}>;

/**
 * Whether `error`, the rejection of an admitted statement, is an SQL
 * execution failure — one that may have ended the transaction in the engine
 * — rather than a typed refusal TypeGraph raised itself (a
 * {@link TypeGraphError}: a missing contribution marker after a marker read
 * that succeeded, a statement refused before it ran). THE one classification
 * the view's failure probing uses.
 */
export function isSqlExecutionFailure(error: unknown): boolean {
  return !(error instanceof TypeGraphError);
}

type EngineEnd =
  | Readonly<{ observed: true; failure: unknown }>
  | Readonly<{ observed: false }>;

/** The outcome of a transaction that ended as `end` records. */
function endedOutcome(end: EngineEnd): TransactionViewEndedOutcome {
  return end.observed ?
      new TransactionRolledBackError(
        {
          conflict: false,
          detectedBy: "statement-failure",
          causeObserved: true,
        },
        { cause: end.failure },
      )
    : new TransactionOutcomeUnknownError({ reason: "transaction-ended" });
}

/** A probe's answer; a probe that throws answers `"unknown"`. */
function readState(probe: () => TransactionState): TransactionState {
  try {
    return probe();
  } catch {
    return "unknown";
  }
}

/**
 * Swallows an admitted statement's outcome: its caller owns the result, and
 * the drain only needs to know it settled.
 */
function ignoreOutcome(): void {
  // Intentionally empty: see above.
}

export function createTransactionView(
  options: TransactionViewOptions = {},
): TransactionView {
  const { engineState, stateAfterFailure } = options;
  const queue = options.queue ?? createConnectionStatementQueue();
  let closed = false;
  let engineEnd: EngineEnd | undefined;
  // Every statement this view admitted that has not settled yet.
  const inFlight = new Set<Promise<unknown>>();

  /**
   * Asks whether a failure ended the transaction, before the failing
   * statement's queue slot is released: nothing later on the connection
   * starts until the answer is in.
   */
  function observeFailure(failure: unknown): void | Promise<void> {
    if (engineEnd !== undefined || !isSqlExecutionFailure(failure)) return;
    if (engineState !== undefined) {
      if (readState(engineState) !== "open") {
        engineEnd = { observed: true, failure };
      }
      return;
    }
    if (stateAfterFailure === undefined) return;
    return Promise.resolve()
      .then(() => stateAfterFailure())
      .catch((): TransactionState => "unknown")
      .then((state) => {
        if (state !== "open") engineEnd ??= { observed: true, failure };
      });
  }

  /** Why a statement may not start now, if it may not. */
  function refusalAtStart(): TransactionViewEndedOutcome | undefined {
    if (
      engineEnd === undefined &&
      engineState !== undefined &&
      readState(engineState) !== "open"
    )
      engineEnd = { observed: false };
    return engineEnd === undefined ? undefined : endedOutcome(engineEnd);
  }

  /**
   * Rejects with `failure` once the probe has answered. Pending when it is
   * returned, so a callback that returns it never hands over an
   * already-rejected promise that would sit unhandled until it is adopted.
   */
  async function failAfterObserving(failure: unknown): Promise<never> {
    await observeFailure(failure);
    throw failure;
  }

  return {
    admit<T>(task: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new TransactionClosedError());
      if (engineEnd !== undefined) {
        return Promise.reject(endedOutcome(engineEnd));
      }
      // A failure the driver throws from the call itself (better-sqlite3)
      // while the statement starts in this call, to rethrow as the
      // unwrapped call would.
      let synchronousFailure: Readonly<{ error: unknown }> | undefined;
      let startedInCall = true;
      const result = queue.enqueue((): Promise<T> => {
        const refusal = refusalAtStart();
        // Thrown, not returned: the queue turns it into its own rejection.
        if (refusal !== undefined) throw refusal;
        let started: Promise<T>;
        try {
          started = task();
        } catch (error) {
          if (startedInCall) synchronousFailure = { error };
          return failAfterObserving(error);
        }
        // Handled in the turn it is created: a driver that rejects at once
        // (Durable Object storage) never leaves it unhandled.
        return started.then(undefined, (error: unknown) =>
          failAfterObserving(error),
        );
      });
      startedInCall = false;
      inFlight.add(result);
      void result.then(ignoreOutcome, ignoreOutcome).then(() => {
        inFlight.delete(result);
      });
      if (synchronousFailure !== undefined) {
        result.catch(ignoreOutcome);
        throw synchronousFailure.error;
      }
      return result;
    },

    async drainAndClose(): Promise<TransactionViewEndedOutcome | undefined> {
      closed = true;
      // Nothing is admitted once closed, so `inFlight` only shrinks.
      while (inFlight.size > 0) {
        await Promise.allSettled(inFlight);
      }
      // Statements of other views of the connection submitted before the
      // boundary settle before it too.
      await queue.drain();
      return refusalAtStart();
    },
  };
}
