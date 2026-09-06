/**
 * The in-process half of a write-fence promise: a FIFO queue that runs one
 * task at a time on the same JavaScript process, used wherever a backend (or
 * a `caller-serialized` write-fence declaration built on top of one) needs to
 * serialize the top-level operations it issues rather than relying on a
 * database-side lock.
 *
 * Moved out of `./drizzle/sqlite.ts` (SQLite's own per-connection queue is
 * still built by calling {@link createSerializedExecutionQueue} from there)
 * so `src/backend/drizzle/engine/create-sql-backend.ts` can build a second,
 * independent instance for a `caller-serialized` backend without importing a
 * Drizzle-specific module to get it.
 */
import { BackendDisposedError, ConfigurationError } from "../errors";

export type SerializedExecutionQueue = Readonly<{
  dispose: () => void;
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
}>;

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

/** A shared promise that never settles — used to absorb post-dispose work. */
const PENDING_FOREVER: Promise<never> = new Promise<never>(noop);

function pendingForever<T>(): Promise<T> {
  return PENDING_FOREVER;
}

/**
 * Tracks every serialized queue (if any) the current async execution is
 * running a task FOR — every enclosing `runExclusive` call, not only the
 * innermost one — so a re-entrant submission to ANY of them can be rejected
 * with a typed error instead of deadlocking (the enclosing task holds the
 * queue slot until it completes, so the inner operation can never run).
 *
 * A `caller-serialized` backend built on top of SQLite nests two queue
 * instances: this module's own, and SQLite's per-connection one
 * (`sqlite.ts`'s `transaction`/`transactionWithNative` run inside BOTH).
 * `AsyncLocalStorage.run` replaces the ambient store for the DURATION of its
 * own callback — it does not merge with whatever the enclosing `run` already
 * set — so storing a single marker (as this module used to) would let the
 * inner queue's `run` shadow the outer one's marker for exactly the window a
 * reentrant submission to the OUTER queue needs it visible. Storing the SET
 * of every marker still on the stack, accumulated as each `run` nests, is
 * what keeps every enclosing queue's own reentrancy check correct regardless
 * of how many other queues are nested inside it.
 *
 * AsyncLocalStorage is loaded lazily and optionally: it is available on Node
 * and on Cloudflare workers with the `nodejs_als` compatibility flag, and a
 * runtime without it simply skips the detection (the queue behaves as before).
 */
type QueueTaskContext = Readonly<{
  getStore: () => ReadonlySet<object> | undefined;
  run: <T>(store: ReadonlySet<object>, callback: () => T) => T;
}>;

let queueTaskContext: QueueTaskContext | undefined;

async function loadQueueTaskContext(): Promise<void> {
  try {
    const asyncHooks = await import("node:async_hooks");
    queueTaskContext = new asyncHooks.AsyncLocalStorage<ReadonlySet<object>>();
  } catch {
    // AsyncLocalStorage unavailable on this runtime: re-entrant submissions
    // stay undetected, matching the queue's previous behavior.
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- the dual CJS/ESM build cannot use top-level await
void loadQueueTaskContext();

function rejectReentrantQueueSubmission(): Promise<never> {
  return Promise.reject(
    new ConfigurationError(
      "This operation was awaited from inside a transaction running on the " +
        "same SQLite backend and would deadlock: the transaction holds the " +
        "backend's serialized execution slot until it completes, so the " +
        "operation could never run.",
      { backend: "sqlite", capability: "concurrentRootAccess" },
      {
        suggestion:
          "Inside a store.transaction callback, use the transaction-scoped " +
          "context (tx.nodes / tx.edges / tx.backend) instead of the root " +
          "store or backend, or move the operation outside the transaction.",
      },
    ),
  );
}

export function createSerializedExecutionQueue(): SerializedExecutionQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;
  // Unique per queue: a task running on THIS queue must not submit back to it,
  // but may freely submit to a different backend's queue.
  const taskMarker: object = {};

  function isDisposed(): boolean {
    return disposed;
  }

  return {
    dispose() {
      disposed = true;
    },

    runExclusive<T>(task: () => Promise<T>): Promise<T> {
      if (isDisposed()) return Promise.reject(new BackendDisposedError());
      if (queueTaskContext?.getStore()?.has(taskMarker) === true) {
        return rejectReentrantQueueSubmission();
      }

      // When disposed, runTask returns a never-settling promise so that no
      // rejection propagates through the 7+ async wrappers between this
      // queue and the store-level caller. A rejection here would become an
      // unhandled rejection if the caller abandoned the promise during
      // teardown — and JavaScript offers no way to `.catch()` a rejection
      // at the bottom of a chain without every async wrapper above it also
      // creating an independently-unhandled rejected promise.
      //
      // The tradeoff: an active caller whose operation was queued before
      // dispose() will see a permanently-pending promise rather than a
      // BackendDisposedError. Post-dispose submissions (the check above)
      // still reject immediately since the caller actively holds that
      // promise.
      const runTask = async (): Promise<T> => {
        if (isDisposed()) return pendingForever<T>();
        try {
          const context = queueTaskContext;
          if (context === undefined) return await task();
          const activeMarkers = new Set(context.getStore());
          activeMarkers.add(taskMarker);
          return await context.run(activeMarkers, () => task());
        } catch (error) {
          if (isDisposed()) return pendingForever<T>();
          throw error;
        }
      };
      const result = tail.then(runTask, runTask);
      tail = result.then(
        () => 0,
        () => 0,
      );
      return result;
    },
  };
}

export function runWithSerializedQueue<T>(
  queue: SerializedExecutionQueue | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (queue === undefined) return task();
  return queue.runExclusive(task);
}
