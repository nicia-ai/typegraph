/**
 * #134: cross-store atomicity on libsql — proves the *documented async*
 * shape `db.transaction(async (sqlTx) => store.withTransaction(sqlTx))`
 * works for a sqlite-family async driver, not just Postgres.
 *
 * better-sqlite3 (synchronous) uses the raw BEGIN/COMMIT shape instead;
 * that path is covered in `tests/cross-store-transaction.test.ts`.
 *
 * libsql opens transactions on a separate connection, so in-memory
 * databases break (tursodatabase/libsql-client-ts#229) — use a temp
 * file, mirroring `libsql-backend.test.ts`.
 */
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../../../src";
import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";

const temporaryFiles: string[] = [];

function createTemporaryDbPath(): string {
  const dbPath = path.join(
    tmpdir(),
    `typegraph-libsql-xstore-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.db`,
  );
  temporaryFiles.push(dbPath);
  return dbPath;
}

afterEach(() => {
  for (const dbPath of temporaryFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = dbPath + suffix;
      if (existsSync(filePath)) unlinkSync(filePath);
    }
  }
});

const connectors = sqliteTable("connectors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

const ArtifactSource = defineNode("ArtifactSource", {
  schema: z.object({
    connectorId: z.number().int(),
    label: z.string(),
  }),
});

const PlainGraph = defineGraph({
  id: "libsql-cross-store",
  nodes: { ArtifactSource: { type: ArtifactSource } },
  edges: {},
});

describe("#134 cross-store atomicity (libsql, documented async shape)", () => {
  it("commits a relational row and a graph node in one db.transaction()", async () => {
    const client = createClient({ url: `file:${createTemporaryDbPath()}` });
    const { backend, db } = await createLibsqlBackend(client);
    await client.execute(
      "CREATE TABLE connectors (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)",
    );
    const store = createStore(PlainGraph, backend);

    const sourceId = await db.transaction(async (sqlTx) => {
      const inserted = await sqlTx
        .insert(connectors)
        .values({ name: "github" })
        .returning({ id: connectors.id });
      const txStore = store.withTransaction(sqlTx);
      const source = await txStore.nodes.ArtifactSource.create({
        connectorId: inserted[0]!.id,
        label: "primary",
      });
      return source.id;
    });

    expect(await db.select().from(connectors)).toEqual([
      { id: 1, name: "github" },
    ]);
    const fetched = await store.nodes.ArtifactSource.getById(sourceId);
    expect(fetched?.connectorId).toBe(1);
    client.close();
  });

  it("rolls back BOTH layers when the async callback throws", async () => {
    const client = createClient({ url: `file:${createTemporaryDbPath()}` });
    const { backend, db } = await createLibsqlBackend(client);
    await client.execute(
      "CREATE TABLE connectors (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)",
    );
    const store = createStore(PlainGraph, backend);

    await expect(
      db.transaction(async (sqlTx) => {
        await sqlTx.insert(connectors).values({ name: "orphan" });
        const txStore = store.withTransaction(sqlTx);
        await txStore.nodes.ArtifactSource.create({
          connectorId: 999,
          label: "doomed",
        });
        throw new Error("business failure after both writes");
      }),
    ).rejects.toThrow("business failure after both writes");

    expect(await db.select().from(connectors)).toEqual([]);
    expect(await store.nodes.ArtifactSource.find()).toEqual([]);
    client.close();
  });

  // #140 — graph-owned: TypeGraph opens the tx, `tx.sql` is
  // the bound libsql transaction handle (the "drizzle" SQLite mode).
  it("commits/rolls back a tx.sql relational row with the graph node in one store.transaction", async () => {
    const client = createClient({ url: `file:${createTemporaryDbPath()}` });
    const { backend, db } = await createLibsqlBackend(client);
    await client.execute(
      "CREATE TABLE connectors (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)",
    );
    const store = createStore(PlainGraph, backend);

    const source = await store.transaction(async (tx) => {
      const sqlTx = tx.sql as typeof db;
      const inserted = await sqlTx
        .insert(connectors)
        .values({ name: "github" })
        .returning({ id: connectors.id });
      return tx.nodes.ArtifactSource.create({
        connectorId: inserted[0]!.id,
        label: "primary",
      });
    });

    expect(await db.select().from(connectors)).toEqual([
      { id: 1, name: "github" },
    ]);
    const fetched = await store.nodes.ArtifactSource.getById(source.id);
    expect(fetched?.connectorId).toBe(1);

    await expect(
      store.transaction(async (tx) => {
        const sqlTx = tx.sql as typeof db;
        await sqlTx.insert(connectors).values({ name: "orphan" });
        await tx.nodes.ArtifactSource.create({
          connectorId: 999,
          label: "doomed",
        });
        throw new Error("phase2-libsql-rollback");
      }),
    ).rejects.toThrow("phase2-libsql-rollback");

    expect(await db.select().from(connectors)).toEqual([
      { id: 1, name: "github" },
    ]);
    expect(await store.nodes.ArtifactSource.find()).toHaveLength(1);
    client.close();
  });
});
