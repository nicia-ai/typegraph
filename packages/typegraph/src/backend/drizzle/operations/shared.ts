import { type SQL, sql } from "drizzle-orm";

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

/**
 * Subquery yielding the ids of LIVE nodes of one kind — the candidate set a
 * facade search statement is allowed to return. Passed into the fulltext and
 * vector search builders so top-k is computed over live rows in SQL, instead
 * of ranking side-table rows first and dropping tombstones after (which
 * silently shrinks results below `limit` under index drift).
 */
export function liveNodeIdsSubquery(
  nodes: Tables["nodes"],
  graphId: string,
  nodeKind: string,
): SQL {
  return sql`SELECT ${nodes.id} FROM ${nodes} WHERE ${nodes.graphId} = ${graphId} AND ${nodes.kind} = ${nodeKind} AND ${nodes.deletedAt} IS NULL`;
}

export function nodeColumnList(nodes: Tables["nodes"]): SQL {
  return sql.raw(`"${nodes.graphId.name}", "${nodes.kind.name}", "${nodes.id.name}", "${nodes.props.name}", "${nodes.version.name}", "${nodes.validFrom.name}", "${nodes.validTo.name}", "${nodes.createdAt.name}", "${nodes.updatedAt.name}"`);
}

export function edgeColumnList(edges: Tables["edges"]): SQL {
  return sql.raw(`"${edges.graphId.name}", "${edges.id.name}", "${edges.kind.name}", "${edges.fromKind.name}", "${edges.fromId.name}", "${edges.toKind.name}", "${edges.toId.name}", "${edges.props.name}", "${edges.validFrom.name}", "${edges.validTo.name}", "${edges.createdAt.name}", "${edges.updatedAt.name}"`);
}
