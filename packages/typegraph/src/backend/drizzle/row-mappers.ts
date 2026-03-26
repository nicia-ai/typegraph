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

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new DatabaseOperationError(
      `Expected ${field} to be string, got ${typeof value}`,
      { operation: "select", entity: "row" },
    );
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new DatabaseOperationError(
      `Expected ${field} to be number, got ${typeof value}`,
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
  formatTimestamp: (value) => {
    if (value === null || value === undefined) return;
    if (typeof value !== "string") {
      throw new DatabaseOperationError(
        `Expected timestamp to be string, got ${typeof value}`,
        { operation: "select", entity: "row" },
      );
    }
    return value;
  },
  normalizeJson: (value) => {
    if (typeof value !== "string") {
      throw new DatabaseOperationError(
        `Expected JSON column to be string, got ${typeof value}`,
        { operation: "select", entity: "row" },
      );
    }
    return value;
  },
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
    graph_id: asString(row.graph_id, "graph_id"),
    kind: asString(row.kind, "kind"),
    id: asString(row.id, "id"),
    props: config.normalizeJson(row.props),
    version: asNumber(row.version, "version"),
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
    graph_id: asString(row.graph_id, "graph_id"),
    id: asString(row.id, "id"),
    kind: asString(row.kind, "kind"),
    from_kind: asString(row.from_kind, "from_kind"),
    from_id: asString(row.from_id, "from_id"),
    to_kind: asString(row.to_kind, "to_kind"),
    to_id: asString(row.to_id, "to_id"),
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
    graph_id: asString(row.graph_id, "graph_id"),
    node_kind: asString(row.node_kind, "node_kind"),
    constraint_name: asString(row.constraint_name, "constraint_name"),
    key: asString(row.key, "key"),
    node_id: asString(row.node_id, "node_id"),
    concrete_kind: asString(row.concrete_kind, "concrete_kind"),
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
      graph_id: asString(row.graph_id, "graph_id"),
      version: asNumber(row.version, "version"),
      schema_hash: asString(row.schema_hash, "schema_hash"),
      schema_doc: config.normalizeJson(row.schema_doc),
      created_at: requireTimestamp(config.formatTimestamp(row.created_at), "created_at"),
      is_active: isActive,
    };
  };
}
