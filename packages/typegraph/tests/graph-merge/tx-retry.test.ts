import { describe, expect, it } from "vitest";

import { MergeError } from "../../src/graph-merge/errors";
import {
  isRetryableTxConflict,
  MAX_COMMIT_ATTEMPTS,
  withTxConflictRetry,
} from "../../src/graph-merge/tx-retry";

/** A pg-driver-shaped error: `code` carries the SQLSTATE. */
function pgError(code: string, message = "tx failed"): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

describe("isRetryableTxConflict", () => {
  it("detects a serialization failure (40001) by SQLSTATE", () => {
    expect(isRetryableTxConflict(pgError("40001"))).toBe(true);
  });

  it("detects a deadlock (40P01) by SQLSTATE", () => {
    expect(isRetryableTxConflict(pgError("40P01"))).toBe(true);
  });

  it("detects a conflict buried in a wrapped cause chain", () => {
    const wrapped = new Error("Merge failed", {
      cause: new Error("drizzle tx", { cause: pgError("40001") }),
    });
    expect(isRetryableTxConflict(wrapped)).toBe(true);
  });

  it("detects the fixed Postgres message when the SQLSTATE was lost", () => {
    expect(
      isRetryableTxConflict(
        new Error(
          "could not serialize access due to read/write dependencies among transactions",
        ),
      ),
    ).toBe(true);
    expect(isRetryableTxConflict(new Error("deadlock detected"))).toBe(true);
  });

  it("rejects non-conflict SQLSTATEs and plain errors", () => {
    expect(isRetryableTxConflict(pgError("23505"))).toBe(false);
    expect(isRetryableTxConflict(new Error("cardinality violation"))).toBe(
      false,
    );
    expect(isRetryableTxConflict(null)).toBe(false);
    expect(isRetryableTxConflict("40001")).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    const first = new Error("a");
    const second = new Error("b", { cause: first });
    (first as Error & { cause: unknown }).cause = second;
    expect(isRetryableTxConflict(first)).toBe(false);
  });
});

describe("withTxConflictRetry", () => {
  it("retries a retryable conflict and returns the eventual result", async () => {
    let attempts = 0;
    const result = await withTxConflictRetry(async () => {
      attempts += 1;
      if (attempts < MAX_COMMIT_ATTEMPTS) {
        throw pgError("40001", "could not serialize access");
      }
      return "committed";
    });
    expect(result).toBe("committed");
    expect(attempts).toBe(MAX_COMMIT_ATTEMPTS);
  });

  it("propagates a non-retryable error immediately, without retrying", async () => {
    let attempts = 0;
    await expect(
      withTxConflictRetry(async () => {
        attempts += 1;
        throw pgError("23505", "unique violation");
      }),
    ).rejects.toThrow(/unique violation/);
    expect(attempts).toBe(1);
  });

  it("gives up after the bounded attempts with a typed MergeError", async () => {
    let attempts = 0;
    const conflict = pgError("40001", "could not serialize access");
    let caught: unknown;
    try {
      await withTxConflictRetry(async () => {
        attempts += 1;
        throw conflict;
      });
    } catch (error) {
      caught = error;
    }
    expect(attempts).toBe(MAX_COMMIT_ATTEMPTS);
    expect(caught).toBeInstanceOf(MergeError);
    const mergeError = caught as MergeError;
    expect(mergeError.code).toBe("GRAPH_MERGE_ERROR");
    expect(mergeError.cause).toBe(conflict);
  });
});
