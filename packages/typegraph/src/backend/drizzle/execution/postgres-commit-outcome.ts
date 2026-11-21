/**
 * The one owner of "may the PostgreSQL transaction TypeGraph opened be
 * committed?" for every transaction a bundled PostgreSQL backend opens and
 * commits itself (`capabilities.execution.commitOutcome: "session-marker"`).
 *
 * A statement that fails inside a PostgreSQL transaction aborts the whole
 * transaction, whether or not the code that issued it catches the error;
 * the server then answers the closing `COMMIT` with `ROLLBACK`, which
 * node-postgres, neon-serverless and PGlite report as a success. A caller
 * holding the native `tx.sql` handle can also end the transaction itself
 * (`COMMIT`, `ROLLBACK`) and even open another (`BEGIN`), after which a
 * `COMMIT` TypeGraph sends would close a transaction it never opened.
 *
 * The evidence is a marker that identifies the transaction itself: right
 * after the transaction opens, a transaction-local setting
 * (`SET LOCAL typegraph.transaction_marker = 'open'`); right before the
 * `COMMIT`, a read of that setting on the same session, through the
 * connection's statement queue so it never overlaps a statement still
 * running. A transaction-local setting lives exactly as long as the
 * transaction that set it — whether the transaction ends in `COMMIT` or
 * `ROLLBACK` — and survives a caller's `ROLLBACK TO SAVEPOINT`, since it was
 * set before any savepoint the caller could take. The read decides:
 *
 * - It returns the marker: the session is still inside the transaction
 *   TypeGraph opened, and that transaction is healthy. Commit.
 * - It is refused with `25P02`: that transaction is aborted. Reject with
 *   {@link TransactionRolledBackError}.
 * - It returns anything else: the transaction TypeGraph opened was ended,
 *   and possibly replaced, by a statement TypeGraph did not issue. Do not
 *   commit; reject with {@link TransactionOutcomeUnknownError}, which is
 *   never retried — whatever ended the transaction may have committed it.
 *
 * The marker is planted with `SET LOCAL`, not `SELECT set_config(...)`: a
 * `SET` takes no snapshot, so a `REPEATABLE READ` or `SERIALIZABLE`
 * transaction still takes its snapshot at the callback's first statement,
 * exactly as it did before the marker existed. The value is a constant, which
 * `SET` (it binds no parameters) and statement caching both prefer: no
 * other transaction can set it on this session, since the setting ends with
 * the transaction that set it and a nested transaction (a savepoint on this
 * one) plants none, so its presence alone identifies the transaction.
 *
 * A transaction-local setting is preferred to a savepoint marker: both
 * survive a caller's savepoint rollback and both distinguish the three
 * outcomes, but a savepoint held for the whole transaction puts every later
 * write inside a subtransaction, which costs each writing transaction a
 * second transaction id.
 *
 * Errors observed on the session no longer decide anything. They supply the
 * rejection's `cause` — the first error that reached the engine (it carries
 * a SQLSTATE; a driver's client-side refusal is not a cause) — and its
 * retry classification: a rolled-back transaction is a conflict, re-run
 * under `retry: { attempts }`, when any engine error observed in the attempt
 * was a serialization failure or deadlock. They are observed on the pinned
 * driver client, which every statement on the transaction passes through:
 * Drizzle's session (and so the native `tx.sql` handle, its relational
 * queries included) and TypeGraph's compiled fast path both read it when
 * they prepare a statement.
 *
 * One driver needs the observation for more than that. postgres-js tracks
 * the first failed statement of a transaction scope and, when the scope's
 * callback resolves, rolls back and rethrows that failure in place of
 * committing — even when a raw `ROLLBACK TO SAVEPOINT` recovered the session
 * and the marker read succeeded. A rejection that is the very error a
 * statement of the transaction failed with before TypeGraph handed the
 * transaction back to its driver is that substitution, so it is reported as
 * the {@link TransactionRolledBackError} it is.
 */
import {
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
} from "../../../errors";
import { sql } from "../../../query/sql-fragment";
import {
  carriesEngineSqlState,
  isPostgresFailedTransactionError,
} from "../../../utils/sql-errors";
import {
  type AnyPgTransaction,
  createPostgresExecutionAdapter,
  getPinnedPostgresTransactionConnection,
  hasFunctionProperty,
  replacePinnedPostgresTransactionClient,
} from "./postgres-execution";
import { createSerialExecutionAdapter } from "./statement-queue";

/** The commit check of one TypeGraph-opened transaction. */
export type PostgresTransactionMarker = Readonly<{
  /**
   * Resolves when the transaction TypeGraph opened is still open and healthy
   * on its session. Rejects with {@link TransactionRolledBackError} when it
   * is aborted, and with {@link TransactionOutcomeUnknownError} when the
   * session is no longer inside it. Call it after every statement the
   * transaction issued has settled; a call with no statement sent since the
   * last successful one answers from that read.
   */
  assertCommittable: () => Promise<void>;
}>;

/**
 * The transaction-local setting that carries the marker. Namespaced so it
 * cannot collide with an application's own custom setting. Both marker
 * statements name it in their text and bind no parameters.
 */
export const TRANSACTION_MARKER_SETTING = "typegraph.transaction_marker";

/** The marker's value while the transaction that set it is open. */
const MARKER_VALUE = "open";

const PLANT_MARKER_STATEMENT = sql.raw(
  `SET LOCAL ${TRANSACTION_MARKER_SETTING} = '${MARKER_VALUE}'`,
);

const READ_MARKER_STATEMENT = sql.raw(
  `SELECT current_setting('${TRANSACTION_MARKER_SETTING}', true) AS marker`,
);

/**
 * Driver-client members that send a statement and return its pending result:
 * node-postgres and PGlite `query`, PGlite `exec` and `sql`, postgres-js
 * `unsafe`. A postgres-js client is also callable as a tagged template.
 */
const STATEMENT_MEMBERS: ReadonlySet<PropertyKey> = new Set([
  "query",
  "exec",
  "sql",
  "unsafe",
]);

/**
 * The driver-client member that opens a nested scope and hands its callback a
 * client of its own: postgres-js `savepoint`, behind Drizzle's nested
 * transactions and TypeGraph's driver savepoint scopes. That client sends its
 * statements on the same session, so it is observed too.
 */
const SCOPED_CLIENT_MEMBER = "savepoint";

/** What one transaction attempt observed on its session. */
interface AttemptEvidence {
  /** Statements sent through the observed client; `undefined` when unobserved. */
  statements: number | undefined;
  /** The first failure that reached the engine. */
  firstEngineError: unknown;
  /** Whether any failure that reached the engine was a conflict. */
  conflict: boolean;
  /** Every failure a statement settled with, by identity. */
  readonly failures: WeakSet<object>;
  /** Whether the marker was found and the transaction handed back to its driver to commit. */
  handedToDriver: boolean;
}

type StatementObserver = Readonly<{
  sent: () => void;
  failed: (error: unknown) => void;
}>;

function createStatementObserver(
  evidence: AttemptEvidence,
  isConflict: (error: unknown) => boolean,
): StatementObserver {
  return {
    sent() {
      evidence.statements = (evidence.statements ?? 0) + 1;
    },
    failed(error) {
      if (typeof error === "object" && error !== null) {
        evidence.failures.add(error);
      }
      if (!carriesEngineSqlState(error)) return;
      if (evidence.firstEngineError === undefined) {
        evidence.firstEngineError = error;
      }
      if (!evidence.conflict && isConflict(error)) evidence.conflict = true;
    },
  };
}

/**
 * Observes a statement's pending result without consuming it or changing its
 * outcome. A native promise gets a side branch whose own rejection is
 * handled. A driver's lazy query object (postgres-js, which only executes once
 * something calls its `then`) instead gets an own `then` that records the
 * outcome on the way through: every consumer — `await`, `catch`, `finally`,
 * the driver's own scope tracking — reaches the outcome through `then`, and
 * nothing here triggers execution early.
 */
function observeOutcome(result: unknown, observer: StatementObserver): unknown {
  if (result instanceof Promise && result.constructor === Promise) {
    result.then(undefined, (error: unknown) => {
      observer.failed(error);
    });
    return result;
  }
  if (
    (typeof result === "object" || typeof result === "function") &&
    result !== null &&
    hasFunctionProperty(result, "then")
  ) {
    const inheritedThen = result.then;
    // eslint-disable-next-line unicorn/no-thenable -- observes, never replaces, the driver's own lazy `then`
    Object.defineProperty(result, "then", {
      configurable: true,
      writable: true,
      value: function observedThen(
        this: unknown,
        onFulfilled?: unknown,
        onRejected?: unknown,
      ): unknown {
        return Reflect.apply(inheritedThen, this, [
          onFulfilled,
          (error: unknown) => {
            observer.failed(error);
            if (typeof onRejected !== "function") throw error;
            const handled: unknown = Reflect.apply(onRejected, undefined, [
              error,
            ]);
            return handled;
          },
        ]);
      },
    });
  }
  return result;
}

/** A proxy must report a non-configurable, read-only property unchanged. */
function isFixedProperty(target: object, property: PropertyKey): boolean {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
  return descriptor?.configurable === false && descriptor.writable === false;
}

function observeClient(client: object, observer: StatementObserver): object {
  function send(statement: () => unknown): unknown {
    observer.sent();
    return observeOutcome(statement(), observer);
  }
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || isFixedProperty(target, property)) {
        return value;
      }
      if (property === SCOPED_CLIENT_MEMBER) {
        // The scope's statements run on the client handed to its callback.
        return (...args: unknown[]): unknown =>
          Reflect.apply(
            value,
            target,
            args.map((argument) =>
              typeof argument === "function" ?
                (scoped: unknown, ...rest: unknown[]): unknown =>
                  Reflect.apply(argument, undefined, [
                    (
                      (typeof scoped === "object" && scoped !== null) ||
                      typeof scoped === "function"
                    ) ?
                      observeClient(scoped, observer)
                    : scoped,
                    ...rest,
                  ])
              : argument,
            ),
          );
      }
      if (!STATEMENT_MEMBERS.has(property)) {
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      }
      return (...args: unknown[]): unknown =>
        send(() => Reflect.apply(value, target, args));
    },
    apply(target, thisArgument, args: unknown[]) {
      return send(() =>
        Reflect.apply(
          target as (...a: unknown[]) => unknown,
          thisArgument,
          args,
        ),
      );
    },
  });
}

function rolledBack(evidence: AttemptEvidence): TransactionRolledBackError {
  return new TransactionRolledBackError(
    { conflict: evidence.conflict },
    { cause: evidence.firstEngineError },
  );
}

/**
 * Plants the marker on the transaction's session and returns the check that
 * reads it back. Both statements run through the connection's statement
 * queue, behind any statement already queued on it.
 */
async function plantMarker(
  transaction: AnyPgTransaction,
  evidence: AttemptEvidence,
): Promise<PostgresTransactionMarker> {
  const session = createSerialExecutionAdapter(
    createPostgresExecutionAdapter(transaction),
    getPinnedPostgresTransactionConnection(transaction) ?? transaction,
  );
  await session.execute(PLANT_MARKER_STATEMENT);
  // The statement count at the last read that found the marker; a check
  // with nothing sent since has nothing new to learn from the session.
  let verifiedAtStatement: number | undefined;

  return {
    async assertCommittable(): Promise<void> {
      if (
        verifiedAtStatement !== undefined &&
        verifiedAtStatement === evidence.statements
      ) {
        return;
      }
      let rows: readonly Readonly<{ marker?: unknown }>[];
      try {
        rows = await session.execute<Readonly<{ marker?: unknown }>>(
          READ_MARKER_STATEMENT,
        );
      } catch (error) {
        if (isPostgresFailedTransactionError(error)) {
          throw rolledBack(evidence);
        }
        throw error;
      }
      if (rows[0]?.marker !== MARKER_VALUE) {
        throw new TransactionOutcomeUnknownError(
          { reason: "transaction-ended" },
          { cause: evidence.firstEngineError },
        );
      }
      verifiedAtStatement = evidence.statements;
    },
  };
}

/**
 * Runs one transaction TypeGraph opens and will commit, with its commit
 * decided by the marker.
 *
 * `open` opens the transaction and runs the body it is given inside it —
 * `(body) => db.transaction(body, config)`. The body plants the marker first,
 * before anything else binds to the transaction, then runs `body`, then reads
 * the marker; only a body that resolves and finds its marker reaches the
 * driver's `COMMIT`. A `body` that rejects propagates unchanged, and the
 * driver rolls the transaction back as before.
 *
 * `isConflict` is the backend's own serialization-failure classifier.
 */
export async function runMarkedPostgresTransaction<T>(
  open: (body: (transaction: AnyPgTransaction) => Promise<T>) => Promise<T>,
  isConflict: (error: unknown) => boolean,
  body: (
    transaction: AnyPgTransaction,
    marker: PostgresTransactionMarker,
  ) => Promise<T>,
): Promise<T> {
  const evidence: AttemptEvidence = {
    statements: undefined,
    firstEngineError: undefined,
    conflict: false,
    failures: new WeakSet(),
    handedToDriver: false,
  };
  const observer = createStatementObserver(evidence, isConflict);
  try {
    return await open(async (transaction) => {
      const restoreClient = replacePinnedPostgresTransactionClient(
        transaction,
        (client) => observeClient(client, observer),
      );
      try {
        const marker = await plantMarker(transaction, evidence);
        const result = await body(transaction, marker);
        await marker.assertCommittable();
        evidence.handedToDriver = true;
        return result;
      } finally {
        restoreClient?.();
      }
    });
  } catch (error) {
    // The driver rolled back and rethrew a failure the transaction's own
    // statements met (postgres-js), rather than committing.
    if (
      evidence.handedToDriver &&
      typeof error === "object" &&
      error !== null &&
      evidence.failures.has(error)
    ) {
      throw rolledBack(evidence);
    }
    throw error;
  }
}
