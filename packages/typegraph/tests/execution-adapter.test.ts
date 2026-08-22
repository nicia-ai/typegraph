import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import {
  type AnyPgDatabase,
  createPostgresExecutionAdapter,
  resetStatementNameCacheForTests,
} from "../src/backend/drizzle/execution/postgres-execution";
import {
  type AnySqliteDatabase,
  createSqliteExecutionAdapter,
} from "../src/backend/drizzle/execution/sqlite-execution";
import { toDrizzleSql } from "../src/backend/drizzle/execution/types";
import {
  D1_MAX_BIND_PARAMETERS,
  DURABLE_OBJECT_MAX_BIND_PARAMETERS,
} from "../src/backend/types";
import { sql as portableSql } from "../src/query/sql-fragment";
import { createTestDatabase } from "./test-utils";

describe("sqlite execution adapter", () => {
  it("renders TypeGraph fragments without binding nested fragments as values", () => {
    const db = createTestDatabase();
    const adapter = createSqliteExecutionAdapter(db);
    const condition = portableSql`${portableSql.identifier("display_name")} = ${"Alice"}`;
    const query = portableSql`SELECT ${portableSql.identifier("id")} FROM ${portableSql.identifier("people")} WHERE ${condition}`;

    expect(adapter.compile(query)).toEqual({
      params: ["Alice"],
      sql: 'SELECT "id" FROM "people" WHERE "display_name" = ?',
    });
  });

  it("converts portable fragments to Drizzle SQL only at the driver boundary", () => {
    const db = createTestDatabase();
    const adapter = createSqliteExecutionAdapter(db);
    const query = portableSql`SELECT ${portableSql.identifier('display"name')} FROM ${portableSql.identifier("people")} WHERE ${portableSql.identifier("id")} = ${42}`;

    expect(adapter.compile(toDrizzleSql(query, "sqlite"))).toMatchObject({
      params: [42],
      sql: 'SELECT "display""name" FROM "people" WHERE "id" = ?',
    });
  });

  it("normalizes direct parameters at the Drizzle boundary", () => {
    const db = createTestDatabase();
    const adapter = createSqliteExecutionAdapter(db);
    const query = portableSql`SELECT ${true}, ${new Date(
      "2025-01-02T03:04:05.000Z",
    )}`;

    expect(adapter.compile(toDrizzleSql(query, "sqlite"))).toMatchObject({
      params: [1, "2025-01-02T03:04:05.000Z"],
      sql: "SELECT ?, ?",
    });
  });

  it("preserves exotic parameters and named placeholders at the Drizzle bridge", () => {
    const db = createTestDatabase();
    const adapter = createSqliteExecutionAdapter(db);
    const binary = new Uint8Array([1, 2, 3]);
    const array = ["a", "b"];
    const query = portableSql`SELECT ${array}, ${binary}, ${undefined}, ${portableSql.placeholder(
      "late",
    )}`;

    expect(adapter.compile(toDrizzleSql(query, "sqlite"))).toMatchObject({
      params: [array, binary, undefined, expect.anything()],
      sql: "SELECT ?, ?, ?, ?",
    });
  });

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
      // Spy AFTER construction: the adapter probes the connection's
      // bound-parameter budget at creation, and those one-time statements
      // are not part of the execute() reuse behavior under test.
      const adapter = createSqliteExecutionAdapter(db);
      sqliteClient.prepare = (sqlText) => {
        prepareCalls += 1;
        return originalPrepare.call(sqliteClient, sqlText);
      };

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
      // Spy AFTER construction — see the reuse test above.
      const adapter = createSqliteExecutionAdapter(db, {
        statementCacheMax: 2,
      });
      sqliteClient.prepare = (sqlText) => {
        prepareCalls += 1;
        return originalPrepare.call(sqliteClient, sqlText);
      };

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

    it("uses the structural Durable Object client despite minified names and stale hints", () => {
      const db = {
        $client: {
          sql: { exec: vi.fn() },
          transaction: <Result>(run: () => Promise<Result>) => run(),
          transactionSync: <Result>(run: () => Result) => run(),
        },
        session: { constructor: { name: "a" } },
      } as unknown as AnySqliteDatabase;
      const adapter = createSqliteExecutionAdapter(db, {
        profileHints: { isSync: false, transactionMode: "none" },
      });

      expect(adapter.profile).toMatchObject({
        hardMaxBindParameters: DURABLE_OBJECT_MAX_BIND_PARAMETERS,
        hostedPlatform: "durable-object",
        isSync: true,
        maxBindParameters: DURABLE_OBJECT_MAX_BIND_PARAMETERS,
        transactionMode: "do-sqlite",
      });
    });

    it("routes sql.js through Drizzle instead of the compiled path", async () => {
      // sql.js `prepare()` returns a Statement with bind/step/getAsObject and
      // NO `all()`, so driving it from the compiled path throws on the first
      // statement — the advertised sql.js support could never have executed a
      // query. The client is positively identified and excluded, and Drizzle's
      // own sql-js session (which drives that statement shape correctly) runs
      // the query instead.
      const prepare = vi.fn(() => ({
        bind: () => true,
        step: () => false,
        getAsObject: () => ({}),
        free: () => true,
      }));
      const all = vi.fn(() => [{ value: 1 }]);
      const db = {
        $client: {
          prepare,
          exec: () => [],
          run: () => ({}),
          export: () => new Uint8Array(),
          getRowsModified: () => 0,
        },
        get: () => ({}),
        all,
      } as unknown as AnySqliteDatabase;

      const adapter = createSqliteExecutionAdapter(db);

      expect(adapter.profile.supportsCompiledExecution).toBe(false);
      expect(adapter.executeCompiled).toBeUndefined();
      await expect(
        adapter.execute<{ value: number }>(sql`SELECT 1 AS value`),
      ).resolves.toEqual([{ value: 1 }]);
      expect(all).toHaveBeenCalledOnce();
      // The sql.js Statement was never asked for rows it cannot return.
      expect(prepare).not.toHaveBeenCalled();
    });

    it("keeps detected D1 limits and transaction mode authoritative", () => {
      const db = {
        session: { constructor: { name: "SQLiteD1Session" } },
      } as unknown as AnySqliteDatabase;
      const adapter = createSqliteExecutionAdapter(db, {
        profileHints: { isSync: true, transactionMode: "drizzle" },
      });

      expect(adapter.profile).toMatchObject({
        hardMaxBindParameters: D1_MAX_BIND_PARAMETERS,
        hostedPlatform: "d1",
        isSync: false,
        maxBindParameters: D1_MAX_BIND_PARAMETERS,
        transactionMode: "none",
      });
    });
  });
});

/**
 * Builds a mock pg-style db whose `dialect.sqlToQuery()` echoes the
 * `SqlFragment` built from a single placeholder, so each test can issue
 * distinct queries via `sql\`q1\``, `sql\`q2\``, etc. and the adapter
 * sees a different `compiled.sql` per query.
 */
type MockPgQueryFunction = ReturnType<
  typeof vi.fn<
    (
      configOrSql: unknown,
      params?: readonly unknown[],
    ) => Promise<{ rows: readonly unknown[] }>
  >
>;

function makeMockPgDb(): { db: AnyPgDatabase; query: MockPgQueryFunction } {
  const query: MockPgQueryFunction = vi.fn(() => Promise.resolve({ rows: [] }));
  // Compile each Drizzle SQL object to a stable SQL string keyed on
  // object identity, so a query executed twice produces the same
  // compiled text — matching the real dialect's behavior. A naive
  // monotonic counter would assign a new SQL string per call and break
  // any test that asserts on cache hits.
  const compiled = new WeakMap<object, string>();
  let counter = 0;
  const db = {
    $client: { query },
    dialect: {
      sqlToQuery(query: object) {
        let sqlText = compiled.get(query);
        if (sqlText === undefined) {
          counter += 1;
          sqlText = `SELECT ${counter} AS x`;
          compiled.set(query, sqlText);
        }
        return { params: [] as readonly unknown[], sql: sqlText };
      },
    },
    execute: vi.fn(() => Promise.resolve({ rows: [] as readonly unknown[] })),
  } as unknown as AnyPgDatabase;
  return { db, query };
}

describe("postgres execution adapter", () => {
  it("renders TypeGraph fragments with PostgreSQL placeholders", () => {
    const { db } = makeMockPgDb();
    const adapter = createPostgresExecutionAdapter(db);
    const query = portableSql`SELECT ${portableSql.identifier("display_name")} FROM ${portableSql.identifier("people")} WHERE ${portableSql.identifier("id")} = ${42}`;

    expect(adapter.compile(query)).toEqual({
      params: [42],
      sql: 'SELECT "display_name" FROM "people" WHERE "id" = $1',
    });
  });

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

  it("rejects statements over the configured bind limit before dispatch", async () => {
    const query = vi.fn(() =>
      Promise.resolve({ rows: [] as readonly unknown[] }),
    );
    const db = {
      $client: { query },
      dialect: {
        sqlToQuery() {
          return {
            params: [1, 2] as const,
            sql: "SELECT $1, $2",
          };
        },
      },
      execute: vi.fn(() => Promise.resolve({ rows: [] as readonly unknown[] })),
    } as unknown as AnyPgDatabase;
    const adapter = createPostgresExecutionAdapter(db, {
      maxBindParameters: 1,
    });
    const expectedError = {
      code: "CONFIGURATION_ERROR",
      details: {
        capability: "maxBindParameters",
        maxBindParameters: 1,
        parameterCount: 2,
      },
    };

    await expect(adapter.execute(sql`SELECT ${1}, ${2}`)).rejects.toMatchObject(
      expectedError,
    );
    await expect(
      adapter.executeCompiled?.({ params: [1, 2], sql: "SELECT $1, $2" }),
    ).rejects.toMatchObject(expectedError);
    await expect(
      adapter.prepare?.("SELECT $1, $2").execute([1, 2]),
    ).rejects.toMatchObject(expectedError);

    expect(query).not.toHaveBeenCalled();
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

  describe("statement-name cache", () => {
    it("evicts oldest entries when cache exceeds the configured cap", async () => {
      resetStatementNameCacheForTests();
      const { db, query } = makeMockPgDb();
      const adapter = createPostgresExecutionAdapter(db, {
        preparedStatementCacheMax: 2,
      });

      // Three distinct compiled SQL strings → cache exceeds cap by one,
      // so the oldest entry must be evicted.
      await adapter.execute(sql`q1`);
      await adapter.execute(sql`q2`);
      await adapter.execute(sql`q3`);

      const namesUsed = query.mock.calls.map(
        (call) => (call[0] as { name: string }).name,
      );
      expect(namesUsed).toHaveLength(3);
      expect(new Set(namesUsed).size).toBe(3);
    });

    it("keeps names unique after eviction on a connection that remembers prepared SQL", async () => {
      resetStatementNameCacheForTests();
      const { db, query } = makeMockPgDb();
      // node-postgres remembers each prepared statement's SQL text for the
      // lifetime of a connection and rejects a name paired with different
      // text. Model that contract here rather than only counting generated
      // names: a name-reuse regression fails at the same second eviction that
      // reaches a real long-lived connection.
      const preparedSqlByName = new Map<string, string>();
      query.mockImplementation((configOrSql) => {
        if (typeof configOrSql === "string") {
          return Promise.resolve({ rows: [] });
        }
        const config = configOrSql as Readonly<{
          name: string;
          text: string;
        }>;
        const existingSql = preparedSqlByName.get(config.name);
        if (existingSql !== undefined && existingSql !== config.text) {
          return Promise.reject(
            new Error(
              `Prepared statements must be unique - '${config.name}' was used for a different statement`,
            ),
          );
        }
        preparedSqlByName.set(config.name, config.text);
        return Promise.resolve({ rows: [{ sqlText: config.text }] });
      });
      const adapter = createPostgresExecutionAdapter(db, {
        preparedStatementCacheMax: 2,
      });

      // Four distinct statements exceed a two-entry LRU twice. A cache that
      // recycled either evicted name would be rejected by the modeled pg
      // connection instead of safely preparing the new SQL text.
      const executedSql = await Promise.all(
        [sql`q1`, sql`q2`, sql`q3`, sql`q4`].map(async (statement) => {
          const rows = await adapter.execute<{ sqlText: string }>(statement);
          return rows[0]?.sqlText;
        }),
      );

      const namesUsed = query.mock.calls.map(
        (call) => (call[0] as { name: string }).name,
      );
      expect(executedSql).toEqual([
        "SELECT 1 AS x",
        "SELECT 2 AS x",
        "SELECT 3 AS x",
        "SELECT 4 AS x",
      ]);
      expect(new Set(namesUsed).size).toBe(4);
    });

    it("promotes recently-used entries so they are not evicted next", async () => {
      resetStatementNameCacheForTests();
      const { db, query } = makeMockPgDb();
      const adapter = createPostgresExecutionAdapter(db, {
        preparedStatementCacheMax: 2,
      });

      const queryA = sql`alpha`;
      const queryB = sql`beta`;
      const queryC = sql`gamma`;

      await adapter.execute(queryA);
      await adapter.execute(queryB);
      const nameA = (query.mock.calls[0]?.[0] as { name: string }).name;
      const nameB = (query.mock.calls[1]?.[0] as { name: string }).name;

      // Touch queryA so queryB becomes the oldest entry.
      await adapter.execute(queryA);
      // Now queryC evicts queryB, not queryA.
      await adapter.execute(queryC);
      // Re-execute queryA: should reuse the existing name (no new entry).
      await adapter.execute(queryA);

      const namesUsed = query.mock.calls.map(
        (call) => (call[0] as { name: string }).name,
      );
      // 5 calls total. queryA shows up 3× under nameA, queryB once under
      // nameB (then evicted), queryC once under a fresh third name.
      expect(namesUsed.filter((name) => name === nameA)).toHaveLength(3);
      expect(namesUsed.filter((name) => name === nameB)).toHaveLength(1);
      expect(new Set(namesUsed).size).toBe(3);
    });

    it("uses unnamed positional query when prepareStatements is false", async () => {
      resetStatementNameCacheForTests();
      const { db, query } = makeMockPgDb();
      const adapter = createPostgresExecutionAdapter(db, {
        prepareStatements: false,
      });

      await adapter.execute(sql`q1`);
      await adapter.execute(sql`q2`);

      for (const call of query.mock.calls) {
        expect(typeof call[0]).toBe("string");
        expect(Array.isArray(call[1])).toBe(true);
      }
    });
  });
});
