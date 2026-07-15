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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";

import {
  type AdoptedTransaction,
  createStore,
  defineGraph,
  defineNode,
  type HistoryStore,
  type MeasurableHistoryTransactionContext,
  type MeasurableTransactionContext,
  type RecordedInstant,
  type ScopedMeasure,
  type Store,
  type TransactionContext,
  type TransactionOutcome,
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

// Composition graph for the #255 + #257 scenario: a projected `Item` and an
// in-graph `Cursor` written in the same adopted transaction. The projector's
// writes are measured; the cursor's bookkeeping write is not.
const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});

const Cursor = defineNode("Cursor", {
  schema: z.object({ offset: z.string() }),
});

const composedGraph = defineGraph({
  id: "recorded_with_transaction_composed",
  nodes: { Item: { type: Item }, Cursor: { type: Cursor } },
  edges: {},
});

function createHistoryStore(db: BetterSQLite3Database) {
  const backend = createSqliteBackend(db, {
    executionProfile: { isSync: true },
    tables: defaultTables,
  });
  return createStore(graph, backend, { history: true });
}

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
    const {
      result: [alice, bob],
    } = await store.withRecordedTransaction(db, async (tx) => {
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
    const { result: escaped } = await store.withRecordedTransaction(db, (tx) =>
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

  it("returns a receipt with the recorded anchor on the history adopted path (#255)", async () => {
    const store = createHistoryStore(db);

    sqlite.exec("BEGIN");
    const { result, receipt } = await store.withRecordedTransaction(
      db,
      async (tx) => {
        const a = await tx.nodes.Person.create({ name: "Alice" });
        await tx.nodes.Person.create({ name: "Bob" });
        return a.id;
      },
    );
    sqlite.exec("COMMIT");

    expect(receipt.writes.nodes).toEqual({ Person: 2 });
    expect(receipt.writes.total).toBe(2);
    const recorded = requireRecordedInstant(
      receipt.recorded,
      "expected the adopted path to surface a recorded anchor",
    );
    // The receipt's anchor reconstructs the belief this transaction produced —
    // the value #255 needs for per-offset replay.
    const reconstructed = store.asOfRecorded(recorded);
    const alice = await reconstructed.nodes.Person.getById(result);
    expect(alice?.name).toBe("Alice");
  });

  it("returns recorded undefined for a read-only callback on the adopted path", async () => {
    const store = createHistoryStore(db);

    sqlite.exec("BEGIN");
    const { result, receipt } = await store.withRecordedTransaction(
      db,
      async (tx) => tx.nodes.Person.count(),
    );
    sqlite.exec("COMMIT");

    expect(result).toBe(0);
    expect(receipt.writes.total).toBe(0);
    expect(receipt.recorded).toBeUndefined();
  });

  it("counts write intents but leaves recorded undefined on a non-history store", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(graph, backend);

    sqlite.exec("BEGIN");
    const { result, receipt } = await store.withRecordedTransaction(
      db,
      async (tx) => {
        const alice = await tx.nodes.Person.create({ name: "Alice" });
        return alice.id;
      },
    );
    sqlite.exec("COMMIT");

    expect(receipt.writes.nodes).toEqual({ Person: 1 });
    expect(receipt.writes.total).toBe(1);
    // No history capture: the write intent is still counted, but there is no
    // recorded time to anchor.
    expect(receipt.recorded).toBeUndefined();
    const alice = await store.nodes.Person.getById(result);
    expect(alice?.name).toBe("Alice");
  });

  it("composes an exactly-once in-graph cursor with an attributable projector receipt (#255 + #257)", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(composedGraph, backend, { history: true });

    sqlite.exec("BEGIN");
    const { result: projected, receipt } = await store.withRecordedTransaction(
      db,
      async (tx) => {
        // The projector writes through its scoped context; the cursor
        // bookkeeping goes through the outer `tx`, so `projected` attributes
        // only what the projector wrote.
        const scoped = await tx.measure(async (projector) => {
          await projector.nodes.Item.upsertById("item-1", { label: "v1" });
        });
        await tx.nodes.Cursor.upsertById("stream-1", { offset: "001" });
        return scoped;
      },
    );
    sqlite.exec("COMMIT");

    // Scoped receipt: the projector wrote exactly one Item, and a measured scope
    // never carries the recorded instant.
    expect(projected.receipt.writes.nodes).toEqual({ Item: 1 });
    expect(projected.receipt.writes.total).toBe(1);
    expect(projected.receipt.recorded).toBeUndefined();

    // Outer receipt: the whole transaction wrote the Item and the Cursor, and
    // carries the per-transaction replay anchor.
    expect(receipt.writes.nodes).toEqual({ Item: 1, Cursor: 1 });
    expect(receipt.writes.total).toBe(2);
    expect(receipt.recorded).toBeDefined();
  });

  it("detects a dropped change while the cursor still advances (#257)", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(composedGraph, backend, { history: true });

    sqlite.exec("BEGIN");
    const { result: projected, receipt } = await store.withRecordedTransaction(
      db,
      async (tx) => {
        // A projector that drops the change: it writes nothing.
        const scoped = await tx.measure(() => Promise.resolve());
        // The consumer's own bookkeeping still advances the cursor.
        await tx.nodes.Cursor.upsertById("stream-1", { offset: "002" });
        return scoped;
      },
    );
    sqlite.exec("COMMIT");

    // The dropped change is detectable: the projector's scoped total is 0 even
    // though the cursor bookkeeping made the outer total non-zero.
    expect(projected.receipt.writes.total).toBe(0);
    expect(receipt.writes.nodes).toEqual({ Cursor: 1 });
    expect(receipt.writes.total).toBe(1);
  });

  it("does not cross-count two concurrent sibling measures (#257)", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(composedGraph, backend, { history: true });

    sqlite.exec("BEGIN");
    const { result, receipt } = await store.withRecordedTransaction(
      db,
      async (tx) => {
        // Two sibling scopes whose lifetimes overlap under Promise.all, each
        // writing through its OWN scoped context. A resolution-time model
        // cross-counted — one scope's write leaked into the other's total.
        const [a, b] = await Promise.all([
          tx.measure(async (projector) => {
            await projector.nodes.Item.upsertById("a", { label: "a" });
          }),
          tx.measure(async (projector) => {
            await projector.nodes.Item.upsertById("b", { label: "b" });
          }),
        ]);
        return { a, b };
      },
    );
    sqlite.exec("COMMIT");

    // Each scope counts exactly its own write, and the outer receipt counts
    // both exactly once.
    expect(result.a.receipt.writes.total).toBe(1);
    expect(result.b.receipt.writes.total).toBe(1);
    expect(receipt.writes.nodes).toEqual({ Item: 2 });
    expect(receipt.writes.total).toBe(2);
  });

  it("does not persist an escaped write's live row even if the caller commits (history)", async () => {
    const store = createHistoryStore(db);

    sqlite.exec("BEGIN");
    // Smuggle the context out; capture sealed when the callback resolved.
    const { result: escaped } = await store.withRecordedTransaction(db, (tx) =>
      Promise.resolve(tx),
    );
    // The seal guard must reject BEFORE the live insert runs, so a caller who
    // swallows the error and commits cannot leave an uncaptured row behind.
    await expect(
      escaped.nodes.Person.create({ name: "Escaped" }),
    ).rejects.toThrow(/capture session is sealed/i);
    sqlite.exec("COMMIT");

    // The live write never happened — neither the row nor a recorded instant.
    expect(await store.nodes.Person.find()).toEqual([]);
    expect(await store.recordedNow()).toBeUndefined();
  });

  it("seals the receipt-tracked context on the non-history adopted path too", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(graph, backend);

    sqlite.exec("BEGIN");
    const { result: escaped, receipt } = await store.withRecordedTransaction(
      db,
      (tx) => Promise.resolve(tx),
    );
    // The receipt is already snapshotted; a write through the retained context
    // must fail loud (before the live insert) rather than persist a row the
    // receipt can never count.
    await expect(
      escaped.nodes.Person.create({ name: "Escaped" }),
    ).rejects.toThrow(/sealed/i);
    sqlite.exec("COMMIT");

    expect(receipt.writes.total).toBe(0);
    expect(await store.nodes.Person.find()).toEqual([]);
  });

  it("does not expose measure on a plain transaction() context", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(graph, backend);

    await store.transaction((tx) => {
      // Plain transactions run no recorder, so there is nothing to scope.
      expect("measure" in tx).toBe(false);
      return Promise.resolve();
    });
  });
});

// --- #255 / #257 type-level assertions (fail `pnpm typecheck` on regression) ---
//
// Never invoked: the assertions are checked by `tsc`, and the bodies reference
// `declare`d values that are erased at runtime.
function measureTypeAssertions(
  history: HistoryStore<typeof graph>,
  plain: Store<typeof graph>,
  externalTx: AdoptedTransaction,
): void {
  // Receipt-enabled contexts expose `measure`; a plain context does not.
  expectTypeOf<MeasurableTransactionContext<typeof graph>>().toHaveProperty(
    "measure",
  );
  expectTypeOf<
    MeasurableHistoryTransactionContext<typeof graph>
  >().toHaveProperty("measure");
  expectTypeOf<TransactionContext<typeof graph>>().not.toHaveProperty(
    "measure",
  );

  // Assignability chain: history-measurable ⊑ measurable ⊑ TransactionContext,
  // so a projector helper typed against any of the three accepts the context
  // `withRecordedTransaction` hands it.
  expectTypeOf<MeasurableHistoryTransactionContext<typeof graph>>().toExtend<
    MeasurableTransactionContext<typeof graph>
  >();
  expectTypeOf<MeasurableTransactionContext<typeof graph>>().toExtend<
    TransactionContext<typeof graph>
  >();

  // Both adopted overloads now return a TransactionOutcome, and hand a
  // measurable context whose `measure` scopes to a same-kind child context.
  expectTypeOf(
    history.withRecordedTransaction(externalTx, async (tx) => {
      expectTypeOf(tx.measure).toEqualTypeOf<
        ScopedMeasure<MeasurableHistoryTransactionContext<typeof graph>>
      >();
      return tx.nodes.Person.count();
    }),
  ).toEqualTypeOf<Promise<TransactionOutcome<number>>>();

  expectTypeOf(
    plain.withRecordedTransaction(externalTx, async (tx) => {
      expectTypeOf(tx.measure).toEqualTypeOf<
        ScopedMeasure<MeasurableTransactionContext<typeof graph>>
      >();
      return tx.nodes.Person.count();
    }),
  ).toEqualTypeOf<Promise<TransactionOutcome<number>>>();
}
void measureTypeAssertions;
