/**
 * The one owner of "can this PostgreSQL transaction still commit?" for every
 * transaction TypeGraph itself opens and commits.
 *
 * A statement that fails inside a PostgreSQL transaction aborts the whole
 * transaction, whether or not the code that issued it catches the error. Every
 * later statement is refused with `25P02`, and the server answers the closing
 * `COMMIT` with `ROLLBACK`. node-postgres, neon-serverless and PGlite report
 * that `COMMIT` as a success, so a callback that caught the failure would see
 * its transaction resolve with nothing saved. postgres-js instead tracks the
 * first failed statement of a transaction scope and rethrows it in place of
 * committing.
 *
 * {@link observePostgresTransaction} answers the question before TypeGraph
 * issues the `COMMIT`. Only a failed statement can abort a transaction, so it
 * first asks whether any statement on the session failed:
 *
 * - None did: the transaction can commit, and nothing is probed. A
 *   transaction without failures pays nothing for the check.
 * - One did, on postgres-js, in the transaction's own scope (not inside one of
 *   the driver's savepoint scopes): the driver will roll back in place of
 *   committing, whatever state the session is in, so the transaction is lost.
 * - One did, on any other driver: a probe `SAVEPOINT` asks the session
 *   itself, through the connection's statement queue so it never overlaps a
 *   statement the caller left running. A `25P02` refusal is an aborted
 *   transaction. A `25P01` refusal is a session no longer inside a
 *   transaction block at all: the caller ended the transaction through its
 *   native handle, so nothing written before that will be committed. Success
 *   proves the session is inside a healthy transaction block — a savepoint
 *   rolled it back past every failure so far — and the probe's savepoint is
 *   released at once.
 *
 * The probe proves the session is inside *a* transaction block, not that it
 * is the block TypeGraph opened: a caller that ends the transaction and
 * opens another one through the native handle is not detected, and nor is a
 * caller that ends it with no statement failing first (no probe runs).
 *
 * The session's own answer is preferred to a guess from which calls threw,
 * because a caller may roll a savepoint back past a failure it caught. It is
 * asked with a statement rather than read from the driver's transaction
 * status: node-postgres does expose the `ReadyForQuery` status byte, but
 * delivers a failed statement's error before that message arrives, so the
 * status read right after a caught failure still says the transaction is
 * healthy.
 *
 * Statement failures are observed on the pinned driver client, which every
 * statement on the transaction passes through: Drizzle's session (and so the
 * native `tx.sql` handle a caller holds, its relational queries included) and
 * TypeGraph's compiled fast path all read it at the time they prepare a
 * statement. The observation also supplies the error that aborted the
 * transaction as the {@link TransactionRolledBackError}'s `cause`: the first
 * failure since the transaction began or since the session last proved it
 * had recovered, so a later failure (a statement PostgreSQL parses before it
 * checks for an aborted transaction reports its own syntax error, not
 * `25P02`) never hides the one that aborted it from the retry classifier.
 */
import { TransactionRolledBackError } from "../../../errors";
import { sql } from "../../../query/sql-fragment";
import {
  isPostgresFailedTransactionError,
  isPostgresNoActiveTransactionError,
} from "../../../utils/sql-errors";
import {
  type AnyPgTransaction,
  createPostgresExecutionAdapter,
  getPinnedPostgresTransactionConnection,
  hasFunctionProperty,
  isPostgresJsClient,
  replacePinnedPostgresTransactionClient,
} from "./postgres-execution";
import { createSerialExecutionAdapter } from "./statement-queue";

/** What one TypeGraph-owned transaction exposes about its commit outcome. */
export type ObservedPostgresTransaction = Readonly<{
  /**
   * Resolves when the transaction can still commit. Rejects with a
   * {@link TransactionRolledBackError} when the database has already aborted
   * it. Call it after every statement the transaction issues has settled and
   * before the `COMMIT`; calling it again re-reads the session.
   */
  assertCommittable: () => Promise<void>;
  /** Puts the driver client back. Call once the transaction body has settled. */
  release: () => void;
}>;

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

/** Receives the outcome of every statement sent on the observed session. */
type OutcomeRecorder = Readonly<{
  failed: (error: unknown) => void;
  succeeded: () => void;
}>;

/**
 * The probe's savepoint. Named so it cannot collide with a caller's; it is
 * released by the statement after the one that takes it.
 */
const PROBE_SAVEPOINT = sql`SAVEPOINT typegraph_commit_probe`;
const PROBE_RELEASE = sql`RELEASE SAVEPOINT typegraph_commit_probe`;

/**
 * Observes a statement's pending result without consuming it or changing its
 * outcome. A native promise gets a side branch whose own rejection is
 * handled. A driver's lazy query object (postgres-js, which only executes once
 * something calls its `then`) instead gets an own `then` that records the
 * outcome on the way through: every consumer — `await`, `catch`, `finally`,
 * the driver's own scope tracking — reaches the outcome through `then`, and
 * nothing here triggers execution early.
 */
function observeOutcome(result: unknown, record: OutcomeRecorder): unknown {
  if (result instanceof Promise && result.constructor === Promise) {
    result.then(
      () => {
        record.succeeded();
      },
      (error: unknown) => {
        record.failed(error);
      },
    );
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
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: unknown,
      ): unknown {
        return Reflect.apply(inheritedThen, this, [
          (value: unknown) => {
            record.succeeded();
            if (typeof onFulfilled !== "function") return value;
            return onFulfilled(value);
          },
          (error: unknown) => {
            record.failed(error);
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

function observeClient(client: object, record: OutcomeRecorder): object {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || isFixedProperty(target, property)) {
        return value;
      }
      if (!STATEMENT_MEMBERS.has(property)) {
        return (...args: unknown[]): unknown =>
          Reflect.apply(value, target, args);
      }
      return (...args: unknown[]): unknown =>
        observeOutcome(Reflect.apply(value, target, args), record);
    },
    apply(target, thisArgument, args: unknown[]) {
      return observeOutcome(
        Reflect.apply(
          target as (...a: unknown[]) => unknown,
          thisArgument,
          args,
        ),
        record,
      );
    },
  });
}

/**
 * Starts observing one Drizzle transaction TypeGraph opened. Must run first in
 * the transaction body, before anything binds to the transaction's client.
 * Returns `undefined` when the transaction exposes no inspectable client.
 */
function observePostgresTransaction(
  transaction: AnyPgTransaction,
): ObservedPostgresTransaction | undefined {
  const connection = getPinnedPostgresTransactionConnection(transaction);
  if (connection === undefined) return undefined;

  let failed = false;
  // The error that put the session into its aborted state: the FIRST failure
  // that is not itself a `25P02` refusal caused by an earlier one, counted
  // from the start of the transaction or from the last statement that
  // succeeded after it. An aborted session refuses every statement but a
  // rollback, so a success after a failure means a savepoint rolled it back;
  // only then may a later failure become the cause.
  let abortingError: unknown;
  let succeededSinceFailure = false;
  const record: OutcomeRecorder = {
    failed(error) {
      failed = true;
      if (isPostgresFailedTransactionError(error)) return;
      if (abortingError !== undefined && !succeededSinceFailure) return;
      abortingError = error;
      succeededSinceFailure = false;
    },
    succeeded() {
      if (abortingError !== undefined) succeededSinceFailure = true;
    },
  };

  const release = replacePinnedPostgresTransactionClient(
    transaction,
    (client) => observeClient(client, record),
  );
  if (release === undefined) return undefined;

  const driverTracksScopeFailures = isPostgresJsClient(connection);

  async function isAborted(): Promise<boolean> {
    if (!failed) return false;
    if (driverTracksScopeFailures) return true;
    // Queued with every other statement on this connection, so the probe
    // waits for a statement the caller left running instead of overlapping
    // it on a driver that carries one statement at a time.
    const probeConnection = createSerialExecutionAdapter(
      createPostgresExecutionAdapter(transaction),
      connection,
    );
    // The probe's own refusal is evidence, not the failure being reported.
    const causeBeforeProbe = abortingError;
    const succeededBeforeProbe = succeededSinceFailure;
    try {
      await probeConnection.runExclusive(async (session) => {
        await session.execute(PROBE_SAVEPOINT);
        await session.execute(PROBE_RELEASE);
      });
    } catch (probeError) {
      abortingError = causeBeforeProbe;
      succeededSinceFailure = succeededBeforeProbe;
      if (
        isPostgresFailedTransactionError(probeError) ||
        isPostgresNoActiveTransactionError(probeError)
      ) {
        return true;
      }
      throw probeError;
    }
    // The session is inside a healthy transaction block: a savepoint rolled
    // it back past every failure so far. Only a later failure can abort it
    // again, and that failure is then the cause.
    failed = false;
    abortingError = undefined;
    succeededSinceFailure = false;
    return false;
  }

  return {
    async assertCommittable(): Promise<void> {
      if (!(await isAborted())) return;
      throw new TransactionRolledBackError(
        { dialect: "postgres" },
        { cause: abortingError },
      );
    },
    release,
  };
}

/**
 * Runs the body of a transaction TypeGraph opened and will commit: observes
 * the session from the start, and once `body` resolves — after it has
 * settled every statement it issued — refuses to let the transaction reach
 * its `COMMIT` when the database has already aborted it. A body that rejects
 * propagates unchanged; the driver rolls the transaction back as before.
 */
export async function runCommittingPostgresTransactionBody<T>(
  transaction: AnyPgTransaction,
  body: (observation: ObservedPostgresTransaction | undefined) => Promise<T>,
): Promise<T> {
  const observation = observePostgresTransaction(transaction);
  try {
    const result = await body(observation);
    await observation?.assertCommittable();
    return result;
  } finally {
    observation?.release();
  }
}
