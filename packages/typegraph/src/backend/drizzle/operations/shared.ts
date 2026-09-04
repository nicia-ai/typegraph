import { getTableName, type SQL, sql, type SQLWrapper } from "drizzle-orm";

import { getDialect } from "../../../query/dialect";
import type { SqlFragment } from "../../../query/sql-fragment";
import type { PrimaryKeyRelation } from "../../../utils/sql-errors";
import type { SqlDialect } from "../../types";
import { toDrizzleSql } from "../execution/types";
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
  const sqliteColumns = [nodes.graphId.name, nodes.kind.name, nodes.id.name];
  return {
    table: relation,
    constraintNames: primaryKeyConstraintNames(relation, sqliteColumns),
    sqliteColumns,
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
  const sqliteColumns = [edges.graphId.name, edges.id.name];
  return {
    table: relation,
    constraintNames: primaryKeyConstraintNames(relation, sqliteColumns),
    sqliteColumns,
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
 * Gives a bound value the destination column's declared SQL type before it
 * enters a CTE. PostgreSQL otherwise resolves JSON and timestamp parameters in
 * a standalone `VALUES` relation as text, then refuses to assign them to their
 * typed destination columns. SQLite's declared types make the same lowering a
 * no-op in practice, so write programs keep one shared statement shape.
 */
export function castBoundValueForColumn(
  column: Readonly<{ getSQLType: () => string }>,
  value: unknown,
): SQL {
  return sql`CAST(${value} AS ${sql.raw(column.getSQLType())})`;
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

const EXISTING_COLUMN_QUALIFIERS = {
  postgres: (tableName: string, columnName: string) =>
    sql`${quotedTableName(tableName)}.${quotedColumn({ name: columnName })}`,
  sqlite: (_tableName: string, columnName: string) =>
    quotedColumn({ name: columnName }),
} satisfies Record<SqlDialect, (tableName: string, columnName: string) => SQL>;

/**
 * The EXISTING row's column inside an `ON CONFLICT ... DO UPDATE`, as
 * opposed to `excluded.<column>` (the row that was proposed for insertion).
 * PostgreSQL requires this reference qualified with the table name to
 * disambiguate it from `excluded`; SQLite takes the bare column. Every
 * upsert builder that reads the conflicting row routes through this one
 * owner instead of re-spelling the qualification: `buildInsertUnique`,
 * `buildInsertUniqueBatch`, and `buildInsertUniqueFromSource` (all in
 * `operations/uniques.ts`), plus the atomic node claim upsert in
 * `operations/atomic-node-claims.ts` — four call sites.
 */
export function existingColumn(
  dialect: SqlDialect,
  tableName: string,
  columnName: string,
): SQL {
  return EXISTING_COLUMN_QUALIFIERS[dialect](tableName, columnName);
}

/**
 * `column` (an identifier or raw fragment, e.g. `sql.identifier("node_id")`
 * or `sql.raw("node_id")`) rendered so that ORDER BY sorts it by code point
 * on both engines.
 *
 * Relevance-ranking SQL breaks score ties on `node_id`. Left bare, Postgres
 * sorts it under the column's collation — a linguistic collation such as
 * `en_US.UTF-8` orders `a, A, b, B` where byte order gives `A, B, a, b`, so
 * the same query returns different pages on two databases whose `datcollate`
 * differs. SQLite's default `BINARY` collation is already code-point order,
 * as is the store's `compareCodePoints`, which ranks the same rows whenever a
 * search falls back to fusing in JavaScript.
 *
 * `DialectAdapter.binaryText` is the repo's one owner of this decision
 * (`COLLATE "C"` on Postgres, identity on SQLite — the same seam
 * `src/store/algorithms/**` and `identity/interchange-read.ts` already
 * consume), so this reaches it instead of re-spelling the collation choice.
 * Forcing the `C` collation on Postgres makes all three agree. The ranking is
 * sorted anyway (no index supplies the order), so this costs nothing.
 */
export function codePointOrderKey(column: SqlFragment, dialect: SqlDialect): SQL {
  return toDrizzleSql(getDialect(dialect).binaryText(column), dialect);
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
    `"${edges.graphId.name}", "${edges.id.name}", "${edges.kind.name}", "${edges.fromKind.name}", "${edges.fromId.name}", "${edges.toKind.name}", "${edges.toId.name}", "${edges.props.name}", "${edges.matchIdentityName.name}", "${edges.matchIdentityKey.name}", "${edges.validFrom.name}", "${edges.validTo.name}", "${edges.createdAt.name}", "${edges.updatedAt.name}"`,
  );
}
