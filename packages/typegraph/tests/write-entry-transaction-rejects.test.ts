/**
 * A WRITE THAT OPENS ITS OWN TRANSACTION REPORTS A SETUP FAILURE AS A
 * REJECTION.
 *
 * The helpers that open a write's own transaction are promise-returning, and
 * a caller may compose them without `await` (inside `Promise.all`, a retry
 * owner, a `.then` chain). A backend whose `transaction()` throws while it
 * sets the transaction up — before it returns a promise — must therefore
 * surface as a rejected promise, never as a synchronous throw out of the
 * helper. Before sessions this was guaranteed by `runOptionallyInTransaction`
 * being `async`; the opener that replaced it must keep that.
 *
 * MUTATION CHECK, verified and reverted: dropping `async` from
 * `runInWriteEntryTransaction` (so it returns `root.transaction(...)`
 * directly) fails all three cases: each helper throws synchronously.
 */
import { describe, expect, it } from "vitest";

import { deriveBackend } from "../src/backend/derive-backend";
import type { GraphBackend } from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  runInWriteEntryTransaction,
  runInWriteTransaction,
  runOwnedMutationSetTransaction,
  type WriteTransactionContext,
} from "../src/store/operations/write-transaction";
import { createTestBackend } from "./test-utils";

class TransactionSetupFailure extends Error {}

/** A root whose `transaction()` throws before it returns a promise. */
function backendWhoseTransactionThrows(): GraphBackend {
  const base: GraphBackend = createTestBackend();
  return deriveBackend(base, {
    transaction: () => {
      throw new TransactionSetupFailure("transaction setup failed");
    },
  });
}

const ctx: WriteTransactionContext = {
  graphId: "write_entry_rejects",
  schemaVersion: undefined,
  historyEnabled: false,
  revisionTrackingEnabled: false,
  revisionSchema: createSqlSchema(),
};

/**
 * Calls `start` and returns what it produced, failing the test if it threw
 * synchronously instead.
 */
function startWithoutThrowing(start: () => Promise<unknown>): Promise<unknown> {
  let started: Promise<unknown> | undefined;
  expect(() => {
    started = start();
  }).not.toThrow();
  if (started === undefined) throw new Error("the helper returned nothing");
  return started;
}

describe("a write that opens its own transaction", () => {
  it("rejects when the backend's transaction() throws during setup", async () => {
    const backend = backendWhoseTransactionThrows();
    const pending = startWithoutThrowing(() =>
      runInWriteEntryTransaction(backend, () => Promise.resolve("ran")),
    );
    await expect(pending).rejects.toBeInstanceOf(TransactionSetupFailure);
  });

  it("rejects through the mutation-set opener", async () => {
    const backend = backendWhoseTransactionThrows();
    const pending = startWithoutThrowing(() =>
      runOwnedMutationSetTransaction(backend, () => Promise.resolve("ran")),
    );
    await expect(pending).rejects.toBeInstanceOf(TransactionSetupFailure);
  });

  it("rejects through the write executor", async () => {
    const backend = backendWhoseTransactionThrows();
    const pending = startWithoutThrowing(() =>
      runInWriteTransaction(ctx, backend, () => Promise.resolve("ran")),
    );
    await expect(pending).rejects.toBeInstanceOf(TransactionSetupFailure);
  });
});
