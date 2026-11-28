/**
 * One owner decides "is this the same connection"
 * (`resolveConnectionIdentity`, `src/backend/transaction-resource.ts`).
 *
 * Two consumers ask it: the serialized-resource audit (a serialized
 * verdict's `resource`) and the native-transaction record (a SQLite
 * handle's `connection`, `sqliteConnectionIdentity`). Before they shared
 * the decision, two `sqlite-proxy` wrappers declaring one resource were one
 * connection to the audit and two to the native record, because the record
 * read detection alone and fell back to each wrapper's own handle.
 *
 * Naming one connection is not evidence of one transaction, and a DECLARED
 * connection is not evidence at all: the cases at the bottom pin that two
 * wrappers on one connection get a state per transaction, and that a handle
 * whose connection only a declaration names never joins a transaction the
 * engine published on that connection.
 */
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it, vi } from "vitest";

import { type AnySqliteDatabase } from "../src/backend/drizzle/execution";
import {
  createSqliteBackend,
  sqliteConnectionIdentity,
} from "../src/backend/drizzle/sqlite";
import type * as NativeTransactionHandleModule from "../src/backend/native-transaction-handle";
import {
  type NativeHandle,
  recordNativeTransactionHandle,
} from "../src/backend/native-transaction-handle";
import {
  type ConnectionIdentity,
  resolveBackendAudit,
  resolveConnectionIdentity,
  type SerializedResourceDeclaration,
  sharesSerializedTransactionResource,
} from "../src/backend/transaction-resource";
import { openTransactionSession } from "../src/store/operation-scope";
import { expectObservation } from "./helpers/known-defect";
import { createTestDatabase } from "./test-utils";

// The recorder is wrapped, not replaced: every bind still records exactly as
// in production, and a test reads what a real bind handed it.
vi.mock("../src/backend/native-transaction-handle", async (importOriginal) => {
  const original = await importOriginal<typeof NativeTransactionHandleModule>();
  return {
    ...original,
    recordNativeTransactionHandle: vi.fn(
      original.recordNativeTransactionHandle,
    ),
  };
});

/**
 * The connection the native-transaction record was handed by the latest bind
 * of `db`; fails when no bind of it reached the recorder, or reached it as
 * another kind of handle.
 */
function recordedConnectionOf(db: object): object {
  const handle: NativeHandle | undefined = vi
    .mocked(recordNativeTransactionHandle)
    .mock.calls.map(([, recorded]) => recorded)
    .findLast((recorded) => recorded.handle === db);
  if (handle?.kind !== "connection") {
    throw new Error(
      `expected a bind of this handle to record a connection, got ${handle?.kind ?? "no record"}`,
    );
  }
  return handle.connection;
}

/** A SQLite database whose driver no detection predicate recognizes. */
function createUnidentifiableSqliteDatabase(): AnySqliteDatabase {
  return drizzleSqliteProxy(() => Promise.resolve({ rows: [] }));
}

/** The better-sqlite3 client a test database runs on. */
function clientOf(db: object): object {
  return (db as Readonly<{ $client: object }>).$client;
}

/** The resource a serialized audit names; fails on any other verdict. */
function auditedResource(backend: object): object {
  const audit = resolveBackendAudit(backend);
  if (audit?.kind !== "serialized") {
    throw new Error(`expected a serialized audit, got ${audit?.kind}`);
  }
  return audit.resource;
}

describe("resolveConnectionIdentity", () => {
  const detected = { detected: true };
  const declared = { declared: true };

  /** An identity as a comparable label. */
  function label(identity: ConnectionIdentity | undefined): string {
    if (identity === undefined) return "none";
    const named =
      identity.connection === detected ? "detected object"
      : identity.connection === declared ? "declared object"
      : "other object";
    return `${named} (${identity.source})`;
  }

  it("answers the detected connection, else the declared one, else nothing", () => {
    expect(
      [
        resolveConnectionIdentity(detected, undefined),
        resolveConnectionIdentity(detected, { mode: "detect" }),
        resolveConnectionIdentity(detected, { mode: "independent" }),
        resolveConnectionIdentity(detected, {
          mode: "shared",
          resource: detected,
        }),
        resolveConnectionIdentity(undefined, {
          mode: "shared",
          resource: declared,
        }),
        resolveConnectionIdentity(undefined, { mode: "independent" }),
        resolveConnectionIdentity(undefined, undefined),
      ].map((identity) => label(identity)),
    ).toEqual([
      "detected object (detected)",
      "detected object (detected)",
      "detected object (detected)",
      "detected object (detected)",
      "declared object (declared)",
      "none",
      "none",
    ]);
  });
});

describe("one connection identity for the audit and the native record", () => {
  it("names the declared resource for two sqlite-proxy wrappers in both", () => {
    const resource = { name: "the far side's one connection" };
    const declaration: SerializedResourceDeclaration = {
      mode: "shared",
      resource,
    };
    const firstDb = createUnidentifiableSqliteDatabase();
    const secondDb = createUnidentifiableSqliteDatabase();
    const first = createSqliteBackend(firstDb, {
      serializedResource: declaration,
    });
    const second = createSqliteBackend(secondDb, {
      serializedResource: declaration,
    });

    expect(sharesSerializedTransactionResource(first, second)).toBe(true);
    expect(auditedResource(first)).toBe(resource);
    // What a real bind hands the native record, so the factory's wiring of
    // the declaration into the bind is under test, not only the decision.
    // The record named each wrapper's own handle here before the two
    // consumers shared one decision.
    first.adoptTransaction(firstDb);
    second.adoptTransaction(secondDb);
    expect(recordedConnectionOf(firstDb)).toBe(resource);
    expect(recordedConnectionOf(secondDb)).toBe(resource);
  });

  it("names the detected client for a better-sqlite3 database and a transaction object over it", async () => {
    const db = createTestDatabase();
    const backend = createSqliteBackend(db);
    const client = clientOf(db);

    expect(auditedResource(backend)).toBe(client);
    expect(sqliteConnectionIdentity(db, undefined)).toEqual({
      connection: client,
      source: "detected",
    });
    const inTransaction = await new Promise<ConnectionIdentity | undefined>(
      (resolve) => {
        db.transaction((tx) => {
          resolve(sqliteConnectionIdentity(tx, undefined));
        });
      },
    );
    expect(inTransaction?.connection).toBe(client);
  });

  it("keeps naming the detected client under an independent declaration", () => {
    const db = createTestDatabase();
    const backend = createSqliteBackend(db, {
      serializedResource: { mode: "independent" },
    });

    // The declaration lifts the stream guard; it does not move statements
    // off the connection they land on, so the native record still names it.
    expect(resolveBackendAudit(backend)?.kind).toBe("independent");
    expect(
      sqliteConnectionIdentity(db, { mode: "independent" })?.connection,
    ).toBe(clientOf(db));
  });

  it("names nothing when neither detection nor a declaration identifies a connection", () => {
    expect(
      sqliteConnectionIdentity(createUnidentifiableSqliteDatabase(), undefined),
    ).toBeUndefined();
  });

  // Pinned, not fixed here: the factory audits a backend from the handle's
  // `$client`, which a Drizzle transaction object does not carry, while the
  // native record reads the transaction's session client. A backend built
  // over a better-sqlite3 transaction object is therefore audited
  // independent although its record names the client. Changing the audit
  // for transaction-object backends is a behaviour change of its own (a
  // libSQL transaction runs on a connection of its own, which the client
  // does not name), so it is left to its own change.
  it("audits a backend over a better-sqlite3 transaction object from its handle, not its session client", () => {
    const db = createTestDatabase();
    const client = clientOf(db);
    const observed = db.transaction((tx) => {
      const backend = createSqliteBackend(tx);
      const audit = resolveBackendAudit(backend);
      return {
        audit:
          audit?.kind === "serialized" && audit.resource === client ?
            "the client"
          : (audit?.kind ?? "unaudited"),
        record:
          sqliteConnectionIdentity(tx, undefined)?.connection === client ?
            "the client"
          : "other",
      };
    });
    expectObservation({
      lane: { driver: "better-sqlite3" },
      observed,
      correct: { audit: "the client", record: "the client" },
      defects: [
        {
          label: "transaction-object-backend-audit",
          on: { driver: ["better-sqlite3"] },
          today: { audit: "independent", record: "the client" },
        },
      ],
    });
  });
});

describe("one connection is not one transaction", () => {
  it("gives each transaction of two declared sqlite-proxy wrappers a state of its own", async () => {
    const declaration: SerializedResourceDeclaration = {
      mode: "shared",
      resource: { name: "one far-side connection" },
    };
    const first = createSqliteBackend(createUnidentifiableSqliteDatabase(), {
      serializedResource: declaration,
    });
    const second = createSqliteBackend(createUnidentifiableSqliteDatabase(), {
      serializedResource: declaration,
    });
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);

    const states = [
      await first.transactionWithNative((target) =>
        Promise.resolve(openTransactionSession(target).native),
      ),
      await second.transactionWithNative((target) =>
        Promise.resolve(openTransactionSession(target).native),
      ),
      await first.transactionWithNative((target) =>
        Promise.resolve(openTransactionSession(target).native),
      ),
    ];

    expect(new Set(states).size).toBe(3);
  });

  it("never joins a handle to a live transaction through a connection only a declaration names", async () => {
    // A proxy backend declaring a real better-sqlite3 client as its resource.
    // While another backend over that client holds a transaction open on it,
    // a handle the proxy backend adopts is not shown to run on that
    // transaction by anything read off its own session, so it must not join
    // the transaction's state.
    const db = createTestDatabase();
    const owner = createSqliteBackend(db);
    const proxyDb = createUnidentifiableSqliteDatabase();
    const proxy = createSqliteBackend(proxyDb, {
      serializedResource: { mode: "shared", resource: clientOf(db) },
    });
    expect(sharesSerializedTransactionResource(owner, proxy)).toBe(true);

    const observed = await owner.transactionWithNative((target, native) => {
      const opener = openTransactionSession(target).native;
      return Promise.resolve({
        ownerJoin: openTransactionSession(owner.adoptTransaction(native))
          .native,
        proxyJoin: openTransactionSession(proxy.adoptTransaction(proxyDb))
          .native,
        opener,
      });
    });

    // Detection proves the owner's own adoption, so it joins.
    expect(observed.ownerJoin).toBe(observed.opener);
    expect(observed.proxyJoin).not.toBe(observed.opener);
  });
});
