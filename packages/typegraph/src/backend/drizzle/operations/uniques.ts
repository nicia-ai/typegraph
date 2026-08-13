import { getTableName, type SQL, sql } from "drizzle-orm";

import {
  sql as fragmentSql,
  type SqlFragment,
} from "../../../query/sql-fragment";
import {
  type ClaimOwnerColumnNames,
  claimOwnerMatchesSql,
} from "../../../store/claims/axis";
import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  DeleteUniqueParams,
  HardDeleteUniquesByNodeIdsParams,
  InsertUniqueParams,
  SqlDialect,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import { quotedColumn, type Tables } from "./shared";

type InsertUniqueDialectBuilder = (
  tables: Tables,
  params: InsertUniqueParams,
) => SQL;

/**
 * The owner columns of the uniques relation, by physical column name — the
 * one owner {@link claimOwnerMatchesSql} is handed instead of a re-spelled
 * qualification decision.
 */
function ownerColumnNames(uniques: Tables["uniques"]): ClaimOwnerColumnNames {
  return {
    nodeId: uniques.nodeId.name,
    concreteKind: uniques.concreteKind.name,
  };
}

/**
 * The proposed row's owner columns, as bound values — the single-row builders'
 * rendering of the `proposed` side of {@link claimOwnerMatchesSql}.
 */
function boundOwnerColumn(
  uniques: Tables["uniques"],
  params: InsertUniqueParams,
): (columnName: string) => SqlFragment {
  return (columnName) =>
    columnName === uniques.nodeId.name ?
      fragmentSql`${params.nodeId}`
    : fragmentSql`${params.concreteKind}`;
}

/**
 * The batch builder's rendering of the `proposed` side of
 * {@link claimOwnerMatchesSql}: the row `ON CONFLICT DO UPDATE` is about to
 * write, read back off `excluded`.
 */
function excludedColumnFragment(columnName: string): SqlFragment {
  return fragmentSql`excluded.${fragmentSql.identifier(columnName)}`;
}

/**
 * Builds an INSERT query for a uniqueness claim (SQLite).
 *
 * Uses ON CONFLICT with a conditional update that only succeeds if:
 * 1. The existing claim belongs to the same node — the OWNER PAIR
 *    `(concrete_kind, node_id)`, because ids are unique only per kind — OR
 * 2. The existing claim is soft-deleted (can be reused)
 *
 * If a different live node holds this key, the conflict handler leaves the
 * row unchanged, and RETURNING shows the conflicting owner.
 */
function buildInsertUniqueSqlite(
  tables: Tables,
  params: InsertUniqueParams,
): SQL {
  const { uniques } = tables;

  const columns = sql.raw(
    `"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}", "${uniques.nodeId.name}", "${uniques.concreteKind.name}", "${uniques.deletedAt.name}"`,
  );
  const conflictColumns = sql.raw(
    `"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}"`,
  );

  const ownerMatches = toDrizzleSql(
    claimOwnerMatchesSql(
      (columnName) => fragmentSql.identifier(columnName),
      boundOwnerColumn(uniques, params),
      ownerColumnNames(uniques),
    ),
    "sqlite",
  );

  return sql`
    INSERT INTO ${uniques} (${columns})
    VALUES (
      ${params.graphId}, ${params.nodeKind}, ${params.constraintName},
      ${params.key}, ${params.nodeId}, ${params.concreteKind}, ${sql.raw("NULL")}
    )
    ON CONFLICT (${conflictColumns})
    DO UPDATE SET
      ${quotedColumn(uniques.nodeId)} = CASE
        WHEN ${ownerMatches} THEN ${params.nodeId}
        WHEN ${quotedColumn(uniques.deletedAt)} IS NOT NULL THEN ${params.nodeId}
        ELSE ${quotedColumn(uniques.nodeId)}
      END,
      ${quotedColumn(uniques.concreteKind)} = CASE
        WHEN ${ownerMatches} THEN ${params.concreteKind}
        WHEN ${quotedColumn(uniques.deletedAt)} IS NOT NULL THEN ${params.concreteKind}
        ELSE ${quotedColumn(uniques.concreteKind)}
      END,
      ${quotedColumn(uniques.deletedAt)} = CASE
        WHEN ${ownerMatches} THEN NULL
        WHEN ${quotedColumn(uniques.deletedAt)} IS NOT NULL THEN NULL
        ELSE ${quotedColumn(uniques.deletedAt)}
      END
    RETURNING
      ${quotedColumn(uniques.nodeId)} as node_id,
      ${quotedColumn(uniques.concreteKind)} as concrete_kind
  `;
}

/**
 * Builds an INSERT query for a uniqueness claim (PostgreSQL).
 *
 * Uses ON CONFLICT with a conditional update that only succeeds if:
 * 1. The existing claim belongs to the same node — the OWNER PAIR
 *    `(concrete_kind, node_id)`, because ids are unique only per kind — OR
 * 2. The existing claim is soft-deleted (can be reused)
 *
 * If a different live node holds this key, the conflict handler leaves the
 * row unchanged, and RETURNING shows the conflicting owner.
 */
function buildInsertUniquePostgres(
  tables: Tables,
  params: InsertUniqueParams,
): SQL {
  const { uniques } = tables;

  const columns = sql.raw(
    `"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}", "${uniques.nodeId.name}", "${uniques.concreteKind.name}", "${uniques.deletedAt.name}"`,
  );
  const conflictColumns = sql.raw(
    `"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}"`,
  );

  const tableName = getTableName(uniques);
  const existingColumnFragment = (columnName: string): SqlFragment =>
    fragmentSql`${fragmentSql.identifier(tableName)}.${fragmentSql.identifier(columnName)}`;
  const existingColumn = (column: Readonly<{ name: string }>) =>
    toDrizzleSql(existingColumnFragment(column.name), "postgres");

  const ownerMatches = toDrizzleSql(
    claimOwnerMatchesSql(
      (columnName) => existingColumnFragment(columnName),
      boundOwnerColumn(uniques, params),
      ownerColumnNames(uniques),
    ),
    "postgres",
  );

  return sql`
    INSERT INTO ${uniques} (${columns})
    VALUES (
      ${params.graphId}, ${params.nodeKind}, ${params.constraintName},
      ${params.key}, ${params.nodeId}, ${params.concreteKind}, ${sql.raw("NULL")}
    )
    ON CONFLICT (${conflictColumns})
    DO UPDATE SET
      ${quotedColumn(uniques.nodeId)} = CASE
        WHEN ${ownerMatches} THEN ${params.nodeId}
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN ${params.nodeId}
        ELSE ${existingColumn(uniques.nodeId)}
      END,
      ${quotedColumn(uniques.concreteKind)} = CASE
        WHEN ${ownerMatches} THEN ${params.concreteKind}
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN ${params.concreteKind}
        ELSE ${existingColumn(uniques.concreteKind)}
      END,
      ${quotedColumn(uniques.deletedAt)} = CASE
        WHEN ${ownerMatches} THEN NULL
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN NULL
        ELSE ${existingColumn(uniques.deletedAt)}
      END
    RETURNING
      ${quotedColumn(uniques.nodeId)} as node_id,
      ${quotedColumn(uniques.concreteKind)} as concrete_kind
  `;
}

const UNIQUE_INSERT_BUILDERS: Record<SqlDialect, InsertUniqueDialectBuilder> = {
  postgres: buildInsertUniquePostgres,
  sqlite: buildInsertUniqueSqlite,
};

/**
 * Builds an INSERT query for a uniqueness entry.
 * Returns the node_id that now holds the key (may differ from input if conflict).
 */
export function buildInsertUnique(
  tables: Tables,
  dialect: SqlDialect,
  params: InsertUniqueParams,
): SQL {
  const builder = UNIQUE_INSERT_BUILDERS[dialect];
  return builder(tables, params);
}

/**
 * Builds a multi-row INSERT for uniqueness claims with the same conflict
 * semantics as {@link buildInsertUnique}, expressed against `excluded`
 * (the proposed row) instead of per-statement bound values. RETURNING
 * exposes `(node_kind, constraint_name, key, node_id, concrete_kind)` for
 * every row — ON CONFLICT DO UPDATE returns updated rows too — so the caller
 * can attribute each entry's final OWNER PAIR and raise a uniqueness error for
 * the ones a different live node holds. `concrete_kind` is load-bearing in that
 * list: without it two batch rows sharing an id under different kinds would
 * both read their own `node_id` back and both be accepted.
 *
 * Callers must not pass two entries with the same conflict target
 * (`node_kind`, `constraint_name`, `key`): a multi-row upsert cannot
 * affect one row twice.
 */
export function buildInsertUniqueBatch(
  tables: Tables,
  dialect: SqlDialect,
  entries: readonly InsertUniqueParams[],
): SQL {
  const { uniques } = tables;

  const columns = sql.raw(
    `"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}", "${uniques.nodeId.name}", "${uniques.concreteKind.name}", "${uniques.deletedAt.name}"`,
  );
  const conflictColumns = sql.raw(
    `"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}"`,
  );

  // Mirror the single-row builders' dialect split for references to the
  // EXISTING row inside DO UPDATE: Postgres qualifies with the table name,
  // SQLite uses the bare quoted column. This is the batch builder's own
  // switch — claimOwnerMatchesSql only composes whatever renderer it is
  // handed.
  const tableName = getTableName(uniques);
  const existingColumnFragment = (columnName: string): SqlFragment => {
    switch (dialect) {
      case "postgres": {
        return fragmentSql`${fragmentSql.identifier(tableName)}.${fragmentSql.identifier(columnName)}`;
      }
      case "sqlite": {
        return fragmentSql.identifier(columnName);
      }
      default: {
        return dialect satisfies never;
      }
    }
  };

  const existingColumn = (column: Readonly<{ name: string }>) =>
    toDrizzleSql(existingColumnFragment(column.name), dialect);
  const excludedColumn = (column: Readonly<{ name: string }>) =>
    toDrizzleSql(excludedColumnFragment(column.name), dialect);

  const ownerMatches = toDrizzleSql(
    claimOwnerMatchesSql(
      (columnName) => existingColumnFragment(columnName),
      (columnName) => excludedColumnFragment(columnName),
      ownerColumnNames(uniques),
    ),
    dialect,
  );

  const valueRows = sql.join(
    entries.map(
      (params) =>
        sql`(${params.graphId}, ${params.nodeKind}, ${params.constraintName}, ${params.key}, ${params.nodeId}, ${params.concreteKind}, ${sql.raw("NULL")})`,
    ),
    sql`, `,
  );

  return sql`
    INSERT INTO ${uniques} (${columns})
    VALUES ${valueRows}
    ON CONFLICT (${conflictColumns})
    DO UPDATE SET
      ${quotedColumn(uniques.nodeId)} = CASE
        WHEN ${ownerMatches} THEN ${excludedColumn(uniques.nodeId)}
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN ${excludedColumn(uniques.nodeId)}
        ELSE ${existingColumn(uniques.nodeId)}
      END,
      ${quotedColumn(uniques.concreteKind)} = CASE
        WHEN ${ownerMatches} THEN ${excludedColumn(uniques.concreteKind)}
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN ${excludedColumn(uniques.concreteKind)}
        ELSE ${existingColumn(uniques.concreteKind)}
      END,
      ${quotedColumn(uniques.deletedAt)} = CASE
        WHEN ${ownerMatches} THEN NULL
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN NULL
        ELSE ${existingColumn(uniques.deletedAt)}
      END
    RETURNING
      ${quotedColumn(uniques.nodeKind)} as node_kind,
      ${quotedColumn(uniques.constraintName)} as constraint_name,
      ${quotedColumn(uniques.key)} as key,
      ${quotedColumn(uniques.nodeId)} as node_id,
      ${quotedColumn(uniques.concreteKind)} as concrete_kind
  `;
}

/**
 * Builds the owner-scoped soft DELETE that releases a uniqueness claim.
 * Uses raw column name in SET clause.
 *
 * The owner pair `(concrete_kind, node_id)` is always part of the predicate:
 * a release gives up the claims THIS node holds, never a namesake's under
 * another kind and never one that predates this node's write. `nodeKind`
 * additionally restricts the release to one claim axis — see
 * {@link DeleteUniqueParams} for the two shapes and who issues each.
 */
export function buildDeleteUnique(
  tables: Tables,
  params: DeleteUniqueParams,
  timestamp: string,
): SQL {
  const { uniques } = tables;

  const axisTerm =
    params.nodeKind === undefined ?
      sql``
    : sql` AND ${uniques.nodeKind} = ${params.nodeKind}`;

  return sql`
    UPDATE ${uniques}
    SET ${quotedColumn(uniques.deletedAt)} = ${timestamp}
    WHERE ${uniques.graphId} = ${params.graphId}
      AND ${uniques.concreteKind} = ${params.concreteKind}
      AND ${uniques.nodeId} = ${params.nodeId}
      AND ${uniques.constraintName} = ${params.constraintName}
      AND ${uniques.key} = ${params.key}${axisTerm}
      AND ${uniques.deletedAt} IS NULL
  `;
}

/**
 * Builds a hard DELETE query for all uniqueness entries for a node.
 */
export function buildHardDeleteUniquesByNode(
  tables: Tables,
  graphId: string,
  concreteKind: string,
  nodeId: string,
): SQL {
  return buildHardDeleteUniquesByNodeIds(tables, {
    graphId,
    concreteKind,
    nodeIds: [nodeId],
  });
}

/**
 * Builds a hard DELETE for every uniqueness entry owned by concrete nodes.
 */
export function buildHardDeleteUniquesByNodeIds(
  tables: Tables,
  params: HardDeleteUniquesByNodeIdsParams,
): SQL {
  const { uniques } = tables;

  return sql`
    DELETE FROM ${uniques}
    WHERE ${uniques.graphId} = ${params.graphId}
      AND ${uniques.concreteKind} = ${params.concreteKind}
      AND ${uniques.nodeId} IN (${sql.join(
        params.nodeIds.map((nodeId) => sql`${nodeId}`),
        sql`, `,
      )})
  `;
}

// Re-exported from its new owner so `operations/strategy.ts:117,256,597-600`
// sees no change.
export { buildHardDeleteUniquesByConcreteKind } from "../../../store/claims/removal-sql";

/**
 * Builds a SELECT query to check for uniqueness violations.
 */
export function buildCheckUnique(
  tables: Tables,
  params: CheckUniqueParams,
): SQL {
  const { uniques } = tables;

  if (params.includeDeleted) {
    return sql`
      SELECT * FROM ${uniques}
      WHERE ${uniques.graphId} = ${params.graphId}
        AND ${uniques.nodeKind} = ${params.nodeKind}
        AND ${uniques.constraintName} = ${params.constraintName}
        AND ${uniques.key} = ${params.key}
    `;
  }

  return sql`
    SELECT * FROM ${uniques}
    WHERE ${uniques.graphId} = ${params.graphId}
      AND ${uniques.nodeKind} = ${params.nodeKind}
      AND ${uniques.constraintName} = ${params.constraintName}
      AND ${uniques.key} = ${params.key}
      AND ${uniques.deletedAt} IS NULL
  `;
}

/**
 * Builds a SELECT query to batch-check uniqueness entries by multiple keys.
 */
export function buildCheckUniqueBatch(
  tables: Tables,
  params: CheckUniqueBatchParams,
): SQL {
  const { uniques } = tables;

  const keyPlaceholders = sql.join(
    params.keys.map((key) => sql`${key}`),
    sql`, `,
  );

  if (params.includeDeleted) {
    return sql`
      SELECT * FROM ${uniques}
      WHERE ${uniques.graphId} = ${params.graphId}
        AND ${uniques.nodeKind} = ${params.nodeKind}
        AND ${uniques.constraintName} = ${params.constraintName}
        AND ${uniques.key} IN (${keyPlaceholders})
    `;
  }

  return sql`
    SELECT * FROM ${uniques}
    WHERE ${uniques.graphId} = ${params.graphId}
      AND ${uniques.nodeKind} = ${params.nodeKind}
      AND ${uniques.constraintName} = ${params.constraintName}
      AND ${uniques.key} IN (${keyPlaceholders})
      AND ${uniques.deletedAt} IS NULL
  `;
}
