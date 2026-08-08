import {
  getTableName,
  type SQL,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import type { PrimaryKeyRelation } from "../../../utils/sql-errors";
import type { SqlDialect } from "../../types";
import type { PostgresTables } from "../schema/postgres";
import type { SqliteTables } from "../schema/sqlite";

export type Tables = SqliteTables | PostgresTables;

/**
 * The names a relation's PRIMARY KEY constraint can carry, given the relation
 * name and its key columns.
 *
 * Two, because TypeGraph supports two provisioning paths for the same schema
 * and they name the constraint differently:
 *
 *  - TypeGraph's own DDL (`generatePostgresCreateTableSQL`) emits an UNNAMED
 *    `PRIMARY KEY (...)` clause, which PostgreSQL names `<relation>_pkey`;
 *  - `drizzle-kit` renders the Drizzle `primaryKey({ columns })` builder with
 *    its explicit name, `<relation>_<column>_..._pk`.
 *
 * Both are derived rather than hardcoded so a custom table name is covered
 * too. Accepting only these two — never
 * an arbitrary unique constraint on the relation — is what keeps a declared
 * `unique: true` index violation out of the duplicate-identity classification.
 *
 * One declared bound: PostgreSQL clips every identifier to 63 bytes, and clips
 * the RELATION part to make room for the `_pkey` it appends, so a custom
 * relation name long enough to overflow that (58+ bytes) is named something
 * neither of these matches. Classification then simply does not happen and the
 * driver failure surfaces as it did before — no misattribution, just no
 * translation.
 */
function primaryKeyConstraintNames(
  relation: string,
  keyColumns: readonly string[],
): readonly string[] {
  return [`${relation}_pkey`, `${relation}_${keyColumns.join("_")}_pk`];
}

/**
 * The nodes relation's identity constraint: `(graph_id, kind, id)`, the tuple
 * every node read also filters on.
 */
export function nodePrimaryKeyConstraint(
  nodes: Tables["nodes"],
): PrimaryKeyRelation {
  const relation = getTableName(nodes);
  return {
    table: relation,
    constraintNames: primaryKeyConstraintNames(relation, [
      nodes.graphId.name,
      nodes.kind.name,
      nodes.id.name,
    ]),
  };
}

/**
 * The edges relation's identity constraint: `(graph_id, id)`. An edge id is
 * unique per graph without its kind, so the key is one column shorter than a
 * node's.
 */
export function edgePrimaryKeyConstraint(
  edges: Tables["edges"],
): PrimaryKeyRelation {
  const relation = getTableName(edges);
  return {
    table: relation,
    constraintNames: primaryKeyConstraintNames(relation, [
      edges.graphId.name,
      edges.id.name,
    ]),
  };
}

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
 *
 * The `timestamp` fallback is a storage convention, not an assertion the caller
 * can be held to, so a write whose validity window is GUARDED against the
 * resulting lower bound must supply that bound explicitly instead of relying on
 * it: this function samples nothing, but its caller's `timestamp` comes from a
 * later clock read than the guard's, and the difference is a window of negative
 * width (issue #413). The node resurrection path therefore passes the instant it
 * validated against; see `buildUpdateNode` and `performNodeUpdate`.
 */
export function resolveValidFrom(
  validFrom: string | null | undefined,
  timestamp: string,
): string | undefined {
  if (validFrom === null) return undefined;
  return validFrom ?? timestamp;
}

/**
 * The `AND valid_from …` conjunction a write carries when its caller ASSERTED
 * the lower bound the target row already holds (see
 * {@link UpdateNodeParams.expectedValidFrom} /
 * {@link UpdateEdgeParams.expectedValidFrom}).
 *
 * NULL-SAFE by construction, and that is the whole point of routing both
 * entities through one builder: `valid_from` is nullable (an open-left window),
 * and `col = NULL` is UNKNOWN in SQL, so the obvious `AND col = ?` spelling
 * turns "I checked that this row has no lower bound" into a predicate that
 * matches NOTHING — an assertion that always fails is as wrong as one that
 * never runs. The three states are therefore distinct:
 *
 *  - `undefined` — the caller asserted nothing; no predicate is emitted.
 *  - `null` — the caller read an OPEN-LEFT window; emits `IS NULL`.
 *  - a string — the caller read that bound; emits `= <bound>`.
 *
 * One owner: nodes and edges share this function so the two statements cannot
 * drift into disagreeing about what "the bound I read" means.
 */
export function expectedValidFromPredicate(
  column: SQLWrapper,
  expected: string | null | undefined,
): SQL {
  if (expected === undefined) return sql.empty();
  if (expected === null) return sql` AND ${column} IS NULL`;
  return sql` AND ${column} = ${expected}`;
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
