/**
 * DDL generation utilities for TypeGraph backends.
 *
 * Provides utilities for generating DDL statements from Drizzle
 * table definitions. This ensures migrations match production schema.
 */
import {
  getTableConfig as getPgTableConfig,
  type PgColumn,
  type PgTableWithColumns,
} from "drizzle-orm/pg-core";
import {
  getTableConfig as getSqliteTableConfig,
  type SQLiteColumn,
  type SQLiteTableWithColumns,
} from "drizzle-orm/sqlite-core";

import { type PostgresTables, tables as postgresTables } from "./schema/postgres";
import { type SqliteTables, tables as sqliteTables } from "./schema/sqlite";

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
function generateSqliteCreateTableSQL(
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

  return `CREATE TABLE IF NOT EXISTS "${config.name}" (\n  ${columnDefs.join(",\n  ")}\n);`;
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
    if ("value" in chunk && Array.isArray((chunk as { value: unknown }).value)) {
      return (chunk as { value: readonly unknown[] }).value
        .map((part) => flattenSqlChunk(part))
        .join("");
    }

    if (
      "queryChunks" in chunk &&
      Array.isArray((chunk as { queryChunks: unknown }).queryChunks)
    ) {
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
 * Generates all DDL statements for the given SQLite tables.
 */
export function generateSqliteDDL(tables: SqliteTables = sqliteTables): string[] {
  const statements: string[] = [];

  // Generate in dependency order (tables first, then indexes)
  for (const table of Object.values(tables)) {
    statements.push(generateSqliteCreateTableSQL(table));
  }

  for (const table of Object.values(tables)) {
    statements.push(...generateSqliteCreateIndexSQL(table));
  }

  return statements;
}

/**
 * Generates a single SQL string for SQLite migrations.
 * Convenience function that joins all DDL statements.
 */
export function getSqliteMigrationSQL(tables: SqliteTables = sqliteTables): string {
  return generateSqliteDDL(tables).join("\n\n");
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
    case "PgBoolean": {
      return "BOOLEAN";
    }
    case "PgJsonb": {
      return "JSONB";
    }
    case "PgTimestamp": {
      // Check if it has timezone
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      return (column as any).config?.withTimezone ? "TIMESTAMPTZ" : "TIMESTAMP";
    }
    case "PgReal": {
      return "REAL";
    }
    case "PgDoublePrecision": {
      return "DOUBLE PRECISION";
    }
    case "PgCustomColumn": {
      // Custom column type - get the SQL type from dataType()
      // This handles our vector column type
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      const dataType = (column as any).getSQLType?.() as string | undefined;
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
function generatePgCreateTableSQL(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: PgTableWithColumns<any>,
): string {
  const config = getPgTableConfig(table);
  const columnDefs: string[] = [];

  // Generate column definitions
  for (const column of config.columns) {
    const parts: string[] = [
      `"${column.name}"`,
      getPgColumnType(column),
    ];

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
 * Generates all DDL statements for the given PostgreSQL tables.
 */
export function generatePostgresDDL(tables: PostgresTables = postgresTables): string[] {
  const statements: string[] = [];

  // Generate in dependency order (tables first, then indexes)
  for (const table of Object.values(tables)) {
    statements.push(generatePgCreateTableSQL(table));
  }

  for (const table of Object.values(tables)) {
    statements.push(...generatePgCreateIndexSQL(table));
  }

  return statements;
}

/**
 * Generates a single SQL string for PostgreSQL migrations.
 * Convenience function that joins all DDL statements.
 *
 * Includes CREATE EXTENSION for pgvector since the embeddings table
 * uses the native VECTOR type.
 */
export function getPostgresMigrationSQL(tables: PostgresTables = postgresTables): string {
  // pgvector extension is required for the embeddings table
  const extensionSql = "-- Enable pgvector extension for vector similarity search\nCREATE EXTENSION IF NOT EXISTS vector;";
  const ddlSql = generatePostgresDDL(tables).join("\n\n");
  return `${extensionSql}\n\n${ddlSql}`;
}
