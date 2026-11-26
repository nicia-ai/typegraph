/**
 * The one statement queue of a connection a transaction runs on.
 *
 * Every view of a transaction's connection — the transaction's own backend,
 * a backend adopted over its native handle, a trusted-import session —
 * enqueues its statements here, synchronously, as they are submitted. The
 * queue starts them one at a time in submission order, whichever view
 * submitted them: two views of one connection never reorder each other's
 * work, so a read through one sees every write already submitted through
 * the other. A view keeps the promises of the statements it enqueued for
 * its own drain-and-close; ordering is the connection's, not the view's.
 *
 * Edge-safe: no `node:*` imports.
 */

export type ConnectionStatementQueue = Readonly<{
  /**
   * Runs `task` once every task enqueued before it has settled; on an idle
   * queue it starts synchronously, in the call. `task` must not throw
   * synchronously (a throw is turned into a rejection so the queue never
   * stalls).
   */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  /** Waits until every task enqueued so far has settled. Never rejects. */
  drain: () => Promise<void>;
}>;

/**
 * Swallows a task's outcome: its caller owns the result, the queue only
 * needs to know it settled.
 */
function ignoreOutcome(): void {
  // Intentionally empty: see above.
}

export function createConnectionStatementQueue(): ConnectionStatementQueue {
  // Always fulfilled: a failed statement must not strand its successors.
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  /** Runs `task` in the call; a synchronous throw becomes its rejection. */
  async function start<T>(task: () => Promise<T>): Promise<T> {
    return task();
  }

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const previous = pending === 0 ? undefined : tail;
      pending += 1;
      // Queued, `task` runs inside the callback, so a throw rejects the
      // callback's own promise: an already-rejected promise returned from a
      // callback would sit unhandled until it is adopted.
      const result =
        previous === undefined ? start(task) : previous.then(() => task());
      tail = result.then(ignoreOutcome, ignoreOutcome).then(() => {
        pending -= 1;
      });
      return result;
    },

    async drain(): Promise<void> {
      while (pending > 0) {
        await tail;
      }
    },
  };
}

const connectionQueues = new WeakMap<object, ConnectionStatementQueue>();

/**
 * The statement queue of the connection `connection` identifies: THE one
 * registry, so every view of one connection shares one queue. `connection`
 * is the identity the native-transaction record resolves for a handle (a
 * SQLite driver client, Durable Object storage, a libSQL transaction
 * handle) or a PostgreSQL transaction's pinned owner.
 */
export function connectionStatementQueue(
  connection: object,
): ConnectionStatementQueue {
  const existing = connectionQueues.get(connection);
  if (existing !== undefined) return existing;
  const queue = createConnectionStatementQueue();
  connectionQueues.set(connection, queue);
  return queue;
}
