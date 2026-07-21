/** End-to-end migration coverage for the timestamp-only preview schema. */
import { describe, expect, it } from "vitest";

import {
  deleteLegacyRecordedAnchorMap,
  migrateLegacyRecordedTime,
  migrateRecordedAnchor,
  recordedInstantRevision,
} from "../src";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../src/query/sql-intent";
import { createTestBackend, recordedRevisionFromDriver } from "./test-utils";

const FIRST = "2026-01-01T00:00:00.000Z";
const SECOND = "2026-01-01T00:00:00.001Z";
const THIRD = "2026-01-01T00:00:00.002Z";
const LEGACY_MAX = "9999-12-31T23:59:59.999Z";
const GRAPH_ID = "legacy-recorded-graph";

type RevisionRow = Readonly<{
  recorded_from: unknown;
  recorded_to: unknown;
}>;
type ClockRow = Readonly<{ recorded_at: unknown; revision: unknown }>;
type TableNameRow = Readonly<{ name: unknown }>;

async function createLegacyRecordedSchema(
  backend: ReturnType<typeof createTestBackend>,
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
});
