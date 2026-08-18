/** End-to-end migration coverage for the timestamp-only preview schema. */
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  deleteLegacyRecordedAnchorMap,
  migrateLegacyRecordedTime,
  migrateRecordedAnchor,
  recordedInstantRevision,
  UnsupportedBackendCapabilityError,
} from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { type AnySqliteDatabase } from "../src/backend/drizzle/execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import {
  type AdapterBackend,
  type RecordedTableNames,
} from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../src/query/sql-intent";
import { assertCurrentRecordedSchema } from "../src/store/recorded-capture";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend, recordedRevisionFromDriver } from "./test-utils";

const FIRST = "2026-01-01T00:00:00.000Z";
const SECOND = "2026-01-01T00:00:00.001Z";
const THIRD = "2026-01-01T00:00:00.002Z";
const LEGACY_MAX = "9999-12-31T23:59:59.999Z";
const GRAPH_ID = "legacy-recorded-graph";

const LegacyItem = defineNode("LegacyItem", {
  schema: z.object({ label: z.string() }),
});

const legacyGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { LegacyItem: { type: LegacyItem } },
  edges: {},
});

const identityGraph = defineGraph({
  id: `${GRAPH_ID}-identity`,
  nodes: { LegacyItem: { type: LegacyItem } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

async function captureConfigurationError(
  promise: Promise<unknown>,
): Promise<ConfigurationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("Expected ConfigurationError");
}

async function captureUnsupportedCapabilityError(
  promise: Promise<unknown>,
): Promise<UnsupportedBackendCapabilityError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnsupportedBackendCapabilityError) return error;
    throw error;
  }
  throw new Error("Expected UnsupportedBackendCapabilityError");
}

/**
 * Wraps `base` with an `executeStatement`-counting `transaction` override,
 * built entirely through the derivation seam (`deriveBackend`/
 * `projectBackendWithout`) rather than by spreading a backend — the cap
 * `tests/backend-derivation-population.test.ts` holds spread-derivations to.
 */
function withStatementCounter(
  base: AdapterBackend<AnySqliteDatabase>,
  count: { value: number },
): AdapterBackend<AnySqliteDatabase> {
  return deriveBackend(base, {
    transaction: (fn, options) =>
      base.transaction(
        (target) =>
          fn(
            deriveBackend(target, {
              executeStatement: async (statement) => {
                count.value += 1;
                await requireDefined(target.executeStatement)(statement);
              },
            }),
          ),
        options,
      ),
  });
}

type RevisionRow = Readonly<{
  recorded_from: unknown;
  recorded_to: unknown;
}>;
type ClockRow = Readonly<{ recorded_at: unknown; revision: unknown }>;
type TableNameRow = Readonly<{ name: unknown }>;
type ColumnTypeRow = Readonly<{ name: unknown; type: unknown }>;

async function createLegacyRecordedSchema(
  backend: ReturnType<typeof createTestBackend>,
  options: Readonly<{ withRows?: boolean }> = {},
): Promise<void> {
  if (backend.executeStatement === undefined) {
    throw new Error("SQLite test backend must execute statements");
  }
  const schema = createSqlSchema(backend.tableNames);
  for (const table of [
    schema.recordedNodesTable,
    schema.recordedEdgesTable,
    schema.recordedClockTable,
  ]) {
    await backend.executeStatement(
      asCompiledStatementSql(sql`DROP TABLE IF EXISTS ${table}`),
    );
  }
  const statements = [
    sql`
      CREATE TABLE ${schema.recordedNodesTable} (
        history_id TEXT NOT NULL PRIMARY KEY,
        graph_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        props TEXT NOT NULL,
        version INTEGER NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        recorded_from TEXT NOT NULL,
        recorded_to TEXT NOT NULL,
        op TEXT NOT NULL,
        schema_version INTEGER,
        tx_id TEXT,
        meta TEXT
      )
    `,
    sql`
      CREATE TABLE ${schema.recordedEdgesTable} (
        history_id TEXT NOT NULL PRIMARY KEY,
        graph_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_kind TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_id TEXT NOT NULL,
        props TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        recorded_from TEXT NOT NULL,
        recorded_to TEXT NOT NULL,
        op TEXT NOT NULL,
        schema_version INTEGER,
        tx_id TEXT,
        meta TEXT
      )
    `,
    sql`
      CREATE TABLE ${schema.recordedClockTable} (
        graph_id TEXT NOT NULL PRIMARY KEY,
        recorded_at TEXT NOT NULL
      )
    `,
  ];
  for (const statement of statements) {
    await backend.executeStatement(asCompiledStatementSql(statement));
  }
  if (options.withRows === false) return;
  await backend.executeStatement(
    asCompiledStatementSql(sql`
      INSERT INTO ${schema.recordedNodesTable} (
        history_id, graph_id, kind, id, props, version,
        created_at, updated_at, recorded_from, recorded_to, op, meta
      ) VALUES
        (${"h1"}, ${GRAPH_ID}, ${"Item"}, ${"a"}, ${'{"label":"first"}'}, ${1},
         ${FIRST}, ${FIRST}, ${FIRST}, ${SECOND}, ${"create"}, ${"{}"}),
        (${"h2"}, ${GRAPH_ID}, ${"Item"}, ${"a"}, ${'{"label":"second"}'}, ${2},
         ${FIRST}, ${SECOND}, ${SECOND}, ${LEGACY_MAX}, ${"update"}, ${"{}"}),
        (${"h3"}, ${GRAPH_ID}, ${"Item"}, ${"b"}, ${'{"label":"third"}'}, ${1},
         ${THIRD}, ${THIRD}, ${THIRD}, ${LEGACY_MAX}, ${"create"}, ${"{}"})
    `),
  );
  await backend.executeStatement(
    asCompiledStatementSql(sql`
      INSERT INTO ${schema.recordedClockTable} (graph_id, recorded_at)
      VALUES (${GRAPH_ID}, ${THIRD})
    `),
  );
}

describe("migrateLegacyRecordedTime", () => {
  it("dense-ranks legacy boundaries and durably remaps external anchors", async () => {
    const backend = createTestBackend();
    await createLegacyRecordedSchema(backend);

    const result = await migrateLegacyRecordedTime({ backend });

    expect(result).toMatchObject({ migrated: true, graphs: 1, anchors: 3 });
    const schema = createSqlSchema(backend.tableNames);
    const revisions = await backend.execute<RevisionRow>(
      asCompiledRowsSql(sql`
        SELECT recorded_from, recorded_to
        FROM ${schema.recordedNodesTable}
        WHERE graph_id = ${GRAPH_ID}
        ORDER BY recorded_from
      `),
    );
    expect(
      revisions.map((row) => [
        recordedRevisionFromDriver(row.recorded_from),
        recordedRevisionFromDriver(row.recorded_to),
      ]),
    ).toEqual([
      [1, 2],
      [2, Number.MAX_SAFE_INTEGER],
      [3, Number.MAX_SAFE_INTEGER],
    ]);

    const clocks = await backend.execute<ClockRow>(
      asCompiledRowsSql(sql`
        SELECT revision, recorded_at
        FROM ${schema.recordedClockTable}
        WHERE graph_id = ${GRAPH_ID}
      `),
    );
    expect(recordedRevisionFromDriver(clocks[0]?.revision)).toBe(3);

    const migratedAnchor = await migrateRecordedAnchor({
      backend,
      graphId: GRAPH_ID,
      anchor: SECOND,
    });
    expect(migratedAnchor).toBe("r1:0000000000000002:2026-01-01T00:00:00.001Z");
    expect(recordedInstantRevision(migratedAnchor)).toBe(2);
    await expect(
      migrateRecordedAnchor({
        backend,
        graphId: GRAPH_ID,
        anchor: "2026-01-01 00:00:00.001",
      }),
    ).resolves.toBe(migratedAnchor);
    await expect(
      migrateRecordedAnchor({
        backend,
        graphId: GRAPH_ID,
        anchor: migratedAnchor,
      }),
    ).resolves.toBe(migratedAnchor);

    await expect(migrateLegacyRecordedTime({ backend })).resolves.toMatchObject(
      { migrated: false, anchors: 3 },
    );

    await deleteLegacyRecordedAnchorMap({ backend, graphId: GRAPH_ID });
    await expect(
      migrateRecordedAnchor({ backend, graphId: GRAPH_ID, anchor: SECOND }),
    ).rejects.toThrow("No migrated recorded anchor");

    await deleteLegacyRecordedAnchorMap({
      backend,
      graphId: GRAPH_ID,
      dropWhenEmpty: true,
    });
    const mappingTables = await backend.execute<TableNameRow>(
      asCompiledRowsSql(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = ${"table"} AND name = ${result.mappingTableName}
      `),
    );
    expect(mappingTables).toEqual([]);
  });

  it("rewrites existing empty legacy tables to the current schema", async () => {
    const backend = createTestBackend();
    await createLegacyRecordedSchema(backend, { withRows: false });

    await expect(migrateLegacyRecordedTime({ backend })).resolves.toMatchObject(
      {
        migrated: true,
        anchors: 0,
        graphs: 0,
      },
    );

    const schema = createSqlSchema(backend.tableNames);
    const nodeColumns = await backend.execute<ColumnTypeRow>(
      asCompiledRowsSql(sql`PRAGMA table_info(${schema.recordedNodesTable})`),
    );
    const clockColumns = await backend.execute<ColumnTypeRow>(
      asCompiledRowsSql(sql`PRAGMA table_info(${schema.recordedClockTable})`),
    );
    expect(
      nodeColumns.find((column) => column.name === "recorded_from")?.type,
    ).toBe("INTEGER");
    expect(
      clockColumns.find((column) => column.name === "revision")?.type,
    ).toBe("INTEGER");
  });

  it("rejects a history-enabled async open until legacy tables migrate", async () => {
    const backend = createTestBackend();
    await createLegacyRecordedSchema(backend, { withRows: false });

    const error = await captureConfigurationError(
      createStoreWithSchema(legacyGraph, backend, { history: true }),
    );
    expect(error.details["code"]).toBe("RECORDED_SCHEMA_INCOMPATIBLE");
    expect(error.suggestion).toContain("migrateLegacyRecordedTime");

    await migrateLegacyRecordedTime({ backend });
    await expect(
      createStoreWithSchema(legacyGraph, backend, { history: true }),
    ).resolves.toBeDefined();
  });

  it("distinguishes missing recorded identity enablement from malformed columns", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(identityGraph, backend, { history: true });
    const schema = createSqlSchema(backend.tableNames);
    if (backend.executeStatement === undefined) {
      throw new Error("SQLite test backend must execute statements");
    }
    await backend.executeStatement(
      asCompiledStatementSql(
        sql`DROP TABLE ${schema.recordedIdentityAssertionsTable}`,
      ),
    );

    const error = await captureConfigurationError(
      assertCurrentRecordedSchema(backend, schema, true),
    );
    expect(error.details["code"]).toBe("RECORDED_IDENTITY_SCHEMA_MISSING");
    expect(error.suggestion).toContain(
      "Restore the missing recorded identity ledger from backup",
    );
    expect(error.suggestion).toContain("first-time identity enablement");
  });

  it("is a clean no-op on a fresh database", async () => {
    const backend = createTestBackend();

    await expect(migrateLegacyRecordedTime({ backend })).resolves.toMatchObject(
      {
        migrated: false,
        anchors: 0,
        graphs: 0,
      },
    );
  });

  it("refuses on a legacy schema when the backend cannot author recorded DDL", async () => {
    const base = createTestBackend();
    await createLegacyRecordedSchema(base);
    const memberless = projectBackendWithout(base, ["recordedTableDdl"]);
    const count = { value: 0 };
    const wrapped = withStatementCounter(memberless, count);

    const error = await captureUnsupportedCapabilityError(
      migrateLegacyRecordedTime({ backend: wrapped }),
    );
    expect(error.details["capability"]).toBe("recordedTableDdl");
    expect(error.message).toContain("recordedTableDdl");
    expect(count.value).toBe(0);

    // Positive control: the SAME wrapper shape over the UNMODIFIED backend
    // migrates and leaves count > 0 — what makes the 0 above load-bearing.
    const controlBase = createTestBackend();
    await createLegacyRecordedSchema(controlBase);
    const controlCount = { value: 0 };
    const controlWrapped = withStatementCounter(controlBase, controlCount);

    await expect(
      migrateLegacyRecordedTime({ backend: controlWrapped }),
    ).resolves.toMatchObject({ migrated: true });
    expect(controlCount.value).toBeGreaterThan(0);
  });

  it.each([
    ["temporary name only", true, false],
    ["final name only", false, true],
  ] as const)(
    "refuses mismatched primary-key metadata when the port returns the %s",
    async (_caseName, nameTemporaryConstraint, nameFinalConstraint) => {
      const base = createTestBackend();
      await createLegacyRecordedSchema(base);
      const backend = deriveBackend(base, {
        recordedTableDdl: (tableNames) => {
          const ddl = requireDefined(base.recordedTableDdl)(tableNames);
          const isTemporary = tableNames.recordedNodes.startsWith("__tg_");
          const shouldNameConstraint =
            isTemporary ? nameTemporaryConstraint : nameFinalConstraint;
          return {
            ...ddl,
            recordedNodes: {
              ...ddl.recordedNodes,
              primaryKeyConstraintName:
                shouldNameConstraint ?
                  `${tableNames.recordedNodes}_pkey`
                : undefined,
            },
          };
        },
      });

      const error = await captureConfigurationError(
        migrateLegacyRecordedTime({ backend }),
      );
      expect(error.details["code"]).toBe(
        "RECORDED_DDL_CONSTRAINT_NAME_MISMATCH",
      );
      expect(error.details["finalTable"]).toBe(
        createSqlSchema(base.tableNames).tables.recordedNodes,
      );

      const schema = createSqlSchema(base.tableNames);
      const nodeColumns = await base.execute<ColumnTypeRow>(
        asCompiledRowsSql(sql`PRAGMA table_info(${schema.recordedNodesTable})`),
      );
      expect(
        nodeColumns.find((column) => column.name === "recorded_from")?.type,
      ).toBe("TEXT");
    },
  );

  it("still reports no migration for a non-legacy schema without the port", async () => {
    const base = createTestBackend();
    const memberless = projectBackendWithout(base, ["recordedTableDdl"]);

    await expect(
      migrateLegacyRecordedTime({ backend: memberless }),
    ).resolves.toMatchObject({ migrated: false, anchors: 0, graphs: 0 });
  });
});

describe("recordedTableDdl", () => {
  it("returns keyed, role-split DDL for both bundled backends", async () => {
    const LOGICAL_KEYS = [
      "recordedClock",
      "recordedEdges",
      "recordedNodes",
    ] as const;

    const sqliteNames: RecordedTableNames = {
      recordedNodes: "tg_rtd_recorded_nodes",
      recordedEdges: "tg_rtd_recorded_edges",
      recordedClock: "tg_rtd_recorded_clock",
    };
    const sqliteBackend = createTestBackend();
    const sqliteDdl = requireDefined(sqliteBackend.recordedTableDdl)(
      sqliteNames,
    );
    expect(Object.keys(sqliteDdl).toSorted()).toEqual(LOGICAL_KEYS.toSorted());
    for (const key of LOGICAL_KEYS) {
      expect(sqliteDdl[key].createTable).toMatch(/^CREATE TABLE /);
      for (const statement of sqliteDdl[key].indexes) {
        expect(statement).not.toContain("CREATE TABLE");
      }
      expect(sqliteDdl[key].primaryKeyConstraintName).toBeUndefined();
    }

    const pool = new Pool({
      connectionString: "postgres://user@127.0.0.1:1/typegraph_recorded_ddl",
    });
    try {
      const postgresBackend = createPostgresBackend(drizzlePostgres(pool), {
        vector: false,
      });
      const postgresNamesA: RecordedTableNames = {
        recordedNodes: "tg_rtd_a_recorded_nodes",
        recordedEdges: "tg_rtd_a_recorded_edges",
        recordedClock: "tg_rtd_a_recorded_clock",
      };
      const postgresDdlA = requireDefined(postgresBackend.recordedTableDdl)(
        postgresNamesA,
      );
      expect(Object.keys(postgresDdlA).toSorted()).toEqual(
        LOGICAL_KEYS.toSorted(),
      );
      for (const key of LOGICAL_KEYS) {
        expect(postgresDdlA[key].createTable).toMatch(/^CREATE TABLE /);
        for (const statement of postgresDdlA[key].indexes) {
          expect(statement).not.toContain("CREATE TABLE");
        }
        expect(postgresDdlA[key].primaryKeyConstraintName).toBeDefined();
      }

      const postgresNamesB: RecordedTableNames = {
        recordedNodes: "tg_rtd_b_recorded_nodes",
        recordedEdges: "tg_rtd_b_recorded_edges",
        recordedClock: "tg_rtd_b_recorded_clock",
      };
      const postgresDdlB = requireDefined(postgresBackend.recordedTableDdl)(
        postgresNamesB,
      );
      for (const key of LOGICAL_KEYS) {
        expect(postgresDdlB[key].primaryKeyConstraintName).not.toBe(
          postgresDdlA[key].primaryKeyConstraintName,
        );
      }
    } finally {
      await pool.end();
    }
  });
});
