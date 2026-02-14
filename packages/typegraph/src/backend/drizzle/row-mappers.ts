/**
 * Shared row-mapping utilities for Drizzle backend adapters.
 */

import { DatabaseOperationError } from "../../errors";
import type { EdgeRow, NodeRow, SchemaVersionRow, UniqueRow } from "../types";

function requireTimestamp(value: string | undefined, field: string): string {
  if (value === undefined) {
    throw new DatabaseOperationError(
      `Expected non-null ${field} timestamp`,
      { operation: "select", entity: "row" },
    );
  }
  return value;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function nullToUndefined<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

/**
 * Formats a PostgreSQL timestamp value to ISO string.
 * PostgreSQL returns Date objects or timestamp strings that need normalization.
 */
export function formatPostgresTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    if (value.includes("T")) return value;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return value;
  }
  return undefined;
}

/**
 * Normalizes a JSON column that may be returned as a parsed object (JSONB) or string.
 */
function normalizeJsonColumn(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

/**
 * Dialect-specific configuration for row mappers.
 *
 * Row mapper factories accept this config to produce dialect-appropriate
 * mappers. The `formatTimestamp` and `normalizeJson` functions handle
 * the differences between how SQLite and PostgreSQL return timestamps
 * and JSON columns.
 */
type DialectRowMapperConfig = Readonly<{
  formatTimestamp: (value: unknown) => string | undefined;
  normalizeJson: (value: unknown) => string;
}>;

/**
 * SQLite row mapper config.
 * Timestamps are stored as ISO strings; JSON is stored as TEXT.
 */
export const SQLITE_ROW_MAPPER_CONFIG: DialectRowMapperConfig = {
  formatTimestamp: (value) => nullToUndefined(value as string | null),
  normalizeJson: (value) => value as string,
};

/**
 * PostgreSQL row mapper config.
 * Timestamps may be Date objects or PG-format strings; JSONB is parsed objects.
 */
export const POSTGRES_ROW_MAPPER_CONFIG: DialectRowMapperConfig = {
  formatTimestamp: formatPostgresTimestamp,
  normalizeJson: normalizeJsonColumn,
};

// Trust boundary: Drizzle raw SQL returns Record<string, unknown> rows.
// The field access patterns below are intentional unsafe casts at the
// database driver boundary where we know the column shapes.

export function createNodeRowMapper(
  config: DialectRowMapperConfig,
): (row: Record<string, unknown>) => NodeRow {
  return (row) => ({
    graph_id: row.graph_id as string,
    kind: row.kind as string,
    id: row.id as string,
    props: config.normalizeJson(row.props),
    version: row.version as number,
    valid_from: nullToUndefined(config.formatTimestamp(row.valid_from)),
    valid_to: nullToUndefined(config.formatTimestamp(row.valid_to)),
    created_at: requireTimestamp(config.formatTimestamp(row.created_at), "created_at"),
    updated_at: requireTimestamp(config.formatTimestamp(row.updated_at), "updated_at"),
    deleted_at: nullToUndefined(config.formatTimestamp(row.deleted_at)),
  });
}

export function createEdgeRowMapper(
  config: DialectRowMapperConfig,
): (row: Record<string, unknown>) => EdgeRow {
  return (row) => ({
    graph_id: row.graph_id as string,
    id: row.id as string,
    kind: row.kind as string,
    from_kind: row.from_kind as string,
    from_id: row.from_id as string,
    to_kind: row.to_kind as string,
    to_id: row.to_id as string,
    props: config.normalizeJson(row.props),
    valid_from: nullToUndefined(config.formatTimestamp(row.valid_from)),
    valid_to: nullToUndefined(config.formatTimestamp(row.valid_to)),
    created_at: requireTimestamp(config.formatTimestamp(row.created_at), "created_at"),
    updated_at: requireTimestamp(config.formatTimestamp(row.updated_at), "updated_at"),
    deleted_at: nullToUndefined(config.formatTimestamp(row.deleted_at)),
  });
}

export function createUniqueRowMapper(
  config: DialectRowMapperConfig,
): (row: Record<string, unknown>) => UniqueRow {
  return (row) => ({
    graph_id: row.graph_id as string,
    node_kind: row.node_kind as string,
    constraint_name: row.constraint_name as string,
    key: row.key as string,
    node_id: row.node_id as string,
    concrete_kind: row.concrete_kind as string,
    deleted_at: nullToUndefined(config.formatTimestamp(row.deleted_at)),
  });
}

export function createSchemaVersionRowMapper(
  config: DialectRowMapperConfig,
): (row: Record<string, unknown>) => SchemaVersionRow {
  return (row) => {
    const isActiveValue = row.is_active;
    const isActive =
      isActiveValue === true || isActiveValue === 1 || isActiveValue === "1";

    return {
      graph_id: row.graph_id as string,
      version: row.version as number,
      schema_hash: row.schema_hash as string,
      schema_doc: config.normalizeJson(row.schema_doc),
      created_at: requireTimestamp(config.formatTimestamp(row.created_at), "created_at"),
      is_active: isActive,
    };
  };
}
