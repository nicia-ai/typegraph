import { type SQL, sql } from "drizzle-orm";

import type {
  DeleteNodeParams,
  HardDeleteNodeParams,
  InsertNodeParams,
  UpdateNodeParams,
} from "../../types";
import {
  nodeColumnList,
  quotedColumn,
  sqlNull,
  type Tables,
} from "./shared";

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
  const columns = nodeColumnList(nodes);

  return sql`
    INSERT INTO ${nodes} (${columns})
    VALUES (
      ${params.graphId}, ${params.kind}, ${params.id}, ${propsJson},
      1, ${sqlNull(params.validFrom)}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
    RETURNING *
  `;
}

/**
 * Builds an INSERT query for a node without RETURNING payload.
 */
export function buildInsertNodeNoReturn(
  tables: Tables,
  params: InsertNodeParams,
  timestamp: string,
): SQL {
  const { nodes } = tables;
  const propsJson = JSON.stringify(params.props);
  const columns = nodeColumnList(nodes);

  return sql`
    INSERT INTO ${nodes} (${columns})
    VALUES (
      ${params.graphId}, ${params.kind}, ${params.id}, ${propsJson},
      1, ${sqlNull(params.validFrom)}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
  `;
}

/**
 * Builds a batched INSERT query for nodes without RETURNING payload.
 */
export function buildInsertNodesBatch(
  tables: Tables,
  params: readonly InsertNodeParams[],
  timestamp: string,
): SQL {
  const { nodes } = tables;
  const columns = nodeColumnList(nodes);
  const values = params.map((nodeParams) => {
    const propsJson = JSON.stringify(nodeParams.props);
    return sql`(${nodeParams.graphId}, ${nodeParams.kind}, ${nodeParams.id}, ${propsJson}, 1, ${sqlNull(nodeParams.validFrom)}, ${sqlNull(nodeParams.validTo)}, ${timestamp}, ${timestamp})`;
  });

  return sql`
    INSERT INTO ${nodes} (${columns})
    VALUES ${sql.join(values, sql`, `)}
  `;
}

/**
 * Builds a batched INSERT query for nodes with RETURNING *.
 */
export function buildInsertNodesBatchReturning(
  tables: Tables,
  params: readonly InsertNodeParams[],
  timestamp: string,
): SQL {
  const { nodes } = tables;
  const columns = nodeColumnList(nodes);
  const values = params.map((nodeParams) => {
    const propsJson = JSON.stringify(nodeParams.props);
    return sql`(${nodeParams.graphId}, ${nodeParams.kind}, ${nodeParams.id}, ${propsJson}, 1, ${sqlNull(nodeParams.validFrom)}, ${sqlNull(nodeParams.validTo)}, ${timestamp}, ${timestamp})`;
  });

  return sql`
    INSERT INTO ${nodes} (${columns})
    VALUES ${sql.join(values, sql`, `)}
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
 * Builds a SELECT query to get multiple nodes by kind and ids.
 * Returns nodes regardless of deletion status (store layer handles filtering).
 */
export function buildGetNodes(
  tables: Tables,
  graphId: string,
  kind: string,
  ids: readonly string[],
): SQL {
  const { nodes } = tables;
  const idPlaceholders = sql.join(
    ids.map((nodeId) => sql`${nodeId}`),
    sql`, `,
  );

  return sql`
    SELECT * FROM ${nodes}
    WHERE ${nodes.graphId} = ${graphId}
      AND ${nodes.kind} = ${kind}
      AND ${nodes.id} IN (${idPlaceholders})
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

  const setParts: SQL[] = [
    sql`${quotedColumn(nodes.props)} = ${propsJson}`,
    sql`${quotedColumn(nodes.updatedAt)} = ${timestamp}`,
  ];

  if (params.incrementVersion) {
    setParts.push(
      sql`${quotedColumn(nodes.version)} = ${quotedColumn(nodes.version)} + 1`,
    );
  }

  if (params.validTo !== undefined) {
    setParts.push(sql`${quotedColumn(nodes.validTo)} = ${params.validTo}`);
  }

  if (params.clearDeleted) {
    setParts.push(sql`${quotedColumn(nodes.deletedAt)} = NULL`);
  }

  const setClause = sql.join(setParts, sql`, `);

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

  return sql`
    UPDATE ${nodes}
    SET ${quotedColumn(nodes.deletedAt)} = ${timestamp}
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
