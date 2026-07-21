/**
 * One-time offline migration from timestamp-only recorded relations to numeric
 * revisions. The durable remap table lets applications translate checkpoints
 * stored outside TypeGraph before deleting the migration metadata.
 */
import {
  asRecordedInstant,
  createRecordedInstant,
  RECORDED_MAX_REVISION,
  type RecordedInstant,
} from "../core/temporal";
import { ConfigurationError, ValidationError } from "../errors";
import {
  createSqlSchema,
  type ResolvedSqlTableNames,
  type SqlTableNames,
} from "../query/compiler/schema";
import { shortHash } from "../query/dialect/vector-strategy";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql, asCompiledStatementSql } from "../query/sql-intent";
import { canonicalizeDatabaseTimestamp } from "../utils/date";
import { postgresContributions, sqliteContributions } from "./drizzle/ddl";
import { createPostgresTables } from "./drizzle/schema/postgres";
import { createSqliteTables } from "./drizzle/schema/sqlite";
import { type GraphBackend, type TransactionBackend } from "./types";

const LEGACY_RECORDED_MAX = "9999-12-31T23:59:59.999Z";
const MIGRATION_SUFFIX = "legacy_recorded_anchors";

const RECORDED_NODE_COLUMNS = [
  "history_id",
  "graph_id",
  "kind",
  "id",
  "props",
  "version",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
  "recorded_from",
  "recorded_to",
  "op",
  "schema_version",
  "tx_id",
  "meta",
] as const;

const RECORDED_EDGE_COLUMNS = [
  "history_id",
  "graph_id",
  "id",
  "kind",
  "from_kind",
  "from_id",
  "to_kind",
  "to_id",
  "props",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
  "recorded_from",
  "recorded_to",
  "op",
  "schema_version",
  "tx_id",
  "meta",
] as const;

type LegacyInstantRow = Readonly<{
  graph_id: unknown;
  recorded_at: unknown;
}>;

type MappingRow = Readonly<{
  graphId: string;
  legacyRecordedAt: string;
  recordedAt: string;
  revision: number;
}>;

type RemapRow = Readonly<{ recorded_at: unknown; revision: unknown }>;
type MappingCountRow = Readonly<{ anchors: unknown; graphs: unknown }>;
type MissingMappingRow = Readonly<{ missing: unknown }>;
type ColumnRow = Readonly<{ name: unknown }>;

export type MigrateLegacyRecordedTimeOptions = Readonly<{
  backend: GraphBackend;
  /** Override the backend's recorded table names. */
  tableNames?: Partial<SqlTableNames> | undefined;
  /** Override the durable legacy-anchor mapping table name. */
  mappingTableName?: string | undefined;
}>;

export type MigrateLegacyRecordedTimeResult = Readonly<{
  /** `true` when timestamp columns were rewritten during this call. */
  migrated: boolean;
  /** Number of graphs represented in the legacy commit order. */
  graphs: number;
  /** Number of distinct legacy anchors available for remapping. */
  anchors: number;
  /** Physical table retaining the old-anchor → revision mapping. */
  mappingTableName: string;
}>;

export type MigrateRecordedAnchorOptions = Readonly<{
  backend: Pick<GraphBackend, "dialect" | "execute" | "tableNames">;
  graphId: string;
  anchor: string;
  tableNames?: Partial<SqlTableNames> | undefined;
  mappingTableName?: string | undefined;
}>;

export type DeleteLegacyRecordedAnchorMapOptions = Readonly<{
  backend: Pick<
    GraphBackend,
    "dialect" | "execute" | "executeStatement" | "tableNames" | "transaction"
  >;
  graphId: string;
  tableNames?: Partial<SqlTableNames> | undefined;
  mappingTableName?: string | undefined;
  /** Drop the mapping table when this deletion leaves it empty. */
  dropWhenEmpty?: boolean | undefined;
}>;

function resolvedTableNames(
  backend: Pick<GraphBackend, "tableNames">,
  override: Partial<SqlTableNames> | undefined,
): ResolvedSqlTableNames {
  return createSqlSchema(override ?? backend.tableNames ?? {}).tables;
}

function shortenedIdentifier(value: string): string {
  if (value.length <= 63) return value;
  return `${value.slice(0, 50)}_${shortHash(value)}`;
}

function mappingTableName(
  tables: ResolvedSqlTableNames,
  override: string | undefined,
): string {
  const candidate = override ?? `${tables.recordedClock}_${MIGRATION_SUFFIX}`;
  return createSqlSchema({
    recordedClock: shortenedIdentifier(candidate),
  }).tables.recordedClock;
}

function temporaryTableName(tableName: string, role: string): string {
  return shortenedIdentifier(`__tg_${role}_${shortHash(tableName)}`);
}

function requireStatements(
  target: Pick<TransactionBackend, "dialect" | "executeStatement">,
): NonNullable<TransactionBackend["executeStatement"]> {
  if (target.executeStatement === undefined) {
    throw new ConfigurationError(
      "Recorded-time migration requires executeStatement support.",
      { dialect: target.dialect },
      { suggestion: "Use a built-in SQLite or PostgreSQL backend." },
    );
  }
  return target.executeStatement;
}

async function executeStatement(
  target: Pick<TransactionBackend, "dialect" | "executeStatement">,
  statement: SqlFragment,
): Promise<void> {
  await requireStatements(target)(asCompiledStatementSql(statement));
}

async function executeDdl(
  target: Pick<TransactionBackend, "dialect" | "executeStatement">,
  ddl: string,
): Promise<void> {
  await executeStatement(target, sql.raw(ddl));
}

function canonicalLegacyInstant(value: unknown): string {
  const canonical = canonicalizeDatabaseTimestamp(value);
  if (canonical === undefined) {
    throw new ConfigurationError(
      "Legacy recorded-time relation contained an invalid timestamp.",
      { value },
    );
  }
  return canonical;
}

function safeRevision(value: unknown): number {
  const revision =
    typeof value === "bigint" ? Number(value)
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value)
    : value;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision >= RECORDED_MAX_REVISION
  ) {
    throw new ConfigurationError(
      "Recorded anchor mapping contained an invalid revision.",
      { value },
    );
  }
  return revision;
}

async function columnNames(
  target: TransactionBackend,
  tableName: string,
): Promise<ReadonlySet<string>> {
  const rows =
    target.dialect === "sqlite" ?
      await target.execute<ColumnRow>(
        asCompiledRowsSql(sql`PRAGMA table_info(${sql.identifier(tableName)})`),
      )
    : await target.execute<ColumnRow>(
        asCompiledRowsSql(sql`
          SELECT column_name AS name
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = ${tableName}
        `),
      );
  return new Set(
    rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

async function readLegacyInstants(
  target: TransactionBackend,
  tables: ResolvedSqlTableNames,
): Promise<readonly MappingRow[]> {
  const rows = await target.execute<LegacyInstantRow>(
    asCompiledRowsSql(sql`
      SELECT graph_id, recorded_from AS recorded_at
      FROM ${sql.identifier(tables.recordedNodes)}
      UNION
      SELECT graph_id, recorded_to AS recorded_at
      FROM ${sql.identifier(tables.recordedNodes)}
      WHERE recorded_to <> ${LEGACY_RECORDED_MAX}
      UNION
      SELECT graph_id, recorded_from AS recorded_at
      FROM ${sql.identifier(tables.recordedEdges)}
      UNION
      SELECT graph_id, recorded_to AS recorded_at
      FROM ${sql.identifier(tables.recordedEdges)}
      WHERE recorded_to <> ${LEGACY_RECORDED_MAX}
      UNION
      SELECT graph_id, recorded_at
      FROM ${sql.identifier(tables.recordedClock)}
    `),
  );
  const instants = rows.map((row) => {
    if (typeof row.graph_id !== "string") {
      throw new ConfigurationError(
        "Legacy recorded-time relation contained an invalid graph id.",
        { graphId: row.graph_id },
      );
    }
    return {
      graphId: row.graph_id,
      recordedAt: canonicalLegacyInstant(row.recorded_at),
    };
  });
  instants.sort((left, right) => {
    if (left.graphId < right.graphId) return -1;
    if (left.graphId > right.graphId) return 1;
    if (left.recordedAt < right.recordedAt) return -1;
    if (left.recordedAt > right.recordedAt) return 1;
    return 0;
  });

  const mapping: MappingRow[] = [];
  let graphId: string | undefined;
  let revision = 0;
  let previousInstant: string | undefined;
  for (const instant of instants) {
    if (instant.graphId !== graphId) {
      graphId = instant.graphId;
      revision = 0;
      previousInstant = undefined;
    }
    if (instant.recordedAt === previousInstant) continue;
    revision += 1;
    mapping.push({
      graphId: instant.graphId,
      legacyRecordedAt: instant.recordedAt,
      recordedAt: instant.recordedAt,
      revision,
    });
    previousInstant = instant.recordedAt;
  }
  return mapping;
}

function migrationMapDdl(
  dialect: GraphBackend["dialect"],
  table: string,
): string {
  const revisionType = dialect === "postgres" ? "BIGINT" : "INTEGER";
  const recordedAtType = dialect === "postgres" ? "TIMESTAMPTZ" : "TEXT";
  return `CREATE TABLE IF NOT EXISTS "${table}" (
  graph_id TEXT NOT NULL,
  legacy_recorded_at TEXT NOT NULL,
  revision ${revisionType} NOT NULL,
  recorded_at ${recordedAtType} NOT NULL,
  PRIMARY KEY (graph_id, legacy_recorded_at)
);`;
}

async function writeMappingRows(
  target: TransactionBackend,
  tableName: string,
  rows: readonly MappingRow[],
): Promise<void> {
  await executeStatement(target, sql`DELETE FROM ${sql.identifier(tableName)}`);
  const rowsPerStatement = Math.max(
    1,
    Math.floor((target.capabilities.maxBindParameters ?? 900) / 4),
  );
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const values = rows
      .slice(start, start + rowsPerStatement)
      .map(
        (row) =>
          sql`(${row.graphId}, ${row.legacyRecordedAt}, ${row.revision}, ${row.recordedAt})`,
      );
    await executeStatement(
      target,
      sql`
        INSERT INTO ${sql.identifier(tableName)}
          (graph_id, legacy_recorded_at, revision, recorded_at)
        VALUES ${sql.join(values, sql`, `)}
      `,
    );
  }
}

function tableDdl(
  dialect: GraphBackend["dialect"],
  tables: ResolvedSqlTableNames,
  temporary: Readonly<{
    recordedClock: string;
    recordedEdges: string;
    recordedNodes: string;
  }>,
): Readonly<{
  clock: readonly string[];
  edges: readonly string[];
  nodes: readonly string[];
}> {
  if (dialect === "sqlite") {
    const temporaryTables = createSqliteTables(temporary);
    const finalTables = createSqliteTables(tables);
    const temporaryContributions = sqliteContributions(temporaryTables);
    const finalContributions = sqliteContributions(finalTables);
    return ddlForRecordedTables(temporaryContributions, finalContributions);
  }
  const temporaryTables = createPostgresTables(temporary);
  const finalTables = createPostgresTables(tables);
  return ddlForRecordedTables(
    postgresContributions(temporaryTables),
    postgresContributions(finalTables),
  );
}

function ddlForRecordedTables(
  temporary: readonly Readonly<{
    createDdl: readonly string[];
    logicalName: string;
  }>[],
  final: readonly Readonly<{
    createDdl: readonly string[];
    logicalName: string;
  }>[],
): Readonly<{
  clock: readonly string[];
  edges: readonly string[];
  nodes: readonly string[];
}> {
  function statements(
    logicalName: "recordedClock" | "recordedEdges" | "recordedNodes",
  ): readonly string[] {
    const temporaryDdl = temporary.find(
      (entry) => entry.logicalName === logicalName,
    )?.createDdl;
    const finalDdl = final.find(
      (entry) => entry.logicalName === logicalName,
    )?.createDdl;
    if (temporaryDdl === undefined || finalDdl === undefined) {
      throw new ConfigurationError(
        `Could not generate migration DDL for ${logicalName}.`,
      );
    }
    const createTable = temporaryDdl[0];
    if (createTable === undefined) {
      throw new ConfigurationError(
        `Could not generate migration table DDL for ${logicalName}.`,
      );
    }
    return [createTable, ...finalDdl.slice(1)];
  }
  return {
    clock: statements("recordedClock"),
    edges: statements("recordedEdges"),
    nodes: statements("recordedNodes"),
  };
}

function migratedColumn(column: string, legacyAlias: string): SqlFragment {
  if (column === "recorded_from") return sql`from_map.revision`;
  if (column === "recorded_to") {
    return sql`
      CASE
            WHEN ${sql.raw(legacyAlias)}.recorded_to = ${LEGACY_RECORDED_MAX}
            THEN ${RECORDED_MAX_REVISION}
            ELSE to_map.revision
          END
    `;
  }
  return sql`${sql.raw(legacyAlias)}.${sql.identifier(column)}`;
}

function mappingMatch(
  dialect: GraphBackend["dialect"],
  mappingAlias: "anchor_map" | "from_map" | "to_map",
  legacyColumn: "recorded_at" | "recorded_from" | "recorded_to",
): SqlFragment {
  const mapping = sql.raw(mappingAlias);
  const legacy = sql.raw(`legacy.${legacyColumn}`);
  return dialect === "postgres" ?
      sql`${mapping}.recorded_at = ${legacy}`
    : sql`${mapping}.legacy_recorded_at = ${legacy}`;
}

function missingMappingCount(value: unknown, legacyTable: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ConfigurationError(
      "Recorded-time migration returned an invalid integrity-check count.",
      { legacyTable, value },
    );
  }
  return count;
}

async function assertRecordedRelationMappings(
  target: TransactionBackend,
  options: Readonly<{ legacyTable: string; mappingTable: string }>,
): Promise<void> {
  const fromMatch = mappingMatch(target.dialect, "from_map", "recorded_from");
  const toMatch = mappingMatch(target.dialect, "to_map", "recorded_to");
  const rows = await target.execute<MissingMappingRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS missing
      FROM ${sql.identifier(options.legacyTable)} AS legacy
      LEFT JOIN ${sql.identifier(options.mappingTable)} AS from_map
        ON from_map.graph_id = legacy.graph_id AND ${fromMatch}
      LEFT JOIN ${sql.identifier(options.mappingTable)} AS to_map
        ON to_map.graph_id = legacy.graph_id AND ${toMatch}
      WHERE from_map.revision IS NULL
         OR (
           legacy.recorded_to <> ${LEGACY_RECORDED_MAX}
           AND to_map.revision IS NULL
         )
    `),
  );
  const missing = missingMappingCount(rows[0]?.missing, options.legacyTable);
  if (missing === 0) return;
  throw new ConfigurationError(
    "Legacy recorded-time boundaries could not be mapped exactly.",
    { legacyTable: options.legacyTable, missingRows: missing },
    {
      suggestion:
        "Ensure every legacy boundary is a valid millisecond-precision timestamp produced by the preview recorded clock before retrying the offline migration.",
    },
  );
}

async function assertRecordedClockMappings(
  target: TransactionBackend,
  options: Readonly<{ legacyTable: string; mappingTable: string }>,
): Promise<void> {
  const match = mappingMatch(target.dialect, "anchor_map", "recorded_at");
  const rows = await target.execute<MissingMappingRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS missing
      FROM ${sql.identifier(options.legacyTable)} AS legacy
      LEFT JOIN ${sql.identifier(options.mappingTable)} AS anchor_map
        ON anchor_map.graph_id = legacy.graph_id AND ${match}
      WHERE anchor_map.revision IS NULL
    `),
  );
  const missing = missingMappingCount(rows[0]?.missing, options.legacyTable);
  if (missing === 0) return;
  throw new ConfigurationError(
    "Legacy recorded clock values could not be mapped exactly.",
    { legacyTable: options.legacyTable, missingRows: missing },
    {
      suggestion:
        "Ensure every legacy clock value is a valid millisecond-precision timestamp produced by the preview recorded clock before retrying the offline migration.",
    },
  );
}

async function copyRecordedRelation(
  target: TransactionBackend,
  options: Readonly<{
    columns: readonly string[];
    legacyTable: string;
    mappingTable: string;
    temporaryTable: string;
  }>,
): Promise<void> {
  const columnList = options.columns.map((column) => sql.identifier(column));
  const values = options.columns.map((column) =>
    migratedColumn(column, "legacy"),
  );
  await assertRecordedRelationMappings(target, options);
  const fromMatch = mappingMatch(target.dialect, "from_map", "recorded_from");
  const toMatch = mappingMatch(target.dialect, "to_map", "recorded_to");
  await executeStatement(
    target,
    sql`
      INSERT INTO ${sql.identifier(options.temporaryTable)}
        (${sql.join(columnList, sql`, `)})
      SELECT ${sql.join(values, sql`, `)}
      FROM ${sql.identifier(options.legacyTable)} AS legacy
      -- LEFT JOIN is deliberate: a missing mapping reaches the NOT NULL
      -- revision columns and fails loud instead of silently dropping history.
      LEFT JOIN ${sql.identifier(options.mappingTable)} AS from_map
        ON from_map.graph_id = legacy.graph_id AND ${fromMatch}
      LEFT JOIN ${sql.identifier(options.mappingTable)} AS to_map
        ON to_map.graph_id = legacy.graph_id AND ${toMatch}
    `,
  );
}

async function copyRecordedClock(
  target: TransactionBackend,
  options: Readonly<{
    legacyTable: string;
    mappingTable: string;
    temporaryTable: string;
  }>,
): Promise<void> {
  await assertRecordedClockMappings(target, options);
  const match = mappingMatch(target.dialect, "anchor_map", "recorded_at");
  await executeStatement(
    target,
    sql`
      INSERT INTO ${sql.identifier(options.temporaryTable)}
        (graph_id, revision, recorded_at)
      SELECT legacy.graph_id, anchor_map.revision, legacy.recorded_at
      FROM ${sql.identifier(options.legacyTable)} AS legacy
      -- Preserve fail-loud behavior if the preflight invariant changes later.
      LEFT JOIN ${sql.identifier(options.mappingTable)} AS anchor_map
        ON anchor_map.graph_id = legacy.graph_id AND ${match}
    `,
  );
}

async function replaceLegacyTables(
  target: TransactionBackend,
  tables: ResolvedSqlTableNames,
  mappingTable: string,
): Promise<void> {
  const temporary = {
    recordedNodes: temporaryTableName(tables.recordedNodes, "rn"),
    recordedEdges: temporaryTableName(tables.recordedEdges, "re"),
    recordedClock: temporaryTableName(tables.recordedClock, "rc"),
  };
  const ddl = tableDdl(target.dialect, tables, temporary);
  for (const table of Object.values(temporary)) {
    await executeStatement(
      target,
      sql`DROP TABLE IF EXISTS ${sql.identifier(table)}`,
    );
  }
  await executeDdl(target, requireCreateTable(ddl.nodes));
  await executeDdl(target, requireCreateTable(ddl.edges));
  await executeDdl(target, requireCreateTable(ddl.clock));
  await copyRecordedRelation(target, {
    columns: RECORDED_NODE_COLUMNS,
    legacyTable: tables.recordedNodes,
    mappingTable,
    temporaryTable: temporary.recordedNodes,
  });
  await copyRecordedRelation(target, {
    columns: RECORDED_EDGE_COLUMNS,
    legacyTable: tables.recordedEdges,
    mappingTable,
    temporaryTable: temporary.recordedEdges,
  });
  await copyRecordedClock(target, {
    legacyTable: tables.recordedClock,
    mappingTable,
    temporaryTable: temporary.recordedClock,
  });

  await executeStatement(
    target,
    sql`DROP TABLE ${sql.identifier(tables.recordedNodes)}`,
  );
  await executeStatement(
    target,
    sql`DROP TABLE ${sql.identifier(tables.recordedEdges)}`,
  );
  await executeStatement(
    target,
    sql`DROP TABLE ${sql.identifier(tables.recordedClock)}`,
  );
  await renameTable(target, temporary.recordedNodes, tables.recordedNodes);
  await renameTable(target, temporary.recordedEdges, tables.recordedEdges);
  await renameTable(target, temporary.recordedClock, tables.recordedClock);
  for (const statement of [
    ...ddl.nodes.slice(1),
    ...ddl.edges.slice(1),
    ...ddl.clock.slice(1),
  ]) {
    await executeDdl(target, statement);
  }
}

function requireCreateTable(statements: readonly string[]): string {
  const statement = statements[0];
  if (statement === undefined) {
    throw new ConfigurationError("Recorded migration table DDL was empty.");
  }
  return statement;
}

async function renameTable(
  target: TransactionBackend,
  from: string,
  to: string,
): Promise<void> {
  try {
    await executeStatement(
      target,
      sql`ALTER TABLE ${sql.identifier(from)} RENAME TO ${sql.identifier(to)}`,
    );
  } catch (error) {
    throw new ConfigurationError(
      "Could not rename a migrated recorded-time table.",
      { from, to },
      { cause: error },
    );
  }
}

/**
 * Rewrites timestamp-only recorded relations to numeric revisions.
 *
 * Run offline before opening a Store with the new schema. The durable mapping
 * table is retained so external checkpoint stores can call
 * {@link migrateRecordedAnchor}; delete each graph's rows after its downstream
 * checkpoints have been rewritten.
 */
export async function migrateLegacyRecordedTime(
  options: MigrateLegacyRecordedTimeOptions,
): Promise<MigrateLegacyRecordedTimeResult> {
  const tables = resolvedTableNames(options.backend, options.tableNames);
  const mapTable = mappingTableName(tables, options.mappingTableName);
  return options.backend.transaction(async (target) => {
    const clockColumns = await columnNames(target, tables.recordedClock);
    if (clockColumns.size === 0) {
      return {
        migrated: false,
        graphs: 0,
        anchors: 0,
        mappingTableName: mapTable,
      };
    }
    if (clockColumns.has("revision")) {
      const mapColumns = await columnNames(target, mapTable);
      if (mapColumns.size === 0) {
        return {
          migrated: false,
          graphs: 0,
          anchors: 0,
          mappingTableName: mapTable,
        };
      }
      const rows = await target.execute<MappingCountRow>(
        asCompiledRowsSql(sql`
          SELECT COUNT(*) AS anchors, COUNT(DISTINCT graph_id) AS graphs
          FROM ${sql.identifier(mapTable)}
        `),
      );
      const anchors = Number(rows[0]?.anchors ?? 0);
      const graphs = Number(rows[0]?.graphs ?? 0);
      return {
        migrated: false,
        graphs: Number.isSafeInteger(graphs) ? graphs : 0,
        anchors: Number.isSafeInteger(anchors) ? anchors : 0,
        mappingTableName: mapTable,
      };
    }
    const nodeColumns = await columnNames(target, tables.recordedNodes);
    const edgeColumns = await columnNames(target, tables.recordedEdges);
    if (
      !nodeColumns.has("recorded_from") ||
      !edgeColumns.has("recorded_from")
    ) {
      throw new ConfigurationError(
        "Legacy recorded-time schema is incomplete.",
        { tables },
      );
    }

    await executeDdl(target, migrationMapDdl(target.dialect, mapTable));
    const mapping = await readLegacyInstants(target, tables);
    await writeMappingRows(target, mapTable, mapping);
    await replaceLegacyTables(target, tables, mapTable);
    return {
      migrated: true,
      graphs: new Set(mapping.map((row) => row.graphId)).size,
      anchors: mapping.length,
      mappingTableName: mapTable,
    };
  });
}

/** Remaps one timestamp-only checkpoint after {@link migrateLegacyRecordedTime}. */
export async function migrateRecordedAnchor(
  options: MigrateRecordedAnchorOptions,
): Promise<RecordedInstant> {
  try {
    return asRecordedInstant(options.anchor);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  const legacyRecordedAt = canonicalLegacyInstant(options.anchor);
  const tables = resolvedTableNames(options.backend, options.tableNames);
  const mapTable = mappingTableName(tables, options.mappingTableName);
  const rows = await options.backend.execute<RemapRow>(
    asCompiledRowsSql(sql`
      SELECT revision, recorded_at
      FROM ${sql.identifier(mapTable)}
      WHERE graph_id = ${options.graphId}
        AND legacy_recorded_at = ${legacyRecordedAt}
    `),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new ConfigurationError(
      "No migrated recorded anchor matches this graph and legacy timestamp.",
      { anchor: options.anchor, graphId: options.graphId },
      {
        suggestion:
          "Run migrateLegacyRecordedTime() before deleting its mapping rows, and pass the graph that produced the checkpoint.",
      },
    );
  }
  return createRecordedInstant(
    safeRevision(row.revision),
    canonicalLegacyInstant(row.recorded_at),
  );
}

/**
 * Deletes one graph's legacy remap rows after downstream checkpoints migrate.
 * Set `dropWhenEmpty` to remove the migration table after the final graph.
 */
export async function deleteLegacyRecordedAnchorMap(
  options: DeleteLegacyRecordedAnchorMapOptions,
): Promise<void> {
  if (options.backend.executeStatement === undefined) {
    throw new ConfigurationError(
      "Deleting a recorded anchor migration map requires executeStatement support.",
      { dialect: options.backend.dialect },
    );
  }
  const tables = resolvedTableNames(options.backend, options.tableNames);
  const mapTable = mappingTableName(tables, options.mappingTableName);
  await options.backend.transaction(async (target) => {
    await executeStatement(
      target,
      sql`
        DELETE FROM ${sql.identifier(mapTable)}
        WHERE graph_id = ${options.graphId}
      `,
    );
    if (options.dropWhenEmpty !== true) return;
    const rows = await target.execute<MappingCountRow>(
      asCompiledRowsSql(sql`
        SELECT COUNT(*) AS anchors, COUNT(DISTINCT graph_id) AS graphs
        FROM ${sql.identifier(mapTable)}
      `),
    );
    const remaining = missingMappingCount(rows[0]?.anchors, mapTable);
    if (remaining === 0) {
      await executeStatement(
        target,
        sql`DROP TABLE ${sql.identifier(mapTable)}`,
      );
    }
  });
}
