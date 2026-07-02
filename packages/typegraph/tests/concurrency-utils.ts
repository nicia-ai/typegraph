/**
 * Small lab for interleaving tests: bounded waits that distinguish "blocked"
 * from "slow", and explicit gates for holding an operation open at a chosen
 * point. Extracted from the Postgres advisory-lock suite so writing a new
 * concurrency test costs a few lines instead of re-inventing the barrier
 * plumbing.
 */

export const TIMEOUT_SENTINEL = Symbol("timeout");

/**
 * Resolves with the promise's value, or with {@link TIMEOUT_SENTINEL} once
 * `ms` elapses — assert on the sentinel to prove an operation is blocked
 * (`expect(raced).toBe(TIMEOUT_SENTINEL)`) or on its absence to prove it is
 * not (`expect(raced).not.toBe(TIMEOUT_SENTINEL)`).
 */
export async function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMEOUT_SENTINEL> {
  return Promise.race([
    promise,
    new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
      setTimeout(() => {
        resolve(TIMEOUT_SENTINEL);
      }, ms),
    ),
  ]);
}

export type Gate = Readonly<{
  /** Resolves once {@link Gate.open} is called. Await it to hold position. */
  opened: Promise<void>;
  open: () => void;
}>;

/**
 * A one-shot gate: an operation awaits `gate.opened` to pause mid-flight
 * (typically while holding a lock), and the test calls `gate.open()` to let
 * it proceed.
 */
export function createGate(): Gate {
  let release: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    opened,
    open() {
      release?.();
    },
  };
}
