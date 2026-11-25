/**
 * Which native transaction a real engine bind records, where the driver's
 * handle alone does not say: a connection-level handle (better-sqlite3's
 * database object) reached through more than one Drizzle wrapper or more
 * than one backend, and a transaction object from another loaded copy of
 * Drizzle.
 */
import Database from "better-sqlite3";
import { entityKind } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { BaseSQLiteDatabase, SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";

import type { AnySqliteDatabase } from "../src/backend/drizzle/execution";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import type { AdapterBackend } from "../src/backend/types";
import type { NativeTransactionState } from "../src/store/native-transaction-state";
import { openTransactionSession } from "../src/store/operation-scope";

const opened: Database.Database[] = [];

afterEach(() => {
  for (const client of opened.splice(0)) client.close();
});

function openClient(): Database.Database {
  const client = new Database(":memory:");
  opened.push(client);
  return client;
}

function stateOfAdoption(
  backend: AdapterBackend<AnySqliteDatabase>,
  handle: AnySqliteDatabase,
): NativeTransactionState {
  return openTransactionSession(backend.adoptTransaction(handle)).native;
}

/**
 * A Drizzle class as another loaded copy of Drizzle defines it: the same
 * entity kind, a different class, so `instanceof` fails where Drizzle's own
 * `is()` brand check passes.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- A Drizzle entity class is identified by its static entity kind alone.
class ForeignSqliteDatabase {
  static readonly [entityKind] = BaseSQLiteDatabase[entityKind];
}
class ForeignSqliteTransaction extends ForeignSqliteDatabase {
  static override readonly [entityKind] = SQLiteTransaction[entityKind];
}

/** `transaction` as a handle of another loaded copy of Drizzle sees it. */
function asForeignTransaction<T extends object>(transaction: T): T {
  return new Proxy(transaction, {
    getPrototypeOf: () => ForeignSqliteTransaction.prototype,
  });
}

describe("engine binds on better-sqlite3", () => {
  it("records the transaction it opened for an adoption through another Drizzle wrapper over the same client", async () => {
    const client = openClient();
    const backend = createSqliteBackend(drizzle(client));
    const otherWrapper = drizzle(client);
    await backend.transactionWithNative((target) => {
      const opener = openTransactionSession(target).native;
      expect(stateOfAdoption(backend, otherWrapper)).toBe(opener);
      return Promise.resolve();
    });
  });

  it("never hands a live transaction's adoption the identity of another backend's BEGIN that failed on the same connection", async () => {
    const database = drizzle(openClient());
    const owner = createSqliteBackend(database);
    const rival = createSqliteBackend(database);
    await owner.transactionWithNative(async (target, native) => {
      const opener = openTransactionSession(target).native;
      // The rival's queue is its own, so its BEGIN reaches the connection
      // while the owner's transaction is open, and SQLite refuses it.
      const rivalAttempt = rival
        .transactionWithNative(() => Promise.resolve())
        .then(
          () => "committed",
          () => "refused",
        );
      const adopted: NativeTransactionState[] = [];
      for (let tick = 0; tick < 20; tick += 1) {
        adopted.push(stateOfAdoption(owner, native));
        await Promise.resolve();
      }
      expect(await rivalAttempt).toBe("refused");
      for (const state of adopted) expect(state).toBe(opener);
    });
  });

  it("records a transaction object of another loaded copy of Drizzle as itself, as adoption accepts it", () => {
    const database = drizzle(openClient());
    const backend = createSqliteBackend(database);
    database.transaction((transaction) => {
      const foreign = asForeignTransaction(transaction);
      expect(foreign instanceof SQLiteTransaction).toBe(false);
      expect(stateOfAdoption(backend, foreign)).toBe(
        stateOfAdoption(backend, foreign),
      );
    });
  });
});
