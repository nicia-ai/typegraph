/**
 * The one owner of "may the PostgreSQL transaction TypeGraph opened be
 * committed, and may it be retried?" for every transaction a bundled
 * PostgreSQL backend opens and commits itself
 * (`capabilities.execution.commitOutcome: "session-marker"`).
 *
 * A statement that fails inside a PostgreSQL transaction aborts the whole
 * transaction, whether or not the code that issued it catches the error;
 * the server then answers the closing `COMMIT` with `ROLLBACK`, which
 * node-postgres, neon-serverless and PGlite report as a success. A caller
 * holding the native `tx.sql` handle can also end the transaction itself
 * (`COMMIT`, `COMMIT AND CHAIN`, `ROLLBACK`) and even open another (`BEGIN`),
 * after which a `COMMIT` TypeGraph sends would close a transaction it never
 * opened, and a failure would belong to a transaction TypeGraph never opened.
 *
 * A transaction in which nothing failed and whose native handle never left
 * TypeGraph costs nothing: no statement is added to it. Evidence is gathered
 * only when one of the two things that can go wrong becomes possible.
 *
 * **The native handle is released.** Native transaction control can only
 * arrive through a port that forwards the caller's SQL (`releaseNativeTransaction`:
 * the `tx.sql` getter, a public `transactionWithNative` callback, a schema
 * preflight's `executeSchemaDdl`). From that moment the attempt's outcome is
 * exactly one of two:
 *
 * - **committed**: right before the `COMMIT`, the marker planted at the
 *   release is read back on the same session with this attempt's value, and
 *   the `COMMIT` then succeeds;
 * - **unknown** ({@link TransactionOutcomeUnknownError}): the marker is
 *   missing, the read is refused, or the attempt failed with a conflict (a
 *   serialization failure or deadlock, from the callback or the `COMMIT`).
 *   Any other rejection is the callback's own error and propagates unchanged;
 *   no retry loop re-runs it. Never retried: an aborted transaction cannot be queried,
 *   so nothing proves that the transaction that failed is the one TypeGraph
 *   opened rather than one the caller began after committing it through the
 *   handle, and re-running the callback could repeat committed writes. The
 *   failure is the error's `cause`.
 *
 * The marker is a transaction-local setting
 * (`SET LOCAL typegraph.transaction_marker = '<value>'`) whose value TypeGraph
 * generates for the attempt from a fixed alphabet, so no session-level value
 * and no other attempt can satisfy the read. It is ordered on the pinned
 * driver client ahead of every statement handed to it afterwards, so the
 * session receives it before anything the caller sends through the handle,
 * in the same tick included: postgres-js takes it at once; on node-postgres,
 * neon-serverless and PGlite it waits for the statements already executing
 * and holds the later ones behind it, so it never overlaps another statement
 * on the client. The read goes through the connection's statement queue so
 * it never overlaps a statement still running. A transaction-local setting
 * lives exactly as long as the transaction that set it, and survives a
 * caller's `ROLLBACK TO SAVEPOINT`, since a caller can only take a savepoint
 * after the release planted the marker. A savepoint of TypeGraph's own that
 * was open when the marker was planted would undo it on rollback, so the
 * marker is planted again right after TypeGraph rolls back to such a
 * savepoint (see {@link NativeTransactionReleasePort.guardSavepoint}).
 *
 * **A statement failed, and the handle was never released.** Every statement
 * on the transaction passes through the pinned driver client, which is
 * observed for the attempt: Drizzle's session (and so the native handle, its
 * relational queries included) and TypeGraph's compiled fast path both read
 * it when they send a statement. When an engine error (one carrying a
 * SQLSTATE) was observed, a plain health probe decides: refused with `25P02`,
 * the transaction is aborted and is reported as
 * {@link TransactionRolledBackError} — the only outcome that claims "rolled
 * back, safe to retry", since with the handle never released the transaction
 * cannot have been ended or replaced; answered, a savepoint TypeGraph rolled
 * back has recovered it. A rolled-back transaction is a conflict, re-run under
 * `retry: { attempts }`, when any engine error observed in the attempt was a
 * serialization failure or deadlock. Errors the engine surfaces only at
 * `COMMIT` (a deferred constraint, a serialization failure at commit, a
 * terminated connection) reject the `COMMIT` itself.
 *
 * The marker is planted with `SET LOCAL`, not `SELECT set_config(...)`: a
 * `SET` takes no snapshot, so a `REPEATABLE READ` or `SERIALIZABLE`
 * transaction still takes its snapshot at the callback's first statement
 * even when the handle is released before it. `SET` binds no parameters, so
 * the value is inlined, and its shape is asserted before it is.
 *
 * One driver needs the observation for more than that. postgres-js tracks
 * the first failed statement of a transaction scope and, when the scope's
 * callback resolves, rolls back and rethrows that failure in place of
 * committing — even when a raw `ROLLBACK TO SAVEPOINT` recovered the session
 * and the marker read succeeded. A rejection that is the very error a
 * statement of the transaction failed with before TypeGraph handed the
 * transaction back to its driver is that substitution: reported as the
 * {@link TransactionRolledBackError} it is when the handle was never
 * released, and as an unknown outcome otherwise.
 */
import {
  CompilerInvariantError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
} from "../../../errors";
import { sql } from "../../../query/sql-fragment";
import {
  carriesEngineSqlState,
  isPostgresFailedTransactionError,
  isTransactionOutcomeUnknown,
} from "../../../utils/sql-errors";
import {
  type NativeTransactionReleasePort,
  registerNativeTransactionRelease,
} from "../../native-transaction-release";
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
   * on its session. Once the native handle was released, rejects with
   * {@link TransactionOutcomeUnknownError} unless this attempt's marker is
   * read back; before that, rejects with {@link TransactionRolledBackError}
   * when the transaction is aborted. Waits for every statement queued on the
   * connection first, then sends nothing unless the handle was released or
   * an engine error was observed since the last check that found the
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

/**
 * The shape of a marker value: 32 lowercase hexadecimal digits. Asserted
 * before a value is inlined into the plant, which `SET` cannot bind.
 */
const MARKER_VALUE_SHAPE = /^[\da-f]{32}$/;

/** A marker value no other attempt and no session-level setting carries. */
function newMarkerValue(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "");
}

/** The plant of `value`, which must have the marker's shape. */
function plantStatement(value: string): string {
  if (!MARKER_VALUE_SHAPE.test(value)) {
    throw new CompilerInvariantError(
      "A transaction marker value does not have the shape it is inlined with.",
      { value },
    );
  }
  return `SET LOCAL ${TRANSACTION_MARKER_SETTING} = '${value}'`;
}

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
  /**
   * Whether control of the transaction left TypeGraph: from then on the
   * attempt either commits with its marker read back, or its outcome is
   * unknown and it is never retried.
   */
  released: boolean;
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

/** A statement's text, normalized for comparison; `undefined` when it has none. */
function normalizedStatementText(statement: unknown): string | undefined {
  const text: unknown =
    typeof statement === "string" ? statement
    : typeof statement === "object" && statement !== null ?
      Reflect.get(statement, "text")
    : undefined;
  return typeof text === "string" ?
      text.trim().replaceAll(/\s+/g, " ").toLowerCase()
    : undefined;
}

/**
 * Where each statement stands in the order the session executes them. Every
 * bundled driver executes the statements of one connection in the order they
 * are handed to it: node-postgres, neon-serverless and PGlite as they are
 * called, postgres-js as their lazy query's `then` is first called.
 */
interface HandOffLedger {
  /** Statements handed to the driver client so far. */
  handed: number;
  /** TypeGraph savepoints whose `SAVEPOINT` has not been handed yet. */
  readonly pendingSavepoints: Set<SavepointWatch>;
}

/** One TypeGraph savepoint, and where its `SAVEPOINT` was handed. */
interface SavepointWatch {
  readonly statement: string;
  handedAt: number | undefined;
}

function recordHandOff(ledger: HandOffLedger, statement: unknown): number {
  ledger.handed += 1;
  if (ledger.pendingSavepoints.size > 0) {
    const text = normalizedStatementText(statement);
    for (const watch of ledger.pendingSavepoints) {
      if (watch.statement !== text) continue;
      watch.handedAt = ledger.handed;
      ledger.pendingSavepoints.delete(watch);
      break;
    }
  }
  return ledger.handed;
}

/**
 * Observes a statement's pending result without consuming it or changing its
 * outcome. A native promise gets a side branch whose own rejection is
 * handled. A driver's lazy query object (postgres-js, which only executes once
 * something calls its `then`) instead gets an own `then` that records the
 * outcome on the way through, and calls `onStart` the first time it is
 * called: every consumer — `await`, `catch`, `finally`, the driver's own scope
 * tracking — reaches the outcome through `then`, and nothing here triggers
 * execution early.
 */
function observeOutcome(
  result: unknown,
  observer: StatementObserver,
  onStart: () => void,
): unknown {
  if (result instanceof Promise && result.constructor === Promise) {
    onStart();
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
    let started = false;
    // eslint-disable-next-line unicorn/no-thenable -- observes, never replaces, the driver's own lazy `then`
    Object.defineProperty(result, "then", {
      configurable: true,
      writable: true,
      value: function observedThen(
        this: unknown,
        onFulfilled?: unknown,
        onRejected?: unknown,
      ): unknown {
        if (!started) {
          started = true;
          onStart();
        }
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
    return result;
  }
  onStart();
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
  readonly ledger: HandOffLedger;
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
  function send(statement: () => unknown, text: unknown): unknown {
    observer.sent();
    const blocker = gate.blocker;
    if (blocker === undefined) {
      const result = statement();
      trackInFlight(gate, result);
      return observeOutcome(result, observer, () => {
        recordHandOff(gate.ledger, text);
      });
    }
    // Held behind the plant: its place in the session's order is taken when
    // it is actually handed to the driver, after the plant.
    const handOff = (): unknown => {
      recordHandOff(gate.ledger, text);
      return statement();
    };
    const held = blocker.then(handOff, handOff);
    trackInFlight(gate, held);
    return observeOutcome(held, observer, ignoreSettlement);
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
        send(() => Reflect.apply(value, target, args), args[0]);
    },
    apply(target, thisArgument, args: unknown[]) {
      return send(
        () =>
          Reflect.apply(
            target as (...a: unknown[]) => unknown,
            thisArgument,
            args,
          ),
        undefined,
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
 * The outcome of an attempt that failed after the native handle was
 * released: unknown, and never retried. `cause` is the failure.
 */
function releasedAttemptFailed(cause: unknown): TransactionOutcomeUnknownError {
  return new TransactionOutcomeUnknownError(
    { reason: "native-handle-released" },
    { cause },
  );
}

function ignoreSettlement(): void {
  // The observer records the plant's failure; nothing awaits the plant.
}

/**
 * Plants `statement` on the transaction's driver client, and returns where
 * it was handed to the driver (resolving once it is). `rawClient` is the
 * driver client itself, `observedClient` the observing wrapper the
 * transaction's statements go through, which also holds them behind the plant
 * (see {@link SendGate}). Returns `undefined` when the client cannot take it.
 *
 * - postgres-js (`unsafe`) builds a lazy query that executes once its `then`
 *   is called, so `then` is called here, in this tick; the driver sends its
 *   queries in the order they started executing.
 * - node-postgres, neon-serverless and PGlite (`query`): the plant is sent
 *   once every statement already handed to the client has settled, and every
 *   statement handed to the client meanwhile waits for the plant first.
 */
function sendPlant(
  statement: string,
  rawClient: object,
  observedClient: object,
  observer: StatementObserver,
  gate: SendGate,
): Promise<number> | undefined {
  if (hasFunctionProperty(observedClient, "unsafe")) {
    const pending: unknown = observedClient.unsafe(statement);
    if (
      (typeof pending === "object" || typeof pending === "function") &&
      pending !== null &&
      hasFunctionProperty(pending, "then")
    ) {
      pending.then(ignoreSettlement, ignoreSettlement);
    }
    return Promise.resolve(gate.ledger.handed);
  }
  if (!hasFunctionProperty(rawClient, "query")) return undefined;
  let handedAt = 0;
  const planted = Promise.allSettled(gate.inFlight).then(() => {
    observer.sent();
    handedAt = recordHandOff(gate.ledger, statement);
    const result = rawClient.query(statement);
    trackInFlight(gate, result);
    return observeOutcome(result, observer, ignoreSettlement);
  });
  gate.blocker = planted;
  const release = (): void => {
    if (gate.blocker === planted) gate.blocker = undefined;
  };
  planted.then(release, release);
  return planted.then(
    () => handedAt,
    () => handedAt,
  );
}

/** The pinned client of an observed transaction attempt. */
type ObservedClient = Readonly<{
  raw: object;
  observer: StatementObserver;
  gate: SendGate;
}>;

type TransactionEvidenceSession = Readonly<{
  marker: PostgresTransactionMarker;
  /** What the opening backend registers for the transaction's native handle. */
  releasePort: NativeTransactionReleasePort;
  /**
   * Waits until nothing this attempt handed to the driver (the plant
   * included) is still running, so the driver's `ROLLBACK` never overlaps
   * it. Never rejects.
   */
  settle: () => Promise<void>;
  /** Ends the evidence: a later release sends nothing. */
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
  // This attempt's marker value, once something planted it.
  let markerValue: string | undefined;
  let closed = false;
  // Where the latest plant was handed to the driver; `undefined` until it is.
  let plantHandedAt: number | undefined;
  // The statement count at the last read that found the marker; a check
  // with nothing sent since has nothing new to learn from the session.
  let verifiedAtStatement: number | undefined;
  // The engine errors already accounted for by a probe that found the
  // transaction healthy.
  let probedAtEngineErrors = 0;

  if (observed === undefined) {
    markerValue = newMarkerValue();
    await session.execute(sql.raw(plantStatement(markerValue)));
  }

  /** Sends the plant through the observed client; whether it could. */
  function sendObservedPlant(value: string): boolean {
    const client = getPinnedPostgresTransactionClient(transaction);
    if (observed === undefined || client === undefined) return false;
    const handed = sendPlant(
      plantStatement(value),
      observed.raw,
      client,
      observed.observer,
      observed.gate,
    );
    if (handed === undefined) return false;
    plantHandedAt = undefined;
    void handed.then((position) => {
      plantHandedAt = position;
    });
    return true;
  }

  function release(): void {
    if (closed) return;
    evidence.released = true;
    if (markerValue !== undefined) return;
    const value = newMarkerValue();
    if (sendObservedPlant(value)) markerValue = value;
  }

  function guardSavepoint(savepointStatement: string): () => void {
    const ledger = observed?.gate.ledger;
    const statement = normalizedStatementText(savepointStatement);
    if (ledger === undefined || statement === undefined) {
      // Unobserved: the marker was planted before anything else.
      return ignoreSettlement;
    }
    const watch: SavepointWatch = { statement, handedAt: undefined };
    ledger.pendingSavepoints.add(watch);
    return () => {
      ledger.pendingSavepoints.delete(watch);
      // Plant again only when the plant this rollback undid was handed after
      // the savepoint's own `SAVEPOINT`: that savepoint was then opened
      // before anything the caller sent through the handle, so it is a
      // savepoint of the transaction TypeGraph opened. Anything else (the
      // savepoint not identified, the plant still on its way) leaves the
      // attempt to report an unknown outcome rather than mark a transaction
      // it cannot vouch for.
      if (
        closed ||
        markerValue === undefined ||
        watch.handedAt === undefined ||
        plantHandedAt === undefined ||
        plantHandedAt <= watch.handedAt
      ) {
        return;
      }
      sendObservedPlant(markerValue);
    };
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
      // An unobserved transaction is planted before the callback runs; until
      // its handle is released, nothing can have ended or replaced it.
      if (!evidence.released && isPostgresFailedTransactionError(error)) {
        throw rolledBack(evidence);
      }
      throw releasedAttemptFailed(evidence.firstEngineError ?? error);
    }
    if (markerValue === undefined || rows[0]?.marker !== markerValue) {
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
    releasePort: { release, guardSavepoint },
    async settle(): Promise<void> {
      const gate = observed?.gate;
      if (gate !== undefined) {
        await Promise.allSettled([gate.blocker, ...gate.inFlight]);
      }
      await session
        .runExclusive(() => Promise.resolve())
        .catch(() => {
          // Settling only waits; the queue's own failures belong to its callers.
        });
    },
    close() {
      closed = true;
    },
    marker: {
      async assertCommittable(): Promise<void> {
        // Every statement queued on the connection settles first, so its
        // failure, if any, has been observed before anything is decided.
        await session.runExclusive(() => Promise.resolve());
        if (evidence.released || markerValue !== undefined) {
          return readMarker();
        }
        if (evidence.engineErrors === probedAtEngineErrors) return;
        return probe();
      },
    },
  };
}

/**
 * What a failed attempt reports, and so whether the retry loop above it may
 * re-run it: the one decision for both ways an attempt fails, the callback
 * rejecting and the commit evidence refusing.
 *
 * Once the native handle was released, no failure may reach a retry loop as
 * retryable: a failure the backend's conflict classifier accepts (a
 * serialization failure or deadlock, however wrapped, the `COMMIT`'s own
 * included) is an unknown outcome with that failure as its `cause`; so is
 * the driver's substitution of a failure the transaction's statements met.
 * The evidence's own refusals already are unknown outcomes. Any other
 * rejection is the callback's own error, which no retry loop re-runs, and
 * propagates unchanged.
 *
 * Before the release, a driver that rolled back and rethrew a failure the
 * transaction's own statements met (postgres-js), rather than committing, is
 * reported as the rollback it is; anything else propagates unchanged.
 */
function attemptFailure(
  evidence: AttemptEvidence,
  error: unknown,
  isConflict: (error: unknown) => boolean,
): unknown {
  const substitutedByDriver =
    evidence.handedToDriver &&
    typeof error === "object" &&
    error !== null &&
    evidence.failures.has(error);
  if (evidence.released) {
    if (isTransactionOutcomeUnknown(error)) return error;
    return substitutedByDriver || isConflict(error) ?
        releasedAttemptFailed(error)
      : error;
  }
  return substitutedByDriver ? rolledBack(evidence) : error;
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
 * check reaches the driver's `COMMIT`. A `body` that rejects waits for
 * whatever the attempt still has running and then lets the driver roll back.
 * Every failure is reported through {@link attemptFailure}.
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
    released: false,
  };
  const observer = createStatementObserver(evidence, isConflict);
  try {
    return await open(async (transaction) => {
      const gate: SendGate = {
        inFlight: new Set(),
        blocker: undefined,
        ledger: { handed: 0, pendingSavepoints: new Set() },
      };
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
        if (
          !registerNativeTransactionRelease(transaction, attempt.releasePort)
        ) {
          // Nothing would say when the handle escapes: treat it as escaped.
          attempt.releasePort.release();
        }
        const result = await body(transaction, attempt.marker);
        await attempt.marker.assertCommittable();
        evidence.handedToDriver = true;
        return result;
      } catch (error) {
        await attempt?.settle();
        throw error;
      } finally {
        attempt?.close();
        restoreClient?.();
      }
    });
  } catch (error) {
    throw attemptFailure(evidence, error, isConflict);
  }
}
