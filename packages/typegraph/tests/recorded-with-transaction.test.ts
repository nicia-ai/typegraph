/**
 * `store.withRecordedTransaction(externalTx, fn)` — the adopted-transaction
 * entry point for recorded-time capture. Unlike `withTransaction` (which throws
 * under `history: true` because a returned long-lived context has no flush
 * point), this callback form lets TypeGraph close/open recorded rows before the
 * caller commits.
 */
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  type RecordedInstant,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables as defaultTables } from "../src/backend/sqlite";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "recorded_with_transaction",
  nodes: { Person: { type: Person } },
  edges: {},
});

function requireRecordedInstant(
  instant: RecordedInstant | undefined,
  message: string,
): RecordedInstant {
  expect(instant).toBeDefined();
  if (instant === undefined) throw new Error(message);
  return instant;
}

function createSqlite(): {
  sqlite: Database.Database;
  db: BetterSQLite3Database;
} {
  const sqlite = new Database(":memory:");
  // All base + recorded tables; the fulltext virtual table is irrelevant here
  // (no searchable fields) and filtered out to keep setup minimal.
  const ddl = generateSqliteDDL(defaultTables).filter(
    (statement) => !statement.includes(defaultTables.fulltextTableName),
  );
  for (const statement of ddl) sqlite.exec(statement);
  return { sqlite, db: drizzle(sqlite) };
}

describe("withRecordedTransaction (adopted-tx recorded capture)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqlite());
  });

  // Close in teardown (not at the end of each test body) so an assertion
  // failure mid-test still releases the in-memory connection.
  afterEach(() => {
    sqlite.close();
  });

  it("captures recorded history through an adopted transaction", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(graph, backend, { history: true });

    // The caller owns BEGIN / COMMIT; TypeGraph flushes capture before COMMIT.
    sqlite.exec("BEGIN");
    const [alice, bob] = await store.withRecordedTransaction(db, async (tx) => {
      const a = await tx.nodes.Person.create({ name: "Alice" });
      const b = await tx.nodes.Person.create({ name: "Bob" });
      return [a, b] as const;
    });
    sqlite.exec("COMMIT");

    const recordedNow = requireRecordedInstant(
      await store.recordedNow(),
      "expected adopted transaction to write a recorded instant",
    );

    const recorded = store.asOfRecorded(recordedNow);
    const recordedAlice = await recorded.nodes.Person.getById(alice.id);
    const recordedBob = await recorded.nodes.Person.getById(bob.id);
    expect(recordedAlice?.name).toBe("Alice");
    expect(recordedBob?.name).toBe("Bob");
  });

  it("seals the session: a write through the context after the callback returns throws", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(graph, backend, { history: true });

    sqlite.exec("BEGIN");
    // Smuggle the transaction context out of the callback. Capture flushed and
    // sealed when the callback resolved, so a further write through this context
    // — which would otherwise commit uncaptured and diverge history from live
    // state — must fail loud rather than silently escape capture.
    const escaped = await store.withRecordedTransaction(db, (tx) =>
      Promise.resolve(tx),
    );
    await expect(
      escaped.nodes.Person.create({ name: "Escaped" }),
    ).rejects.toThrow(/capture session is sealed/i);
    sqlite.exec("ROLLBACK");

    expect(await store.nodes.Person.find()).toEqual([]);
    expect(await store.recordedNow()).toBeUndefined();
  });

  it("rolls back capture with the caller's transaction", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(graph, backend, { history: true });

    sqlite.exec("BEGIN");
    let caught: unknown;
    try {
      await store.withRecordedTransaction(db, async (tx) => {
        await tx.nodes.Person.create({ name: "Doomed" });
        throw new Error("business failure before flush");
      });
    } catch (error) {
      caught = error;
    }
    sqlite.exec("ROLLBACK");

    expect((caught as Error).message).toBe("business failure before flush");
    // Neither the live node nor any recorded clock advance survived.
    expect(await store.nodes.Person.find()).toEqual([]);
    expect(await store.recordedNow()).toBeUndefined();
  });

  it("does not flush capture when the callback throws before a caller-owned commit", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(graph, backend, { history: true });

    sqlite.exec("BEGIN");
    let nodeId: string | undefined;
    let caught: unknown;
    try {
      await store.withRecordedTransaction(db, async (tx) => {
        const node = await tx.nodes.Person.create({ name: "Committed Anyway" });
        nodeId = node.id;
        throw new Error("caller catches and commits");
      });
    } catch (error) {
      caught = error;
    }
    sqlite.exec("COMMIT");

    expect((caught as Error).message).toBe("caller catches and commits");
    // Committing after a rejected callback is caller misuse, but TypeGraph must
    // not run capture on the error path: doing so can mask the real error on an
    // aborted PostgreSQL transaction.
    const live = await store.nodes.Person.getById(nodeId as never);
    expect(live?.name).toBe("Committed Anyway");
    expect(await store.recordedNow()).toBeUndefined();
  });
});
