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
 * A transaction in which nothing failed and whose native handle never left
 * TypeGraph costs nothing: no statement is added to it. Evidence is gathered
 * only when one of the two things that can go wrong becomes possible.
 *
 * **The native handle is released.** Native `COMMIT`, `ROLLBACK` and `BEGIN`
 * can only arrive through the native handle, so the moment it leaves
 * TypeGraph's hands (`releaseNativeTransaction`: the `tx.sql` getter, a
 * public `transactionWithNative` callback) the transaction gets a marker
 * that identifies it: a transaction-local setting
 * (`SET LOCAL typegraph.transaction_marker = 'open'`), ordered on the pinned
 * driver client ahead of every statement handed to it afterwards, so the
 * session receives it before anything the caller sends through the handle,
 * in the same tick included: postgres-js takes it at once; on node-postgres,
 * neon-serverless and PGlite it waits for the statements already executing
 * and holds the later ones behind it, so it never overlaps another statement
 * on the client. Right before the
 * `COMMIT`, the setting is read back on the same session, through the
 * connection's statement queue so the read never overlaps a statement still
 * running. A transaction-local setting lives exactly as long as the
 * transaction that set it — whether the transaction ends in `COMMIT` or
 * `ROLLBACK` — and survives a caller's `ROLLBACK TO SAVEPOINT`, since a
 * caller can only take a savepoint through a handle whose release planted
 * the marker first. The read decides:
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
 * **A statement failed.** Every statement on the transaction passes through
 * the pinned driver client, which is observed for the attempt: Drizzle's
 * session (and so the native handle, its relational queries included) and
 * TypeGraph's compiled fast path both read it when they send a statement.
 * When an engine error (one carrying a SQLSTATE) was observed and the
 * marker was never planted, the transaction cannot have been ended or
 * replaced, so a plain health probe decides: refused with `25P02`, the
 * transaction is aborted; answered, a savepoint TypeGraph rolled back has
 * recovered it. Errors the engine surfaces only at `COMMIT` (a deferred
 * constraint, a serialization failure at commit, a terminated connection)
 * reject the `COMMIT` itself.
 *
 * The marker is planted with `SET LOCAL`, not `SELECT set_config(...)`: a
 * `SET` takes no snapshot, so a `REPEATABLE READ` or `SERIALIZABLE`
 * transaction still takes its snapshot at the callback's first statement
 * even when the handle is released before it. The value is a constant, which
 * `SET` (it binds no parameters) prefers: no other transaction can set it on
 * this session, since the setting ends with the transaction that set it and
 * a nested transaction (a savepoint on this one) plants none, so its
 * presence alone identifies the transaction.
 *
 * Observed errors also supply the rejection's `cause` — the first error that
 * reached the engine (a driver's client-side refusal is not a cause) — and
 * its retry classification: a rolled-back transaction is a conflict, re-run
 * under `retry: { attempts }`, when any engine error observed in the attempt
 * was a serialization failure or deadlock.
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
import { registerNativeTransactionRelease } from "../../native-transaction-release";
import {
  type AnyPgTransaction,
  createPostgresExecutionAdapter,
  getPinnedPostgresTransactionClient,
  getPinnedPostgresTransactionConnection,
  hasFunctionProperty,
  replacePinnedPostgresTransactionClient,
} from "./postgres-execution";
import { createSerialExecutionAdapter } from "./statement-queue";

/** The commit evidence of one TypeGraph-opened transaction. */
export type PostgresTransactionMarker = Readonly<{
  /**
   * Resolves when the transaction TypeGraph opened is still open and healthy
   * on its session. Rejects with {@link TransactionRolledBackError} when it
   * is aborted, and with {@link TransactionOutcomeUnknownError} when the
   * session is no longer inside it. Waits for every statement queued on the
   * connection first, then sends nothing unless the marker was planted or an
   * engine error was observed since the last check that found the
   * transaction healthy.
   */
  assertCommittable: () => Promise<void>;
}>;

/**
 * The transaction-local setting that carries the marker. Namespaced so it
 * cannot collide with an application's own custom setting. Both marker
 * statements name it in their text and bind no parameters.
 */
const TRANSACTION_MARKER_SETTING = "typegraph.transaction_marker";

/** The marker's value while the transaction that set it is open. */
const MARKER_VALUE = "open";

const PLANT_MARKER_TEXT = `SET LOCAL ${TRANSACTION_MARKER_SETTING} = '${MARKER_VALUE}'`;

const READ_MARKER_STATEMENT = sql.raw(
  `SELECT current_setting('${TRANSACTION_MARKER_SETTING}', true) AS marker`,
);

/**
 * The health probe of a transaction whose native handle never left
 * TypeGraph: refused with `25P02` exactly when the transaction is aborted.
 */
const PROBE_STATEMENT = sql.raw("SELECT 1 AS healthy");

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
  /** Failures that reached the engine, counted. */
  engineErrors: number;
  /** The first failure that reached the engine. */
  firstEngineError: unknown;
  /** Whether any failure that reached the engine was a conflict. */
  conflict: boolean;
  /** Every failure a statement settled with, by identity. */
  readonly failures: WeakSet<object>;
  /** Whether the transaction was found committable and handed back to its driver to commit. */
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
      evidence.engineErrors += 1;
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

/**
 * Holds statements on a client that queues them itself (node-postgres,
 * neon-serverless, PGlite) behind a marker plant still on its way, so the
 * plant is never sent while another statement is executing on the client —
 * node-postgres deprecates that overlap and `pg@9` removes it — and still
 * reaches the session ahead of every statement handed to the client after
 * it. postgres-js queues and pipelines statements on its connection itself,
 * so its plant is sent at once and nothing is ever held.
 */
interface SendGate {
  /** Statements handed to the driver that have not settled, by result. */
  readonly inFlight: Set<Promise<unknown>>;
  /** The plant, while it waits for {@link inFlight} or runs. */
  blocker: Promise<unknown> | undefined;
}

/** Tracks a driver's native promise; a lazy query object is never touched. */
function trackInFlight(gate: SendGate, result: unknown): void {
  if (!(result instanceof Promise) || result.constructor !== Promise) return;
  const pending: Promise<unknown> = result;
  gate.inFlight.add(pending);
  const settle = (): void => {
    gate.inFlight.delete(pending);
  };
  pending.then(settle, settle);
}

function observeClient(
  client: object,
  observer: StatementObserver,
  gate: SendGate,
): object {
  function send(statement: () => unknown): unknown {
    observer.sent();
    const blocker = gate.blocker;
    const result =
      blocker === undefined ? statement() : blocker.then(statement, statement);
    trackInFlight(gate, result);
    return observeOutcome(result, observer);
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
                      observeClient(scoped, observer, gate)
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

function ignoreSettlement(): void {
  // The observer records the plant's failure; nothing awaits the plant.
}

/**
 * Plants the marker on the transaction's driver client. `rawClient` is the
 * driver client itself, `observedClient` the observing wrapper the
 * transaction's statements go through, which also holds them behind the plant
 * (see {@link SendGate}). Returns whether the client could take the plant.
 *
 * - postgres-js (`unsafe`) builds a lazy query that executes once its `then`
 *   is called, so `then` is called here, in this tick; the driver sends its
 *   queries in the order they started executing.
 * - node-postgres, neon-serverless and PGlite (`query`): the plant is sent
 *   once every statement already handed to the client has settled, and every
 *   statement handed to the client meanwhile waits for the plant first.
 */
function sendPlant(
  rawClient: object,
  observedClient: object,
  observer: StatementObserver,
  gate: SendGate,
): boolean {
  if (hasFunctionProperty(observedClient, "unsafe")) {
    const pending: unknown = observedClient.unsafe(PLANT_MARKER_TEXT);
    if (
      (typeof pending === "object" || typeof pending === "function") &&
      pending !== null &&
      hasFunctionProperty(pending, "then")
    ) {
      pending.then(ignoreSettlement, ignoreSettlement);
    }
    return true;
  }
  if (!hasFunctionProperty(rawClient, "query")) return false;
  const planted = Promise.allSettled(gate.inFlight).then(() => {
    observer.sent();
    return observeOutcome(rawClient.query(PLANT_MARKER_TEXT), observer);
  });
  gate.blocker = planted;
  const release = (): void => {
    if (gate.blocker === planted) gate.blocker = undefined;
  };
  planted.then(release, release);
  return true;
}

/** The pinned client of an observed transaction attempt. */
type ObservedClient = Readonly<{
  raw: object;
  observer: StatementObserver;
  gate: SendGate;
}>;

type TransactionEvidenceSession = Readonly<{
  marker: PostgresTransactionMarker;
  /** Plants the marker; see `releaseNativeTransaction`. Idempotent. */
  plant: () => void;
  /** Ends the evidence: a later plant sends nothing. */
  close: () => void;
}>;

/**
 * The commit evidence of one transaction. `observed` is its observed pinned
 * client; without one no failure can be seen and the plant cannot be ordered
 * ahead of the caller's statements, so the marker is planted at once,
 * through the queue, and always read.
 */
async function createTransactionEvidence(
  transaction: AnyPgTransaction,
  evidence: AttemptEvidence,
  observed: ObservedClient | undefined,
): Promise<TransactionEvidenceSession> {
  const session = createSerialExecutionAdapter(
    createPostgresExecutionAdapter(transaction),
    getPinnedPostgresTransactionConnection(transaction) ?? transaction,
  );
  let planted = false;
  let closed = false;
  // The statement count at the last read that found the marker; a check
  // with nothing sent since has nothing new to learn from the session.
  let verifiedAtStatement: number | undefined;
  // The engine errors already accounted for by a probe that found the
  // transaction healthy.
  let probedAtEngineErrors = 0;

  if (observed === undefined) {
    await session.execute(sql.raw(PLANT_MARKER_TEXT));
    planted = true;
  }

  function plant(): void {
    if (planted || closed) return;
    const client = getPinnedPostgresTransactionClient(transaction);
    planted =
      observed !== undefined &&
      client !== undefined &&
      sendPlant(observed.raw, client, observed.observer, observed.gate);
  }

  async function readMarker(): Promise<void> {
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
  }

  async function probe(): Promise<void> {
    const accountedFor = evidence.engineErrors;
    try {
      await session.execute(PROBE_STATEMENT);
    } catch (error) {
      if (isPostgresFailedTransactionError(error)) {
        throw rolledBack(evidence);
      }
      throw error;
    }
    probedAtEngineErrors = accountedFor;
  }

  return {
    plant,
    close() {
      closed = true;
    },
    marker: {
      async assertCommittable(): Promise<void> {
        // Every statement queued on the connection settles first, so its
        // failure, if any, has been observed before anything is decided.
        await session.runExclusive(() => Promise.resolve());
        if (planted) return readMarker();
        if (evidence.engineErrors === probedAtEngineErrors) return;
        return probe();
      },
    },
  };
}

/**
 * Runs one transaction TypeGraph opens and will commit, with its commit
 * decided by the evidence above.
 *
 * `open` opens the transaction and runs the body it is given inside it —
 * `(body) => db.transaction(body, config)`. The body installs the observer
 * and registers the marker's plant as the transaction's native-handle
 * release, both before anything else binds to the transaction, then runs
 * `body`, then checks the evidence; only a body that resolves and passes the
 * check reaches the driver's `COMMIT`. A `body` that rejects propagates
 * unchanged, and the driver rolls the transaction back as before.
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
    engineErrors: 0,
    firstEngineError: undefined,
    conflict: false,
    failures: new WeakSet(),
    handedToDriver: false,
  };
  const observer = createStatementObserver(evidence, isConflict);
  try {
    return await open(async (transaction) => {
      const gate: SendGate = { inFlight: new Set(), blocker: undefined };
      let observed: ObservedClient | undefined;
      const restoreClient = replacePinnedPostgresTransactionClient(
        transaction,
        (client) => {
          observed = { raw: client, observer, gate };
          return observeClient(client, observer, gate);
        },
      );
      let attempt: TransactionEvidenceSession | undefined;
      try {
        attempt = await createTransactionEvidence(
          transaction,
          evidence,
          observed,
        );
        registerNativeTransactionRelease(transaction, attempt.plant);
        const result = await body(transaction, attempt.marker);
        await attempt.marker.assertCommittable();
        evidence.handedToDriver = true;
        return result;
      } finally {
        attempt?.close();
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
