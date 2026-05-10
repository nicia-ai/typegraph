/**
 * Regression tests for the drizzle-kit-managed fulltext bootstrap
 * gap on SQLite. drizzle-kit can't model FTS5 virtual tables, so
 * consumers driving migrations through `drizzle-kit push` land here
 * with every typegraph table EXCEPT `typegraph_node_fulltext`. The
 * fix is `backend.ensureFulltextTable()`, called from
 * `loadActiveSchemaWithBootstrap` on the success path.
 */
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  fts5Strategy,
  searchable,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables as defaultTables } from "../src/backend/sqlite";

/**
 * Builds an in-memory SQLite database that has every typegraph table
 * EXCEPT the FTS5 fulltext virtual table — the post-`drizzle-kit
 * push` state where drizzle-kit creates the Drizzle-modeled tables
 * but skips the strategy-owned FTS5 virtual table.
 */
function createDrizzleKitOnlySqlite(): {
  sqlite: Database.Database;
  db: BetterSQLite3Database;
} {
  const sqlite = new Database(":memory:");
  const drizzleOnlyDdl = generateSqliteDDL(defaultTables, fts5Strategy).filter(
    (statement) => !statement.includes(defaultTables.fulltextTableName),
  );
  for (const statement of drizzleOnlyDdl) {
    sqlite.exec(statement);
  }
  return { sqlite, db: drizzle(sqlite) };
}

const Document = defineNode("Doc", {
  schema: z.object({
    title: searchable({ language: "english" }),
  }),
});

const FtGraph = defineGraph({
  id: "fulltext-bootstrap-gap",
  nodes: { Doc: { type: Document } },
  edges: {},
});

describe("drizzle-kit-managed setup: fulltext bootstrap gap", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ sqlite, db } = createDrizzleKitOnlySqlite());
  });

  /**
   * Bootstraps a real schema row (so subsequent `createStore` CRUD
   * passes the no-schema gate) then drops the fulltext table again,
   * restoring the drizzle-kit-only state. Mirrors what a consumer
   * who ran `drizzle-kit push` + an external schema migration would
   * leave on disk.
   */
  async function seedSchemaThenDropFulltext(): Promise<void> {
    const seederBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    await createStoreWithSchema(FtGraph, seederBackend);
    sqlite.exec(`DROP TABLE IF EXISTS ${defaultTables.fulltextTableName}`);
  }

  it("starts with the fulltext virtual table missing", () => {
    expect(() =>
      sqlite.prepare(`SELECT * FROM ${defaultTables.fulltextTableName}`).all(),
    ).toThrow(/no such table/);
    sqlite.close();
  });

  it("creates the fulltext table during createStoreWithSchema bootstrap", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });

    const [store] = await createStoreWithSchema(FtGraph, backend);

    // The bootstrap probe should have created the table.
    const rows = sqlite
      .prepare(`SELECT * FROM ${defaultTables.fulltextTableName}`)
      .all();
    expect(rows).toEqual([]);

    // And the searchable() write should land without error.
    await store.nodes.Doc.create({ title: "hello world" });

    const fulltext = sqlite
      .prepare(`SELECT content FROM ${defaultTables.fulltextTableName}`)
      .all() as readonly { content: string }[];
    expect(fulltext).toHaveLength(1);
    expect(fulltext[0]?.content).toBe("hello world");

    sqlite.close();
  });

  it("sync createStore path materializes the fulltext table on first write", async () => {
    // createStore is sync and skips loadActiveSchemaWithBootstrap, so
    // the bootstrap-load probe can't help here — the backend's
    // wrapped write methods must self-ensure.
    await seedSchemaThenDropFulltext();
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(FtGraph, backend);
    await store.nodes.Doc.create({ title: "sync path works" });

    const rows = sqlite
      .prepare(`SELECT content FROM ${defaultTables.fulltextTableName}`)
      .all() as readonly { content: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("sync path works");

    sqlite.close();
  });

  it("store.transaction() materializes the fulltext table before BEGIN", async () => {
    // The tx-scoped backend exposes raw fulltext methods without
    // the outer wrappers, so transaction() itself ensures the
    // table BEFORE BEGIN runs (avoiding CREATE-inside-tx and
    // keeping the table durable on rollback).
    await seedSchemaThenDropFulltext();
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(FtGraph, backend);
    await store.transaction(async (tx) => {
      await tx.nodes.Doc.create({ title: "tx path works" });
    });

    const rows = sqlite
      .prepare(`SELECT content FROM ${defaultTables.fulltextTableName}`)
      .all() as readonly { content: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("tx path works");

    sqlite.close();
  });

  it("transaction() with transactionMode 'none' rejects without side effects", async () => {
    // The early-rejection must fire before the ensure runs —
    // otherwise a backend configured without transactions would
    // materialize the fulltext table from a call that's about to
    // throw.
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true, transactionMode: "none" },
      tables: defaultTables,
    });

    const callback = vi.fn(() => Promise.resolve("unreached"));
    await expect(backend.transaction(callback)).rejects.toThrow(
      /does not support atomic transactions/,
    );
    expect(callback).not.toHaveBeenCalled();
    expect(() =>
      sqlite.prepare(`SELECT * FROM ${defaultTables.fulltextTableName}`).all(),
    ).toThrow(/no such table/);

    sqlite.close();
  });

  it("ensureFulltextTable is idempotent across repeat calls", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });

    expect(backend.ensureFulltextTable).toBeTypeOf("function");

    await backend.ensureFulltextTable!();
    await backend.ensureFulltextTable!();
    await backend.ensureFulltextTable!();

    // Inserts still work after multiple ensure calls — no double-create
    // surprise from FTS5. Using raw `sqlite.exec` (rather than the
    // drizzle wrapper) sidesteps the sync/async return-type juggling
    // for a one-off insert in a sync-mode test.
    sqlite.exec(
      `INSERT INTO ${defaultTables.fulltextTableName} ` +
        `(graph_id, node_kind, node_id, content, language, updated_at) ` +
        `VALUES ('g', 'Doc', 'n', 'body', 'english', '2026-01-01T00:00:00.000Z')`,
    );

    const rows = sqlite
      .prepare(
        `SELECT graph_id, node_id FROM ${defaultTables.fulltextTableName}`,
      )
      .all() as readonly { graph_id: string; node_id: string }[];
    expect(rows).toEqual([{ graph_id: "g", node_id: "n" }]);

    sqlite.close();
  });
});
