/**
 * Schema-parameterized query builders for TypeGraph.
 *
 * These functions generate Drizzle SQL objects that can be executed
 * by any Drizzle database instance. Table and column references are
 * passed as parameters, enabling customizable table names.
 */
import { getTableName, type SQL, sql } from "drizzle-orm";

/**
 * Converts undefined to SQL NULL for use in template literals.
 * Drizzle doesn't handle undefined in sql`` templates correctly.
 */
function sqlNull(value: string | undefined): SQL | string {
  return value ?? sql.raw("NULL");
}

import { getDialect } from "../../query/dialect";
import type {
  CheckUniqueParams,
  CountEdgesByKindParams,
  CountEdgesFromParams,
  CountNodesByKindParams,
  DeleteEdgeParams,
  DeleteEmbeddingParams,
  DeleteNodeParams,
  DeleteUniqueParams,
  Dialect,
  EdgeExistsBetweenParams,
  FindEdgesByKindParams,
  FindEdgesConnectedToParams,
  FindNodesByKindParams,
  HardDeleteEdgeParams,
  HardDeleteNodeParams,
  InsertEdgeParams,
  InsertNodeParams,
  InsertSchemaParams,
  InsertUniqueParams,
  UpdateEdgeParams,
  UpdateNodeParams,
  UpsertEmbeddingParams,
  VectorMetric,
  VectorSearchParams,
} from "../types";
import type { PostgresTables } from "./schema/postgres";
import type { SqliteTables } from "./schema/sqlite";

/**
 * Union type for all supported table configurations.
 */
type Tables = SqliteTables | PostgresTables;

// ============================================================
// Node Operations
// ============================================================

/**
 * Builds an INSERT query for a node.
 * Uses raw column names in the column list (required by SQL syntax).
 */
export function buildInsertNode(
  tables: Tables,
  params: InsertNodeParams,
  timestamp: string,
): SQL {
  const { nodes } = tables;
  const propsJson = JSON.stringify(params.props);

  // Column list uses raw identifiers (not table-qualified)
  const cols = sql.raw(`"${nodes.graphId.name}", "${nodes.kind.name}", "${nodes.id.name}", "${nodes.props.name}", "${nodes.version.name}", "${nodes.validFrom.name}", "${nodes.validTo.name}", "${nodes.createdAt.name}", "${nodes.updatedAt.name}"`);

  return sql`
    INSERT INTO ${nodes} (${cols})
    VALUES (
      ${params.graphId}, ${params.kind}, ${params.id}, ${propsJson},
      1, ${sqlNull(params.validFrom)}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
    RETURNING *
  `;
}

/**
 * Builds a SELECT query to get a node by kind and id.
 * Returns the node regardless of deletion status (store layer handles filtering).
 */
export function buildGetNode(
  tables: Tables,
  graphId: string,
  kind: string,
  id: string,
): SQL {
  const { nodes } = tables;

  return sql`
    SELECT * FROM ${nodes}
    WHERE ${nodes.graphId} = ${graphId}
      AND ${nodes.kind} = ${kind}
      AND ${nodes.id} = ${id}
  `;
}

/**
 * Builds an UPDATE query for a node.
 * Uses raw column names in SET clause (required by SQL syntax).
 */
export function buildUpdateNode(
  tables: Tables,
  params: UpdateNodeParams,
  timestamp: string,
): SQL {
  const { nodes } = tables;
  const propsJson = JSON.stringify(params.props);

  // Helper for raw column name
  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  // Build SET clause parts
  const setParts: SQL[] = [
    sql`${col(nodes.props)} = ${propsJson}`,
    sql`${col(nodes.updatedAt)} = ${timestamp}`,
  ];

  if (params.incrementVersion) {
    setParts.push(sql`${col(nodes.version)} = ${col(nodes.version)} + 1`);
  }

  if (params.validTo !== undefined) {
    setParts.push(sql`${col(nodes.validTo)} = ${params.validTo}`);
  }

  if (params.clearDeleted) {
    setParts.push(sql`${col(nodes.deletedAt)} = NULL`);
  }

  // Join SET parts with commas
  const setClause = sql.join(setParts, sql`, `);

  // Build WHERE clause - skip deleted_at check if clearDeleted is set
  if (params.clearDeleted) {
    return sql`
      UPDATE ${nodes}
      SET ${setClause}
      WHERE ${nodes.graphId} = ${params.graphId}
        AND ${nodes.kind} = ${params.kind}
        AND ${nodes.id} = ${params.id}
      RETURNING *
    `;
  }

  return sql`
    UPDATE ${nodes}
    SET ${setClause}
    WHERE ${nodes.graphId} = ${params.graphId}
      AND ${nodes.kind} = ${params.kind}
      AND ${nodes.id} = ${params.id}
      AND ${nodes.deletedAt} IS NULL
    RETURNING *
  `;
}

/**
 * Builds a soft DELETE query for a node (sets deleted_at).
 * Uses raw column name in SET clause.
 */
export function buildDeleteNode(
  tables: Tables,
  params: DeleteNodeParams,
  timestamp: string,
): SQL {
  const { nodes } = tables;
  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  return sql`
    UPDATE ${nodes}
    SET ${col(nodes.deletedAt)} = ${timestamp}
    WHERE ${nodes.graphId} = ${params.graphId}
      AND ${nodes.kind} = ${params.kind}
      AND ${nodes.id} = ${params.id}
      AND ${nodes.deletedAt} IS NULL
  `;
}

/**
 * Builds a hard DELETE query for a node (permanent removal).
 */
export function buildHardDeleteNode(
  tables: Tables,
  params: HardDeleteNodeParams,
): SQL {
  const { nodes } = tables;

  return sql`
    DELETE FROM ${nodes}
    WHERE ${nodes.graphId} = ${params.graphId}
      AND ${nodes.kind} = ${params.kind}
      AND ${nodes.id} = ${params.id}
  `;
}

// ============================================================
// Edge Operations
// ============================================================

/**
 * Builds an INSERT query for an edge.
 * Uses raw column names in the column list (required by SQL syntax).
 */
export function buildInsertEdge(
  tables: Tables,
  params: InsertEdgeParams,
  timestamp: string,
): SQL {
  const { edges } = tables;
  const propsJson = JSON.stringify(params.props);

  const cols = sql.raw(`"${edges.graphId.name}", "${edges.id.name}", "${edges.kind.name}", "${edges.fromKind.name}", "${edges.fromId.name}", "${edges.toKind.name}", "${edges.toId.name}", "${edges.props.name}", "${edges.validFrom.name}", "${edges.validTo.name}", "${edges.createdAt.name}", "${edges.updatedAt.name}"`);

  return sql`
    INSERT INTO ${edges} (${cols})
    VALUES (
      ${params.graphId}, ${params.id}, ${params.kind},
      ${params.fromKind}, ${params.fromId}, ${params.toKind}, ${params.toId},
      ${propsJson}, ${sqlNull(params.validFrom)}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
    RETURNING *
  `;
}

/**
 * Builds a SELECT query to get an edge by id.
 * Returns the edge regardless of deletion status (store layer handles filtering).
 */
export function buildGetEdge(
  tables: Tables,
  graphId: string,
  id: string,
): SQL {
  const { edges } = tables;

  return sql`
    SELECT * FROM ${edges}
    WHERE ${edges.graphId} = ${graphId}
      AND ${edges.id} = ${id}
  `;
}

/**
 * Builds an UPDATE query for an edge.
 * Uses raw column names in SET clause.
 */
export function buildUpdateEdge(
  tables: Tables,
  params: UpdateEdgeParams,
  timestamp: string,
): SQL {
  const { edges } = tables;
  const propsJson = JSON.stringify(params.props);
  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  if (params.validTo !== undefined) {
    return sql`
      UPDATE ${edges}
      SET ${col(edges.props)} = ${propsJson},
          ${col(edges.validTo)} = ${params.validTo},
          ${col(edges.updatedAt)} = ${timestamp}
      WHERE ${edges.graphId} = ${params.graphId}
        AND ${edges.id} = ${params.id}
        AND ${edges.deletedAt} IS NULL
      RETURNING *
    `;
  }

  return sql`
    UPDATE ${edges}
    SET ${col(edges.props)} = ${propsJson},
        ${col(edges.updatedAt)} = ${timestamp}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.id} = ${params.id}
      AND ${edges.deletedAt} IS NULL
    RETURNING *
  `;
}

/**
 * Builds a soft DELETE query for an edge (sets deleted_at).
 * Uses raw column name in SET clause.
 */
export function buildDeleteEdge(
  tables: Tables,
  params: DeleteEdgeParams,
  timestamp: string,
): SQL {
  const { edges } = tables;
  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  return sql`
    UPDATE ${edges}
    SET ${col(edges.deletedAt)} = ${timestamp}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.id} = ${params.id}
      AND ${edges.deletedAt} IS NULL
  `;
}

/**
 * Builds a hard DELETE query for an edge (permanent removal).
 */
export function buildHardDeleteEdge(
  tables: Tables,
  params: HardDeleteEdgeParams,
): SQL {
  const { edges } = tables;

  return sql`
    DELETE FROM ${edges}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.id} = ${params.id}
  `;
}

// ============================================================
// Unique Constraint Operations
// ============================================================

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

  const cols = sql.raw(`"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}", "${uniques.nodeId.name}", "${uniques.concreteKind.name}", "${uniques.deletedAt.name}"`);

  // Use raw column names for ON CONFLICT clause (SQLite requires bare names)
  const conflictCols = sql.raw(`"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}"`);

  // Helper to reference columns without table prefix in UPDATE SET
  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  // Conditional upsert: only update if same node OR deleted
  // The CASE expressions ensure conflicting entries are left unchanged
  return sql`
    INSERT INTO ${uniques} (${cols})
    VALUES (
      ${params.graphId}, ${params.nodeKind}, ${params.constraintName},
      ${params.key}, ${params.nodeId}, ${params.concreteKind}, ${sql.raw("NULL")}
    )
    ON CONFLICT (${conflictCols})
    DO UPDATE SET
      ${col(uniques.nodeId)} = CASE
        WHEN ${col(uniques.nodeId)} = ${params.nodeId} THEN ${params.nodeId}
        WHEN ${col(uniques.deletedAt)} IS NOT NULL THEN ${params.nodeId}
        ELSE ${col(uniques.nodeId)}
      END,
      ${col(uniques.concreteKind)} = CASE
        WHEN ${col(uniques.nodeId)} = ${params.nodeId} THEN ${params.concreteKind}
        WHEN ${col(uniques.deletedAt)} IS NOT NULL THEN ${params.concreteKind}
        ELSE ${col(uniques.concreteKind)}
      END,
      ${col(uniques.deletedAt)} = CASE
        WHEN ${col(uniques.nodeId)} = ${params.nodeId} THEN NULL
        WHEN ${col(uniques.deletedAt)} IS NOT NULL THEN NULL
        ELSE ${col(uniques.deletedAt)}
      END
    RETURNING ${col(uniques.nodeId)} as node_id
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

  const cols = sql.raw(`"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}", "${uniques.nodeId.name}", "${uniques.concreteKind.name}", "${uniques.deletedAt.name}"`);
  const conflictCols = sql.raw(`"${uniques.graphId.name}", "${uniques.nodeKind.name}", "${uniques.constraintName.name}", "${uniques.key.name}"`);

  // Helper to reference columns without table prefix in UPDATE SET (for left side of assignment)
  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  // Helper to reference the existing row's column value (table-qualified for PostgreSQL 18+)
  // In ON CONFLICT DO UPDATE, unqualified column references are ambiguous
  const tableName = getTableName(uniques);
  const existingCol = (c: { name: string }) => sql.raw(`"${tableName}"."${c.name}"`);

  // Conditional upsert: only update if same node OR deleted
  // The CASE expressions ensure conflicting entries are left unchanged
  // PostgreSQL 18+ requires table-qualified column references in CASE WHEN
  return sql`
    INSERT INTO ${uniques} (${cols})
    VALUES (
      ${params.graphId}, ${params.nodeKind}, ${params.constraintName},
      ${params.key}, ${params.nodeId}, ${params.concreteKind}, ${sql.raw("NULL")}
    )
    ON CONFLICT (${conflictCols})
    DO UPDATE SET
      ${col(uniques.nodeId)} = CASE
        WHEN ${existingCol(uniques.nodeId)} = ${params.nodeId} THEN ${params.nodeId}
        WHEN ${existingCol(uniques.deletedAt)} IS NOT NULL THEN ${params.nodeId}
        ELSE ${existingCol(uniques.nodeId)}
      END,
      ${col(uniques.concreteKind)} = CASE
        WHEN ${existingCol(uniques.nodeId)} = ${params.nodeId} THEN ${params.concreteKind}
        WHEN ${existingCol(uniques.deletedAt)} IS NOT NULL THEN ${params.concreteKind}
        ELSE ${existingCol(uniques.concreteKind)}
      END,
      ${col(uniques.deletedAt)} = CASE
        WHEN ${existingCol(uniques.nodeId)} = ${params.nodeId} THEN NULL
        WHEN ${existingCol(uniques.deletedAt)} IS NOT NULL THEN NULL
        ELSE ${existingCol(uniques.deletedAt)}
      END
    RETURNING ${col(uniques.nodeId)} as node_id
  `;
}

/**
 * Builds an INSERT query for a uniqueness entry.
 * Returns the node_id that now holds the key (may differ from input if conflict).
 */
export function buildInsertUnique(
  tables: Tables,
  dialect: Dialect,
  params: InsertUniqueParams,
): SQL {
  if (dialect === "sqlite") {
    return buildInsertUniqueSqlite(tables, params);
  }
  return buildInsertUniquePostgres(tables, params);
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
  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  return sql`
    UPDATE ${uniques}
    SET ${col(uniques.deletedAt)} = ${timestamp}
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

  return sql`
    SELECT * FROM ${uniques}
    WHERE ${uniques.graphId} = ${params.graphId}
      AND ${uniques.nodeKind} = ${params.nodeKind}
      AND ${uniques.constraintName} = ${params.constraintName}
      AND ${uniques.key} = ${params.key}
      AND ${uniques.deletedAt} IS NULL
  `;
}

// ============================================================
// Edge Cardinality Operations
// ============================================================

/**
 * Builds a query to count edges from a source node.
 */
export function buildCountEdgesFrom(
  tables: Tables,
  params: CountEdgesFromParams,
): SQL {
  const { edges } = tables;

  if (params.activeOnly) {
    return sql`
      SELECT COUNT(*) as count FROM ${edges}
      WHERE ${edges.graphId} = ${params.graphId}
        AND ${edges.kind} = ${params.edgeKind}
        AND ${edges.fromKind} = ${params.fromKind}
        AND ${edges.fromId} = ${params.fromId}
        AND ${edges.deletedAt} IS NULL
        AND ${edges.validTo} IS NULL
    `;
  }

  return sql`
    SELECT COUNT(*) as count FROM ${edges}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.kind} = ${params.edgeKind}
      AND ${edges.fromKind} = ${params.fromKind}
      AND ${edges.fromId} = ${params.fromId}
      AND ${edges.deletedAt} IS NULL
  `;
}

/**
 * Builds a query to check if an edge exists between two nodes.
 */
export function buildEdgeExistsBetween(
  tables: Tables,
  params: EdgeExistsBetweenParams,
): SQL {
  const { edges } = tables;

  return sql`
    SELECT 1 FROM ${edges}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.kind} = ${params.edgeKind}
      AND ${edges.fromKind} = ${params.fromKind}
      AND ${edges.fromId} = ${params.fromId}
      AND ${edges.toKind} = ${params.toKind}
      AND ${edges.toId} = ${params.toId}
      AND ${edges.deletedAt} IS NULL
    LIMIT 1
  `;
}

/**
 * Builds a query to find all edges connected to a node.
 */
export function buildFindEdgesConnectedTo(
  tables: Tables,
  params: FindEdgesConnectedToParams,
): SQL {
  const { edges } = tables;

  return sql`
    SELECT * FROM ${edges}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.deletedAt} IS NULL
      AND (
        (${edges.fromKind} = ${params.nodeKind} AND ${edges.fromId} = ${params.nodeId})
        OR
        (${edges.toKind} = ${params.nodeKind} AND ${edges.toId} = ${params.nodeId})
      )
  `;
}

// ============================================================
// Collection Query Operations
// ============================================================

/**
 * Builds a query to find nodes by kind.
 */
export function buildFindNodesByKind(
  tables: Tables,
  params: FindNodesByKindParams,
): SQL {
  const { nodes } = tables;
  const excludeDeleted = params.excludeDeleted ?? true;

  // Build base query parts
  const baseCondition = excludeDeleted
    ? sql`${nodes.graphId} = ${params.graphId} AND ${nodes.kind} = ${params.kind} AND ${nodes.deletedAt} IS NULL`
    : sql`${nodes.graphId} = ${params.graphId} AND ${nodes.kind} = ${params.kind}`;

  // Handle pagination
  if (params.limit !== undefined && params.offset !== undefined) {
    return sql`
      SELECT * FROM ${nodes}
      WHERE ${baseCondition}
      ORDER BY ${nodes.createdAt} DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `;
  }

  if (params.limit !== undefined) {
    return sql`
      SELECT * FROM ${nodes}
      WHERE ${baseCondition}
      ORDER BY ${nodes.createdAt} DESC
      LIMIT ${params.limit}
    `;
  }

  return sql`
    SELECT * FROM ${nodes}
    WHERE ${baseCondition}
    ORDER BY ${nodes.createdAt} DESC
  `;
}

/**
 * Builds a query to count nodes by kind.
 */
export function buildCountNodesByKind(
  tables: Tables,
  params: CountNodesByKindParams,
): SQL {
  const { nodes } = tables;
  const excludeDeleted = params.excludeDeleted ?? true;

  if (excludeDeleted) {
    return sql`
      SELECT COUNT(*) as count FROM ${nodes}
      WHERE ${nodes.graphId} = ${params.graphId}
        AND ${nodes.kind} = ${params.kind}
        AND ${nodes.deletedAt} IS NULL
    `;
  }

  return sql`
    SELECT COUNT(*) as count FROM ${nodes}
    WHERE ${nodes.graphId} = ${params.graphId}
      AND ${nodes.kind} = ${params.kind}
  `;
}

/**
 * Builds a query to find edges by kind with optional endpoint filters.
 */
export function buildFindEdgesByKind(
  tables: Tables,
  params: FindEdgesByKindParams,
): SQL {
  const { edges } = tables;
  const excludeDeleted = params.excludeDeleted ?? true;

  // Build conditions dynamically
  const conditions: SQL[] = [
    sql`${edges.graphId} = ${params.graphId}`,
    sql`${edges.kind} = ${params.kind}`,
  ];

  if (excludeDeleted) {
    conditions.push(sql`${edges.deletedAt} IS NULL`);
  }

  if (params.fromKind !== undefined) {
    conditions.push(sql`${edges.fromKind} = ${params.fromKind}`);
  }

  if (params.fromId !== undefined) {
    conditions.push(sql`${edges.fromId} = ${params.fromId}`);
  }

  if (params.toKind !== undefined) {
    conditions.push(sql`${edges.toKind} = ${params.toKind}`);
  }

  if (params.toId !== undefined) {
    conditions.push(sql`${edges.toId} = ${params.toId}`);
  }

  // Join conditions with AND
  const whereClause = sql.join(conditions, sql` AND `);

  // Handle pagination
  if (params.limit !== undefined && params.offset !== undefined) {
    return sql`
      SELECT * FROM ${edges}
      WHERE ${whereClause}
      ORDER BY ${edges.createdAt} DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `;
  }

  if (params.limit !== undefined) {
    return sql`
      SELECT * FROM ${edges}
      WHERE ${whereClause}
      ORDER BY ${edges.createdAt} DESC
      LIMIT ${params.limit}
    `;
  }

  return sql`
    SELECT * FROM ${edges}
    WHERE ${whereClause}
    ORDER BY ${edges.createdAt} DESC
  `;
}

/**
 * Builds a query to count edges by kind with optional endpoint filters.
 */
export function buildCountEdgesByKind(
  tables: Tables,
  params: CountEdgesByKindParams,
): SQL {
  const { edges } = tables;
  const excludeDeleted = params.excludeDeleted ?? true;

  // Build conditions dynamically
  const conditions: SQL[] = [
    sql`${edges.graphId} = ${params.graphId}`,
    sql`${edges.kind} = ${params.kind}`,
  ];

  if (excludeDeleted) {
    conditions.push(sql`${edges.deletedAt} IS NULL`);
  }

  if (params.fromKind !== undefined) {
    conditions.push(sql`${edges.fromKind} = ${params.fromKind}`);
  }

  if (params.fromId !== undefined) {
    conditions.push(sql`${edges.fromId} = ${params.fromId}`);
  }

  if (params.toKind !== undefined) {
    conditions.push(sql`${edges.toKind} = ${params.toKind}`);
  }

  if (params.toId !== undefined) {
    conditions.push(sql`${edges.toId} = ${params.toId}`);
  }

  // Join conditions with AND
  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    SELECT COUNT(*) as count FROM ${edges}
    WHERE ${whereClause}
  `;
}

// ============================================================
// Schema Operations
// ============================================================

/**
 * Builds an INSERT query for a schema version (SQLite).
 * Uses raw column names in the column list (required by SQL syntax).
 * Converts boolean to number for SQLite compatibility.
 */
function buildInsertSchemaSqlite(
  tables: Tables,
  params: InsertSchemaParams,
  timestamp: string,
): SQL {
  const { schemaVersions } = tables;
  const schemaDocumentJson = JSON.stringify(params.schemaDoc);
  // Use raw SQL for boolean to ensure it's stored as integer, not float
  // (drizzle's ${1} produces '1.0' which breaks Boolean() conversion on read)
  const isActiveValue = params.isActive ? sql.raw("1") : sql.raw("0");

  const cols = sql.raw(`"${schemaVersions.graphId.name}", "${schemaVersions.version.name}", "${schemaVersions.schemaHash.name}", "${schemaVersions.schemaDoc.name}", "${schemaVersions.createdAt.name}", "${schemaVersions.isActive.name}"`);

  return sql`
    INSERT INTO ${schemaVersions} (${cols})
    VALUES (
      ${params.graphId}, ${params.version},
      ${params.schemaHash}, ${schemaDocumentJson},
      ${timestamp}, ${isActiveValue}
    )
    RETURNING *
  `;
}

/**
 * Builds an INSERT query for a schema version (PostgreSQL).
 * Uses raw column names in the column list (required by SQL syntax).
 * Uses boolean values for PostgreSQL's native boolean type.
 */
function buildInsertSchemaPostgres(
  tables: Tables,
  params: InsertSchemaParams,
  timestamp: string,
): SQL {
  const { schemaVersions } = tables;
  const schemaDocumentJson = JSON.stringify(params.schemaDoc);
  // PostgreSQL uses native boolean type
  const isActiveValue = params.isActive ? sql.raw("true") : sql.raw("false");

  const cols = sql.raw(`"${schemaVersions.graphId.name}", "${schemaVersions.version.name}", "${schemaVersions.schemaHash.name}", "${schemaVersions.schemaDoc.name}", "${schemaVersions.createdAt.name}", "${schemaVersions.isActive.name}"`);

  return sql`
    INSERT INTO ${schemaVersions} (${cols})
    VALUES (
      ${params.graphId}, ${params.version},
      ${params.schemaHash}, ${schemaDocumentJson},
      ${timestamp}, ${isActiveValue}
    )
    RETURNING *
  `;
}

/**
 * Builds an INSERT query for a schema version.
 */
export function buildInsertSchema(
  tables: Tables,
  params: InsertSchemaParams,
  timestamp: string,
  dialect: Dialect = "sqlite",
): SQL {
  if (dialect === "postgres") {
    return buildInsertSchemaPostgres(tables, params, timestamp);
  }
  return buildInsertSchemaSqlite(tables, params, timestamp);
}

/**
 * Builds a SELECT query to get the active schema for a graph.
 */
export function buildGetActiveSchema(
  tables: Tables,
  graphId: string,
  dialect: Dialect = "sqlite",
): SQL {
  const { schemaVersions } = tables;
  const adapter = getDialect(dialect);

  return sql`
    SELECT * FROM ${schemaVersions}
    WHERE ${schemaVersions.graphId} = ${graphId}
      AND ${schemaVersions.isActive} = ${adapter.booleanLiteral(true)}
  `;
}

/**
 * Builds a SELECT query to get a specific schema version.
 */
export function buildGetSchemaVersion(
  tables: Tables,
  graphId: string,
  version: number,
): SQL {
  const { schemaVersions } = tables;

  return sql`
    SELECT * FROM ${schemaVersions}
    WHERE ${schemaVersions.graphId} = ${graphId}
      AND ${schemaVersions.version} = ${version}
  `;
}

/**
 * Builds UPDATE queries to set the active schema version.
 * Returns two queries: first deactivates all, second activates the specified version.
 * Uses raw column names in SET clause (SQLite doesn't allow table prefix there).
 */
export function buildSetActiveSchema(
  tables: Tables,
  graphId: string,
  version: number,
  dialect: Dialect = "sqlite",
): { deactivateAll: SQL; activateVersion: SQL } {
  const { schemaVersions } = tables;
  const adapter = getDialect(dialect);
  // Helper to reference columns without table prefix in SET clause only
  // (SQLite doesn't allow table prefix in SET, but WHERE works fine with drizzle refs)
  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  const deactivateAll = sql`
    UPDATE ${schemaVersions}
    SET ${col(schemaVersions.isActive)} = ${adapter.booleanLiteral(false)}
    WHERE ${schemaVersions.graphId} = ${graphId}
  `;

  const activateVersion = sql`
    UPDATE ${schemaVersions}
    SET ${col(schemaVersions.isActive)} = ${adapter.booleanLiteral(true)}
    WHERE ${schemaVersions.graphId} = ${graphId}
      AND ${schemaVersions.version} = ${version}
  `;

  return { deactivateAll, activateVersion };
}

// ============================================================
// Embedding Operations
// ============================================================

/**
 * Validates that all values in an array are finite numbers.
 * Throws if any value is NaN, Infinity, or not a number.
 */
function assertFiniteNumberArray(array: readonly number[], name: string): void {
  for (const [index, value] of array.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `${name}[${index}] must be a finite number, got: ${value}`,
      );
    }
  }
}

/**
 * Formats an embedding array as a pgvector literal string.
 * Validates all values are finite numbers first.
 */
function formatEmbeddingLiteral(embedding: readonly number[]): string {
  assertFiniteNumberArray(embedding, "embedding");
  return `[${embedding.join(",")}]`;
}

/**
 * Builds an UPSERT query for an embedding (PostgreSQL).
 * Uses ON CONFLICT to update existing embeddings.
 */
export function buildUpsertEmbeddingPostgres(
  tables: PostgresTables,
  params: UpsertEmbeddingParams,
  timestamp: string,
): SQL {
  const { embeddings } = tables;

  // Format and validate embedding
  const embeddingLiteral = formatEmbeddingLiteral(params.embedding);

  const cols = sql.raw(
    `"${embeddings.graphId.name}", "${embeddings.nodeKind.name}", "${embeddings.nodeId.name}", "${embeddings.fieldPath.name}", "${embeddings.embedding.name}", "${embeddings.dimensions.name}", "${embeddings.createdAt.name}", "${embeddings.updatedAt.name}"`,
  );

  const conflictCols = sql.raw(
    `"${embeddings.graphId.name}", "${embeddings.nodeKind.name}", "${embeddings.nodeId.name}", "${embeddings.fieldPath.name}"`,
  );

  const col = (c: { name: string }) => sql.raw(`"${c.name}"`);

  return sql`
    INSERT INTO ${embeddings} (${cols})
    VALUES (
      ${params.graphId}, ${params.nodeKind}, ${params.nodeId}, ${params.fieldPath},
      ${embeddingLiteral}::vector, ${params.dimensions}, ${timestamp}, ${timestamp}
    )
    ON CONFLICT (${conflictCols})
    DO UPDATE SET
      ${col(embeddings.embedding)} = ${embeddingLiteral}::vector,
      ${col(embeddings.dimensions)} = ${params.dimensions},
      ${col(embeddings.updatedAt)} = ${timestamp}
  `;
}

/**
 * Builds a DELETE query for an embedding.
 */
export function buildDeleteEmbedding(
  tables: Tables,
  params: DeleteEmbeddingParams,
): SQL {
  const { embeddings } = tables;

  return sql`
    DELETE FROM ${embeddings}
    WHERE ${embeddings.graphId} = ${params.graphId}
      AND ${embeddings.nodeKind} = ${params.nodeKind}
      AND ${embeddings.nodeId} = ${params.nodeId}
      AND ${embeddings.fieldPath} = ${params.fieldPath}
  `;
}

/**
 * Builds a SELECT query to get an embedding.
 */
export function buildGetEmbedding(
  tables: Tables,
  graphId: string,
  nodeKind: string,
  nodeId: string,
  fieldPath: string,
): SQL {
  const { embeddings } = tables;

  return sql`
    SELECT * FROM ${embeddings}
    WHERE ${embeddings.graphId} = ${graphId}
      AND ${embeddings.nodeKind} = ${nodeKind}
      AND ${embeddings.nodeId} = ${nodeId}
      AND ${embeddings.fieldPath} = ${fieldPath}
  `;
}

/**
 * Builds the distance expression for a given metric.
 * Uses parameterized embedding literal to prevent SQL injection.
 */
function buildDistanceExpression(
  embeddingColumn: SQL,
  queryLiteral: string,
  metric: VectorMetric,
): SQL {
  // The query literal is passed as a parameter and cast to vector type
  // This ensures proper escaping by the database driver
  const vectorParam = sql`${queryLiteral}::vector`;

  switch (metric) {
    case "cosine": {
      return sql`(${embeddingColumn} <=> ${vectorParam})`;
    }
    case "l2": {
      return sql`(${embeddingColumn} <-> ${vectorParam})`;
    }
    case "inner_product": {
      return sql`(${embeddingColumn} <#> ${vectorParam})`;
    }
  }
}

/**
 * Builds a vector similarity search query (PostgreSQL).
 * Returns node IDs ordered by similarity (closest first).
 */
export function buildVectorSearchPostgres(
  tables: PostgresTables,
  params: VectorSearchParams,
): SQL {
  const { embeddings } = tables;

  // Format and validate query embedding
  const queryLiteral = formatEmbeddingLiteral(params.queryEmbedding);

  // Build the distance expression using parameterized query literal
  // The embedding column reference and the validated literal are combined safely
  const embeddingColumn = sql`${embeddings.embedding}`;
  const distanceExpr = buildDistanceExpression(
    embeddingColumn,
    queryLiteral,
    params.metric,
  );

  // Build base conditions (all parameterized by Drizzle)
  const conditions = [
    sql`${embeddings.graphId} = ${params.graphId}`,
    sql`${embeddings.nodeKind} = ${params.nodeKind}`,
    sql`${embeddings.fieldPath} = ${params.fieldPath}`,
  ];

  // Add minScore filter if specified
  if (params.minScore !== undefined) {
    // Validate minScore is a finite number
    if (!Number.isFinite(params.minScore)) {
      throw new TypeError(`minScore must be a finite number, got: ${params.minScore}`);
    }
    // minScore is similarity (1.0 = identical), convert to distance threshold
    // For cosine: distance = 1 - similarity, so threshold = 1 - minScore
    const threshold = 1 - params.minScore;
    conditions.push(sql`${distanceExpr} <= ${threshold}`);
  }

  // Validate limit is a positive integer
  if (!Number.isInteger(params.limit) || params.limit <= 0) {
    throw new Error(`limit must be a positive integer, got: ${params.limit}`);
  }

  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    SELECT
      ${embeddings.nodeId} as node_id,
      (1 - (${distanceExpr})) as score
    FROM ${embeddings}
    WHERE ${whereClause}
    ORDER BY ${distanceExpr} ASC
    LIMIT ${params.limit}
  `;
}
