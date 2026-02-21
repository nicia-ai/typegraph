import { getTableName, type SQL, sql } from "drizzle-orm";

import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  DeleteUniqueParams,
  InsertUniqueParams,
  SqlDialect,
} from "../../types";
import { quotedColumn, type Tables } from "./shared";

type InsertUniqueDialectBuilder = (
  tables: Tables,
  params: InsertUniqueParams,
) => SQL;

/**
 * Builds an INSERT query for a uniqueness entry (SQLite).
 *
 * Uses ON CONFLICT with a conditional update that only succeeds if:
 * 1. The existing entry belongs to the same node (safe update), OR
 * 2. The existing entry is soft-deleted (can be reused)
 *
 * If a different live node holds this key, the conflict handler leaves the
 * row unchanged, and RETURNING will show the conflicting node_id.
 */
function buildInsertUniqueSqlite(
  tables: Tables,
  params: InsertUniqueParams,
): SQL {
  const { uniques } = tables;

  const columns = sql.raw(`"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}", "${uniques.nodeId.name}", "${uniques.concreteKind.name}", "${uniques.deletedAt.name}"`);
  const conflictColumns = sql.raw(`"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}"`);

  return sql`
    INSERT INTO ${uniques} (${columns})
    VALUES (
      ${params.graphId}, ${params.nodeKind}, ${params.constraintName},
      ${params.key}, ${params.nodeId}, ${params.concreteKind}, ${sql.raw("NULL")}
    )
    ON CONFLICT (${conflictColumns})
    DO UPDATE SET
      ${quotedColumn(uniques.nodeId)} = CASE
        WHEN ${quotedColumn(uniques.nodeId)} = ${params.nodeId} THEN ${params.nodeId}
        WHEN ${quotedColumn(uniques.deletedAt)} IS NOT NULL THEN ${params.nodeId}
        ELSE ${quotedColumn(uniques.nodeId)}
      END,
      ${quotedColumn(uniques.concreteKind)} = CASE
        WHEN ${quotedColumn(uniques.nodeId)} = ${params.nodeId} THEN ${params.concreteKind}
        WHEN ${quotedColumn(uniques.deletedAt)} IS NOT NULL THEN ${params.concreteKind}
        ELSE ${quotedColumn(uniques.concreteKind)}
      END,
      ${quotedColumn(uniques.deletedAt)} = CASE
        WHEN ${quotedColumn(uniques.nodeId)} = ${params.nodeId} THEN NULL
        WHEN ${quotedColumn(uniques.deletedAt)} IS NOT NULL THEN NULL
        ELSE ${quotedColumn(uniques.deletedAt)}
      END
    RETURNING ${quotedColumn(uniques.nodeId)} as node_id
  `;
}

/**
 * Builds an INSERT query for a uniqueness entry (PostgreSQL).
 *
 * Uses ON CONFLICT with a conditional update that only succeeds if:
 * 1. The existing entry belongs to the same node (safe update), OR
 * 2. The existing entry is soft-deleted (can be reused)
 *
 * If a different live node holds this key, the conflict handler leaves the
 * row unchanged, and RETURNING will show the conflicting node_id.
 */
function buildInsertUniquePostgres(
  tables: Tables,
  params: InsertUniqueParams,
): SQL {
  const { uniques } = tables;

  const columns = sql.raw(`"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}", "${uniques.nodeId.name}", "${uniques.concreteKind.name}", "${uniques.deletedAt.name}"`);
  const conflictColumns = sql.raw(`"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}"`);

  const tableName = getTableName(uniques);
  const existingColumn = (column: { name: string }) =>
    sql.raw(`"${tableName}"."${column.name}"`);

  return sql`
    INSERT INTO ${uniques} (${columns})
    VALUES (
      ${params.graphId}, ${params.nodeKind}, ${params.constraintName},
      ${params.key}, ${params.nodeId}, ${params.concreteKind}, ${sql.raw("NULL")}
    )
    ON CONFLICT (${conflictColumns})
    DO UPDATE SET
      ${quotedColumn(uniques.nodeId)} = CASE
        WHEN ${existingColumn(uniques.nodeId)} = ${params.nodeId} THEN ${params.nodeId}
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN ${params.nodeId}
        ELSE ${existingColumn(uniques.nodeId)}
      END,
      ${quotedColumn(uniques.concreteKind)} = CASE
        WHEN ${existingColumn(uniques.nodeId)} = ${params.nodeId} THEN ${params.concreteKind}
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN ${params.concreteKind}
        ELSE ${existingColumn(uniques.concreteKind)}
      END,
      ${quotedColumn(uniques.deletedAt)} = CASE
        WHEN ${existingColumn(uniques.nodeId)} = ${params.nodeId} THEN NULL
        WHEN ${existingColumn(uniques.deletedAt)} IS NOT NULL THEN NULL
        ELSE ${existingColumn(uniques.deletedAt)}
      END
    RETURNING ${quotedColumn(uniques.nodeId)} as node_id
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
 * Builds a soft DELETE query for a uniqueness entry.
 * Uses raw column name in SET clause.
 */
export function buildDeleteUnique(
  tables: Tables,
  params: DeleteUniqueParams,
  timestamp: string,
): SQL {
  const { uniques } = tables;

  return sql`
    UPDATE ${uniques}
    SET ${quotedColumn(uniques.deletedAt)} = ${timestamp}
    WHERE ${uniques.graphId} = ${params.graphId}
      AND ${uniques.nodeKind} = ${params.nodeKind}
      AND ${uniques.constraintName} = ${params.constraintName}
      AND ${uniques.key} = ${params.key}
      AND ${uniques.deletedAt} IS NULL
  `;
}

/**
 * Builds a hard DELETE query for all uniqueness entries for a node.
 */
export function buildHardDeleteUniquesByNode(
  tables: Tables,
  graphId: string,
  nodeId: string,
): SQL {
  const { uniques } = tables;

  return sql`
    DELETE FROM ${uniques}
    WHERE ${uniques.graphId} = ${graphId}
      AND ${uniques.nodeId} = ${nodeId}
  `;
}

/**
 * Builds a hard DELETE query for all embeddings for a node.
 */
export function buildHardDeleteEmbeddingsByNode(
  tables: Tables,
  graphId: string,
  nodeKind: string,
  nodeId: string,
): SQL {
  const { embeddings } = tables;

  return sql`
    DELETE FROM ${embeddings}
    WHERE ${embeddings.graphId} = ${graphId}
      AND ${embeddings.nodeKind} = ${nodeKind}
      AND ${embeddings.nodeId} = ${nodeId}
  `;
}

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
