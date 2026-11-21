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
 * - One did, on any other driver: one probe statement asks the session
 *   itself. A `25P02` refusal is an aborted transaction; a result proves a
 *   savepoint rolled the session back past every failure so far.
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
 * transaction as the {@link TransactionRolledBackError}'s `cause`.
 */
import { TransactionRolledBackError } from "../../../errors";
import { sql } from "../../../query/sql-fragment";
import { isPostgresFailedTransactionError } from "../../../utils/sql-errors";
import {
  type AnyPgTransaction,
  createPostgresExecutionAdapter,
  getPinnedPostgresTransactionConnection,
  hasFunctionProperty,
  isPostgresJsClient,
  replacePinnedPostgresTransactionClient,
} from "./postgres-execution";

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

type FailureRecorder = (error: unknown) => void;

/**
 * Observes a statement's pending result without consuming it or changing its
 * outcome. A native promise gets a side branch whose own rejection is
 * handled. A driver's lazy query object (postgres-js, which only executes once
 * something calls its `then`) instead gets an own `then` that records a
 * rejection on the way through: every consumer — `await`, `catch`, `finally`,
 * the driver's own scope tracking — reaches the outcome through `then`, and
 * nothing here triggers execution early.
 */
function observeOutcome(result: unknown, record: FailureRecorder): unknown {
  if (result instanceof Promise && result.constructor === Promise) {
    result.then(undefined, (error: unknown) => {
      record(error);
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
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: unknown,
      ): unknown {
        return Reflect.apply(inheritedThen, this, [
          onFulfilled,
          (error: unknown) => {
            record(error);
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

function observeClient(client: object, record: FailureRecorder): object {
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
export function observePostgresTransaction(
  transaction: AnyPgTransaction,
): ObservedPostgresTransaction | undefined {
  const connection = getPinnedPostgresTransactionConnection(transaction);
  if (connection === undefined) return undefined;

  let failed = false;
  // The error that put the session into its aborted state: the latest failure
  // that is not itself a `25P02` refusal caused by an earlier one. A failure a
  // savepoint recovered is superseded by the next one that aborts.
  let abortingError: unknown;
  const record: FailureRecorder = (error) => {
    failed = true;
    if (!isPostgresFailedTransactionError(error)) abortingError = error;
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
    try {
      await createPostgresExecutionAdapter(transaction).execute(sql`SELECT 1`);
    } catch (probeError) {
      if (isPostgresFailedTransactionError(probeError)) return true;
      throw probeError;
    }
    // The session answered: a savepoint rolled it back past every failure so
    // far. Only a later failure can abort it again.
    failed = false;
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
