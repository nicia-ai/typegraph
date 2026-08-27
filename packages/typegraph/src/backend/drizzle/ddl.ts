/**
 * DDL generation utilities for TypeGraph backends.
 *
 * Provides utilities for generating DDL statements from Drizzle
 * table definitions. This ensures migrations match production schema.
 */
import { is } from "drizzle-orm";
import {
  getTableConfig as getPgTableConfig,
  type PgColumn,
  PgTable,
  type PgTableWithColumns,
} from "drizzle-orm/pg-core";
import {
  getTableConfig as getSqliteTableConfig,
  type SQLiteColumn,
  SQLiteTable,
  type SQLiteTableWithColumns,
} from "drizzle-orm/sqlite-core";

import { systemIndexName } from "../../indexes/system";
import {
  fts5Strategy,
  type FulltextStrategy,
  tsvectorStrategy,
} from "../../query/dialect/fulltext-strategy";
import {
  BASE_CONTRIBUTION_OWNER,
  type StrategyTableContribution,
  type TableContribution,
} from "../table-contribution";
import { CURRENT_BASE_SCHEMA_VERSION } from "./base-schema";
import {
  type PostgresTables,
  tables as postgresTables,
} from "./schema/postgres";
import { type SqliteTables, tables as sqliteTables } from "./schema/sqlite";

// Narrow interfaces for Drizzle column internals not exposed in public types.
// These are accessed only in DDL generation for migration scripts.
type TimestampColumnConfig = Readonly<{
  config?: Readonly<{ withTimezone?: boolean }>;
}>;
type CustomColumnType = Readonly<{
  getSQLType?: () => string;
}>;

const EDGE_MATCH_IDENTITY_NAME_COLUMN = "match_identity_name";
const EDGE_MATCH_IDENTITY_KEY_COLUMN = "match_identity_key";

export function quoteDdlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

type BaseSchemaVersionMarkerTable = Readonly<{
  installation: Readonly<{ name: string }>;
  updatedAt: Readonly<{ name: string }>;
  version: Readonly<{ name: string }>;
}>;

/** Publishes the lifecycle version owned by a complete fresh installation. */
function generateBaseSchemaVersionMarkerSQL(
  tableName: string,
  columns: BaseSchemaVersionMarkerTable,
): string {
  const table = quoteDdlIdentifier(tableName);
  const installation = quoteDdlIdentifier(columns.installation.name);
  const version = quoteDdlIdentifier(columns.version.name);
  const updatedAt = quoteDdlIdentifier(columns.updatedAt.name);
  // DO NOTHING is deliberate: this generator is a fresh-installation tool,
  // not an upgrade planner. Replaying it must never advance a stale marker
  // without running the numbered adoption steps that marker certifies.
  return `INSERT INTO ${table} (${installation}, ${version}, ${updatedAt})
VALUES (1, ${String(CURRENT_BASE_SCHEMA_VERSION)}, CURRENT_TIMESTAMP)
ON CONFLICT (${installation}) DO NOTHING;`;
}

/** Identifier-preserving text accepted by PostgreSQL's `regclass` input. */
export function postgresIdentifierRegclassName(identifier: string): string {
  return quoteDdlIdentifier(identifier);
}

/** Names shared by schema DDL and the additive bootstrap upgrade. */
export function edgeMatchIdentityUniqueIndexName(tableName: string): string {
  return systemIndexName(tableName, "match_identity_uq");
}

export function edgeMatchIdentityPairCheckName(tableName: string): string {
  return systemIndexName(tableName, "match_identity_pair_check");
}

/** Generates idempotent PostgreSQL DDL for adopting an existing edge table. */
export function generatePostgresEdgeMatchIdentityUpgradeDDL(
  tableName: string,
): readonly string[] {
  const table = quoteDdlIdentifier(tableName);
  const nameColumn = quoteDdlIdentifier(EDGE_MATCH_IDENTITY_NAME_COLUMN);
  const keyColumn = quoteDdlIdentifier(EDGE_MATCH_IDENTITY_KEY_COLUMN);
  const checkName = edgeMatchIdentityPairCheckName(tableName);
  const indexName = edgeMatchIdentityUniqueIndexName(tableName);
  const escapedTableName = postgresIdentifierRegclassName(tableName).replaceAll(
    "'",
    "''",
  );
  return [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${nameColumn} TEXT;`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${keyColumn} TEXT;`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('${escapedTableName}') AND conname = '${checkName.replaceAll("'", "''")}') THEN ALTER TABLE ${table} ADD CONSTRAINT ${quoteDdlIdentifier(checkName)} CHECK ((${nameColumn} IS NULL) = (${keyColumn} IS NULL)); END IF; END $$;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteDdlIdentifier(indexName)} ON ${table} (${quoteDdlIdentifier("graph_id")}, ${quoteDdlIdentifier("kind")}, ${nameColumn}, ${keyColumn});`,
  ];
}

/**
 * SQLite has no `ADD COLUMN IF NOT EXISTS`; the adapter checks PRAGMA
 * table_info before running this statement. The pair check is placed on the
 * second added column so old edge tables receive the invariant without a
 * destructive table rebuild.
 */
function generateSqliteEdgeMatchIdentityColumnDDL(
  tableName: string,
  column: "match_identity_name" | "match_identity_key",
  withPairCheck = false,
): string {
  const pairCheck =
    withPairCheck ?
      ` CHECK ((${quoteDdlIdentifier(EDGE_MATCH_IDENTITY_NAME_COLUMN)} IS NULL) = (${quoteDdlIdentifier(EDGE_MATCH_IDENTITY_KEY_COLUMN)} IS NULL))`
    : "";
  return `ALTER TABLE ${quoteDdlIdentifier(tableName)} ADD COLUMN ${quoteDdlIdentifier(column)} TEXT${pairCheck};`;
}

function generateSqliteEdgeMatchIdentityIndexDDL(
  tableName: string,
): string {
  return `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteDdlIdentifier(edgeMatchIdentityUniqueIndexName(tableName))} ON ${quoteDdlIdentifier(tableName)} (${quoteDdlIdentifier("graph_id")}, ${quoteDdlIdentifier("kind")}, ${quoteDdlIdentifier(EDGE_MATCH_IDENTITY_NAME_COLUMN)}, ${quoteDdlIdentifier(EDGE_MATCH_IDENTITY_KEY_COLUMN)});`;
}

/**
 * Plans the focused SQLite v1 adoption from one authoritative column
 * inventory. Factories and backend lifecycle hooks share this owner so a
 * bootstrap retry cannot drift from privileged adoption.
 */
export function planSqliteEdgeMatchIdentityAdoption(
  tableName: string,
  existingColumns: ReadonlySet<string>,
): readonly string[] {
  // A real SQLite table always has at least one column; an empty PRAGMA result
  // means the edge table does not exist and current generated DDL will create it.
  if (existingColumns.size === 0) return [];
  const nameMissing = !existingColumns.has(EDGE_MATCH_IDENTITY_NAME_COLUMN);
  const keyMissing = !existingColumns.has(EDGE_MATCH_IDENTITY_KEY_COLUMN);
  const columnStatements = [
    nameMissing ?
      generateSqliteEdgeMatchIdentityColumnDDL(
        tableName,
        EDGE_MATCH_IDENTITY_NAME_COLUMN,
        !keyMissing,
      )
    : undefined,
    keyMissing ?
      generateSqliteEdgeMatchIdentityColumnDDL(
        tableName,
        EDGE_MATCH_IDENTITY_KEY_COLUMN,
        true,
      )
    : undefined,
  ].filter((statement): statement is string => statement !== undefined);
  return [
    ...columnStatements,
    generateSqliteEdgeMatchIdentityIndexDDL(tableName),
  ];
}

// ============================================================
// SQLite DDL Generation
// ============================================================

/**
 * Maps Drizzle column types to SQLite types.
 */
function getSqliteColumnType(column: SQLiteColumn): string {
  switch (column.columnType) {
    case "SQLiteText": {
      return "TEXT";
    }
    case "SQLiteInteger": {
      return "INTEGER";
    }
    case "SQLiteReal": {
      return "REAL";
    }
    case "SQLiteBlob": {
      return "BLOB";
    }
    default: {
      return "TEXT";
    }
  }
}

/**
 * Formats a default value for SQLite.
 */
function formatDefaultValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  // For other types, use JSON.stringify to avoid [object Object]
  return JSON.stringify(value);
}

/**
 * Generates CREATE TABLE SQL from a Drizzle SQLite table definition.
 */
export function generateSqliteCreateTableSQL(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: SQLiteTableWithColumns<any>,
): string {
  const config = getSqliteTableConfig(table);
  const columnDefs: string[] = [];

  // Generate column definitions
  for (const column of config.columns) {
    const parts: string[] = [
      `"${column.name}"`,
      getSqliteColumnType(column as SQLiteColumn),
    ];

    if (column.notNull) {
      parts.push("NOT NULL");
    }

    if (column.hasDefault && column.default !== undefined) {
      parts.push(`DEFAULT ${formatDefaultValue(column.default)}`);
    }

    columnDefs.push(parts.join(" "));
  }

  // Add primary key constraint
  const pk = config.primaryKeys[0];
  if (pk) {
    const pkColumns = pk.columns.map((c) => `"${c.name}"`).join(", ");
    columnDefs.push(`PRIMARY KEY (${pkColumns})`);
  }

  columnDefs.push(...renderTableChecks(config.checks, config.name));

  return `CREATE TABLE IF NOT EXISTS "${config.name}" (\n  ${columnDefs.join(",\n  ")}\n);`;
}

/**
 * Renders a Drizzle table's CHECK constraints as CREATE TABLE clauses.
 *
 * A CHECK is a correctness barrier, not a hint: the identity separation
 * relation relies on one to abort a contradictory transaction. Dropping it
 * from the emitted DDL would leave the barrier declared in the Drizzle schema
 * and absent from every runtime-provisioned database, so an unrenderable
 * expression throws rather than degrading to a table without it.
 */
function renderTableChecks(
  checks: readonly Readonly<{ name: string; value: unknown }>[],
  tableName: string,
): readonly string[] {
  return checks.map(
    (check) =>
      `CONSTRAINT "${check.name}" CHECK (${inlineSqlOrThrow(
        check.value,
        `table "${tableName}" CHECK constraint "${check.name}"`,
      )})`,
  );
}

/**
 * Gets the column name from an index column, handling both Column and SQL types.
 */
function renderIndexColumn(col: unknown): string {
  if (col && typeof col === "object" && "name" in col) {
    return `"${(col as { name: string }).name}"`;
  }

  const sql = tryInlineSql(col);
  if (sql !== undefined) {
    return sql;
  }

  return "unknown";
}

function tryInlineSql(value: unknown): string | undefined {
  if (value && typeof value === "object" && "getSQL" in value) {
    const maybe = value as { getSQL?: () => unknown };
    if (typeof maybe.getSQL === "function") {
      return inlineSql(maybe.getSQL());
    }
  }

  return inlineSql(value);
}

function flattenSqlChunk(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (typeof chunk === "object" && chunk !== null) {
    // Drizzle column references (SQLiteText, PgText, etc.) carry the
    // column name directly. Match these BEFORE the `getSQL` fallback —
    // a column's `.getSQL()` wraps the column back inside a SQL object
    // that points to itself, which would recurse infinitely.
    if ("name" in chunk && typeof chunk.name === "string") {
      return `"${(chunk as { name: string }).name}"`;
    }

    // Drizzle's StringChunk stores its literal as `.value`, usually as a
    // one-element array ([""], ["SELECT "]) but sometimes as a plain string.
    if ("value" in chunk) {
      const value = chunk.value;
      if (typeof value === "string") {
        return value;
      }
      if (Array.isArray(value)) {
        return value.map((part) => flattenSqlChunk(part)).join("");
      }
    }

    if ("queryChunks" in chunk && Array.isArray(chunk.queryChunks)) {
      return (chunk as { queryChunks: readonly unknown[] }).queryChunks
        .map((part) => flattenSqlChunk(part))
        .join("");
    }

    if ("getSQL" in chunk) {
      const maybe = chunk as { getSQL?: () => unknown };
      if (typeof maybe.getSQL === "function") {
        return flattenSqlChunk(maybe.getSQL());
      }
    }
  }

  throw new Error(`Unable to inline SQL chunk: ${String(chunk)}`);
}

function inlineSql(value: unknown): string | undefined {
  try {
    return flattenSqlChunk(value);
  } catch {
    return undefined;
  }
}

function inlineSqlOrThrow(value: unknown, context: string): string {
  const inlined = inlineSql(value);
  if (inlined === undefined) {
    throw new Error(`Unable to inline SQL for ${context}`);
  }
  return inlined;
}

/**
 * Generates CREATE INDEX SQL statements from a Drizzle SQLite table definition.
 */
function generateSqliteCreateIndexSQL(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: SQLiteTableWithColumns<any>,
): string[] {
  const config = getSqliteTableConfig(table);
  const statements: string[] = [];

  for (const index of config.indexes) {
    const indexConfig = index.config;
    const columns = indexConfig.columns
      .map((c) => renderIndexColumn(c))
      .join(", ");
    const unique = indexConfig.unique ? "UNIQUE " : "";
    const where =
      indexConfig.where ?
        ` WHERE ${inlineSqlOrThrow(indexConfig.where, `SQLite index "${indexConfig.name}" WHERE clause`)}`
      : "";

    statements.push(
      `CREATE ${unique}INDEX IF NOT EXISTS "${indexConfig.name}" ON "${config.name}" (${columns})${where};`,
    );
  }

  return statements;
}

/**
 * Whether a schema-barrel value is a Drizzle SQLite table. The barrel
 * exposes non-table values (e.g. `fulltextTableName: string`) the DDL
 * generators must skip — and a contribution's barrel key is its
 * materialization identity, so a misclassified non-table would corrupt
 * that identity, not just emit stray DDL.
 */
function isSqliteTable(
  value: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): value is SQLiteTableWithColumns<any> {
  return is(value, SQLiteTable);
}

/**
 * Strategy-declared contributions flagged `runtimeEnsure`. Per the
 * `runtimeEnsure` invariant only strategy contributions can be runtime
 * (base tables never are), so this is the complete runtime set without
 * walking base tables.
 */
export function runtimeStrategyContributions(
  fulltextStrategy: FulltextStrategy,
  fulltextTableName: string,
): readonly StrategyTableContribution[] {
  return fulltextStrategy
    .ownedTables(fulltextTableName)
    .filter((contribution) => contribution.runtimeEnsure);
}

/**
 * The authoritative set of tables the SQLite backend owns: every
 * base/status Drizzle table plus the resolved fulltext-strategy
 * contribution(s). Single source of truth for DDL generation, the
 * bootstrap ensure, and drizzle-kit visibility (#129).
 */
export function sqliteContributions(
  tables: SqliteTables = sqliteTables,
  fulltextStrategy: FulltextStrategy = fts5Strategy,
): readonly TableContribution[] {
  const contributions: TableContribution[] = [];
  for (const [key, table] of Object.entries(tables)) {
    if (!isSqliteTable(table)) continue;
    // Stable factory key (`nodes`, `edges`, …) is the logicalName so
    // the #135 materialization identity survives custom table-name
    // overrides; the resolved SQL name is only the physical tableName.
    contributions.push({
      logicalName: key,
      owner: BASE_CONTRIBUTION_OWNER,
      tableName: getSqliteTableConfig(table).name,
      createDdl: [
        generateSqliteCreateTableSQL(table),
        ...generateSqliteCreateIndexSQL(table),
      ],
      runtimeEnsure: false,
    });
  }
  // Strategy declarations are already authoritative contributions;
  // emitted last (after base tables).
  for (const declared of fulltextStrategy.ownedTables(
    tables.fulltextTableName,
  )) {
    contributions.push(declared);
  }
  return contributions;
}

/**
 * Generates all DDL statements for the given SQLite tables.
 *
 * Iterates the unified contribution set (#129) — base tables first,
 * then strategy-owned tables. Per-contribution ordering is
 * table-then-its-own-indexes; safe because TypeGraph's tables carry no
 * cross-table foreign keys. This low-level array deliberately omits the
 * deployment-wide version marker; use generateSqliteMigrationSQL for a
 * complete fresh installation.
 */
export function generateSqliteDDL(
  tables: SqliteTables = sqliteTables,
  fulltextStrategy: FulltextStrategy = fts5Strategy,
): string[] {
  return sqliteContributions(tables, fulltextStrategy).flatMap(
    (contribution) => [...contribution.createDdl],
  );
}

/**
 * Generates complete SQLite installation DDL for a fresh database.
 * This is not an incremental upgrade planner.
 */
export function generateSqliteMigrationSQL(
  tables: SqliteTables = sqliteTables,
  fulltextStrategy: FulltextStrategy = fts5Strategy,
): string {
  const ddlSql = generateSqliteDDL(tables, fulltextStrategy).join("\n\n");
  const markerSql = generateBaseSchemaVersionMarkerSQL(
    getSqliteTableConfig(tables.baseSchemaVersions).name,
    tables.baseSchemaVersions,
  );
  return `${ddlSql}\n\n${markerSql}`;
}

// ============================================================
// PostgreSQL DDL Generation
// ============================================================

/**
 * Maps Drizzle column types to PostgreSQL types.
 */
function getPgColumnType(column: PgColumn): string {
  switch (column.columnType) {
    case "PgText": {
      return "TEXT";
    }
    case "PgInteger": {
      return "INTEGER";
    }
    case "PgBigInt53":
    case "PgBigInt64": {
      return "BIGINT";
    }
    case "PgBoolean": {
      return "BOOLEAN";
    }
    case "PgJsonb": {
      return "JSONB";
    }
    case "PgTimestamp": {
      return (column as unknown as TimestampColumnConfig).config?.withTimezone ?
          "TIMESTAMPTZ"
        : "TIMESTAMP";
    }
    case "PgReal": {
      return "REAL";
    }
    case "PgDoublePrecision": {
      return "DOUBLE PRECISION";
    }
    case "PgCustomColumn": {
      const dataType = (column as unknown as CustomColumnType).getSQLType?.();
      return dataType ?? "TEXT";
    }
    default: {
      return "TEXT";
    }
  }
}

/**
 * Formats a default value for PostgreSQL.
 */
function formatPgDefaultValue(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  // For other types, use JSON.stringify to avoid [object Object]
  return JSON.stringify(value);
}

/**
 * Generates CREATE TABLE SQL from a Drizzle PostgreSQL table definition.
 */
export function generatePgCreateTableSQL(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: PgTableWithColumns<any>,
): string {
  const config = getPgTableConfig(table);
  const columnDefs: string[] = [];

  // Generate column definitions
  for (const column of config.columns) {
    const parts: string[] = [`"${column.name}"`, getPgColumnType(column)];

    if (column.notNull) {
      parts.push("NOT NULL");
    }

    if (column.hasDefault && column.default !== undefined) {
      parts.push(`DEFAULT ${formatPgDefaultValue(column.default)}`);
    }

    columnDefs.push(parts.join(" "));
  }

  // Add primary key constraint
  const pk = config.primaryKeys[0];
  if (pk) {
    const pkColumns = pk.columns.map((c) => `"${c.name}"`).join(", ");
    columnDefs.push(`PRIMARY KEY (${pkColumns})`);
  }

  columnDefs.push(...renderTableChecks(config.checks, config.name));

  return `CREATE TABLE IF NOT EXISTS "${config.name}" (\n  ${columnDefs.join(",\n  ")}\n);`;
}

/**
 * Generates CREATE INDEX SQL statements from a Drizzle PostgreSQL table definition.
 */
function generatePgCreateIndexSQL(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: PgTableWithColumns<any>,
): string[] {
  const config = getPgTableConfig(table);
  const statements: string[] = [];

  for (const index of config.indexes) {
    const indexConfig = index.config;
    const columns = indexConfig.columns
      .map((c) => renderIndexColumn(c))
      .join(", ");
    const unique = indexConfig.unique ? "UNIQUE " : "";
    const method =
      indexConfig.method && indexConfig.method !== "btree" ?
        ` USING ${indexConfig.method}`
      : "";
    const where =
      indexConfig.where ?
        ` WHERE ${inlineSqlOrThrow(indexConfig.where, `PostgreSQL index "${indexConfig.name}" WHERE clause`)}`
      : "";

    statements.push(
      `CREATE ${unique}INDEX IF NOT EXISTS "${indexConfig.name}" ON "${config.name}"${method} (${columns})${where};`,
    );
  }

  return statements;
}

/**
 * Whether a schema-barrel value is a Drizzle Postgres table. See
 * {@link isSqliteTable} for why this uses Drizzle's brand check.
 */
function isPgTable(
  value: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): value is PgTableWithColumns<any> {
  return is(value, PgTable);
}

/**
 * The authoritative set of tables the PostgreSQL backend owns: every
 * base/status Drizzle table plus the resolved fulltext-strategy
 * contribution(s). Single source of truth for DDL generation, the
 * bootstrap ensure, and drizzle-kit visibility (#129).
 *
 * The typed `tables.fulltext` object is **not** emitted via the
 * column-walker (it can't reproduce `GENERATED ALWAYS AS … STORED`);
 * instead the strategy's canonical DDL is carried as the fulltext
 * contribution's `createDdl`. drizzle-kit visibility for the default
 * tsvector strategy comes from `schema/postgres.ts` exporting that
 * same `tables.fulltext` object through the barrel — one object, not
 * two. (Non-default Postgres strategies must export their own table
 * for drizzle-kit; see `FulltextStrategy.ownedTables`.)
 */
export function postgresContributions(
  tables: PostgresTables = postgresTables,
  fulltextStrategy: FulltextStrategy = tsvectorStrategy,
): readonly TableContribution[] {
  const contributions: TableContribution[] = [];
  for (const [key, table] of Object.entries(tables)) {
    if (!isPgTable(table)) continue;
    // The strategy owns the fulltext slot's DDL (the column-walker
    // can't reproduce its generated tsvector column); the strategy
    // declaration below is the authoritative fulltext contribution.
    if (table === tables.fulltext) continue;
    // Stable factory key (`nodes`, `edges`, …) is the logicalName so
    // the #135 materialization identity survives custom table-name
    // overrides; the resolved SQL name is only the physical tableName.
    contributions.push({
      logicalName: key,
      owner: BASE_CONTRIBUTION_OWNER,
      tableName: getPgTableConfig(table).name,
      createDdl: [
        generatePgCreateTableSQL(table),
        ...generatePgCreateIndexSQL(table),
      ],
      runtimeEnsure: false,
    });
  }
  for (const declared of fulltextStrategy.ownedTables(
    tables.fulltextTableName,
  )) {
    contributions.push(declared);
  }
  return contributions;
}

/**
 * Generates all DDL statements for the given PostgreSQL tables.
 *
 * Iterates the unified contribution set (#129) — base tables first,
 * then strategy-owned tables. Per-contribution ordering is
 * table-then-its-own-indexes; safe because TypeGraph's tables carry no
 * cross-table foreign keys. This low-level array deliberately omits the
 * deployment-wide version marker; use generatePostgresMigrationSQL for a
 * complete fresh installation.
 */
export function generatePostgresDDL(
  tables: PostgresTables = postgresTables,
  fulltextStrategy: FulltextStrategy = tsvectorStrategy,
): string[] {
  return postgresContributions(tables, fulltextStrategy).flatMap(
    (contribution) => [...contribution.createDdl],
  );
}

/** Builds complete PostgreSQL installation SQL for a bundled factory profile. */
function generatePostgresInstallationSQL(
  tables: PostgresTables = postgresTables,
  fulltextStrategy: FulltextStrategy = tsvectorStrategy,
  includeVectorExtension: boolean,
): string {
  // pgvector extension is required for the per-field embedding tables
  const extensionSql =
    includeVectorExtension ?
      "-- Enable pgvector extension for vector similarity search\nCREATE EXTENSION IF NOT EXISTS vector;"
    : undefined;
  const ddlSql = generatePostgresDDL(tables, fulltextStrategy).join("\n\n");
  const markerSql = generateBaseSchemaVersionMarkerSQL(
    getPgTableConfig(tables.baseSchemaVersions).name,
    tables.baseSchemaVersions,
  );
  return [extensionSql, ddlSql, markerSql]
    .filter((statement) => statement !== undefined)
    .join("\n\n");
}

/**
 * Generates complete PostgreSQL installation DDL for a fresh database.
 * This is not an incremental upgrade planner.
 *
 * Includes CREATE EXTENSION for pgvector since the per-`(kind, field)`
 * embedding tables `pgvectorStrategy` materializes at runtime use the
 * native VECTOR type.
 */
export function generatePostgresMigrationSQL(
  tables: PostgresTables = postgresTables,
  fulltextStrategy: FulltextStrategy = tsvectorStrategy,
): string {
  return generatePostgresInstallationSQL(tables, fulltextStrategy, true);
}

/** @internal Complete installation SQL for the vector-disabled PGlite factory. */
export function generateVectorlessPostgresMigrationSQL(
  tables: PostgresTables = postgresTables,
  fulltextStrategy: FulltextStrategy = tsvectorStrategy,
): string {
  return generatePostgresInstallationSQL(tables, fulltextStrategy, false);
}
