import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  type AnyPgDatabase,
  createPostgresExecutionAdapter,
} from "../src/backend/drizzle/execution/postgres-execution";
import { createSqliteExecutionAdapter } from "../src/backend/drizzle/execution/sqlite-execution";
import { createTestDatabase } from "./test-utils";

describe("sqlite execution adapter", () => {
  it("enables compiled execution for sync sqlite clients", async () => {
    const db = createTestDatabase();
    const adapter = createSqliteExecutionAdapter(db);

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

      const adapter = createSqliteExecutionAdapter(db);
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

      const adapter = createSqliteExecutionAdapter(db, {
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
    const adapter = createSqliteExecutionAdapter(db, {
      profileHints: {
        isSync: false,
        transactionMode: "none",
      },
    });

    expect(adapter.profile.isSync).toBe(false);
    expect(adapter.profile.supportsCompiledExecution).toBe(false);
    expect(adapter.profile.transactionMode).toBe("none");
  });

  describe("transactionMode detection", () => {
    it("defaults to 'raw' for better-sqlite3", () => {
      const db = createTestDatabase();
      const adapter = createSqliteExecutionAdapter(db);
      expect(adapter.profile.transactionMode).toBe("sql");
    });

    it("respects explicit transactionMode hint", () => {
      const db = createTestDatabase();
      const adapter = createSqliteExecutionAdapter(db, {
        profileHints: { transactionMode: "drizzle" },
      });
      expect(adapter.profile.transactionMode).toBe("drizzle");
    });

    it("explicit transactionMode overrides session-based auto-detection", () => {
      const db = createTestDatabase();
      // better-sqlite3 would normally auto-detect as "sql", but explicit hint wins
      const adapter = createSqliteExecutionAdapter(db, {
        profileHints: { transactionMode: "none" },
      });
      expect(adapter.profile.transactionMode).toBe("none");
    });

    it("defaults to 'drizzle' for async drivers", () => {
      const db = createTestDatabase();
      const adapter = createSqliteExecutionAdapter(db, {
        profileHints: { isSync: false },
      });
      expect(adapter.profile.transactionMode).toBe("drizzle");
    });
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
    // The fast path now wraps the node-postgres client to use named
    // server-side prepared statements: it calls
    // `client.query({name, text, values, types})` instead of
    // `client.query(text, values)`. The mock accepts either shape so
    // tests can assert on the meaningful payload (text, values).
    type QueryArgument =
      | string
      | Readonly<{ name: string; text: string; values: readonly unknown[] }>;
    const query = vi.fn(
      (configOrSql: QueryArgument, paramsArgument?: readonly unknown[]) => {
        const sqlText =
          typeof configOrSql === "string" ? configOrSql : configOrSql.text;
        const params =
          typeof configOrSql === "string" ?
            (paramsArgument ?? [])
          : configOrSql.values;
        return Promise.resolve({ rows: [{ params, sqlText }] });
      },
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
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^tg_\d+$/) as unknown,
        text: "SELECT $1",
        values: [42],
      }),
    );

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
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "SELECT $1",
        values: ["abc"],
      }),
    );
  });
});
