import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it, type Mock, vi } from "vitest";

import {
  resolveBundledRootAtomicEdgeBatch,
  resolveBundledRootAtomicMutationPrograms,
} from "../src/backend/capabilities/atomic-mutation-program";
import type { AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import {
  type ClaimEdgeCardinalityParams,
  D1_MAX_BIND_PARAMETERS,
  type InsertEdgeParams,
} from "../src/backend/types";
import type { ConstrainedCardinality } from "../src/store/claims/edge-claims";
import { requireDefined } from "../src/utils/presence";

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

function edgeClaim(
  params: InsertEdgeParams,
  cardinality: ConstrainedCardinality = "one",
): ClaimEdgeCardinalityParams {
  return {
    graphId: params.graphId,
    cardinality,
    edgeKind: params.kind,
    edgeId: params.id,
    fromKind: params.fromKind,
    fromId: params.fromId,
    toKind: params.toKind,
    toId: params.toId,
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

type BoundD1Statement = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

function makeD1Database(): Readonly<{
  batch: ReturnType<typeof vi.fn>;
  boundStatements: BoundD1Statement[];
  db: AnySqliteDatabase;
}> {
  const boundStatements: BoundD1Statement[] = [];
  const prepare = vi.fn((sqlText: string) => ({
    bind(...params: readonly unknown[]) {
      const statement = { sql: sqlText, params };
      boundStatements.push(statement);
      return statement;
    },
  }));
  const batch = vi.fn((statements: readonly BoundD1Statement[]) =>
    Promise.resolve(
      statements.map((statement) => ({
        results:
          statement.sql.includes('RETURNING 1 AS "inserted"') ?
            Array.from(
              {
                length: statement.params.filter(
                  (value) =>
                    typeof value === "string" && value.includes("-edge-"),
                ).length,
              },
              () => ({ inserted: 1 }),
            )
          : [],
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
  return { batch, boundStatements, db };
}

describe("bundled root atomic edge batch", () => {
  it("dispatches edge-delete chunks through one Neon atomic exchange", async () => {
    const { db, query, transaction } = makeNeonDatabase((sqlText, params) =>
      sqlText.includes("UPDATE") ?
        params
          .filter(
            (parameter): parameter is string =>
              typeof parameter === "string" &&
              parameter.startsWith("delete-edge-"),
          )
          .map((id) => ({ id }))
      : [{ version: 1 }],
    );
    const backend = createPostgresBackend(db, {
      capabilities: { maxBindParameters: 9 },
      vector: false,
    });
    const executeAtomicEdgeDelete =
      resolveBundledRootAtomicMutationPrograms(backend)?.deleteEdges;
    if (executeAtomicEdgeDelete === undefined) {
      throw new Error("Expected Neon atomic edge delete capability");
    }

    await expect(
      executeAtomicEdgeDelete({
        graphId: "graph-1",
        expectedKind: "worksAt",
        ids: ["delete-edge-1", "delete-edge-2", "delete-edge-3"],
        schemaFence,
      }),
    ).resolves.toEqual({ affectedCount: 3, schemaFenceMatched: true });

    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(3);
    for (const [sqlText, params] of query.mock.calls.slice(0, 2)) {
      expect(sqlText).toContain("UPDATE");
      expect(params.length).toBeLessThanOrEqual(9);
    }
    expect(query.mock.calls[2]?.[0]).toContain("SELECT");
  });

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
        claims: [],
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
        claims: [],
        params: edgeParams("stale", 1),
        schemaFence: { graphId: "graph-1", expectedVersion: 99 },
        resultMode: "count",
      }),
    ).resolves.toBe(0);
    expect(query).toHaveBeenCalledOnce();
  });

  it("dispatches edge rows and cardinality sidecars in one Neon exchange", async () => {
    const params = edgeParams("claimed", 1);
    const { db, query, transaction } = makeNeonDatabase((sqlText) =>
      sqlText.includes('RETURNING 1 AS "inserted"') ? [{ inserted: 1 }] : [],
    );
    const backend = createPostgresBackend(db, { vector: false });
    const executeAtomicEdgeBatch = resolveBundledRootAtomicEdgeBatch(backend);
    if (executeAtomicEdgeBatch === undefined) {
      throw new Error("Expected atomic edge batch capability");
    }

    await expect(
      executeAtomicEdgeBatch({
        claims: [edgeClaim(requireDefined(params[0]))],
        params,
        schemaFence,
        resultMode: "count",
      }),
    ).resolves.toBe(1);

    expect(transaction).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.map(([sqlText]) => sqlText)).toEqual([
      expect.stringContaining("DELETE FROM"),
      expect.stringContaining("ON CONFLICT"),
      expect.stringContaining("AS axis"),
      expect.stringContaining("INSERT INTO"),
    ]);
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
        claims: [],
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
    const { batch, boundStatements, db } = makeD1Database();
    const backend = createSqliteBackend(db);
    const executeAtomicEdgeBatch = resolveBundledRootAtomicEdgeBatch(backend);
    if (executeAtomicEdgeBatch === undefined) {
      throw new Error("Expected D1 atomic edge batch capability");
    }

    expect(backend.capabilities.transactions).toBe(false);
    expect(backend.capabilities.maxBindParameters).toBe(D1_MAX_BIND_PARAMETERS);
    await expect(
      executeAtomicEdgeBatch({
        claims: [],
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

  it.each(["one", "unique", "oneActive"] as const)(
    "dispatches a %s edge program through one D1 batch within its bind budget",
    async (cardinality) => {
      const { batch, boundStatements, db } = makeD1Database();
      const backend = createSqliteBackend(db);
      const executeAtomicEdgeBatch = resolveBundledRootAtomicEdgeBatch(backend);
      if (executeAtomicEdgeBatch === undefined) {
        throw new Error("Expected D1 atomic edge batch capability");
      }
      const params = edgeParams("d1-claimed", 20).map((item, index) => ({
        ...item,
        matchIdentity: { name: "role", key: `role-${index}` },
      }));

      await expect(
        executeAtomicEdgeBatch({
          claims: params.map((item) => edgeClaim(item, cardinality)),
          params,
          schemaFence,
          resultMode: "count",
        }),
      ).resolves.toBe(20);

      expect(batch).toHaveBeenCalledOnce();
      expect(boundStatements.length).toBeGreaterThan(4);
      expect(
        boundStatements.some((statement) =>
          statement.sql.includes("DELETE FROM"),
        ),
      ).toBe(true);
      expect(
        boundStatements.some((statement) =>
          statement.sql.includes("ON CONFLICT"),
        ),
      ).toBe(true);
      expect(
        boundStatements.some((statement) => statement.sql.includes("AS axis")),
      ).toBe(true);
      for (const statement of boundStatements) {
        expect(statement.params.length).toBeLessThanOrEqual(
          D1_MAX_BIND_PARAMETERS,
        );
      }
    },
  );
});
