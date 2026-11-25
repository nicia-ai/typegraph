/**
 * The native transaction a binding runs on, as the engine records it once per
 * bind and the Store resolves it, and the state every session of one native
 * transaction shares (`session.native`).
 *
 * The cross-backend shape (an opener, two plain adoptions and a history
 * adoption of one native transaction, on every lane) is in
 * `backends/integration/native-transaction-handle-probes.ts`.
 */
import { describe, expect, it } from "vitest";

import { deriveBackend } from "../src/backend/derive-backend";
import {
  recordNativeTransactionHandle,
  resolveNativeTransactionHandle,
  runConnectionNativeTransaction,
} from "../src/backend/native-transaction-handle";
import type { TransactionBackend } from "../src/backend/types";
import { resolveNativeTransactionState } from "../src/store/native-transaction-state";
import { openTransactionSession } from "../src/store/operation-scope";
import { createTestBackend } from "./test-utils";

/** A span body that settles when the test says so. */
function heldSpan(): Readonly<{
  run: () => Promise<void>;
  end: () => void;
}> {
  const ends: (() => void)[] = [];
  return {
    run: () =>
      new Promise<void>((resolve) => {
        ends.push(resolve);
      }),
    end: () => {
      for (const end of ends) end();
    },
  };
}

/** A stand-in for a bound engine transaction backend. */
function boundBackend(): object {
  return { bound: true };
}

describe("native transaction record", () => {
  it("records a per-BEGIN handle as itself, and every bind on it resolves it", () => {
    const handle = { begin: 1 };
    const first = boundBackend();
    const second = boundBackend();
    recordNativeTransactionHandle(first, handle, "transaction");
    recordNativeTransactionHandle(second, handle, "transaction");
    expect(resolveNativeTransactionHandle(first)).toBe(handle);
    expect(resolveNativeTransactionHandle(second)).toBe(handle);
  });

  it("resolves the record along the derivation chain", () => {
    const handle = { begin: 1 };
    const bound = boundBackend();
    recordNativeTransactionHandle(bound, handle, "transaction");
    const derived = deriveBackend(deriveBackend(bound, {}), {});
    expect(resolveNativeTransactionHandle(derived)).toBe(handle);
  });

  it("records nothing for a backend no engine bound", () => {
    expect(resolveNativeTransactionHandle(boundBackend())).toBeUndefined();
  });

  it("records nothing for a connection the engine holds no transaction open on", () => {
    const connection = { connection: true };
    const bound = boundBackend();
    recordNativeTransactionHandle(bound, connection, "connection");
    expect(resolveNativeTransactionHandle(bound)).toBeUndefined();
  });

  it("identifies each engine transaction on a connection by a token of its own, never the connection", async () => {
    const connection = { connection: true };
    const inFirst = await runConnectionNativeTransaction(connection, () => {
      const one = boundBackend();
      const two = boundBackend();
      recordNativeTransactionHandle(one, connection, "connection");
      recordNativeTransactionHandle(two, connection, "connection");
      return Promise.resolve([one, two] as const);
    });
    const inSecond = await runConnectionNativeTransaction(connection, () => {
      const bound = boundBackend();
      recordNativeTransactionHandle(bound, connection, "connection");
      return Promise.resolve(bound);
    });
    const afterwards = boundBackend();
    recordNativeTransactionHandle(afterwards, connection, "connection");

    const first = resolveNativeTransactionHandle(inFirst[0]);
    expect(first).toBeDefined();
    expect(first).not.toBe(connection);
    expect(resolveNativeTransactionHandle(inFirst[1])).toBe(first);
    const second = resolveNativeTransactionHandle(inSecond);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(resolveNativeTransactionHandle(afterwards)).toBeUndefined();
  });

  it("never reinstates the token of a span that ended first when spans on one connection end out of order", async () => {
    const connection = { connection: true };
    const outerSpan = heldSpan();
    const outer = runConnectionNativeTransaction(connection, outerSpan.run);
    const innerSpan = heldSpan();
    const inner = runConnectionNativeTransaction(connection, innerSpan.run);
    outerSpan.end();
    await outer;
    innerSpan.end();
    await inner;
    const afterwards = boundBackend();
    recordNativeTransactionHandle(afterwards, connection, "connection");
    expect(resolveNativeTransactionHandle(afterwards)).toBeUndefined();
  });
});

describe("native transaction state", () => {
  it("is one object for every binding recorded on one native transaction", () => {
    const handle = { begin: 1 };
    const first = boundBackend();
    const second = boundBackend();
    recordNativeTransactionHandle(first, handle, "transaction");
    recordNativeTransactionHandle(second, handle, "transaction");
    const state = resolveNativeTransactionState(first);
    expect(resolveNativeTransactionState(second)).toBe(state);
    expect(resolveNativeTransactionState(deriveBackend(second, {}))).toBe(
      state,
    );
  });

  it("is a state of its own per binding when the engine recorded nothing", () => {
    const unrecorded = boundBackend();
    expect(resolveNativeTransactionState(unrecorded)).not.toBe(
      resolveNativeTransactionState(unrecorded),
    );
  });

  it("is shared by the sessions of one engine transaction, and by no session of another", async () => {
    const backend = createTestBackend();
    const states = await backend.transactionWithNative((target) => {
      const first = openTransactionSession(target);
      const second = openTransactionSession(deriveBackend(target, {}));
      expect(second.native).toBe(first.native);
      return Promise.resolve(first.native);
    });
    const next = await backend.transactionWithNative((target) =>
      Promise.resolve(openTransactionSession(target).native),
    );
    expect(next).not.toBe(states);
  });

  it("gives every session over a hand-written transaction backend a state of its own", async () => {
    const backend = createTestBackend();
    await backend.transactionWithNative((target) => {
      // A custom backend built by copying the engine's members rather than
      // through `deriveBackend`: nothing links it to the engine's record, so
      // the Store has no evidence its sessions share a native transaction.
      const handWritten: TransactionBackend = { ...target };
      const first = openTransactionSession(handWritten);
      const second = openTransactionSession(handWritten);
      expect(first.native).not.toBe(second.native);
      expect(first.native).not.toBe(openTransactionSession(target).native);
      return Promise.resolve();
    });
  });
});
