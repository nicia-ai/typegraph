/**
 * Which native transaction a real engine bind records, where the driver's
 * handle alone does not say: a connection-level handle (better-sqlite3's
 * database object) reached through more than one Drizzle wrapper or more
 * than one backend, or while the engine's COMMIT or ROLLBACK runs; a
 * transaction object from another loaded copy of Drizzle, on either dialect
 * and through schema-write adoption; and a savepoint the engine opens itself
 * in SQLite's `transactionMode: "drizzle"`.
 *
 * PostgreSQL's engine-opened savepoints, and a caller's own savepoint inside
 * a TypeGraph-owned transaction, are in the shared suite
 * (`backends/integration/native-transaction-handle-probes.ts`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { entityKind } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";
import { BaseSQLiteDatabase, SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import type { AdapterBackend, TransactionBackend } from "../src/backend/types";
import type { NativeTransactionState } from "../src/store/native-transaction-state";
import { openTransactionSession } from "../src/store/operation-scope";
import { requireDefined } from "../src/utils/presence";

const opened: Database.Database[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const client of opened.splice(0)) client.close();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A better-sqlite3 client. `onStatement` is the driver's own statement
 * logger, called synchronously as each statement starts to run.
 */
function openClient(
  onStatement?: (statement: string) => void,
): Database.Database {
  const client = new Database(":memory:", {
    ...(onStatement === undefined ?
      {}
    : {
        verbose: (statement: unknown) => {
          onStatement(String(statement));
        },
      }),
  });
  opened.push(client);
  return client;
}

const Item = defineNode("Item", { schema: z.object({ label: z.string() }) });
const graph = defineGraph({
  id: "native_binds",
  nodes: { Item: { type: Item } },
  edges: {},
});

function stateOf(target: TransactionBackend): NativeTransactionState {
  return openTransactionSession(target).native;
}

type ObservedBind = Readonly<{
  statement: string;
  state: NativeTransactionState;
}>;

/**
 * A better-sqlite3 backend whose driver statement logger adopts the
 * database object, as a caller's commit logger would, as each statement
 * `observes` selects starts to run.
 */
function observeBinds(observes: (statement: string) => boolean): Readonly<{
  backend: AdapterBackend<AnySqliteDatabase>;
  observed: readonly ObservedBind[];
}> {
  const observed: ObservedBind[] = [];
  const built: { backend?: AdapterBackend<AnySqliteDatabase> } = {};
  const database = drizzle(
    openClient((statement) => {
      if (built.backend === undefined || !observes(statement)) return;
      observed.push({
        statement,
        state: stateOfAdoption(built.backend, database),
      });
    }),
  );
  built.backend = createSqliteBackend(database);
  return { backend: built.backend, observed };
}

function stateOfAdoption(
  backend: AdapterBackend<AnySqliteDatabase>,
  handle: AnySqliteDatabase,
): NativeTransactionState {
  return openTransactionSession(backend.adoptTransaction(handle)).native;
}

/**
 * Drizzle classes as another loaded copy of Drizzle defines them: the same
 * entity kinds, different classes, so `instanceof` fails where Drizzle's own
 * `is()` brand check passes.
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- A Drizzle entity class is identified by its static entity kind alone.
class ForeignSqliteDatabase {
  static readonly [entityKind] = BaseSQLiteDatabase[entityKind];
}
class ForeignSqliteTransaction extends ForeignSqliteDatabase {
  static override readonly [entityKind] = SQLiteTransaction[entityKind];
}
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- A Drizzle entity class is identified by its static entity kind alone.
class ForeignPgDatabase {
  static readonly [entityKind] = PgDatabase[entityKind];
}
class ForeignPgTransaction extends ForeignPgDatabase {
  static override readonly [entityKind] = PgTransaction[entityKind];
}

/** `transaction` as a handle of another loaded copy of Drizzle sees it. */
function asForeignTransaction<T extends object>(
  transaction: T,
  foreignClass: object = ForeignSqliteTransaction,
): T {
  return new Proxy(transaction, {
    getPrototypeOf: () => (foreignClass as { prototype: object }).prototype,
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

  it("treats a transaction object of another loaded copy of Drizzle as schema-write adoption's own, as ordinary adoption does", async () => {
    const client = openClient();
    const database = drizzle(client);
    const backend = createSqliteBackend(database);
    await createStoreWithSchema(graph, backend);
    // A transaction object on this client, used while the client holds a
    // transaction open, as a caller's `db.transaction()` hands it out.
    let captured: AnySqliteDatabase | undefined;
    database.transaction((transaction) => {
      captured = transaction;
    });
    const foreign = asForeignTransaction(requireDefined(captured));
    expect(foreign instanceof SQLiteTransaction).toBe(false);
    client.exec("BEGIN IMMEDIATE");
    try {
      const adopted = await requireDefined(backend.adoptSchemaWriteTransaction)(
        foreign,
        graph.id,
        { waitBudgetMs: 1000 },
      );
      expect(stateOf(adopted.backend)).toBe(stateOfAdoption(backend, foreign));
    } finally {
      client.exec("ROLLBACK");
    }
  });

  it("keeps a TypeGraph-owned transaction's identity until its COMMIT has run", async () => {
    const { backend, observed } = observeBinds(
      (statement) => statement === "COMMIT",
    );
    const opener = await backend.transactionWithNative((target) =>
      Promise.resolve(stateOf(target)),
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]?.state).toBe(opener);
  });

  it("keeps a TypeGraph-owned transaction's identity until its ROLLBACK has run", async () => {
    const { backend, observed } = observeBinds(
      (statement) => statement === "ROLLBACK",
    );
    const openers: NativeTransactionState[] = [];
    await expect(
      backend.transactionWithNative((target) => {
        openers.push(stateOf(target));
        return Promise.reject(new Error("the callback fails"));
      }),
    ).rejects.toThrow("the callback fails");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.state).toBe(openers[0]);
  });

  it("keeps a schema-write transaction's identity from its first statement through its COMMIT", async () => {
    const { backend, observed } = observeBinds(() => true);
    await createStoreWithSchema(graph, backend);
    const begin = observed.findLastIndex(
      ({ statement }) => statement === "BEGIN IMMEDIATE",
    );
    const commit = observed.findIndex(
      ({ statement }, index) => index > begin && statement === "COMMIT",
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    // At least one statement ran inside the transaction before its COMMIT.
    expect(commit).toBeGreaterThan(begin + 1);
    const inside = observed.slice(begin + 1, commit + 1);
    for (const { state } of inside) expect(state).toBe(inside[0]?.state);
  });
});

describe("engine binds on PGlite", () => {
  it("records a transaction object of another loaded copy of Drizzle as itself, as adoption accepts it", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    cleanups.push(() => local.backend.close());
    const backend = createPostgresBackend(local.db, { vector: false });
    await backend.transactionWithNative((_target, native) => {
      const foreign = asForeignTransaction(native, ForeignPgTransaction);
      expect(foreign instanceof PgTransaction).toBe(false);
      const adopt = (): NativeTransactionState =>
        stateOf(backend.adoptTransaction(foreign));
      expect(adopt()).toBe(adopt());
      return Promise.resolve();
    });
  });
});

describe("engine binds on libsql", () => {
  it("records a savepoint a SQLite backend in transactionMode drizzle opens on a transaction object as that transaction", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "typegraph-binds-"));
    const client = createClient({
      url: `file:${path.join(directory, "binds.db")}`,
    });
    cleanups.push(
      () => {
        rmSync(directory, { recursive: true, force: true });
      },
      () => {
        client.close();
      },
    );
    const drizzleMode = {
      executionProfile: { isSync: false, transactionMode: "drizzle" },
    } as const;
    await drizzleLibsql(client).transaction(async (transaction) => {
      const overTransaction = createSqliteBackend(transaction, drizzleMode);
      const enclosing = stateOf(overTransaction.adoptTransaction(transaction));
      const states = await overTransaction.transactionWithNative(
        async (savepointTarget, savepoint) => {
          // A backend over the savepoint opens a savepoint of its own in it.
          const overSavepoint = createSqliteBackend(savepoint, drizzleMode);
          const nested = await overSavepoint.transactionWithNative(
            (nestedTarget) => Promise.resolve(stateOf(nestedTarget)),
          );
          return [
            stateOf(savepointTarget),
            stateOf(overTransaction.adoptTransaction(savepoint)),
            nested,
          ];
        },
      );
      expect(states).toHaveLength(3);
      for (const state of states) expect(state).toBe(enclosing);
    });
  });
});
