import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteBackend } from "../../src/backend/drizzle/sqlite";
import { createPostgresBackend } from "../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import type { GraphBackend } from "../../src/backend/types";
import { ConfigurationError } from "../../src/errors";

const openedBackends: GraphBackend[] = [];

afterEach(async () => {
  const backends = openedBackends.splice(0);
  await Promise.all(backends.map((backend) => backend.close()));
});

describe("schema-write transaction adoption", () => {
  it("refuses an SQLite connection in autocommit and adopts its live deferred frame", async () => {
    const { backend, db } = createLocalSqliteBackend();
    expect(backend.schemaProvisioning).toBe("dml-only");
    openedBackends.push(backend);
    const adopt = backend.adoptSchemaWriteTransaction;
    expect(adopt).toBeDefined();
    if (adopt === undefined)
      throw new Error("SQLite schema adoption is absent");

    await expect(
      adopt(db, "adoption_test", { waitBudgetMs: 1000 }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    const client = (db as unknown as Readonly<{ $client: Database.Database }>)
      .$client;
    const previousTimeout = client.pragma("busy_timeout", { simple: true });
    client.exec("BEGIN");
    try {
      const adopted = await adopt(db, "adoption_test", { waitBudgetMs: 1000 });
      expect(adopted.activeSchema).toBeUndefined();
      expect(client.inTransaction).toBe(true);
      expect(client.pragma("busy_timeout", { simple: true })).toBe(
        previousTimeout,
      );
    } finally {
      client.exec("ROLLBACK");
    }
  });

  it("acquires PostgreSQL's fence on the literal native transaction", async () => {
    const { backend, db } = await createLocalPgliteBackend({ vector: false });
    expect(backend.schemaProvisioning).toBe("dml-only");
    openedBackends.push(backend);
    const adopt = backend.adoptSchemaWriteTransaction;
    expect(adopt).toBeDefined();
    if (adopt === undefined)
      throw new Error("PostgreSQL schema adoption is absent");

    await db.transaction(async (nativeTx) => {
      const priorSetting = await nativeTx.execute(
        sql`SELECT current_setting('lock_timeout') AS setting`,
      );
      const adopted = await adopt(nativeTx, "adoption_test", {
        waitBudgetMs: 1000,
      });
      expect(adopted.activeSchema).toBeUndefined();
      const restoredSetting = await nativeTx.execute(
        sql`SELECT current_setting('lock_timeout') AS setting`,
      );
      expect(restoredSetting).toEqual(priorSetting);
    });
    const endedTransaction = await db.transaction((nativeTx) =>
      Promise.resolve(nativeTx),
    );
    await expect(
      adopt(endedTransaction, "adoption_test", { waitBudgetMs: 1000 }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("exposes transactional policy only when adapters opt in", async () => {
    const { backend: sqlite } = createLocalSqliteBackend({
      schemaProvisioning: "transactional",
    });
    openedBackends.push(sqlite);
    expect(sqlite.schemaProvisioning).toBe("transactional");
    const { backend: postgres } = await createLocalPgliteBackend({
      vector: false,
      schemaProvisioning: "transactional",
    });
    openedBackends.push(postgres);
    expect(postgres.schemaProvisioning).toBe("transactional");
  });

  it("rejects invalid provisioning policy values at adapter construction", async () => {
    const { backend: sqlite, db: sqliteDb } = createLocalSqliteBackend();
    openedBackends.push(sqlite);
    expect(() =>
      createSqliteBackend(sqliteDb, {
        schemaProvisioning: "unexpected" as "dml-only",
      }),
    ).toThrow(ConfigurationError);

    const { backend: postgres, db: postgresDb } =
      await createLocalPgliteBackend({ vector: false });
    openedBackends.push(postgres);
    expect(() =>
      createPostgresBackend(postgresDb, {
        vector: false,
        schemaProvisioning: "unexpected" as "dml-only",
      }),
    ).toThrow(ConfigurationError);
  });

  it("refuses a PostgreSQL caller-serialized promise before touching schema rows", async () => {
    const { backend, db } = await createLocalPgliteBackend({ vector: false });
    openedBackends.push(backend);
    const declaredOnly = createPostgresBackend(db, {
      vector: false,
      capabilities: { writeFence: { mechanism: "caller-serialized" } },
    });
    const adopt = declaredOnly.adoptSchemaWriteTransaction;
    expect(adopt).toBeDefined();
    if (adopt === undefined)
      throw new Error("Profile did not expose schema adoption");
    await db.transaction(async (nativeTx) => {
      await expect(
        adopt(nativeTx, "declared_only", { waitBudgetMs: 1000 }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });
    expect(await backend.getActiveSchema("declared_only")).toBeUndefined();
  });
});
