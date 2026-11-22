/**
 * The one owner of "did the PostgreSQL transaction TypeGraph opened commit,
 * and may it be retried?" for every transaction a bundled PostgreSQL backend
 * opens and commits itself (`capabilities.execution.commitOutcome:
 * "commit-reply"`).
 *
 * **The `COMMIT`'s own reply decides.** A statement that fails inside a
 * PostgreSQL transaction aborts the whole transaction, whether or not the
 * code that issued it caught the error, and whether or not the client ever
 * saw the failure: a node-postgres `query_timeout` rejects on the client
 * while the server is still running the statement, which can then fail there
 * with nobody listening. The server answers the closing `COMMIT` of an
 * aborted transaction with the command tag `ROLLBACK` instead of `COMMIT`,
 * which node-postgres, neon-serverless and PGlite resolve as a success.
 * TypeGraph reads the tag of the `COMMIT` that ends the transaction it
 * opened, and adds no statement to do so:
 *
 * - node-postgres and neon-serverless: Drizzle sends `commit` through the
 *   transaction's pinned client, which this module observes for the whole
 *   attempt. The first statement handed to that client once the attempt's
 *   own work is done is that `commit`; its result carries the tag
 *   (`command`).
 * - PGlite: `PGlite.transaction()` sends `COMMIT` through the instance's
 *   `execProtocolStream`, observed from the moment the attempt's work is done
 *   until that `COMMIT` has replied. The instance runs nothing else while the
 *   transaction holds it; the `COMMIT`'s `CommandComplete` message carries
 *   the tag.
 * - postgres-js: the `COMMIT` that `sql.begin()` sends goes through a query
 *   function private to `begin`, so its tag is not reachable. The driver
 *   itself tracks every statement of the transaction and, when one failed,
 *   rolls back and rejects with that failure instead of sending `COMMIT`.
 *   That refusal is the evidence on postgres-js ({@link attemptFailure}).
 *
 * Tag `COMMIT`: committed. Tag `ROLLBACK`: {@link TransactionRolledBackError}
 * (`detectedBy: "commit-reply"`), whose `cause` is the first engine error the
 * attempt observed; there may be none, when the failure never reached the
 * client (`causeObserved: false`). A reply that should be readable and was
 * not is an unknown outcome, never a commit. Errors the engine raises at
 * `COMMIT` itself (a deferred constraint, a serialization failure at commit)
 * reject the `COMMIT` and propagate as they are.
 *
 * Work TypeGraph does on the transaction after the callback returned (a
 * revision-clock advance, a capture flush, a pre-commit hook) can meet an
 * aborted session nobody reported. Its statement is refused with `25P02`,
 * and {@link attemptFailure} reports that refusal as the same rolled-back
 * outcome (`detectedBy: "refused-statement"`): no raw `25P02` escapes.
 *
 * Statement failures are observed for two things only: the `cause` of a
 * rolled-back transaction, and whether it is a conflict (a serialization
 * failure or deadlock), which `retry: { attempts }` re-runs.
 *
 * **Transaction control through a raw-SQL port is unsupported.** A caller
 * holding a port that forwards its SQL text (`tx.sql`, a
 * `transactionWithNative` callback's handle, a schema write's
 * `executeSchemaDdl`) can end or replace the transaction, which cannot be
 * fully detected. As a defence for those known routes, the moment such a
 * port is handed out (`releaseNativeTransaction`) the attempt plants a
 * marker, reads it back right before the `COMMIT`, and is never retried
 * automatically: a failed attempt then reports
 * {@link TransactionOutcomeUnknownError}, since nothing proves the
 * transaction that failed is the one TypeGraph opened. A caller that
 * deliberately carries the marker into a transaction of its own defeats it;
 * that is outside the supported contract.
 *
 * The marker is a transaction-local setting
 * (`SET LOCAL typegraph.transaction_marker = '<value>'`) whose value TypeGraph
 * generates for the attempt from a fixed alphabet. It is ordered on the
 * pinned driver client ahead of every statement handed to it afterwards, so
 * the session receives it before anything the caller sends through the port,
 * in the same tick included: postgres-js takes it at once; on node-postgres,
 * neon-serverless and PGlite it waits for the statements already executing
 * and holds the later ones behind it, so it never overlaps another statement
 * on the client. The read goes through the connection's statement queue so it
 * never overlaps a statement still running. A savepoint of TypeGraph's own
 * that was open when the marker was planted would undo it on rollback, so the
 * marker is planted again right after TypeGraph rolls back to such a
 * savepoint (see {@link NativeTransactionReleasePort.guardSavepoint}). It is
 * planted with `SET LOCAL`, not `SELECT set_config(...)`: a `SET` takes no
 * snapshot, so a `REPEATABLE READ` or `SERIALIZABLE` transaction still takes
 * its snapshot at the callback's first statement. `SET` binds no parameters,
 * so the value is inlined, and its shape is asserted before it is.
 */
import {
  CompilerInvariantError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
  type TransactionRolledBackErrorDetails,
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
  type AnyPgDatabase,
  type AnyPgTransaction,
  createPostgresExecutionAdapter,
  getPgliteClient,
  getPinnedPostgresTransactionClient,
  getPinnedPostgresTransactionConnection,
  hasFunctionProperty,
  isPostgresJsClient,
  replacePinnedPostgresTransactionClient,
} from "./postgres-execution";
import { createSerialExecutionAdapter } from "./statement-queue";

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

/** The normalized text of the statement that ends a committed transaction. */
const COMMIT_STATEMENT = "commit";

/** The command tag PostgreSQL answers a `COMMIT` with when it committed. */
const COMMITTED_TAG = "COMMIT";

/** The command tag PostgreSQL answers a `COMMIT` of an aborted transaction with. */
const ROLLED_BACK_TAG = "ROLLBACK";

/**
 * Where the reply to the `COMMIT` that ends an attempt can be read:
 *
 * - `"client-result"`: from the result the pinned client returns for
 *   Drizzle's `commit` (node-postgres, neon-serverless);
 * - `"pglite-protocol"`: from the PGlite instance's protocol stream;
 * - `"driver-refusal"`: nowhere; the driver refuses to commit a transaction
 *   in which a statement failed (postgres-js);
 * - `"unobserved"`: the transaction's client could not be observed at all.
 *   The marker is then planted before the callback runs and always read, so
 *   an aborted session refuses the read.
 */
type CommitReplySource =
  | "client-result"
  | "pglite-protocol"
  | "driver-refusal"
  | "unobserved";

/** The reply to the first statement sent once an attempt's work was done. */
type CommitReply = Readonly<{
  /** That statement's normalized text; `undefined` when unreadable. */
  statement: string | undefined;
  /** Its command tag; `undefined` when it carried none or failed. */
  tag: string | undefined;
}>;

/** The watch on the statement that ends an attempt. */
interface CommitReplyWatch {
  /** Set once the attempt's own work is done and it is handed to its driver. */
  armed: boolean;
  /** Set once the first statement after arming was handed to the driver. */
  claimed: boolean;
  /** That statement's reply, once it settled. */
  reply: CommitReply | undefined;
}

/** What one transaction attempt observed on its session. */
interface AttemptEvidence {
  /** Statements sent through the observed client; `undefined` when unobserved. */
  statements: number | undefined;
  /**
   * The first failure that reached the engine, other than a refusal of a
   * statement sent to an already aborted transaction (`25P02`), which is the
   * abort's consequence rather than its cause.
   */
  firstEngineError: unknown;
  /** Whether any failure that reached the engine was a conflict. */
  conflict: boolean;
  /** Every failure a statement settled with, by identity. */
  readonly failures: WeakSet<object>;
  /** Whether the attempt's work was done and it was handed back to its driver to commit. */
  handedToDriver: boolean;
  /**
   * Whether a port that forwards the caller's SQL was handed out: from then
   * on the attempt either commits with its marker read back, or its outcome
   * is unknown and it is never retried.
   */
  released: boolean;
  readonly commitReply: CommitReplyWatch;
}

type StatementObserver = Readonly<{
  sent: () => void;
  failed: (error: unknown) => void;
  /** A statement was handed to the driver client and returned `result`. */
  handed: (statement: unknown, result: unknown) => void;
}>;

/** The command tag a node-postgres-style result carries. */
function commandTagOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const command: unknown = Reflect.get(result, "command");
  return typeof command === "string" ? command : undefined;
}

function createStatementObserver(
  evidence: AttemptEvidence,
  isConflict: (error: unknown) => boolean,
  readsClientResult: () => boolean,
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
      if (
        evidence.firstEngineError === undefined &&
        !isPostgresFailedTransactionError(error)
      ) {
        evidence.firstEngineError = error;
      }
      if (!evidence.conflict && isConflict(error)) evidence.conflict = true;
    },
    handed(statement, result) {
      const watch = evidence.commitReply;
      if (!watch.armed || watch.claimed || !readsClientResult()) return;
      watch.claimed = true;
      const text = normalizedStatementText(statement);
      if (!(result instanceof Promise)) {
        watch.reply = { statement: text, tag: undefined };
        return;
      }
      // Attached as the statement is handed over, so this reaction runs
      // before the driver's own continuation sees the result.
      result.then(
        (value: unknown) => {
          watch.reply = { statement: text, tag: commandTagOf(value) };
        },
        () => {
          watch.reply = { statement: text, tag: undefined };
        },
      );
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
      observer.handed(text, result);
      trackInFlight(gate, result);
      return observeOutcome(result, observer, () => {
        recordHandOff(gate.ledger, text);
      });
    }
    // Held behind the plant: its place in the session's order is taken when
    // it is actually handed to the driver, after the plant.
    const handOff = (): unknown => {
      recordHandOff(gate.ledger, text);
      const result = statement();
      observer.handed(text, result);
      return result;
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

/** The PostgreSQL frontend message type byte of a simple query (`'Q'`). */
const SIMPLE_QUERY_MESSAGE = 0x51;

/** The SQL text of a simple-query protocol message; `undefined` for any other. */
function simpleQueryText(message: unknown): string | undefined {
  if (!(message instanceof Uint8Array) || message[0] !== SIMPLE_QUERY_MESSAGE) {
    return undefined;
  }
  // Type byte, 4-byte length, then the NUL-terminated query text.
  return new TextDecoder().decode(message.subarray(5, - 1));
}

/** The tag of the last `CommandComplete` among PGlite's parsed replies. */
function commandCompleteTag(replies: unknown): string | undefined {
  if (!Array.isArray(replies)) return undefined;
  let tag: string | undefined;
  for (const reply of replies as readonly unknown[]) {
    if (typeof reply !== "object" || reply === null) continue;
    if (Reflect.get(reply, "name") !== "commandComplete") continue;
    const text: unknown = Reflect.get(reply, "text");
    if (typeof text === "string") tag = text;
  }
  return tag;
}

const PGLITE_PROTOCOL_MEMBER = "execProtocolStream";

/**
 * Reads the reply to the first protocol message the PGlite `instance` is
 * handed from now on — the `COMMIT` its `transaction()` sends once the
 * callback resolved — into `watch`. The instance's own member is shadowed
 * until that message has replied, then put back exactly as it was. Returns
 * the function that puts it back if no message came.
 */
function watchPgliteCommitReply(
  instance: object,
  watch: CommitReplyWatch,
): () => void {
  const inherited: unknown = Reflect.get(instance, PGLITE_PROTOCOL_MEMBER);
  if (typeof inherited !== "function") return ignoreSettlement;
  const previous = Reflect.getOwnPropertyDescriptor(
    instance,
    PGLITE_PROTOCOL_MEMBER,
  );
  function restore(): void {
    if (
      Reflect.getOwnPropertyDescriptor(instance, PGLITE_PROTOCOL_MEMBER)
        ?.value !== observed
    ) {
      return;
    }
    if (previous === undefined) {
      Reflect.deleteProperty(instance, PGLITE_PROTOCOL_MEMBER);
    } else {
      Reflect.defineProperty(instance, PGLITE_PROTOCOL_MEMBER, previous);
    }
  }
  async function observed(this: unknown, ...args: unknown[]): Promise<unknown> {
    if (watch.claimed) return Reflect.apply(inherited as never, this, args);
    watch.claimed = true;
    const statement = normalizedStatementText(simpleQueryText(args[0]));
    try {
      const replies: unknown = await Reflect.apply(
        inherited as never,
        this,
        args,
      );
      watch.reply = { statement, tag: commandCompleteTag(replies) };
      return replies;
    } catch (error) {
      watch.reply = { statement, tag: undefined };
      throw error;
    } finally {
      restore();
    }
  }
  Reflect.defineProperty(instance, PGLITE_PROTOCOL_MEMBER, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: observed,
  });
  return restore;
}

/** Where the reply to `observed`'s `COMMIT` can be read. */
function commitReplySourceOf(
  observed: ObservedClient | undefined,
  pglite: object | undefined,
): CommitReplySource {
  if (observed === undefined) return "unobserved";
  if (pglite !== undefined) return "pglite-protocol";
  if (isPostgresJsClient(observed.raw)) return "driver-refusal";
  return "client-result";
}

type RolledBackDetection = TransactionRolledBackErrorDetails["detectedBy"];

function rolledBack(
  evidence: AttemptEvidence,
  detectedBy: RolledBackDetection,
): TransactionRolledBackError {
  return new TransactionRolledBackError(
    {
      // An attempt that handed out a raw-SQL port is never retried.
      conflict: evidence.conflict && !evidence.released,
      detectedBy,
      causeObserved: evidence.firstEngineError !== undefined,
    },
    { cause: evidence.firstEngineError },
  );
}

/**
 * The outcome of an attempt that failed after a raw-SQL port was handed out:
 * unknown, and never retried. `cause` is the failure.
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
  /**
   * Resolves when nothing a raw-SQL port could have done stands in the way
   * of the `COMMIT`. Sends nothing unless a port was handed out (or the
   * client is unobserved): then reads this attempt's marker back on the same
   * session, and rejects with {@link TransactionOutcomeUnknownError} unless
   * it is there. Waits for every statement queued on the connection first.
   */
  assertCommittable: () => Promise<void>;
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
 * The marker evidence of one transaction. `observed` is its observed pinned
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
      // a raw-SQL port is handed out, nothing can have ended or replaced it.
      if (!evidence.released && isPostgresFailedTransactionError(error)) {
        throw rolledBack(evidence, "refused-statement");
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
    async assertCommittable(): Promise<void> {
      // Every statement queued on the connection settles first, so its
      // failure, if any, has been observed before anything is decided.
      await session.runExclusive(() => Promise.resolve());
      if (evidence.released || markerValue !== undefined) {
        return readMarker();
      }
    },
  };
}

/**
 * What a failed attempt reports, and so whether the retry loop above it may
 * re-run it: the one decision for every way an attempt fails before its
 * `COMMIT` replied — the callback or TypeGraph's own pre-commit work
 * rejecting, the marker refusing, the driver refusing to commit.
 *
 * Without a raw-SQL port handed out:
 *
 * - a statement refused because the transaction was already aborted
 *   (`25P02`), wherever it surfaced, is the rolled-back transaction it
 *   reveals (`detectedBy: "refused-statement"`);
 * - the driver rolling back and rethrowing a failure the transaction's own
 *   statements met, rather than committing (postgres-js), is the rolled-back
 *   transaction it reports (`detectedBy: "driver"`);
 * - anything else propagates unchanged.
 *
 * After a port was handed out, no failure may reach a retry loop as
 * retryable: a refusal of an aborted transaction, the driver's substitution,
 * or a failure the backend's conflict classifier accepts is an unknown
 * outcome with that failure as its `cause`. Any other rejection is the
 * callback's own error, which no retry loop re-runs, and propagates
 * unchanged.
 */
function attemptFailure(
  evidence: AttemptEvidence,
  error: unknown,
  isConflict: (error: unknown) => boolean,
): unknown {
  if (
    error instanceof TransactionRolledBackError ||
    isTransactionOutcomeUnknown(error)
  ) {
    return error;
  }
  const substitutedByDriver =
    evidence.handedToDriver &&
    typeof error === "object" &&
    error !== null &&
    evidence.failures.has(error);
  const refusedAsAborted = isPostgresFailedTransactionError(error);
  if (evidence.released) {
    if (refusedAsAborted) {
      return releasedAttemptFailed(evidence.firstEngineError ?? error);
    }
    return substitutedByDriver || isConflict(error) ?
        releasedAttemptFailed(error)
      : error;
  }
  if (substitutedByDriver) return rolledBack(evidence, "driver");
  if (refusedAsAborted) return rolledBack(evidence, "refused-statement");
  return error;
}

/**
 * The outcome of an attempt whose `COMMIT` resolved, from that `COMMIT`'s
 * reply. Returns when it committed; throws otherwise.
 */
function assertCommitReplied(
  evidence: AttemptEvidence,
  source: CommitReplySource,
): void {
  if (source !== "client-result" && source !== "pglite-protocol") return;
  const reply = evidence.commitReply.reply;
  if (reply?.statement === COMMIT_STATEMENT) {
    if (reply.tag === COMMITTED_TAG) return;
    if (reply.tag === ROLLED_BACK_TAG) {
      throw rolledBack(evidence, "commit-reply");
    }
  }
  throw new TransactionOutcomeUnknownError(
    { reason: "commit-reply-unread" },
    { cause: evidence.firstEngineError },
  );
}

/**
 * Runs one transaction TypeGraph opens on `driver` and will commit, with its
 * outcome decided by the reply to its `COMMIT` (see the module comment).
 *
 * `open` opens the transaction and runs the body it is given inside it —
 * `(body) => db.transaction(body, config)`. The body installs the observer
 * and registers the marker's plant as the transaction's native-handle
 * release, both before anything else binds to the transaction, then runs
 * `body`, then reads the marker if a raw-SQL port was handed out; only a body
 * that resolves and passes that check reaches the driver's `COMMIT`, whose
 * reply is then read. A `body` that rejects waits for whatever the attempt
 * still has running and then lets the driver roll back. Every failure before
 * the reply is reported through {@link attemptFailure}.
 *
 * `isConflict` is the backend's own serialization-failure classifier.
 */
export async function runMarkedPostgresTransaction<T>(
  driver: AnyPgDatabase,
  open: (body: (transaction: AnyPgTransaction) => Promise<T>) => Promise<T>,
  isConflict: (error: unknown) => boolean,
  body: (transaction: AnyPgTransaction) => Promise<T>,
): Promise<T> {
  const evidence: AttemptEvidence = {
    statements: undefined,
    firstEngineError: undefined,
    conflict: false,
    failures: new WeakSet(),
    handedToDriver: false,
    released: false,
    commitReply: { armed: false, claimed: false, reply: undefined },
  };
  const pglite = getPgliteClient(driver);
  let source: CommitReplySource = "unobserved";
  const observer = createStatementObserver(
    evidence,
    isConflict,
    () => source === "client-result",
  );
  let restoreClient: (() => void) | undefined;
  let stopPgliteWatch: (() => void) | undefined;
  let result: T;
  try {
    result = await open(async (transaction) => {
      const gate: SendGate = {
        inFlight: new Set(),
        blocker: undefined,
        ledger: { handed: 0, pendingSavepoints: new Set() },
      };
      let observed: ObservedClient | undefined;
      // Installed for the whole attempt, `COMMIT` included: the reply to the
      // driver's `commit` is read through it.
      restoreClient = replacePinnedPostgresTransactionClient(
        transaction,
        (client) => {
          observed = { raw: client, observer, gate };
          return observeClient(client, observer, gate);
        },
      );
      source = commitReplySourceOf(observed, pglite);
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
        const value = await body(transaction);
        await attempt.assertCommittable();
        evidence.handedToDriver = true;
        // The next statement the driver sends is the `COMMIT`.
        evidence.commitReply.armed = true;
        if (source === "pglite-protocol" && pglite !== undefined) {
          stopPgliteWatch = watchPgliteCommitReply(
            pglite,
            evidence.commitReply,
          );
        }
        return value;
      } catch (error) {
        await attempt?.settle();
        throw error;
      } finally {
        attempt?.close();
        // Only a reply read from the client's results needs the observer
        // through the driver's `COMMIT`.
        if (source !== "client-result") {
          restoreClient?.();
          restoreClient = undefined;
        }
      }
    });
  } catch (error) {
    throw attemptFailure(evidence, error, isConflict);
  } finally {
    stopPgliteWatch?.();
    restoreClient?.();
  }
  assertCommitReplied(evidence, source);
  return result;
}
