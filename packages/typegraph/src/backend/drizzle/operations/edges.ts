import { type SQL, sql } from "drizzle-orm";

import type {
  CountEdgesFromParams,
  DeleteEdgeParams,
  EdgeExistsBetweenParams,
  FindEdgesConnectedToParams,
  HardDeleteEdgeParams,
  InsertEdgeParams,
  UpdateEdgeParams,
} from "../../types";
import {
  edgeColumnList,
  quotedColumn,
  sqlNull,
  type Tables,
} from "./shared";

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
  const columns = edgeColumnList(edges);

  return sql`
    INSERT INTO ${edges} (${columns})
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
 * Builds an INSERT query for an edge without RETURNING payload.
 */
export function buildInsertEdgeNoReturn(
  tables: Tables,
  params: InsertEdgeParams,
  timestamp: string,
): SQL {
  const { edges } = tables;
  const propsJson = JSON.stringify(params.props);
  const columns = edgeColumnList(edges);

  return sql`
    INSERT INTO ${edges} (${columns})
    VALUES (
      ${params.graphId}, ${params.id}, ${params.kind},
      ${params.fromKind}, ${params.fromId}, ${params.toKind}, ${params.toId},
      ${propsJson}, ${sqlNull(params.validFrom)}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
  `;
}

/**
 * Builds a batched INSERT query for edges without RETURNING payload.
 */
export function buildInsertEdgesBatch(
  tables: Tables,
  params: readonly InsertEdgeParams[],
  timestamp: string,
): SQL {
  const { edges } = tables;
  const columns = edgeColumnList(edges);
  const values = params.map((edgeParams) => {
    const propsJson = JSON.stringify(edgeParams.props);
    return sql`(${edgeParams.graphId}, ${edgeParams.id}, ${edgeParams.kind}, ${edgeParams.fromKind}, ${edgeParams.fromId}, ${edgeParams.toKind}, ${edgeParams.toId}, ${propsJson}, ${sqlNull(edgeParams.validFrom)}, ${sqlNull(edgeParams.validTo)}, ${timestamp}, ${timestamp})`;
  });

  return sql`
    INSERT INTO ${edges} (${columns})
    VALUES ${sql.join(values, sql`, `)}
  `;
}

/**
 * Builds a batched INSERT query for edges with RETURNING *.
 */
export function buildInsertEdgesBatchReturning(
  tables: Tables,
  params: readonly InsertEdgeParams[],
  timestamp: string,
): SQL {
  const { edges } = tables;
  const columns = edgeColumnList(edges);
  const values = params.map((edgeParams) => {
    const propsJson = JSON.stringify(edgeParams.props);
    return sql`(${edgeParams.graphId}, ${edgeParams.id}, ${edgeParams.kind}, ${edgeParams.fromKind}, ${edgeParams.fromId}, ${edgeParams.toKind}, ${edgeParams.toId}, ${propsJson}, ${sqlNull(edgeParams.validFrom)}, ${sqlNull(edgeParams.validTo)}, ${timestamp}, ${timestamp})`;
  });

  return sql`
    INSERT INTO ${edges} (${columns})
    VALUES ${sql.join(values, sql`, `)}
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
 * Builds a SELECT query to get multiple edges by ids.
 * Returns edges regardless of deletion status (store layer handles filtering).
 */
export function buildGetEdges(
  tables: Tables,
  graphId: string,
  ids: readonly string[],
): SQL {
  const { edges } = tables;
  const idPlaceholders = sql.join(
    ids.map((edgeId) => sql`${edgeId}`),
    sql`, `,
  );

  return sql`
    SELECT * FROM ${edges}
    WHERE ${edges.graphId} = ${graphId}
      AND ${edges.id} IN (${idPlaceholders})
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

  const setParts: SQL[] = [
    sql`${quotedColumn(edges.props)} = ${propsJson}`,
    sql`${quotedColumn(edges.updatedAt)} = ${timestamp}`,
  ];

  if (params.validTo !== undefined) {
    setParts.push(sql`${quotedColumn(edges.validTo)} = ${params.validTo}`);
  }

  if (params.clearDeleted) {
    setParts.push(sql`${quotedColumn(edges.deletedAt)} = NULL`);
  }

  const setClause = sql.join(setParts, sql`, `);

  if (params.clearDeleted) {
    return sql`
      UPDATE ${edges}
      SET ${setClause}
      WHERE ${edges.graphId} = ${params.graphId}
        AND ${edges.id} = ${params.id}
      RETURNING *
    `;
  }

  return sql`
    UPDATE ${edges}
    SET ${setClause}
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

  return sql`
    UPDATE ${edges}
    SET ${quotedColumn(edges.deletedAt)} = ${timestamp}
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

/**
 * Builds a hard DELETE query for all edges connected to a node (permanent removal).
 * Deletes edges where the node appears as either source or target.
 */
export function buildHardDeleteEdgesByNode(
  tables: Tables,
  graphId: string,
  nodeKind: string,
  nodeId: string,
): SQL {
  const { edges } = tables;

  return sql`
    DELETE FROM ${edges}
    WHERE ${edges.graphId} = ${graphId}
      AND (
        (${edges.fromKind} = ${nodeKind} AND ${edges.fromId} = ${nodeId})
        OR (${edges.toKind} = ${nodeKind} AND ${edges.toId} = ${nodeId})
      )
  `;
}

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
      AND ${edges.fromKind} = ${params.nodeKind}
      AND ${edges.fromId} = ${params.nodeId}
    UNION ALL
    SELECT * FROM ${edges}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.deletedAt} IS NULL
      AND ${edges.toKind} = ${params.nodeKind}
      AND ${edges.toId} = ${params.nodeId}
      AND NOT (
        ${edges.fromKind} = ${params.nodeKind}
        AND ${edges.fromId} = ${params.nodeId}
      )
  `;
}
