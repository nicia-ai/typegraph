import type Database from "better-sqlite3";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSqliteBackend } from "../../src/backend/drizzle/sqlite";
import { createPostgresBackend } from "../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import type { GraphBackend } from "../../src/backend/types";
import { ConfigurationError, SchemaFenceTimeoutError } from "../../src/errors";
import { requireDefined } from "../../src/utils/presence";

type StatementRunner = (
  statement: string,
  run: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * Routes every `execute` on `nativeTx` through `intercept` with the
 * statement's SQL text. The object itself is patched, not wrapped, so the
 * transaction the fence is handed keeps its identity.
 */
function interceptStatements(
  nativeTx: Readonly<{ execute: (query: SQL) => Promise<unknown> }>,
  intercept: StatementRunner,
): void {
  const execute = nativeTx.execute.bind(nativeTx);
  const dialect = new PgDialect();
  Object.defineProperty(nativeTx, "execute", {
    configurable: true,
    value: (query: SQL) =>
      intercept(dialect.sqlToQuery(query).sql, () => execute(query)),
  });
}

/** The reason `promise` rejects with; `undefined` when it fulfills. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

/**
 * Replaces `performance.now()` with a clock that moves only when the test
 * advances it.
 */
function controlledClock(): Readonly<{
  advance: (milliseconds: number) => void;
  restore: () => void;
}> {
  // An integral start keeps `deadline - now` exact: from a fractional real
  // reading, `(t + 1000) - t` can floor to 999ms.
  let now = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    advance: (milliseconds) => {
      now += milliseconds;
    },
    restore: () => {
      spy.mockRestore();
    },
  };
}

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

    // A controlled clock that stands still until the advisory acquisition
    // returns and then jumps past the budget: the fence has shortened
    // lock_timeout for that acquisition, and its deadline check before the
    // schema-row acquisition refuses. The caller's transaction stays usable.
    const clock = controlledClock();
    try {
      const observed = await db.transaction(async (nativeTx) => {
        await nativeTx.execute(
          sql`SELECT set_config('lock_timeout', '7s', true)`,
        );
        const settingsDuringAdvisory: unknown[] = [];
        interceptStatements(nativeTx, async (statement, run) => {
          const result = await run();
          if (statement.includes("pg_advisory_xact_lock")) {
            const rows = await nativeTx.execute(
              sql`SELECT current_setting('lock_timeout') AS setting`,
            );
            settingsDuringAdvisory.push(rows.rows[0]);
            clock.advance(60_000);
          }
          return result;
        });
        const error = await rejectionOf(
          adopt(nativeTx, "adoption_budget", { waitBudgetMs: 1000 }),
        );
        const rows = await nativeTx.execute(
          sql`SELECT current_setting('lock_timeout') AS setting`,
        );
        return { error, settingsDuringAdvisory, setting: rows.rows[0] };
      });
      expect(observed.error).toBeInstanceOf(SchemaFenceTimeoutError);
      expect((observed.error as SchemaFenceTimeoutError).details.phase).toBe(
        "schema-row",
      );
      expect(observed.settingsDuringAdvisory).toEqual([{ setting: "1s" }]);
      expect(observed.setting).toEqual({ setting: "7s" });
    } finally {
      clock.restore();
    }
  });

  it("preserves a driver failure during the advisory acquisition and issues no restore", async () => {
    const { backend, db } = await createLocalPgliteBackend({ vector: false });
    openedBackends.push(backend);
    const adopt = requireDefined(backend.adoptSchemaWriteTransaction);

    // A client-side query timeout rejects without an SQLSTATE while the
    // statement may still run on the server; the fence must not send a
    // restore after it, and must report the driver's own error.
    const driverTimeout = new Error("Query read timeout");
    const statementsAfterFailure: string[] = [];
    let observed: unknown;
    await db
      .transaction(async (nativeTx) => {
        await nativeTx.execute(
          sql`SELECT set_config('lock_timeout', '7s', true)`,
        );
        let failed = false;
        interceptStatements(nativeTx, async (statement, run) => {
          if (failed) statementsAfterFailure.push(statement);
          if (statement.includes("pg_advisory_xact_lock")) {
            failed = true;
            throw driverTimeout;
          }
          return run();
        });
        observed = await rejectionOf(
          adopt(nativeTx, "adoption_driver_timeout", { waitBudgetMs: 1000 }),
        );
        // Stop recording, then roll the probe transaction back.
        failed = false;
        throw observed;
      })
      .catch((error: unknown) => {
        if (error !== observed) throw error;
      });

    expect(observed).toBe(driverTimeout);
    expect(statementsAfterFailure).toEqual([]);
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
