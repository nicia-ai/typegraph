import { type SQL, sql } from "drizzle-orm";

import type { SqlDialect } from "../../types";
import type { PostgresTables } from "../schema/postgres";
import type { SqliteTables } from "../schema/sqlite";

export type Tables = SqliteTables | PostgresTables;

/**
 * Converts undefined to SQL NULL for use in template literals.
 * Drizzle doesn't handle undefined in sql`` templates correctly.
 */
export function sqlNull(value: string | undefined): SQL | string {
  return value ?? sql.raw("NULL");
}

/**
 * Resolves a `validFrom` insert value against the row's creation timestamp.
 * Three states, matching {@link InsertNodeParams.validFrom} /
 * {@link InsertEdgeParams.validFrom}:
 *  - `undefined` (omitted): defaults to `timestamp` — every insert path
 *    (single, batch, returning/non-returning) agrees that "no validFrom"
 *    means "valid from creation", not open-left NULL (see issue #240).
 *  - `null`: preserves an explicit open-left window — returned as
 *    `undefined` here so the caller's {@link sqlNull} wrap emits SQL NULL,
 *    letting interchange import round-trip a row that predates the #240
 *    fix without narrowing its validity window on re-import (e.g. via a
 *    `branch()` clone).
 *  - a string: passed through unchanged.
 */
export function resolveValidFrom(
  validFrom: string | null | undefined,
  timestamp: string,
): string | undefined {
  if (validFrom === null) return undefined;
  return validFrom ?? timestamp;
}

export function quotedColumn(column: { name: string }): SQL {
  return sql.raw(`"${column.name.replaceAll('"', '""')}"`);
}

/**
 * Returns a quoted SQL identifier for a bare table name string.
 * Use when the operation targets a table that isn't represented as a
 * Drizzle table object (e.g. the FTS5 virtual table).
 */
export function quotedTableName(tableName: string): SQL {
  return sql.raw(`"${tableName.replaceAll('"', '""')}"`);
}

const CODE_POINT_ORDER_BUILDERS = {
  postgres: (value: SQL) => sql`${value} COLLATE "C"`,
  sqlite: (value: SQL) => value,
} satisfies Record<SqlDialect, (value: SQL) => SQL>;

/**
 * `column` rendered so that ORDER BY sorts it by code point on both engines.
 *
 * Relevance-ranking SQL breaks score ties on `node_id`. Left bare, Postgres
 * sorts it under the column's collation — a linguistic collation such as
 * `en_US.UTF-8` orders `a, A, b, B` where byte order gives `A, B, a, b`, so
 * the same query returns different pages on two databases whose `datcollate`
 * differs. SQLite's default `BINARY` collation is already code-point order,
 * as is the store's `compareCodePoints`, which ranks the same rows whenever a
 * search falls back to fusing in JavaScript.
 *
 * Forcing the `C` collation on Postgres makes all three agree. The ranking is
 * sorted anyway (no index supplies the order), so this costs nothing.
 */
export function codePointOrderKey(column: SQL, dialect: SqlDialect): SQL {
  return CODE_POINT_ORDER_BUILDERS[dialect](column);
}

/**
 * Subquery yielding the ids of CURRENT nodes of one kind — the candidate
 * set a facade search statement is allowed to return. Passed into the
 * fulltext and vector search builders so top-k is computed over current
 * rows in SQL, instead of ranking side-table rows first and dropping
 * tombstoned/expired nodes after (which silently shrinks results below
 * `limit` under index drift).
 *
 * Currency matches a `current` read: non-tombstoned AND inside the
 * validity window. The instant is BOUND as a parameter (the backend's
 * clock, same source as its write timestamps) rather than compiled as a
 * per-row SQL now() call — on SQLite a per-row strftime() across two
 * search legs dominated unfiltered facade searches.
 */
export function liveNodeIdsSubquery(
  nodes: Tables["nodes"],
  graphId: string,
  nodeKind: string,
  nowIso: string,
): SQL {
  return sql`SELECT ${nodes.id} AS node_id FROM ${nodes} WHERE ${nodes.graphId} = ${graphId} AND ${nodes.kind} = ${nodeKind} AND ${nodes.deletedAt} IS NULL AND (${nodes.validFrom} IS NULL OR ${nodes.validFrom} <= ${nowIso}) AND (${nodes.validTo} IS NULL OR ${nodes.validTo} > ${nowIso})`;
}

export function nodeColumnList(nodes: Tables["nodes"]): SQL {
  return sql.raw(
    `"${nodes.graphId.name}", "${nodes.kind.name}", "${nodes.id.name}", "${nodes.props.name}", "${nodes.version.name}", "${nodes.validFrom.name}", "${nodes.validTo.name}", "${nodes.createdAt.name}", "${nodes.updatedAt.name}"`,
  );
}

export function edgeColumnList(edges: Tables["edges"]): SQL {
  return sql.raw(
    `"${edges.graphId.name}", "${edges.id.name}", "${edges.kind.name}", "${edges.fromKind.name}", "${edges.fromId.name}", "${edges.toKind.name}", "${edges.toId.name}", "${edges.props.name}", "${edges.validFrom.name}", "${edges.validTo.name}", "${edges.createdAt.name}", "${edges.updatedAt.name}"`,
  );
}
