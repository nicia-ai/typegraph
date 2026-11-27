/**
 * One owner decides "is this the same connection"
 * (`resolveConnectionIdentity`, `src/backend/transaction-resource.ts`).
 *
 * Two consumers ask it: the serialized-resource audit (a serialized
 * verdict's `resource`) and the native-transaction record (a SQLite
 * handle's `connection`, `nativeTransactionConnection`). Before they shared
 * the decision, two `sqlite-proxy` wrappers declaring one resource were one
 * connection to the audit and two to the native record, because the record
 * read detection alone and fell back to each wrapper's own handle.
 *
 * Naming one connection is not evidence of one transaction: the cases at
 * the bottom pin that two wrappers on one connection share a native
 * transaction's state only inside one transaction, never across two.
 */
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";

import { type AnySqliteDatabase } from "../src/backend/drizzle/execution";
import {
  createSqliteBackend,
  nativeTransactionConnection,
} from "../src/backend/drizzle/sqlite";
import {
  resolveBackendAudit,
  resolveConnectionIdentity,
  type SerializedResourceDeclaration,
  sharesSerializedTransactionResource,
} from "../src/backend/transaction-resource";
import { openTransactionSession } from "../src/store/operation-scope";
import { createTestDatabase } from "./test-utils";

/** A SQLite database whose driver no detection predicate recognizes. */
function createUnidentifiableSqliteDatabase(): AnySqliteDatabase {
  return drizzleSqliteProxy(() => Promise.resolve({ rows: [] }));
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
      ].map((answer) =>
        answer === detected ? "detected"
        : answer === declared ? "declared"
        : typeof answer,
      ),
    ).toEqual([
      "detected",
      "detected",
      "detected",
      "detected",
      "declared",
      "undefined",
      "undefined",
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
    // The native record named each wrapper's own handle here before the
    // two consumers shared one decision.
    expect(nativeTransactionConnection(firstDb, declaration)).toBe(resource);
    expect(nativeTransactionConnection(secondDb, declaration)).toBe(resource);
  });

  it("names the detected client for a better-sqlite3 database and a transaction object over it", async () => {
    const db = createTestDatabase();
    const backend = createSqliteBackend(db);
    const client = (db as unknown as Readonly<{ $client: object }>).$client;

    expect(auditedResource(backend)).toBe(client);
    expect(nativeTransactionConnection(db, undefined)).toBe(client);
    const inTransaction = await new Promise<object>((resolve) => {
      db.transaction((tx) => {
        resolve(nativeTransactionConnection(tx, undefined));
      });
    });
    expect(inTransaction).toBe(client);
  });

  it("keeps naming the detected client under an independent declaration", () => {
    const db = createTestDatabase();
    const backend = createSqliteBackend(db, {
      serializedResource: { mode: "independent" },
    });
    const client = (db as unknown as Readonly<{ $client: object }>).$client;

    // The declaration lifts the stream guard; it does not move statements
    // off the connection they land on, so the native record still names it.
    expect(resolveBackendAudit(backend)?.kind).toBe("independent");
    expect(nativeTransactionConnection(db, { mode: "independent" })).toBe(
      client,
    );
  });

  it("names the handle itself when neither detection nor a declaration identifies one", () => {
    const db = createUnidentifiableSqliteDatabase();

    expect(nativeTransactionConnection(db, undefined)).toBe(db);
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
});
