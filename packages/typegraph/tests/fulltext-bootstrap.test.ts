/**
 * #135: durable, enforced fulltext materialization on SQLite.
 *
 * `createStoreWithSchema` is the single canonical writer of the durable
 * `typegraph_contribution_materializations` marker. The sync
 * `createStore` path is attach-only and zero-I/O: it never lazily
 * materializes the FTS5 virtual table. A fulltext read/write — or an
 * adopted transaction — against a database with no valid marker throws
 * `StoreNotInitializedError` instead of silently emitting DDL on the
 * hot path (the pre-#135 behavior).
 *
 * Also covers the drizzle-kit gap (drizzle-kit can't model FTS5 virtual
 * tables, so `drizzle-kit push` leaves every typegraph table EXCEPT
 * `typegraph_node_fulltext`): `createStoreWithSchema` closes it as part
 * of the same durable-materialization step.
 */
import Database from "better-sqlite3";
import { getTableName } from "drizzle-orm";
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
  StoreNotInitializedError,
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

const CONTRIB_MAT_TABLE = getTableName(
  defaultTables.contributionMaterializations,
);

describe("#135 durable fulltext materialization (SQLite)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ sqlite, db } = createDrizzleKitOnlySqlite());
  });

  it("starts with the fulltext virtual table missing", () => {
    expect(() =>
      sqlite.prepare(`SELECT * FROM ${defaultTables.fulltextTableName}`).all(),
    ).toThrow(/no such table/);
    sqlite.close();
  });

  it("createStoreWithSchema materializes the fulltext table and writes the durable marker", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });

    const [store] = await createStoreWithSchema(FtGraph, backend);

    // The canonical boot path created the FTS5 table.
    const rows = sqlite
      .prepare(`SELECT * FROM ${defaultTables.fulltextTableName}`)
      .all();
    expect(rows).toEqual([]);

    // The durable marker was recorded for this graph.
    const markers = sqlite
      .prepare(
        `SELECT graph_id, logical_name, owner, materialized_at, last_error ` +
          `FROM ${CONTRIB_MAT_TABLE}`,
      )
      .all() as readonly {
      graph_id: string;
      logical_name: string;
      owner: string;
      materialized_at: string | null;
      last_error: string | null;
    }[];
    expect(markers).toHaveLength(1);
    expect(markers[0]?.graph_id).toBe(FtGraph.id);
    expect(markers[0]?.logical_name).toBe("fulltext");
    expect(markers[0]?.owner).toBe(fts5Strategy.name);
    expect(markers[0]?.materialized_at).not.toBeNull();
    expect(markers[0]?.last_error).toBeNull();

    // And the searchable() write lands without error.
    await store.nodes.Doc.create({ title: "hello world" });

    const fulltext = sqlite
      .prepare(`SELECT content FROM ${defaultTables.fulltextTableName}`)
      .all() as readonly { content: string }[];
    expect(fulltext).toHaveLength(1);
    expect(fulltext[0]?.content).toBe("hello world");

    sqlite.close();
  });

  it("sync createStore path throws StoreNotInitializedError on a fulltext write (no lazy materialization)", async () => {
    // createStore is sync, attach-only, and skips
    // loadActiveSchemaWithBootstrap. Against an uninitialized database
    // the fulltext write must refuse loudly instead of self-healing.
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(FtGraph, backend);

    await expect(
      store.nodes.Doc.create({ title: "should not persist" }),
    ).rejects.toBeInstanceOf(StoreNotInitializedError);

    // No table was lazily created on the hot path.
    expect(() =>
      sqlite.prepare(`SELECT * FROM ${defaultTables.fulltextTableName}`).all(),
    ).toThrow(/no such table/);

    sqlite.close();
  });

  it("a fulltext write inside store.transaction() throws StoreNotInitializedError (no DDL in the business tx)", async () => {
    // The tx-scoped backend's fulltext methods assert the durable
    // marker at point of use — a cached SELECT, never DDL. The
    // uninitialized database makes the fulltext write refuse, so the
    // transaction rolls back and nothing is created.
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(FtGraph, backend);

    await expect(
      store.transaction(async (tx) => {
        await tx.nodes.Doc.create({ title: "tx" });
      }),
    ).rejects.toBeInstanceOf(StoreNotInitializedError);

    // The gate emitted no DDL: the FTS5 table was never created.
    expect(() =>
      sqlite.prepare(`SELECT * FROM ${defaultTables.fulltextTableName}`).all(),
    ).toThrow(/no such table/);

    sqlite.close();
  });

  it("createStore against an already-initialized database works without re-running boot", async () => {
    // First process boots the database via the canonical writer.
    const bootBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    await createStoreWithSchema(FtGraph, bootBackend);

    // A subsequent fresh backend instance (cold latch) attaches via the
    // sync createStore — the durable marker, not an in-memory boolean,
    // is what lets the hot path proceed DML-only.
    const attachBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    const store = createStore(FtGraph, attachBackend);
    await store.nodes.Doc.create({ title: "attach path works" });

    const rows = sqlite
      .prepare(`SELECT content FROM ${defaultTables.fulltextTableName}`)
      .all() as readonly { content: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("attach path works");

    sqlite.close();
  });

  it("transaction() with transactionMode 'none' rejects without side effects", async () => {
    // The early-rejection fires before any work — a backend configured
    // without transactions never touches the fulltext or marker tables.
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

  it("ensureFulltextTable(graphId) is the durable-marker writer and is idempotent", async () => {
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });

    expect(backend.ensureFulltextTable).toBeTypeOf("function");

    await backend.ensureFulltextTable!(FtGraph.id);
    await backend.ensureFulltextTable!(FtGraph.id);
    await backend.ensureFulltextTable!(FtGraph.id);

    // Exactly one durable marker row, no error recorded.
    const markers = sqlite
      .prepare(
        `SELECT last_error FROM ${CONTRIB_MAT_TABLE} ` +
          `WHERE graph_id = '${FtGraph.id}'`,
      )
      .all() as readonly { last_error: string | null }[];
    expect(markers).toHaveLength(1);
    expect(markers[0]?.last_error).toBeNull();

    // Inserts still work after multiple ensure calls — no double-create
    // surprise from FTS5.
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

describe("#135 signature drift is a loud error, never silently re-blessed", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    for (const statement of generateSqliteDDL(defaultTables, fts5Strategy)) {
      sqlite.exec(statement);
    }
    db = drizzle(sqlite);
  });

  // Same contribution identity (graph/logicalName/owner/tableName) but a
  // changed `createDdl` — the exact shape #129's drift signature exists
  // to detect. The extra statement is idempotent so the FTS5 table is
  // unaffected; only the recorded signature would differ.
  const driftStrategy: typeof fts5Strategy = {
    ...fts5Strategy,
    ownedTables(primaryTableName) {
      return fts5Strategy.ownedTables(primaryTableName).map((contribution) => ({
        ...contribution,
        createDdl: [
          ...contribution.createDdl,
          "CREATE TABLE IF NOT EXISTS typegraph_drift_probe (x)",
        ],
      }));
    },
  };

  it("ensureRuntimeContributions refuses a post-success signature change", async () => {
    const bootBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    await createStoreWithSchema(FtGraph, bootBackend);

    const driftBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
      fulltext: driftStrategy,
    });

    await expect(
      driftBackend.ensureRuntimeContributions!(FtGraph.id),
    ).rejects.toThrow(/already materialized with a different signature/);

    // The recorded marker still reflects the original successful
    // materialization — the drift attempt did not overwrite it as success.
    const markers = sqlite
      .prepare(
        `SELECT materialized_at, last_error FROM ${CONTRIB_MAT_TABLE} ` +
          `WHERE graph_id = '${FtGraph.id}'`,
      )
      .all() as readonly {
      materialized_at: string | null;
      last_error: string | null;
    }[];
    expect(markers).toHaveLength(1);
    expect(markers[0]?.materialized_at).not.toBeNull();
    expect(markers[0]?.last_error).not.toBeNull();

    sqlite.close();
  });

  it("the hot path reports drift as StoreNotInitializedError(stale)", async () => {
    const bootBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
    });
    await createStoreWithSchema(FtGraph, bootBackend);

    const driftBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables: defaultTables,
      fulltext: driftStrategy,
    });
    const store = createStore(FtGraph, driftBackend);

    await expect(
      store.nodes.Doc.create({ title: "drifted" }),
    ).rejects.toMatchObject({
      name: "StoreNotInitializedError",
      details: { reason: "stale" },
    });

    sqlite.close();
  });
});
