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
  type ConnectionTransactionProbe,
  createNativeTransactionToken,
  publishConnectionNativeTransaction,
  recordEngineSavepoint,
  recordNativeTransactionHandle,
  recordOpenedNativeTransaction,
  resolveNativeTransactionHandle,
} from "../src/backend/native-transaction-handle";
import { resolveNativeTransactionState } from "../src/store/native-transaction-state";
import {
  openTransactionSession,
  type StoreTransactionBackend,
} from "../src/store/operation-scope";
import { createTestBackend } from "./test-utils";

/**
 * A connection whose driver reports its transaction state through `open`, as
 * better-sqlite3's `inTransaction` does.
 */
function probedConnection(): ConnectionTransactionProbe &
  Readonly<{ state: { open: boolean } }> {
  const state = { open: true };
  return {
    connection: { connection: true },
    isTransactionOpen: () => state.open,
    state,
  };
}

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

/** A backend bound on the connection-level handle of `connection`. */
function bindOnConnection(connection: object): object {
  const bound = boundBackend();
  recordNativeTransactionHandle(bound, {
    kind: "connection",
    handle: connection,
    connection,
    detected: true,
  });
  return bound;
}

describe("native transaction record", () => {
  it("records a per-BEGIN transaction object as itself (proof 3), and every bind on it resolves it", () => {
    const handle = { begin: 1 };
    const first = boundBackend();
    const second = boundBackend();
    recordNativeTransactionHandle(first, { kind: "transaction", handle });
    recordNativeTransactionHandle(second, { kind: "transaction", handle });
    expect(resolveNativeTransactionHandle(first)).toBe(handle);
    expect(resolveNativeTransactionHandle(second)).toBe(handle);
  });

  it("records two transaction objects that pin one driver transaction handle as that handle (proof 2)", () => {
    const pinned = { driverTransaction: 1 };
    const transaction = { begin: 1 };
    const callerSavepoint = { savepoint: 1 };
    const onTransaction = boundBackend();
    const onSavepoint = boundBackend();
    recordNativeTransactionHandle(onTransaction, {
      kind: "pinned",
      handle: transaction,
      pinned,
      isOpen: () => true,
    });
    recordNativeTransactionHandle(onSavepoint, {
      kind: "pinned",
      handle: callerSavepoint,
      pinned,
      isOpen: () => true,
    });
    expect(resolveNativeTransactionHandle(onTransaction)).toBe(pinned);
    expect(resolveNativeTransactionHandle(onSavepoint)).toBe(pinned);
  });

  it("never resolves a pinned driver handle again once it reported its transaction closed", () => {
    const pinned = { driverTransaction: 1 };
    const state = { open: true };
    const bind = (): object => {
      const bound = boundBackend();
      recordNativeTransactionHandle(bound, {
        kind: "pinned",
        handle: { begin: 1 },
        pinned,
        isOpen: () => state.open,
      });
      return bound;
    };
    const before = bind();
    expect(resolveNativeTransactionHandle(before)).toBe(pinned);
    state.open = false;
    expect(resolveNativeTransactionHandle(before)).toBeUndefined();
    expect(resolveNativeTransactionHandle(bind())).toBeUndefined();
    state.open = true;
    expect(resolveNativeTransactionHandle(bind())).toBeUndefined();
  });

  it("resolves the record along the derivation chain", () => {
    const handle = { begin: 1 };
    const bound = boundBackend();
    recordNativeTransactionHandle(bound, { kind: "transaction", handle });
    const derived = deriveBackend(deriveBackend(bound, {}), {});
    expect(resolveNativeTransactionHandle(derived)).toBe(handle);
  });

  it("records nothing for a backend no engine bound", () => {
    expect(resolveNativeTransactionHandle(boundBackend())).toBeUndefined();
  });

  it("records nothing for a connection the engine holds no transaction open on", () => {
    expect(
      resolveNativeTransactionHandle(bindOnConnection({ connection: true })),
    ).toBeUndefined();
  });
});

describe("native transaction record of a connection token (proof 4)", () => {
  it("identifies each engine transaction on a connection by a token of its own while it is open, and by nothing once it has ended", async () => {
    const probe = probedConnection();
    const firstToken = createNativeTransactionToken(probe);
    const inFirst = await publishConnectionNativeTransaction(firstToken, () => {
      const one = bindOnConnection(probe.connection);
      const two = bindOnConnection(probe.connection);
      expect(resolveNativeTransactionHandle(one)).toBe(firstToken);
      expect(resolveNativeTransactionHandle(two)).toBe(firstToken);
      return Promise.resolve(one);
    });
    const secondToken = createNativeTransactionToken(probe);
    await publishConnectionNativeTransaction(secondToken, () => {
      const bound = bindOnConnection(probe.connection);
      expect(resolveNativeTransactionHandle(bound)).toBe(secondToken);
      // A binding of the first transaction, resolved during the second.
      expect(resolveNativeTransactionHandle(inFirst)).toBeUndefined();
      return Promise.resolve();
    });
    expect(
      resolveNativeTransactionHandle(bindOnConnection(probe.connection)),
    ).toBeUndefined();
  });

  it("never honours a token again once the driver reported its transaction closed, even after the connection opens another", async () => {
    const probe = probedConnection();
    const token = createNativeTransactionToken(probe);
    const opener = boundBackend();
    recordOpenedNativeTransaction(opener, token);
    await publishConnectionNativeTransaction(token, () => {
      expect(resolveNativeTransactionHandle(opener)).toBe(token);
      // An implicit rollback ends the transaction inside the span.
      probe.state.open = false;
      expect(
        resolveNativeTransactionHandle(bindOnConnection(probe.connection)),
      ).toBeUndefined();
      // The caller opens a transaction of its own on the connection.
      probe.state.open = true;
      expect(
        resolveNativeTransactionHandle(bindOnConnection(probe.connection)),
      ).toBeUndefined();
      expect(resolveNativeTransactionHandle(opener)).toBeUndefined();
      return Promise.resolve();
    });
  });

  it("ends a token when a later engine transaction is published on its connection, whatever order the spans end in", async () => {
    const probe = probedConnection();
    const outerSpan = heldSpan();
    const outerToken = createNativeTransactionToken(probe);
    const opener = boundBackend();
    recordOpenedNativeTransaction(opener, outerToken);
    const outer = publishConnectionNativeTransaction(outerToken, outerSpan.run);
    expect(resolveNativeTransactionHandle(opener)).toBe(outerToken);
    // A later BEGIN succeeded on the connection: the outer transaction ended.
    const innerSpan = heldSpan();
    const innerToken = createNativeTransactionToken(probe);
    const inner = publishConnectionNativeTransaction(innerToken, innerSpan.run);
    expect(resolveNativeTransactionHandle(opener)).toBeUndefined();
    outerSpan.end();
    await outer;
    expect(
      resolveNativeTransactionHandle(bindOnConnection(probe.connection)),
    ).toBe(innerToken);
    innerSpan.end();
    await inner;
    expect(
      resolveNativeTransactionHandle(bindOnConnection(probe.connection)),
    ).toBeUndefined();
    // The inner span ending never reinstates the outer token.
    expect(resolveNativeTransactionHandle(opener)).toBeUndefined();
  });

  it("never honours a token through the connection when the driver reports no transaction state; the opener's own bind keeps it until its span ends", async () => {
    const connection = { connection: true };
    const token = createNativeTransactionToken(undefined);
    const opener = boundBackend();
    recordOpenedNativeTransaction(opener, token);
    await publishConnectionNativeTransaction(token, () => {
      expect(resolveNativeTransactionHandle(opener)).toBe(token);
      expect(
        resolveNativeTransactionHandle(bindOnConnection(connection)),
      ).toBeUndefined();
      return Promise.resolve();
    });
    expect(resolveNativeTransactionHandle(opener)).toBeUndefined();
  });
});

describe("native transaction record of a nested handle", () => {
  it("records a savepoint the engine opened, at any depth, as the transaction it is in (proof 1)", () => {
    const transaction = { begin: 1 };
    const savepoint = { savepoint: 1 };
    const nestedSavepoint = { savepoint: 2 };
    recordEngineSavepoint(savepoint, {
      kind: "transaction",
      handle: transaction,
    });
    recordEngineSavepoint(nestedSavepoint, {
      kind: "transaction",
      handle: savepoint,
    });
    for (const handle of [savepoint, nestedSavepoint]) {
      const bound = boundBackend();
      recordNativeTransactionHandle(bound, { kind: "transaction", handle });
      expect(resolveNativeTransactionHandle(bound)).toBe(transaction);
    }
  });

  it("records a savepoint the engine never saw opened as itself", () => {
    const savepoint = { savepoint: 1 };
    const bound = boundBackend();
    recordNativeTransactionHandle(bound, {
      kind: "transaction",
      handle: savepoint,
    });
    expect(resolveNativeTransactionHandle(bound)).toBe(savepoint);
  });

  it("records a transaction object on a connection the engine has published a live transaction on as that transaction, and nothing outside the span", async () => {
    const probe = probedConnection();
    const savepoint = { savepoint: 1 };
    const token = createNativeTransactionToken(probe);
    const bindSavepoint = (): object => {
      const bound = boundBackend();
      recordNativeTransactionHandle(bound, {
        kind: "connection",
        handle: savepoint,
        connection: probe.connection,
        detected: true,
      });
      return bound;
    };
    await publishConnectionNativeTransaction(token, () => {
      expect(resolveNativeTransactionHandle(bindSavepoint())).toBe(token);
      return Promise.resolve();
    });
    expect(resolveNativeTransactionHandle(bindSavepoint())).toBeUndefined();
  });
});

describe("native transaction state", () => {
  it("is one object for every binding recorded on one native transaction", () => {
    const handle = { begin: 1 };
    const first = boundBackend();
    const second = boundBackend();
    recordNativeTransactionHandle(first, {
      kind: "transaction",
      handle,
    });
    recordNativeTransactionHandle(second, {
      kind: "transaction",
      handle,
    });
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
      // A transaction a custom backend built itself: a new object naming
      // only the members a session needs, not derived from the engine's
      // bound backend through `deriveBackend`. Nothing links it to the
      // engine's record, so the Store has no evidence its sessions share a
      // native transaction.
      const handWritten: StoreTransactionBackend = {
        dialect: target.dialect,
        capabilities: target.capabilities,
      };
      const first = openTransactionSession(handWritten);
      const second = openTransactionSession(handWritten);
      expect(first.native).not.toBe(second.native);
      expect(first.native).not.toBe(openTransactionSession(target).native);
      return Promise.resolve();
    });
  });
});
