import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it, type Mock, vi } from "vitest";

import { resolveBundledRootAtomicEdgeBatch } from "../src/backend/capabilities/atomic-edge-batch";
import type { AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { D1_MAX_BIND_PARAMETERS } from "../src/backend/types";

const schemaFence = { graphId: "graph-1", expectedVersion: 1 } as const;

function edgeParams(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    graphId: "graph-1",
    id: `${prefix}-edge-${index}`,
    kind: "worksAt",
    fromKind: "Person",
    fromId: `${prefix}-person-${index}`,
    toKind: "Company",
    toId: `${prefix}-company-${index}`,
    props: { role: `Role ${index}` },
  }));
}

type NeonRows =
  | readonly Record<string, unknown>[]
  | ((
      sqlText: string,
      params: readonly unknown[],
    ) => readonly Record<string, unknown>[]);

type NeonQuery = (
  sqlText: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

function makeNeonDatabase(rows: NeonRows): Readonly<{
  db: AnyPgDatabase;
  query: Mock<NeonQuery>;
  transaction: ReturnType<typeof vi.fn>;
}> {
  const query = vi.fn((sqlText: string, params: readonly unknown[]) => {
    const resultRows =
      typeof rows === "function" ? rows(sqlText, params) : rows;
    return Promise.resolve(
      resultRows.map((row) => ({ ...row, sqlText, params })),
    );
  });
  const transaction = vi.fn(
    async (queries: readonly Promise<readonly unknown[]>[]) =>
      Promise.all(queries),
  );
  const neonClient = Object.assign(vi.fn(), { query, transaction });
  const db = {
    $client: neonClient,
    dialect: {
      sqlToQuery(query: SQL) {
        return new PgDialect().sqlToQuery(query);
      },
    },
    execute: vi.fn(),
  } as unknown as AnyPgDatabase;
  return { db, query, transaction };
}

describe("bundled root atomic edge batch", () => {
  it("compiles and dispatches one Neon exchange for a count-only batch", async () => {
    const { db, query, transaction } = makeNeonDatabase([
      { inserted: 1 },
      { inserted: 1 },
    ]);
    const backend = createPostgresBackend(db, { vector: false });
    const executeAtomicEdgeBatch = resolveBundledRootAtomicEdgeBatch(backend);

    expect(executeAtomicEdgeBatch).toBeDefined();
    if (executeAtomicEdgeBatch === undefined) {
      throw new Error("Expected atomic edge batch capability");
    }

    await expect(
      executeAtomicEdgeBatch({
        params: edgeParams("first", 2),
        schemaFence,
        resultMode: "count",
      }),
    ).resolves.toBe(2);
    expect(query).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO");
  });

  it("returns no rows when the schema fence gates the insert", async () => {
    const { db, query } = makeNeonDatabase([]);
    const backend = createPostgresBackend(db, { vector: false });
    const executeAtomicEdgeBatch = resolveBundledRootAtomicEdgeBatch(backend);
    if (executeAtomicEdgeBatch === undefined) {
      throw new Error("Expected atomic edge batch capability");
    }

    await expect(
      executeAtomicEdgeBatch({
        params: edgeParams("stale", 1),
        schemaFence: { graphId: "graph-1", expectedVersion: 99 },
        resultMode: "count",
      }),
    ).resolves.toBe(0);
    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps every PostgreSQL fenced chunk inside its bind limit", async () => {
    const { db, query, transaction } = makeNeonDatabase((_sqlText, params) =>
      Array.from(
        {
          length: params.filter(
            (parameter) =>
              typeof parameter === "string" && parameter.includes("-edge-"),
          ).length,
        },
        () => ({ inserted: 1 }),
      ),
    );
    const backend = createPostgresBackend(db, {
      capabilities: { maxBindParameters: 100 },
      vector: false,
    });
    const executeAtomicEdgeBatch = resolveBundledRootAtomicEdgeBatch(backend);
    if (executeAtomicEdgeBatch === undefined) {
      throw new Error("Expected atomic edge batch capability");
    }

    await expect(
      executeAtomicEdgeBatch({
        params: edgeParams("chunk", 9),
        schemaFence,
        resultMode: "count",
      }),
    ).resolves.toBe(9);

    expect(transaction).toHaveBeenCalledOnce();
    expect(query.mock.calls.length).toBeGreaterThan(1);
    for (const call of query.mock.calls) {
      expect(call[1].length).toBeLessThanOrEqual(100);
    }
  });

  it("uses one D1 batch while keeping every fenced chunk within its bind limit", async () => {
    const boundStatements: Readonly<{
      sql: string;
      params: readonly unknown[];
    }>[] = [];
    const prepare = vi.fn((sqlText: string) => ({
      bind(...params: readonly unknown[]) {
        const statement = { sql: sqlText, params };
        boundStatements.push(statement);
        return statement;
      },
    }));
    const batch = vi.fn(
      (
        statements: readonly Readonly<{
          sql: string;
          params: readonly unknown[];
        }>[],
      ) =>
        Promise.resolve(
          statements.map((statement) => ({
            results: Array.from(
              {
                length: statement.params.filter(
                  (value) =>
                    typeof value === "string" && value.includes("-edge-"),
                ).length,
              },
              () => ({ inserted: 1 }),
            ),
          })),
        ),
    );
    const dialect = new SQLiteSyncDialect();
    const db = {
      $client: { batch, prepare },
      session: { constructor: { name: "SQLiteD1Session" } },
      dialect: {
        sqlToQuery(query: SQL) {
          return dialect.sqlToQuery(query);
        },
      },
      all: vi.fn(() => Promise.resolve([])),
      get: vi.fn(() => Promise.resolve(undefined)),
      run: vi.fn(() => Promise.resolve()),
    } as unknown as AnySqliteDatabase;
    const backend = createSqliteBackend(db);
    const executeAtomicEdgeBatch = resolveBundledRootAtomicEdgeBatch(backend);
    if (executeAtomicEdgeBatch === undefined) {
      throw new Error("Expected D1 atomic edge batch capability");
    }

    expect(backend.capabilities.transactions).toBe(false);
    expect(backend.capabilities.maxBindParameters).toBe(D1_MAX_BIND_PARAMETERS);
    await expect(
      executeAtomicEdgeBatch({
        params: edgeParams("d1", 20),
        schemaFence,
        resultMode: "count",
      }),
    ).resolves.toBe(20);

    expect(batch).toHaveBeenCalledOnce();
    expect(boundStatements.length).toBeGreaterThan(1);
    for (const statement of boundStatements) {
      expect(statement.params.length).toBeLessThanOrEqual(
        D1_MAX_BIND_PARAMETERS,
      );
      expect(statement.sql.toLowerCase()).toContain('with "schema_fence" as');
      expect(statement.sql.toLowerCase()).toContain(
        'cross join "schema_fence"',
      );
      expect(statement.sql.toLowerCase()).toContain(
        'returning 1 as "inserted"',
      );
    }
  });
});
