import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteBackend } from "../../src/backend/drizzle/sqlite";
import { createPostgresBackend } from "../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import type { GraphBackend } from "../../src/backend/types";
import { ConfigurationError, SchemaFenceTimeoutError } from "../../src/errors";
import { requireDefined } from "../../src/utils/presence";

/**
 * Rolls back an attempt that did not reach the schema-row phase inside the
 * one-millisecond budget: it was adopted, or refused before any acquisition.
 */
class RetriedAttempt extends Error {}

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

  it("hands a PostgreSQL caller its own lock_timeout back after a wait-budget refusal", async () => {
    const { backend, db } = await createLocalPgliteBackend({ vector: false });
    openedBackends.push(backend);
    const adopt = requireDefined(backend.adoptSchemaWriteTransaction);

    // A one-millisecond budget runs out between the fence's acquisitions, so
    // the refusal comes from TypeGraph's own deadline check, and the caller's
    // transaction stays usable. Only a refusal in the `schema-row` phase
    // proves the advisory acquisition before it shortened lock_timeout; an
    // attempt refused before that, or one that fits in the budget, is rolled
    // back and retried.
    const refusals: Readonly<{ error: unknown; setting: unknown }>[] = [];
    for (let attempt = 0; attempt < 20 && refusals.length === 0; attempt++) {
      const observed = await db
        .transaction(async (nativeTx) => {
          await nativeTx.execute(
            sql`SELECT set_config('lock_timeout', '7s', true)`,
          );
          try {
            await adopt(nativeTx, "adoption_budget", { waitBudgetMs: 1 });
          } catch (error) {
            if (
              error instanceof SchemaFenceTimeoutError &&
              error.details.phase !== "schema-row"
            ) {
              throw new RetriedAttempt();
            }
            const rows = await nativeTx.execute(
              sql`SELECT current_setting('lock_timeout') AS setting`,
            );
            return { error, setting: rows.rows[0] };
          }
          throw new RetriedAttempt();
        })
        .catch((error: unknown) => {
          if (error instanceof RetriedAttempt) return;
          throw error;
        });
      if (observed !== undefined) refusals.push(observed);
    }
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.error).toBeInstanceOf(SchemaFenceTimeoutError);
    expect(refusals[0]?.setting).toEqual({ setting: "7s" });
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
