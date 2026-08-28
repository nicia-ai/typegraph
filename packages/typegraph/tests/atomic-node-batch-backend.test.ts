import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it, type Mock, vi } from "vitest";

import {
  resolveBundledRootAtomicMutationPrograms,
  resolveBundledRootAtomicNodeBatch,
} from "../src/backend/capabilities/atomic-mutation-program";
import type { AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { D1_MAX_BIND_PARAMETERS } from "../src/backend/types";
import { CompilerInvariantError } from "../src/errors";

function nodeResultRow(id: string): Record<string, unknown> {
  return {
    graph_id: "graph-1",
    kind: "Person",
    id,
    props: { name: id },
    version: 1,
    valid_from: undefined,
    valid_to: undefined,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    deleted_at: undefined,
  };
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

describe("bundled root atomic node batch", () => {
  it("dispatches node-delete chunks through one Neon atomic exchange", async () => {
    const { db, query, transaction } = makeNeonDatabase((sqlText, params) =>
      sqlText.includes("UPDATE") ?
        params
          .filter(
            (parameter): parameter is string =>
              typeof parameter === "string" &&
              parameter.startsWith("delete-person-"),
          )
          .map((id) => ({ id }))
      : [{ version: 1 }],
    );
    const backend = createPostgresBackend(db, {
      capabilities: { maxBindParameters: 7 },
      vector: false,
    });
    const executeAtomicNodeDelete =
      resolveBundledRootAtomicMutationPrograms(backend)?.deleteNodes;
    if (executeAtomicNodeDelete === undefined) {
      throw new Error("Expected Neon atomic node delete capability");
    }

    await expect(
      executeAtomicNodeDelete({
        graphId: "graph-1",
        kind: "Person",
        ids: ["delete-person-1", "delete-person-2", "delete-person-3"],
        schemaFence: { graphId: "graph-1", expectedVersion: 1 },
      }),
    ).resolves.toEqual({ affectedCount: 3, schemaFenceMatched: true });

    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(3);
    for (const [sqlText, params] of query.mock.calls.slice(0, 2)) {
      expect(sqlText).toContain("UPDATE");
      expect(params.length).toBeLessThanOrEqual(7);
    }
    expect(query.mock.calls[2]?.[0]).toContain("SELECT");
  });

  it.each([
    {
      label: "a partial row result",
      rows: [nodeResultRow("person-1")],
      message: "Atomic node batch returned a partial row result",
    },
    {
      label: "a duplicate result row",
      rows: [nodeResultRow("person-1"), nodeResultRow("person-1")],
      message: "Atomic node batch returned a duplicate result row",
    },
    {
      label: "a row outside the input set",
      rows: [nodeResultRow("outside-1"), nodeResultRow("outside-2")],
      message: "Atomic node batch returned a row outside its input set",
    },
  ])("fails closed on $label", async ({ rows, message }) => {
    const { db, query } = makeNeonDatabase(rows);
    const backend = createPostgresBackend(db, { vector: false });
    const executeAtomicNodeBatch = resolveBundledRootAtomicNodeBatch(backend);
    if (executeAtomicNodeBatch === undefined) {
      throw new Error("Expected atomic node batch capability");
    }

    const failure = executeAtomicNodeBatch({
      entries: [
        {
          idSource: "generated",
          params: {
            graphId: "graph-1",
            kind: "Person",
            id: "person-1",
            props: { name: "Alice" },
          },
        },
        {
          idSource: "generated",
          params: {
            graphId: "graph-1",
            kind: "Person",
            id: "person-2",
            props: { name: "Bob" },
          },
        },
      ],
      resultMode: "rows",
      schemaFence: { graphId: "graph-1", expectedVersion: 1 },
    });
    await expect(failure).rejects.toBeInstanceOf(CompilerInvariantError);
    await expect(failure).rejects.toThrow(message);
    expect(query).toHaveBeenCalledOnce();
  });

  it("classifies a PostgreSQL live caller-ID conflict as a duplicate key", async () => {
    const { db, query } = makeNeonDatabase([]);
    const backend = createPostgresBackend(db, { vector: false });
    const executor = resolveBundledRootAtomicNodeBatch(backend);
    if (executor === undefined) {
      throw new Error("Expected Neon atomic node batch capability");
    }
    query.mockRejectedValueOnce(
      Object.assign(new Error("null value in column props"), {
        code: "23502",
        table: "typegraph_nodes",
        column: "props",
      }),
    );

    await expect(
      executor({
        entries: [
          {
            idSource: "caller",
            params: {
              graphId: "graph-1",
              kind: "Person",
              id: "person-1",
              props: { name: "Alice" },
            },
          },
        ],
        resultMode: "count",
        schemaFence: { graphId: "graph-1", expectedVersion: 1 },
      }),
    ).rejects.toMatchObject({
      details: { reason: "duplicate_key" },
    });
  });

  it("compiles, maps, and dispatches through one Neon atomic exchange", async () => {
    const { db, query, transaction } = makeNeonDatabase([{ inserted: 1 }]);
    const backend = createPostgresBackend(db, { vector: false });
    const executeAtomicNodeBatch = resolveBundledRootAtomicNodeBatch(backend);

    expect(executeAtomicNodeBatch).toBeDefined();
    if (executeAtomicNodeBatch === undefined) {
      throw new Error("Expected atomic node batch capability");
    }

    await expect(
      executeAtomicNodeBatch({
        entries: [
          {
            idSource: "generated",
            params: {
              graphId: "graph-1",
              kind: "Person",
              id: "person-1",
              props: { name: "Alice" },
            },
          },
        ],
        resultMode: "count",
        schemaFence: { graphId: "graph-1", expectedVersion: 1 },
      }),
    ).resolves.toBe(1);
    expect(query).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO");
    expect(query.mock.calls[0]?.[1]).toContain(1);
  });

  it("returns no rows when the schema fence gates the insert", async () => {
    const { db, query } = makeNeonDatabase([]);
    const backend = createPostgresBackend(db, { vector: false });
    const executeAtomicNodeBatch = resolveBundledRootAtomicNodeBatch(backend);
    if (executeAtomicNodeBatch === undefined) {
      throw new Error("Expected atomic node batch capability");
    }

    await expect(
      executeAtomicNodeBatch({
        entries: [
          {
            idSource: "generated",
            params: {
              graphId: "graph-1",
              kind: "Person",
              id: "person-1",
              props: { name: "Alice" },
            },
          },
        ],
        resultMode: "count",
        schemaFence: { graphId: "graph-1", expectedVersion: 99 },
      }),
    ).resolves.toBe(0);
    expect(query).toHaveBeenCalledOnce();
  });

  it("keeps every PostgreSQL chunk within the configured bind limit", async () => {
    const { db, query, transaction } = makeNeonDatabase((_sqlText, params) =>
      Array.from(
        {
          length: params.filter(
            (parameter) =>
              typeof parameter === "string" && parameter.startsWith("person-"),
          ).length,
        },
        () => ({ inserted: 1 }),
      ),
    );
    const backend = createPostgresBackend(db, {
      capabilities: { maxBindParameters: 100 },
      vector: false,
    });
    const executeAtomicNodeBatch = resolveBundledRootAtomicNodeBatch(backend);
    if (executeAtomicNodeBatch === undefined) {
      throw new Error("Expected atomic node batch capability");
    }

    await expect(
      executeAtomicNodeBatch({
        entries: Array.from({ length: 11 }, (_, index) => ({
          idSource: "generated" as const,
          params: {
            graphId: "graph-1",
            kind: "Person",
            id: `person-${index}`,
            props: { name: `Person ${index}` },
          },
        })),
        resultMode: "count",
        schemaFence: { graphId: "graph-1", expectedVersion: 1 },
      }),
    ).resolves.toBe(11);

    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
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
          statements.map((_statement, index) => ({
            results: Array.from({ length: index === 0 ? 10 : 1 }, () => ({
              inserted: 1,
            })),
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
    const executeAtomicNodeBatch = resolveBundledRootAtomicNodeBatch(backend);
    if (executeAtomicNodeBatch === undefined) {
      throw new Error("Expected D1 atomic node batch capability");
    }

    expect(backend.capabilities.execution.interactiveTransactions).toBe(false);
    expect(backend.capabilities.maxBindParameters).toBe(D1_MAX_BIND_PARAMETERS);
    await expect(
      executeAtomicNodeBatch({
        entries: Array.from({ length: 11 }, (_, index) => ({
          idSource: "generated" as const,
          params: {
            graphId: "graph-1",
            kind: "Person",
            id: `person-${index}`,
            props: { name: `Person ${index}` },
          },
        })),
        resultMode: "count",
        schemaFence: { graphId: "graph-1", expectedVersion: 1 },
      }),
    ).resolves.toBe(11);

    expect(batch).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(boundStatements).toHaveLength(2);
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

    batch.mockResolvedValueOnce([
      {
        results: Array.from({ length: 9 }, () => ({ inserted: 1 })),
      },
      {
        results: Array.from({ length: 2 }, () => ({ inserted: 1 })),
      },
    ]);
    await expect(
      executeAtomicNodeBatch({
        entries: Array.from({ length: 11 }, (_, index) => ({
          idSource: "generated" as const,
          params: {
            graphId: "graph-1",
            kind: "Person",
            id: `second-person-${index}`,
            props: { name: `Second person ${index}` },
          },
        })),
        resultMode: "count",
        schemaFence: { graphId: "graph-1", expectedVersion: 1 },
      }),
    ).rejects.toThrow("Atomic node batch returned a partial chunk result");
    expect(batch).toHaveBeenCalledTimes(2);
  });
});
