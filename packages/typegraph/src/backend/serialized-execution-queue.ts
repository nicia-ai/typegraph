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

/**
 * How a queue behaves when the AsyncLocalStorage-based reentrancy detection
 * below is unavailable (or has not finished loading yet):
 *
 * - `"detect"` — best-effort. If the context is unavailable, the queue runs
 *   the task WITHOUT detection, exactly as it always has. SQLite's own
 *   per-connection queue (`sqlite.ts`) uses this: undetected reentrancy there
 *   is a quality-of-life deadlock guard, not a correctness promise a caller
 *   is relying on to hold.
 * - `"require"` — reentrancy detection IS part of the promise this queue
 *   makes. A `caller-serialized` write-fence declaration says every write
 *   unit this backend issues is serialized in-process; a transaction that
 *   silently deadlocks on a nested root write (because detection happened to
 *   be unavailable on this runtime, or the loader had not yet resolved on a
 *   cold start) would falsify that promise instead of merely degrading it.
 *   Under `"require"`, an unavailable context refuses EVERY submission with
 *   `CALLER_SERIALIZED_REQUIRES_ASYNC_CONTEXT` instead of running undetected.
 */
type ReentrancyMode = "detect" | "require";

export type SerializedExecutionQueueOptions = Readonly<{
  reentrancy: ReentrancyMode;
  /**
   * Names this queue in the reentrancy / async-context refusal's message and
   * structured details — a SQLite dialect string for SQLite's own queue, or
   * `"caller-serialized"` for the in-process write-unit queue
   * `createSqlBackend` builds from a `caller-serialized` write-fence
   * declaration. Replaces a hardcoded `"sqlite"` the refusal used to report
   * regardless of which queue actually rejected the submission.
   */
  subject: string;
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
 * and on Cloudflare workers with the `nodejs_als` compatibility flag. Under
 * `reentrancy: "detect"`, a runtime without it simply skips the detection
 * (the queue behaves as before); under `"require"`, its absence is refused —
 * see {@link ReentrancyMode}.
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
    // stay undetected under `reentrancy: "detect"`, and every submission is
    // refused under `reentrancy: "require"` — see `runExclusive` below.
  }
}

/**
 * Resolves once {@link loadQueueTaskContext} has settled — successfully or
 * not; the function above never throws, so this promise never rejects.
 * `runExclusive` awaits it before running ANY task body, on both
 * {@link ReentrancyMode}s: that is what turns "the dynamic import has not
 * resolved yet" from a silent detection gap into, at worst, one microtask of
 * latency before the first task of this queue's lifetime ever runs — by the
 * time a task's own body executes (and could make a nested submission to
 * this same queue), `queueTaskContext` has already reached its final value.
 */
let queueTaskContextReadyPromise: Promise<void> = loadQueueTaskContext();

/**
 * @internal Test seam for `tests/caller-serialized-queue.test.ts`: replaces
 * the module's cached AsyncLocalStorage context and readiness state with a
 * caller-controlled value, so a test can simulate a runtime with no
 * AsyncLocalStorage (`context: undefined`) or a cold start where the loader
 * has not resolved yet (a `readyDelayMs` the test's own assertions run
 * within) deterministically, instead of racing the real dynamic
 * `import("node:async_hooks")`. Not reachable from published entrypoints.
 */
export function __setQueueTaskContextForTesting(
  context: QueueTaskContext | undefined,
  readyDelayMs = 0,
): void {
  queueTaskContext = undefined;
  queueTaskContextReadyPromise = new Promise((resolve) => {
    setTimeout(() => {
      queueTaskContext = context;
      resolve();
    }, readyDelayMs);
  });
}

/** @internal Restores the real loader after a test uses the seam above. */
export function __restoreQueueTaskContextForTesting(): void {
  queueTaskContext = undefined;
  queueTaskContextReadyPromise = loadQueueTaskContext();
}

function rejectReentrantQueueSubmission(subject: string): Promise<never> {
  return Promise.reject(
    new ConfigurationError(
      "This operation was awaited from inside a transaction running on the " +
        `same ${subject} backend and would deadlock: the transaction holds ` +
        "the backend's serialized execution slot until it completes, so " +
        "the operation could never run.",
      { code: "SERIALIZED_QUEUE_REENTRANT_SUBMISSION", subject },
      {
        suggestion:
          "Inside a store.transaction callback, use the transaction-scoped " +
          "context (tx.nodes / tx.edges / tx.backend) instead of the root " +
          "store or backend, or move the operation outside the transaction.",
      },
    ),
  );
}

/**
 * THE refusal `runExclusive` throws under `reentrancy: "require"` when the
 * AsyncLocalStorage context this queue's promise depends on never became
 * available (an unsupported runtime) or had not resolved by the time this
 * submission's turn came up. Refusing beats running without detection: a
 * `caller-serialized` in-process promise with no working reentrancy guard is
 * a promise this queue cannot actually keep.
 */
function rejectAsyncContextUnavailable(subject: string): Promise<never> {
  return Promise.reject(
    new ConfigurationError(
      `The ${subject} write-unit queue requires AsyncLocalStorage ` +
        "(node:async_hooks) to detect a reentrant submission, but it is " +
        "unavailable on this runtime, so this submission is refused rather " +
        "than run without the detection this queue's caller-serialized " +
        "promise depends on.",
      { code: "CALLER_SERIALIZED_REQUIRES_ASYNC_CONTEXT", subject },
      {
        suggestion:
          "Run on a runtime that supports node:async_hooks' " +
          "AsyncLocalStorage (Node.js, or Cloudflare Workers with the " +
          "nodejs_als compatibility flag), or avoid declaring " +
          '`writeFence.mechanism: "caller-serialized"` on this runtime.',
      },
    ),
  );
}

export function createSerializedExecutionQueue(
  options: SerializedExecutionQueueOptions,
): SerializedExecutionQueue {
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
      // Synchronous, at call time, deliberately NOT deferred behind
      // `queueTaskContextReadyPromise`: a submission made from INSIDE a task
      // this same queue is currently running only ever reaches this point
      // after `runTask` (below) already awaited that readiness promise for
      // the ENCLOSING task, so `queueTaskContext` is already resolved by
      // then. Waiting here too would let two concurrent top-level
      // submissions race the promise instead of strictly ordering by call
      // time, which is what keeps the FIFO guarantee below correct.
      if (queueTaskContext?.getStore()?.has(taskMarker) === true) {
        return rejectReentrantQueueSubmission(options.subject);
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
          // Awaited before the context is read (on BOTH reentrancy modes),
          // so a nested submission made from inside `task()` — whether this
          // queue was constructed a microtask ago or a minute ago — always
          // observes `queueTaskContext`'s FINAL value rather than a
          // still-loading `undefined`. See the module doc above.
          await queueTaskContextReadyPromise;
          if (isDisposed()) return await pendingForever<T>();
          const context = queueTaskContext;
          if (context === undefined) {
            if (options.reentrancy === "require") {
              return await rejectAsyncContextUnavailable(options.subject);
            }
            return await task();
          }
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
