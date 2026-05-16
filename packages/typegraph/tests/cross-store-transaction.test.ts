/**
 * #134: cross-store atomicity — a TypeGraph store and a caller-owned
 * Drizzle connection sharing ONE SQLite transaction via
 * `store.withTransaction(externalTx)`.
 *
 * The canonical shape: the caller opens a transaction, writes a
 * relational row, then a TypeGraph node that references it — and both
 * commit or roll back as one unit. `withTransaction` adopts the
 * caller's literal connection (no nested transaction, no schema
 * bootstrap, no DDL in the business transaction).
 *
 * Postgres parity lives in
 * `tests/backends/postgres/postgres-cross-store-transaction.test.ts`.
 */
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
  StoreNotInitializedError,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables as defaultTables } from "../src/backend/sqlite";

// The caller's own relational table (Drizzle-owned, NOT a TypeGraph
// table) — the "Connector" row a graph node will point at.
const connectors = sqliteTable("connectors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

// Graph-dominant, no searchable fields: a node create is a pure INSERT,
// so the adopted-tx path never touches fulltext and needs no boot.
const ArtifactSource = defineNode("ArtifactSource", {
  schema: z.object({
    connectorId: z.number().int(),
    label: z.string(),
  }),
});

const PlainGraph = defineGraph({
  id: "cross-store-plain",
  nodes: { ArtifactSource: { type: ArtifactSource } },
  edges: {},
});

// Fulltext-bearing variant: a node create also writes the FTS5 table,
// so the adopted-tx path asserts the durable materialization marker.
const Document = defineNode("Doc", {
  schema: z.object({
    connectorId: z.number().int(),
    title: searchable({ language: "english" }),
  }),
});

const FtGraph = defineGraph({
  id: "cross-store-fulltext",
  nodes: { Doc: { type: Document } },
  edges: {},
});

function createSqlite(): {
  sqlite: Database.Database;
  db: BetterSQLite3Database;
} {
  const sqlite = new Database(":memory:");
  // Base TypeGraph tables only — the FTS5 virtual table is filtered out
  // (the post-`drizzle-kit push` state). createStoreWithSchema is the
  // single writer that materializes it; the not-booted test relies on
  // it being absent to prove the gate emits no DDL.
  const baseDdl = generateSqliteDDL(defaultTables).filter(
    (statement) => !statement.includes(defaultTables.fulltextTableName),
  );
  for (const statement of baseDdl) {
    sqlite.exec(statement);
  }
  // The caller's own relational table.
  sqlite.exec(
    "CREATE TABLE connectors (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)",
  );
  return { sqlite, db: drizzle(sqlite) };
}

describe("#134 cross-store atomicity (SQLite)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqlite());
  });

  it("commits a relational row and a graph node in one transaction", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    // No createStoreWithSchema: a non-fulltext adopted-tx flow needs no
    // boot — proving "a transaction that never touches fulltext requires
    // no fulltext initialization".
    const store = createStore(PlainGraph, backend);

    // The caller owns BEGIN / COMMIT on its own connection.
    sqlite.exec("BEGIN");
    const txStore = store.withTransaction(db);
    const connectorId = db
      .insert(connectors)
      .values({ name: "github" })
      .returning({ id: connectors.id })
      .all()[0]!.id;
    const source = await txStore.nodes.ArtifactSource.create({
      connectorId,
      label: "primary",
    });
    sqlite.exec("COMMIT");

    expect(db.select().from(connectors).all()).toEqual([
      { id: connectorId, name: "github" },
    ]);
    const fetched = await store.nodes.ArtifactSource.getById(source.id);
    expect(fetched?.connectorId).toBe(connectorId);
    sqlite.close();
  });

  it("rolls back BOTH layers when the caller's transaction fails (no dangling reference)", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(PlainGraph, backend);

    sqlite.exec("BEGIN");
    let caught: unknown;
    try {
      const txStore = store.withTransaction(db);
      db.insert(connectors).values({ name: "orphan" }).run();
      await txStore.nodes.ArtifactSource.create({
        connectorId: 999,
        label: "doomed",
      });
      throw new Error("business failure after both writes");
    } catch (error) {
      caught = error;
    }
    sqlite.exec("ROLLBACK");

    expect((caught as Error).message).toBe(
      "business failure after both writes",
    );
    // Neither layer persisted: no stray relational row, no graph node
    // with a dangling connector reference.
    expect(db.select().from(connectors).all()).toEqual([]);
    expect(await store.nodes.ArtifactSource.find()).toEqual([]);
    sqlite.close();
  });

  it("commits a fulltext write with a relational row when the store is booted", async () => {
    const bootBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    // Canonical boot path: materializes the FTS5 table and warms the
    // durable marker so the adopted-tx assert is a cache hit (no DDL).
    const [store] = await createStoreWithSchema(FtGraph, bootBackend);

    sqlite.exec("BEGIN");
    const txStore = store.withTransaction(db);
    const connectorId = db
      .insert(connectors)
      .values({ name: "drive" })
      .returning({ id: connectors.id })
      .all()[0]!.id;
    const document = await txStore.nodes.Doc.create({
      connectorId,
      title: "quarterly revenue report",
    });
    sqlite.exec("COMMIT");

    // The relational row, the graph node, AND the FTS5 row all landed.
    expect(db.select().from(connectors).all()).toEqual([
      { id: connectorId, name: "drive" },
    ]);
    const hits = await store.search.fulltext("Doc", {
      query: "revenue",
      limit: 10,
    });
    expect(hits.map((hit) => hit.node.id)).toEqual([document.id]);
    sqlite.close();
  });

  it("refuses loudly (and rolls back the relational write) when the store is not booted", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    // Bare createStore against an unmaterialized FTS5 table.
    const store = createStore(FtGraph, backend);

    sqlite.exec("BEGIN");
    let thrown: unknown;
    try {
      const txStore = store.withTransaction(db);
      db.insert(connectors).values({ name: "premature" }).run();
      await txStore.nodes.Doc.create({
        connectorId: 1,
        title: "should not persist",
      });
    } catch (error) {
      thrown = error;
      sqlite.exec("ROLLBACK");
    }

    expect(thrown).toBeInstanceOf(StoreNotInitializedError);
    // The gate emitted no DDL: the FTS5 table was never created...
    expect(() =>
      sqlite.prepare(`SELECT * FROM ${defaultTables.fulltextTableName}`).all(),
    ).toThrow(/no such table/);
    // ...and the caller's relational write rolled back with it.
    expect(db.select().from(connectors).all()).toEqual([]);
    sqlite.close();
  });

  it("rejects withTransaction when the backend cannot adopt a transaction", () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true, transactionMode: "none" },
      tables: defaultTables,
    });
    const store = createStore(PlainGraph, backend);

    expect(() => store.withTransaction(db)).toThrow(ConfigurationError);
    expect(() => store.withTransaction(db)).toThrow(
      /Cross-store atomicity is unavailable/,
    );
    // The rejection fired before any work — no side effects.
    expect(db.select().from(connectors).all()).toEqual([]);
    sqlite.close();
  });
});

// #140: the graph-owned counterpart of withTransaction.
// TypeGraph opens the transaction; `tx.sql` is the same connection,
// so the caller's relational write joins the same atomic boundary.
describe("#140 graph-owned cross-store via tx.sql (SQLite)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqlite());
  });

  it("commits a graph node and a tx.sql relational row in one store.transaction", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(PlainGraph, backend);

    const source = await store.transaction(async (tx) => {
      const sqlTx = tx.sql as typeof db;
      const connectorId = sqlTx
        .insert(connectors)
        .values({ name: "github" })
        .returning({ id: connectors.id })
        .all()[0]!.id;
      return tx.nodes.ArtifactSource.create({ connectorId, label: "primary" });
    });

    expect(db.select().from(connectors).all()).toEqual([
      { id: 1, name: "github" },
    ]);
    const fetched = await store.nodes.ArtifactSource.getById(source.id);
    expect(fetched?.connectorId).toBe(1);
    sqlite.close();
  });

  it("rolls back BOTH the graph node and the tx.sql relational row when the callback throws", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(PlainGraph, backend);

    await expect(
      store.transaction(async (tx) => {
        const sqlTx = tx.sql as typeof db;
        sqlTx.insert(connectors).values({ name: "orphan" }).run();
        await tx.nodes.ArtifactSource.create({
          connectorId: 1,
          label: "doomed",
        });
        throw new Error("phase2-rollback");
      }),
    ).rejects.toThrow("phase2-rollback");

    expect(db.select().from(connectors).all()).toEqual([]);
    expect(await store.nodes.ArtifactSource.find()).toEqual([]);
    sqlite.close();
  });
});
