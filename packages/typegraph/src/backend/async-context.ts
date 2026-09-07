/**
 * Lazy, optional loader for `node:async_hooks`' `AsyncLocalStorage`, shared by
 * every module that needs to detect something through JavaScript's async call
 * graph rather than through an explicit parameter: `serialized-execution-
 * queue.ts` (a submission made from inside a task this same queue is already
 * running) and `capabilities/retried-unit.ts` (a retried unit started while
 * already inside another one). Each caller builds its OWN loader instance —
 * {@link createAsyncContextLoader} is a factory, not a singleton — so the two
 * concerns never share a context object and one module's marker can never be
 * mistaken for the other's.
 *
 * AsyncLocalStorage is available on Node and on Cloudflare Workers with the
 * `nodejs_als` compatibility flag. A caller whose {@link AsyncContextLoader.current}
 * reads `undefined` — the constructor import failed, or the load has not
 * settled yet — must degrade exactly as it did before this loader existed;
 * this module makes no promise about what that degradation looks like, only
 * about loading the constructor once and reporting whether it succeeded.
 */
export type AsyncContextStore<T> = Readonly<{
  getStore: () => T | undefined;
  run: <R>(store: T, callback: () => R) => R;
}>;

export type AsyncContextLoader<T> = Readonly<{
  /**
   * Resolves once loading has settled — successfully or not; the loader
   * never rejects. A caller awaits this before its first read of
   * {@link current} so "the dynamic import has not resolved yet" is, at
   * worst, one microtask of latency rather than a silent detection gap.
   */
  ready: () => Promise<void>;
  /** The loaded context, or `undefined` when unavailable or not yet loaded. */
  current: () => AsyncContextStore<T> | undefined;
  /**
   * @internal Test seam: replaces the loader's context and readiness state
   * with a caller-controlled value, so a test can simulate a runtime with no
   * AsyncLocalStorage (`context: undefined`) or a cold start where the load
   * has not resolved yet (a `readyDelayMs` the test's own assertions run
   * within) deterministically, instead of racing the real dynamic
   * `import("node:async_hooks")`. Not reachable from published entrypoints.
   */
  setForTesting: (
    context: AsyncContextStore<T> | undefined,
    readyDelayMs?: number,
  ) => void;
  /** @internal Restores the real loader after a test uses {@link setForTesting}. */
  restoreForTesting: () => void;
}>;

export function createAsyncContextLoader<T>(): AsyncContextLoader<T> {
  let context: AsyncContextStore<T> | undefined;

  async function load(): Promise<void> {
    try {
      const asyncHooks = await import("node:async_hooks");
      context = new asyncHooks.AsyncLocalStorage<T>();
    } catch {
      // AsyncLocalStorage unavailable on this runtime: the caller degrades
      // per its own documented fallback.
    }
  }

  let readyPromise: Promise<void> = load();

  return {
    ready: () => readyPromise,
    current: () => context,
    setForTesting(newContext, readyDelayMs = 0) {
      context = undefined;
      readyPromise = new Promise((resolve) => {
        setTimeout(() => {
          context = newContext;
          resolve();
        }, readyDelayMs);
      });
    },
    restoreForTesting() {
      context = undefined;
      readyPromise = load();
    },
  };
}
