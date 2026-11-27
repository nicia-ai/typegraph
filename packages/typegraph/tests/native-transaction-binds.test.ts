/**
 * Which native transaction a real engine bind records, per driver, where the
 * case needs a driver the shared suite cannot drive or a handle it cannot
 * build (`src/backend/native-transaction-handle.ts` states the rule and its
 * proofs):
 *
 * - better-sqlite3: a connection-level handle reached through more than one
 *   Drizzle wrapper or backend, or while the engine's COMMIT or ROLLBACK runs
 *   (verified token); a transaction a trigger's `RAISE(ROLLBACK)` ends
 *   mid-callback; a caller-opened transaction and a retained transaction
 *   object (no proof); schema-write adoption.
 * - libSQL: a caller's transaction beside a TypeGraph transaction on one
 *   client, on 0.18 and on 0.17's raw BEGIN framing (pinned handle); a
 *   savepoint the engine opens in `transactionMode: "drizzle"`.
 * - PGlite: a caller-opened transaction's savepoint (pinned handle); factory
 *   routing of a transaction object from another loaded copy of Drizzle.
 *
 * PostgreSQL's engine-opened savepoints, a caller's own savepoint inside a
 * TypeGraph-owned transaction, and two transactions open at once on one pool
 * are in the shared suite
 * (`backends/integration/native-transaction-handle-probes.ts`).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { SQLiteTransaction } from "drizzle-orm/sqlite-core";
import { createClient as createLegacyLibsqlClient } from "libsql-client-017";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution";
import {
  buildPostgresEngineProfile,
  createPostgresBackend,
} from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import type { AdapterBackend, TransactionBackend } from "../src/backend/types";
import type { NativeTransactionState } from "../src/store/native-transaction-state";
import { openTransactionSession } from "../src/store/operation-scope";
import { requireDefined } from "../src/utils/presence";
import {
  asForeignTransaction,
  ForeignPgTransaction,
} from "./helpers/foreign-drizzle-handles";

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

/** What `run` rejects with, or `undefined` when it resolves. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Every message and code along an error's cause chain, as one string. */
function causeChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message, String((current as { code?: unknown }).code));
    current = current.cause;
  }
  return parts.join(" | ");
}

/** A libSQL client of `createClient` on a file in a fresh directory. */
function openLibsqlFile<Client extends Readonly<{ close: () => void }>>(
  createClient: (config: Readonly<{ url: string }>) => Client,
): Client {
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
  return client;
}

/** A better-sqlite3 client whose every INSERT into `guarded` ends its transaction. */
function openClientWithRollbackTrigger(): Database.Database {
  const client = openClient();
  client.exec(
    "CREATE TABLE guarded (value INTEGER); " +
      "CREATE TRIGGER refuse BEFORE INSERT ON guarded " +
      "BEGIN SELECT RAISE(ROLLBACK, 'refused by trigger'); END;",
  );
  return client;
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

  it("never hands out a transaction's state once a trigger's RAISE(ROLLBACK) ended it, nor after another transaction on the connection", async () => {
    const client = openClientWithRollbackTrigger();
    const database = drizzle(client);
    const backend = createSqliteBackend(database);
    const rival = createSqliteBackend(database);
    // The engine's COMMIT finds no transaction: the trigger ended it.
    const attempt = backend.transactionWithNative(async (target, native) => {
      const opener = stateOf(target);
      expect(stateOfAdoption(backend, native)).toBe(opener);
      expect(() => client.exec("INSERT INTO guarded VALUES (1)")).toThrow(
        "refused by trigger",
      );
      expect(client.inTransaction).toBe(false);
      expect(stateOfAdoption(backend, native)).not.toBe(opener);
      // The opener's own binding stops resolving it too.
      expect(stateOf(target)).not.toBe(opener);
      // Another engine transaction runs to completion on the connection.
      const rivalState = await rival.transactionWithNative((rivalTarget) =>
        Promise.resolve(stateOf(rivalTarget)),
      );
      // The caller opens a transaction of its own on the connection.
      client.exec("BEGIN");
      try {
        const adopted = stateOfAdoption(backend, native);
        expect(adopted).not.toBe(opener);
        expect(adopted).not.toBe(rivalState);
      } finally {
        client.exec("ROLLBACK");
      }
    });
    await expect(attempt).rejects.toThrow("no transaction is active");
  });

  it("ends a transaction's identity when another engine transaction is published on the connection, even if the trigger's end was never observed", async () => {
    const client = openClientWithRollbackTrigger();
    const database = drizzle(client);
    const backend = createSqliteBackend(database);
    const rival = createSqliteBackend(database);
    const attempt = backend.transactionWithNative(async (target, native) => {
      const opener = stateOf(target);
      expect(() => client.exec("INSERT INTO guarded VALUES (1)")).toThrow(
        "refused by trigger",
      );
      // No lookup between the implicit rollback and the rival's BEGIN.
      await rival.transactionWithNative(() => Promise.resolve());
      client.exec("BEGIN");
      try {
        expect(stateOfAdoption(backend, native)).not.toBe(opener);
      } finally {
        client.exec("ROLLBACK");
      }
    });
    await expect(attempt).rejects.toThrow("no transaction is active");
  });

  it("gives each binding of a caller-opened transaction, and of its savepoint, a state of its own: a better-sqlite3 transaction object runs on whatever transaction the connection has", () => {
    const database = drizzle(openClient());
    const backend = createSqliteBackend(database);
    database.transaction((transaction) => {
      const first = stateOfAdoption(backend, transaction);
      expect(stateOfAdoption(backend, transaction)).not.toBe(first);
      expect(stateOfAdoption(backend, database)).not.toBe(first);
      transaction.transaction((savepoint) => {
        expect(stateOfAdoption(backend, savepoint)).not.toBe(
          stateOfAdoption(backend, savepoint),
        );
      });
    });
  });

  it("never resolves a TypeGraph transaction's state for a transaction object retained from an earlier caller transaction once that transaction has ended", async () => {
    const database = drizzle(openClient());
    const backend = createSqliteBackend(database);
    let retained: AnySqliteDatabase | undefined;
    database.transaction((transaction) => {
      retained = transaction;
    });
    const handle = requireDefined(retained);
    await backend.transactionWithNative((target) => {
      // Inside the engine's transaction the retained object runs in it.
      expect(stateOfAdoption(backend, handle)).toBe(stateOf(target));
      return Promise.resolve();
    });
    expect(stateOfAdoption(backend, handle)).not.toBe(
      stateOfAdoption(backend, handle),
    );
  });

  it("classifies a transaction object of another loaded copy of Drizzle by its client, as adoption accepts it", async () => {
    const database = drizzle(openClient());
    const backend = createSqliteBackend(database);
    await backend.transactionWithNative((target, native) => {
      const opener = stateOf(target);
      // A caller's savepoint: better-sqlite3 nests it in the open transaction.
      (native as BaseSQLiteDatabase<"sync", unknown>).transaction(
        (savepoint) => {
          const foreign = asForeignTransaction(savepoint);
          expect(foreign instanceof SQLiteTransaction).toBe(false);
          expect(stateOfAdoption(backend, foreign)).toBe(opener);
        },
      );
      return Promise.resolve();
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
      // A caller-opened transaction on a connection-level handle: no proof,
      // so no adoption shares a state with another.
      expect(stateOf(adopted.backend)).not.toBe(
        stateOfAdoption(backend, foreign),
      );
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

  it("resolves the schema-write callback target's own state for every statement from its BEGIN through its COMMIT", async () => {
    const { backend, observed } = observeBinds(() => true);
    await createStoreWithSchema(graph, backend);
    const before = observed.length;
    const opener = await requireDefined(backend.schemaWriteTransaction)(
      graph.id,
      (target) => Promise.resolve(stateOf(target as TransactionBackend)),
    );
    const statements = observed.slice(before);
    const begin = statements.findIndex(
      ({ statement }) => statement === "BEGIN IMMEDIATE",
    );
    const commit = statements.findIndex(
      ({ statement }, index) => index > begin && statement === "COMMIT",
    );
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    // BEGIN runs before the transaction is published; everything after it,
    // COMMIT included, is the callback target's transaction.
    for (const { state } of statements.slice(begin + 1, commit + 1)) {
      expect(state).toBe(opener);
    }
  });
});

describe("engine binds on PGlite", () => {
  it("records a transaction object of another loaded copy of Drizzle as the transaction it runs on, as adoption accepts it", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    cleanups.push(() => local.backend.close());
    const backend = createPostgresBackend(local.db, { vector: false });
    await backend.transactionWithNative((target, native) => {
      const foreign = asForeignTransaction(native, ForeignPgTransaction);
      expect(foreign instanceof PgTransaction).toBe(false);
      expect(stateOf(backend.adoptTransaction(foreign))).toBe(stateOf(target));
      return Promise.resolve();
    });
  });

  it("routes a transaction object of another loaded copy of Drizzle to the transaction-scoped backend, so its savepoint never claims the enclosing transaction's commit", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    cleanups.push(() => local.backend.close());
    const backend = createPostgresBackend(local.db, { vector: false });
    const observed = await backend.transactionWithNative(
      async (target, native) => {
        const foreign = asForeignTransaction(native, ForeignPgTransaction);
        const overForeign = createPostgresBackend(foreign, { vector: false });
        const overOwn = createPostgresBackend(native, { vector: false });
        const nested = await overForeign.transactionWithNative((nestedTarget) =>
          Promise.resolve(stateOf(nestedTarget)),
        );
        return {
          commitOutcome: [
            overForeign.capabilities.execution.commitOutcome,
            overOwn.capabilities.execution.commitOutcome,
          ],
          opener: stateOf(target),
          nested,
        };
      },
    );
    const [foreignOutcome, ownOutcome] = observed.commitOutcome;
    expect(foreignOutcome).toBe(ownOutcome);
    expect(observed.nested).toBe(observed.opener);
  });

  it("refuses to build a root engine profile over a transaction object of another loaded copy of Drizzle, as it does over its own", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    cleanups.push(() => local.backend.close());
    await local.db.transaction((transaction) => {
      const foreign = asForeignTransaction(transaction, ForeignPgTransaction);
      let refusal: unknown;
      try {
        buildPostgresEngineProfile(foreign);
      } catch (error) {
        refusal = error;
      }
      expect(
        (refusal as { details?: { code?: unknown } } | undefined)?.details
          ?.code,
      ).toBe("TRANSACTION_REQUIRES_SCOPED_BACKEND");
      return Promise.resolve();
    });
  });

  it.each([
    { name: "own copy", foreign: false },
    { name: "another loaded copy", foreign: true },
  ])(
    "refuses a commit-reply declaration on a backend over a caller's transaction ($name), whose savepoints cannot report a commit",
    async ({ foreign }) => {
      const local = await createLocalPgliteBackend({ vector: false });
      cleanups.push(() => local.backend.close());
      const root = createPostgresBackend(local.db, { vector: false });
      expect(root.capabilities.execution.commitOutcome).toBe("commit-reply");
      const refusal = await root.transactionWithNative((_target, native) => {
        const handle =
          foreign ? asForeignTransaction(native, ForeignPgTransaction) : native;
        return rejectionOf(() =>
          Promise.resolve().then(() =>
            createPostgresBackend(handle, {
              vector: false,
              capabilities: root.capabilities,
            }),
          ),
        );
      });
      expect(
        (refusal as { details?: { code?: unknown } } | undefined)?.details
          ?.code,
      ).toBe("TRANSACTION_SCOPED_COMMIT_OUTCOME");
    },
  );

  it("resolves a caller-opened transaction and its caller savepoint to one state through the PGlite transaction client they share", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    cleanups.push(() => local.backend.close());
    const backend = createPostgresBackend(local.db, { vector: false });
    await local.db.transaction(async (transaction) => {
      const enclosing = stateOf(backend.adoptTransaction(transaction));
      await transaction.transaction((savepoint) => {
        expect(stateOf(backend.adoptTransaction(savepoint))).toBe(enclosing);
        return Promise.resolve();
      });
    });
  });
});

describe("engine binds on libsql", () => {
  it("records a savepoint a SQLite backend in transactionMode drizzle opens on a transaction object as that transaction", async () => {
    const client = openLibsqlFile(createClient);
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

  it("resolves a caller's transaction, its savepoint and a foreign-copy view of it to one state, and no other transaction to it", async () => {
    const client = openLibsqlFile(createClient);
    const { backend, db } = await createLibsqlBackend(client);
    // Both transactions take libSQL's write lock (Drizzle opens every libSQL
    // transaction as "write"), so they run one after the other.
    const caller = await db.transaction(async (callerTransaction) => {
      const callerState = stateOfAdoption(backend, callerTransaction);
      await callerTransaction.transaction((savepoint) => {
        expect(stateOfAdoption(backend, savepoint)).toBe(callerState);
        return Promise.resolve();
      });
      const foreign = asForeignTransaction(callerTransaction);
      expect(foreign instanceof SQLiteTransaction).toBe(false);
      expect(stateOfAdoption(backend, foreign)).toBe(callerState);
      return callerState;
    });
    await backend.transactionWithNative((target, native) => {
      const opener = stateOf(target);
      expect(opener).not.toBe(caller);
      expect(stateOfAdoption(backend, native)).toBe(opener);
      return Promise.resolve();
    });
  });
});

describe("engine binds on libsql, transaction ended by the engine", () => {
  it("never hands out a caller transaction's state once a trigger's RAISE(ROLLBACK) ended it, and refuses the handle's statements", async () => {
    const client = openLibsqlFile(createClient);
    await client.executeMultiple(
      "CREATE TABLE guarded (value INTEGER); " +
        "CREATE TRIGGER refuse BEFORE INSERT ON guarded " +
        "BEGIN SELECT RAISE(ROLLBACK, 'refused by trigger'); END;",
    );
    const { backend, db } = await createLibsqlBackend(client);
    const observed: {
      caller?: NativeTransactionState;
      afterEnd?: NativeTransactionState;
      insert?: unknown;
      next?: unknown;
    } = {};
    // Drizzle's COMMIT of the ended transaction fails too.
    const outcome = await rejectionOf(() =>
      db.transaction(async (transaction) => {
        observed.caller = stateOfAdoption(backend, transaction);
        observed.insert = await rejectionOf(() =>
          transaction.run(drizzleSql`INSERT INTO guarded VALUES (1)`),
        );
        observed.afterEnd = stateOfAdoption(backend, transaction);
        observed.next = await rejectionOf(() =>
          transaction.run(drizzleSql`SELECT 1`),
        );
      }),
    );
    expect(causeChainText(observed.insert)).toContain("refused by trigger");
    expect(observed.caller).toBeDefined();
    expect(observed.afterEnd).not.toBe(observed.caller);
    expect(causeChainText(observed.next)).toContain("TRANSACTION_CLOSED");
    expect(causeChainText(outcome)).toContain("TRANSACTION_CLOSED");
  });
});

describe("engine binds on @libsql/client 0.17 (raw BEGIN framing)", () => {
  it("identifies a caller's transaction by its own libSQL transaction handle, never by the TypeGraph transaction open on the client", async () => {
    const client = openLibsqlFile(createLegacyLibsqlClient);
    const { backend, db } = await createLibsqlBackend(client);
    await db.transaction(async (callerTransaction) => {
      const caller = stateOfAdoption(backend, callerTransaction);
      await backend.transactionWithNative(
        (target, native) => {
          const opener = stateOf(target);
          expect(opener).not.toBe(caller);
          expect(stateOfAdoption(backend, callerTransaction)).toBe(caller);
          // The client reports no transaction state, so the database the
          // engine hands out proves nothing: a state of its own.
          expect(stateOfAdoption(backend, native)).not.toBe(opener);
          return Promise.resolve();
        },
        { accessMode: "read_only" },
      );
    });
  });
});
