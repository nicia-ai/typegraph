/**
 * Shared database row-mapping utilities.
 */

import { DatabaseOperationError } from "../errors";
import { canonicalizeDatabaseTimestamp } from "../utils/date";
import {
  type EdgeRow,
  type NodeRow,
  rowPropsToJsonText,
  type SchemaVersionRow,
  type UniqueRow,
} from "./types";

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

/**
 * Formats PostgreSQL timestamps used by internal status-table adapters.
 * Row metadata uses the stricter {@link normalizeRowTimestamp} contract.
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
 * Canonicalizes database-driver timestamp values at the row-mapping boundary.
 * Every store and compiled-query metadata projection uses this owner so driver
 * rendering differences cannot become public values.
 */
export function normalizeRowTimestamp(
  value: unknown,
  field: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const canonical = canonicalizeDatabaseTimestamp(value);
  if (canonical === undefined) {
    throw new DatabaseOperationError(
      `Expected ${field} to be a database timestamp, got ${typeof value}`,
      { operation: "select", entity: "row" },
    );
  }
  return canonical;
}

export function normalizeRequiredRowTimestamp(
  value: unknown,
  field: string,
): string {
  const timestamp = normalizeRowTimestamp(value, field);
  if (timestamp === undefined) {
    throw new DatabaseOperationError(`Expected non-null ${field} timestamp`, {
      operation: "select",
      entity: "row",
    });
  }
  return timestamp;
}

/**
 * Coerce a fulltext relevance score to `number` at the backend
 * boundary. Postgres returns `numeric` as a string to preserve
 * precision; a custom `FulltextStrategy` on either dialect could
 * likewise yield a string. Shared so both backends enforce the same
 * `FulltextSearchResult.score: number` contract and reject garbage
 * loudly instead of propagating `NaN`.
 */
export function coerceNumericScore(value: number | string): number {
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new TypeError(
      `Backend returned non-numeric fulltext score: ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/**
 * Normalizes a JSON column that may be returned as a parsed object (JSONB)
 * or string. PostgreSQL drivers hand jsonb back already parsed — keep the
 * object instead of re-stringifying it, so the read path pays zero JSON
 * work per row (consumers normalize via rowPropsToObject /
 * rowPropsToJsonText at the point of use). SQLite text passes through.
 */
function normalizeJsonColumn(value: unknown): string | Record<string, unknown> {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return JSON.stringify(value ?? {});
}

/**
 * Dialect-specific configuration for row mappers.
 *
 * Row mapper factories accept this config to produce dialect-appropriate
 * mappers. Timestamp normalization is dialect-independent and owned by
 * {@link normalizeRowTimestamp}; only JSON columns need dialect configuration.
 */
type DialectRowMapperConfig = Readonly<{
  normalizeJson: (value: unknown) => string | Record<string, unknown>;
}>;

/**
 * SQLite row mapper config. JSON is stored as TEXT.
 */
export const SQLITE_ROW_MAPPER_CONFIG: DialectRowMapperConfig = {
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
 * PostgreSQL row mapper config. JSONB is returned as parsed objects.
 */
export const POSTGRES_ROW_MAPPER_CONFIG: DialectRowMapperConfig = {
  normalizeJson: normalizeJsonColumn,
};

// Trust boundary: Drizzle raw SQL returns Record<string, unknown> rows.
// The field access patterns below are intentional unsafe casts at the
// database driver boundary where we know the column shapes.

export function createNodeRowMapper(
  config: DialectRowMapperConfig,
): (row: Record<string, unknown>) => NodeRow {
  return (row) => ({
    graph_id: asString(row["graph_id"], "graph_id"),
    kind: asString(row["kind"], "kind"),
    id: asString(row["id"], "id"),
    props: config.normalizeJson(row["props"]),
    version: asNumber(row["version"], "version"),
    valid_from: normalizeRowTimestamp(row["valid_from"], "valid_from"),
    valid_to: normalizeRowTimestamp(row["valid_to"], "valid_to"),
    created_at: normalizeRequiredRowTimestamp(row["created_at"], "created_at"),
    updated_at: normalizeRequiredRowTimestamp(row["updated_at"], "updated_at"),
    deleted_at: normalizeRowTimestamp(row["deleted_at"], "deleted_at"),
  });
}

export function createEdgeRowMapper(
  config: DialectRowMapperConfig,
): (row: Record<string, unknown>) => EdgeRow {
  return (row) => ({
    graph_id: asString(row["graph_id"], "graph_id"),
    id: asString(row["id"], "id"),
    kind: asString(row["kind"], "kind"),
    from_kind: asString(row["from_kind"], "from_kind"),
    from_id: asString(row["from_id"], "from_id"),
    to_kind: asString(row["to_kind"], "to_kind"),
    to_id: asString(row["to_id"], "to_id"),
    props: config.normalizeJson(row["props"]),
    valid_from: normalizeRowTimestamp(row["valid_from"], "valid_from"),
    valid_to: normalizeRowTimestamp(row["valid_to"], "valid_to"),
    created_at: normalizeRequiredRowTimestamp(row["created_at"], "created_at"),
    updated_at: normalizeRequiredRowTimestamp(row["updated_at"], "updated_at"),
    deleted_at: normalizeRowTimestamp(row["deleted_at"], "deleted_at"),
  });
}

function mapUniqueRow(row: Record<string, unknown>): UniqueRow {
  return {
    graph_id: asString(row["graph_id"], "graph_id"),
    node_kind: asString(row["node_kind"], "node_kind"),
    constraint_name: asString(row["constraint_name"], "constraint_name"),
    key: asString(row["key"], "key"),
    node_id: asString(row["node_id"], "node_id"),
    concrete_kind: asString(row["concrete_kind"], "concrete_kind"),
    deleted_at: normalizeRowTimestamp(row["deleted_at"], "deleted_at"),
  };
}

export function createUniqueRowMapper(
  _config: DialectRowMapperConfig,
): (row: Record<string, unknown>) => UniqueRow {
  return mapUniqueRow;
}

export function createSchemaVersionRowMapper(
  config: DialectRowMapperConfig,
): (row: Record<string, unknown>) => SchemaVersionRow {
  return (row) => {
    const isActiveValue = row["is_active"];
    const isActive =
      isActiveValue === true || isActiveValue === 1 || isActiveValue === "1";

    return {
      graph_id: asString(row["graph_id"], "graph_id"),
      version: asNumber(row["version"], "version"),
      schema_hash: asString(row["schema_hash"], "schema_hash"),
      schema_doc: rowPropsToJsonText(config.normalizeJson(row["schema_doc"])),
      created_at: normalizeRequiredRowTimestamp(
        row["created_at"],
        "created_at",
      ),
      is_active: isActive,
    };
  };
}
