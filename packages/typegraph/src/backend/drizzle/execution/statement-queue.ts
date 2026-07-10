/**
 * Per-connection statement serialization for transaction-scoped backends.
 *
 * A pooled backend hands every statement its own connection, so concurrent
 * work is genuinely concurrent. A transaction is the opposite: every
 * statement shares one pinned connection, and the PostgreSQL wire protocol
 * has no request pipelining a driver could use to keep two in flight. Drivers
 * paper over this with an internal queue — node-postgres queues on
 * `Client._queryQueue` — but that queue is deprecated as of `pg@8.22` and is
 * removed in `pg@9`:
 *
 * > Calling client.query() when the client is already executing a query is
 * > deprecated and will be removed in pg@9.0. Use async/await or an external
 * > async flow control mechanism instead.
 *
 * TypeGraph overlaps statements on a pinned connection by construction: the
 * node write pipeline issues embedding and fulltext sync concurrently, and
 * `store.transaction()` invites callers to `Promise.all` their writes. This
 * queue is the "external async flow control mechanism" the deprecation asks
 * for — it keeps the concurrency at the API surface while presenting exactly
 * one statement at a time to the connection.
 *
 * Wrapping is deliberately confined to transaction-scoped adapters. On a pool
 * the queue would serialize independent connections and destroy throughput.
 *
 * Edge-safe: no `node:*` imports (loaded on Workers via neon-serverless).
 */
import { type SQL } from "drizzle-orm";

import { TransactionClosedError } from "../../../errors";
import {
  type CompiledSqlQuery,
  type PreparedSqlStatement,
  type SqlExecutionAdapter,
} from "./types";

/**
 * A {@link SqlExecutionAdapter} that runs one statement at a time and can be
 * shut so that late statements never reach the connection.
 */
export type SerialExecutionAdapter = SqlExecutionAdapter &
  Readonly<{
    runExclusive: NonNullable<SqlExecutionAdapter["runExclusive"]>;
    /**
     * Waits for the statement currently on the wire, then refuses every
     * later one with a {@link TransactionClosedError}.
     *
     * Callers invoke this at the transaction boundary, before the driver
     * emits `COMMIT` / `ROLLBACK` on the same connection. The driver's control
     * statement does not travel through this queue, so without the drain it
     * would overlap a live statement; without the close, a statement the
     * callback left running could land after the pool reclaimed the
     * connection — inside an unrelated transaction.
     *
     * Idempotent.
     */
    drainAndClose: () => Promise<void>;
  }>;

type StatementQueue = Readonly<{
  /** Runs tasks one at a time, in the order they were submitted. */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  drainAndClose: () => Promise<void>;
}>;

/**
 * Swallows a statement's outcome so the queue's tail always fulfills. The
 * caller owns the result promise; the tail only tracks completion, and an
 * untouched rejection here would surface as an unhandled rejection.
 */
function ignoreOutcome(): void {
  // Intentionally empty: see above.
}

function createStatementQueue(): StatementQueue {
  // Always fulfilled: a failed statement must not strand its successors, and
  // an untouched rejection here would surface as an unhandled rejection.
  let tail: Promise<void> = Promise.resolve();
  let closed = false;

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new TransactionClosedError());
      // Chained synchronously, so queue order is submission order.
      const result = tail.then(() => task());
      tail = result.then(ignoreOutcome, ignoreOutcome);
      return result;
    },

    async drainAndClose(): Promise<void> {
      // Close first: a statement whose continuation enqueues a successor must
      // find the queue already shut, or it would slip in behind the drain.
      closed = true;
      await tail;
    },
  };
}

/**
 * Wraps `adapter` so at most one statement is in flight on its connection.
 *
 * Only the I/O members are queued. `compile` is pure — it renders a Drizzle
 * `SQL` to text and params without touching the connection — so it stays
 * synchronous and unqueued.
 *
 * The queue is a leaf: nothing it runs re-enters it, so a queued statement
 * can never wait on a statement queued behind it.
 */
export function createSerialExecutionAdapter(
  adapter: SqlExecutionAdapter,
): SerialExecutionAdapter {
  const { enqueue, drainAndClose } = createStatementQueue();
  const { executeCompiled, prepare } = adapter;

  return {
    drainAndClose,

    compile(query: SQL): CompiledSqlQuery {
      return adapter.compile(query);
    },

    execute<TRow>(query: SQL): Promise<readonly TRow[]> {
      return enqueue(() => adapter.execute<TRow>(query));
    },

    runExclusive<T>(
      critical: (connection: SqlExecutionAdapter) => Promise<T>,
    ): Promise<T> {
      // One queue slot for the whole group. `critical` receives the UNQUEUED
      // adapter: re-entering the queue from inside the slot it already holds
      // would deadlock, and it needs no serializing anyway — nothing else can
      // reach the connection until the slot is released.
      return enqueue(() => critical(adapter));
    },

    ...(executeCompiled === undefined ?
      {}
    : {
        executeCompiled<TRow>(
          compiledQuery: CompiledSqlQuery,
        ): Promise<readonly TRow[]> {
          return enqueue(() => executeCompiled<TRow>(compiledQuery));
        },
      }),

    ...(prepare === undefined ?
      {}
    : {
        prepare(sqlText: string): PreparedSqlStatement {
          const statement = prepare(sqlText);
          return {
            execute<TRow>(params: readonly unknown[]): Promise<readonly TRow[]> {
              return enqueue(() => statement.execute<TRow>(params));
            },
          };
        },
      }),
  };
}
