import { describe, expect, it } from "vitest";

import { TransactionConflictError } from "../../src/errors";
import { MergeError } from "../../src/graph-merge/errors";
import { translateMergeCommitError } from "../../src/graph-merge/errors";
import { runRetriedUnit } from "../../src/store/operations/write-transaction";

/** A pg-driver-shaped error: `code` carries the SQLSTATE. */
function pgError(code: string, message = "tx failed"): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

/** Matches `MERGE_COMMIT_ATTEMPTS` in `src/graph-merge/merge.ts`. */
const MERGE_COMMIT_ATTEMPTS = 3;

/**
 * Runs a bare commit callback exactly the way every merge commit site does:
 * through the shared retry owner, translating an exhausted retry into the
 * merge error taxonomy the way `runMergeCommit` does around `commitPlan` /
 * `applyMergePlan` / `commitIncrementalPlan`.
 */
async function runMergeStyleCommit<T>(commit: () => Promise<T>): Promise<T> {
  try {
    return await runRetriedUnit(
      { operation: "test-merge-commit", attempts: MERGE_COMMIT_ATTEMPTS },
      commit,
    );
  } catch (error) {
    throw translateMergeCommitError(error);
  }
}

describe("graph-merge commit retry", () => {
  it("retries a retryable conflict and returns the eventual result", async () => {
    let attempts = 0;
    const result = await runMergeStyleCommit(async () => {
      attempts += 1;
      if (attempts < MERGE_COMMIT_ATTEMPTS) {
        throw pgError("40001", "could not serialize access");
      }
      return "committed";
    });
    expect(result).toBe("committed");
    expect(attempts).toBe(MERGE_COMMIT_ATTEMPTS);
  });

  it("propagates a non-retryable error immediately, without retrying", async () => {
    let attempts = 0;
    await expect(
      runMergeStyleCommit(async () => {
        attempts += 1;
        throw pgError("23505", "unique violation");
      }),
    ).rejects.toThrow(/unique violation/);
    expect(attempts).toBe(1);
  });

  it("gives up after the bounded attempts with a typed MergeError wrapping the conflict", async () => {
    let attempts = 0;
    const conflict = pgError("40001", "could not serialize access");
    let caught: unknown;
    try {
      await runMergeStyleCommit(async () => {
        attempts += 1;
        throw conflict;
      });
    } catch (error) {
      caught = error;
    }
    expect(attempts).toBe(MERGE_COMMIT_ATTEMPTS);
    expect(caught).toBeInstanceOf(MergeError);
    const mergeError = caught as MergeError;
    expect(mergeError.code).toBe("GRAPH_MERGE_ERROR");
    expect(mergeError.details).toMatchObject({
      attempts: MERGE_COMMIT_ATTEMPTS,
    });
    expect(mergeError.cause).toBeInstanceOf(TransactionConflictError);
    const conflictError = mergeError.cause as TransactionConflictError;
    expect(conflictError.details.attempts).toBe(MERGE_COMMIT_ATTEMPTS);
    expect(conflictError.cause).toBe(conflict);
  });
});
