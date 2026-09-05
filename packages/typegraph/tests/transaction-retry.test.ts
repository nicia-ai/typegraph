/**
 * Unit tests for the store's retry owner, {@link runRetriedUnit}. Acceptance
 * tests that exercise it through `store.transaction`, hooks, and import land
 * here too as those features are wired up; this file currently covers the
 * owner itself, in isolation from any backend.
 */
import { describe, expect, it, vi } from "vitest";

import { TransactionConflictError } from "../src/errors";
import { runRetriedUnit } from "../src/store/operations/write-transaction";

/** A pg-driver-shaped error: `code` carries the SQLSTATE. */
function pgError(code: string, message = "tx failed"): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

describe("runRetriedUnit", () => {
  it("passes a fresh frame with the 1-based attempt number on every call", async () => {
    const seenFrames: Readonly<{ attempt: number }>[] = [];
    let attempts = 0;
    const result = await runRetriedUnit(
      { operation: "test", attempts: 3 },
      async (frame) => {
        await Promise.resolve();
        seenFrames.push(frame);
        attempts += 1;
        if (attempts < 3) throw pgError("40001");
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(seenFrames.map((frame) => frame.attempt)).toEqual([1, 2, 3]);
    // A fresh object every call, never one shared/mutated frame.
    expect(new Set(seenFrames).size).toBe(seenFrames.length);
  });

  it("rethrows a non-retryable failure unchanged, without a second attempt", async () => {
    let attempts = 0;
    const failure = pgError("23505", "unique violation");
    await expect(
      runRetriedUnit({ operation: "test", attempts: 3 }, async () => {
        await Promise.resolve();
        attempts += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("throws TransactionConflictError with attempts and the last failure as cause on exhaustion", async () => {
    let attempts = 0;
    const lastFailure = pgError("40001", "third strike");
    let caught: unknown;
    try {
      await runRetriedUnit(
        { operation: "widget-write", attempts: 3 },
        async () => {
          await Promise.resolve();
          attempts += 1;
          throw attempts === 3 ? lastFailure : (
              pgError("40001", `attempt ${attempts}`)
            );
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(attempts).toBe(3);
    expect(caught).toBeInstanceOf(TransactionConflictError);
    const conflict = caught as TransactionConflictError;
    expect(conflict.details).toEqual({
      operation: "widget-write",
      attempts: 3,
    });
    expect(conflict.cause).toBe(lastFailure);
  });

  it("waits with no delay before attempt 2 and a bounded, jittered delay from attempt 3 on", async () => {
    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        // Fire immediately so the test does not actually wait out the delay;
        // only the REQUESTED delay is under test here.
        return originalSetTimeout(callback, 0);
      });
    try {
      let attempts = 0;
      const result = await runRetriedUnit(
        { operation: "test", attempts: 4 },
        async () => {
          await Promise.resolve();
          attempts += 1;
          if (attempts < 4) throw pgError("40001");
          return "done";
        },
      );
      expect(result).toBe("done");
      // No timer scheduled before attempt 1 (first try) or attempt 2
      // (immediate retry); one bounded, jittered delay before each of
      // attempts 3 and 4.
      expect(delays).toHaveLength(2);
      for (const delayMs of delays) {
        expect(delayMs).toBeGreaterThan(0);
        expect(delayMs).toBeLessThanOrEqual(75); // 50ms cap, jittered up to 1.5x
      }
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
