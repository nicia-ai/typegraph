import { describe, expect, it } from "vitest";

import { MergeError } from "../../src/graph-merge/errors";
import {
  MAX_COMMIT_ATTEMPTS,
  withTxConflictRetry,
} from "../../src/graph-merge/tx-retry";

/** A pg-driver-shaped error: `code` carries the SQLSTATE. */
function pgError(code: string, message = "tx failed"): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

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
