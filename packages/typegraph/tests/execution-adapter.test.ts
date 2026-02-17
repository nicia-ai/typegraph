import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  type AnyPgDatabase,
  createPostgresExecutionAdapter,
} from "../src/backend/drizzle/execution/postgres-execution";
import {
  type AnySqliteDatabase,
  createSqliteExecutionAdapter,
} from "../src/backend/drizzle/execution/sqlite-execution";
import { createTestDatabase } from "./test-utils";

describe("sqlite execution adapter", () => {
  it("enables compiled execution for sync sqlite clients", async () => {
    const db = createTestDatabase();
    const adapter = createSqliteExecutionAdapter(db as AnySqliteDatabase);

    expect(adapter.profile.isSync).toBe(true);
    expect(adapter.profile.supportsCompiledExecution).toBe(true);
    expect(adapter.executeCompiled).toBeDefined();
    expect(adapter.prepare).toBeDefined();

    const compiled = adapter.compile(sql`SELECT ${1} AS value`);
    const executeCompiled = adapter.executeCompiled;
    expect(executeCompiled).toBeDefined();
    if (executeCompiled === undefined) {
      throw new Error(
        "Expected sqlite execution adapter to support executeCompiled",
      );
    }

    const rows = await executeCompiled<{ value: number }>(compiled);
    expect(rows[0]?.value).toBe(1);
  });

  it.skipIf(
    (() => {
      try {
        const testDb = createTestDatabase();
        return (
          (testDb as { $client?: { prepare?: unknown } }).$client?.prepare ===
          undefined
        );
      } catch {
        return true;
      }
    })(),
  )("reuses prepared statements for repeated query shapes", async () => {
    const db = createTestDatabase();
    const sqliteClient = (
      db as unknown as {
        $client: {
          prepare: (sqlText: string) => {
            all: (...params: readonly unknown[]) => readonly unknown[];
          };
        };
      }
    ).$client;

    const originalPrepare = sqliteClient.prepare;
    let prepareCalls = 0;

    try {
      sqliteClient.prepare = (sqlText) => {
        prepareCalls += 1;
        return originalPrepare.call(sqliteClient, sqlText);
      };

      const adapter = createSqliteExecutionAdapter(db as AnySqliteDatabase);
      const query = sql`SELECT ${"Alice"} AS name`;

      await adapter.execute<{ name: string }>(query);
      await adapter.execute<{ name: string }>(query);
      await adapter.execute<{ name: string }>(query);

      expect(prepareCalls).toBe(1);
    } finally {
      sqliteClient.prepare = originalPrepare;
    }
  });

  it("evicts oldest entries when statement cache exceeds max", async () => {
    const db = createTestDatabase();
    const sqliteClient = (
      db as {
        $client?: {
          prepare?: (sqlText: string) => {
            all: (...params: readonly unknown[]) => readonly unknown[];
          };
        };
      }
    ).$client;
    if (sqliteClient?.prepare === undefined) {
      return;
    }

    const originalPrepare = sqliteClient.prepare;
    let prepareCalls = 0;

    try {
      sqliteClient.prepare = (sqlText) => {
        prepareCalls += 1;
        return originalPrepare.call(sqliteClient, sqlText);
      };

      const adapter = createSqliteExecutionAdapter(db as AnySqliteDatabase, {
        statementCacheMax: 2,
      });

      // Use structurally different queries (different compiled SQL text)
      const queryA = sql`SELECT ${"x"} AS col_a`;
      const queryB = sql`SELECT ${"x"} AS col_b`;
      const queryC = sql`SELECT ${"x"} AS col_c`;

      await adapter.execute<{ v: string }>(queryA);
      await adapter.execute<{ v: string }>(queryB);
      expect(prepareCalls).toBe(2);

      // Third distinct query evicts queryA (oldest)
      await adapter.execute<{ v: string }>(queryC);
      expect(prepareCalls).toBe(3);

      // Re-execute queryA: should require re-preparation (was evicted)
      await adapter.execute<{ v: string }>(queryA);
      expect(prepareCalls).toBe(4);
    } finally {
      sqliteClient.prepare = originalPrepare;
    }
  });

  it("respects explicit execution profile hints", () => {
    const db = createTestDatabase();
    const adapter = createSqliteExecutionAdapter(db as AnySqliteDatabase, {
      profileHints: {
        isD1: true,
        isSync: false,
      },
    });

    expect(adapter.profile.isD1).toBe(true);
    expect(adapter.profile.isSync).toBe(false);
    expect(adapter.profile.supportsCompiledExecution).toBe(false);
  });
});

describe("postgres execution adapter", () => {
  it("falls back to drizzle execution when raw client is unavailable", async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        rows: [{ id: "row-1" }],
      }),
    );
    const db = {
      dialect: {
        sqlToQuery() {
          return {
            params: [1] as const,
            sql: "SELECT $1",
          };
        },
      },
      execute,
    } as unknown as AnyPgDatabase;

    const adapter = createPostgresExecutionAdapter(db);
    expect(adapter.executeCompiled).toBeUndefined();
    expect(adapter.prepare).toBeUndefined();

    const rows = await adapter.execute<{ id: string }>(sql`SELECT ${1}`);
    expect(rows[0]?.id).toBe("row-1");
    expect(execute).toHaveBeenCalledTimes(1);

    const compiled = adapter.compile(sql`SELECT ${1}`);
    expect(compiled.sql).toBe("SELECT $1");
    expect(compiled.params).toEqual([1]);
  });

  it("exposes executeCompiled and prepare when raw client is available", async () => {
    const query = vi.fn((sqlText: string, params: readonly unknown[]) =>
      Promise.resolve({
        rows: [{ params, sqlText }],
      }),
    );
    const db = {
      $client: { query },
      dialect: {
        sqlToQuery() {
          return {
            params: [42] as const,
            sql: "SELECT $1",
          };
        },
      },
      execute: vi.fn(() => Promise.resolve({ rows: [] as readonly unknown[] })),
    } as unknown as AnyPgDatabase;

    const adapter = createPostgresExecutionAdapter(db);
    expect(adapter.executeCompiled).toBeDefined();
    expect(adapter.prepare).toBeDefined();

    const executeCompiled = adapter.executeCompiled;
    if (executeCompiled === undefined) {
      throw new Error(
        "Expected postgres execution adapter to support executeCompiled",
      );
    }
    const compiledRows = await executeCompiled<{
      params: readonly unknown[];
      sqlText: string;
    }>({
      params: [42],
      sql: "SELECT $1",
    });

    expect(compiledRows[0]?.sqlText).toBe("SELECT $1");
    expect(compiledRows[0]?.params).toEqual([42]);
    expect(query).toHaveBeenCalledWith("SELECT $1", [42]);

    const prepare = adapter.prepare;
    if (prepare === undefined) {
      throw new Error(
        "Expected postgres execution adapter to expose prepare()",
      );
    }
    const preparedStatement = prepare("SELECT $1");
    const preparedRows = await preparedStatement.execute<{
      params: readonly unknown[];
      sqlText: string;
    }>(["abc"]);
    expect(preparedRows[0]?.sqlText).toBe("SELECT $1");
    expect(preparedRows[0]?.params).toEqual(["abc"]);
    expect(query).toHaveBeenCalledWith("SELECT $1", ["abc"]);
  });
});
