import { type SQL, sql } from "drizzle-orm";

import { getDialect } from "../../../query/dialect";
import { sql as portableSql } from "../../../query/sql-fragment";
import type {
  DeleteNodeParams,
  HardDeleteNodeParams,
  InsertNodeParams,
  UpdateNodeParams,
  UpdateNodeSetParams,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import {
  nodeColumnList,
  quotedColumn,
  resolveValidFrom,
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
      1, ${sqlNull(resolveValidFrom(params.validFrom, timestamp))}, ${sqlNull(params.validTo)},
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
      1, ${sqlNull(resolveValidFrom(params.validFrom, timestamp))}, ${sqlNull(params.validTo)},
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
    return sql`(${nodeParams.graphId}, ${nodeParams.kind}, ${nodeParams.id}, ${propsJson}, 1, ${sqlNull(resolveValidFrom(nodeParams.validFrom, timestamp))}, ${sqlNull(nodeParams.validTo)}, ${timestamp}, ${timestamp})`;
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
    return sql`(${nodeParams.graphId}, ${nodeParams.kind}, ${nodeParams.id}, ${propsJson}, 1, ${sqlNull(resolveValidFrom(nodeParams.validFrom, timestamp))}, ${sqlNull(nodeParams.validTo)}, ${timestamp}, ${timestamp})`;
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

  return sql`
    SELECT * FROM ${nodes}
    WHERE ${nodes.graphId} = ${graphId}
      AND ${nodes.kind} = ${kind}
      AND ${nodes.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
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

  // A resurrection RESETS the window: `valid_from` is rewritten rather than
  // retained (an edge retains it — see `buildUpdateEdge`). `timestamp` is only
  // the fallback: the operations layer passes the instant its inverted-window
  // guard measured against as an explicit `validFrom`, so the bound this stores
  // is the bound that was checked. Falling back to a locally sampled instant
  // would store a bound strictly later than the one the guard approved (issue
  // #413).
  if (params.clearDeleted) {
    setParts.push(
      sql`${quotedColumn(nodes.validFrom)} = ${sqlNull(resolveValidFrom(params.validFrom, timestamp))}`,
      sql`${quotedColumn(nodes.validTo)} = ${sqlNull(params.validTo)}`,
    );
  } else if (params.validTo !== undefined) {
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
        AND ${nodes.deletedAt} IS NOT NULL
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
 * Builds one set-based update over candidate ids selected by the shared query
 * compiler. The outer graph/kind/live-row predicates are deliberate write
 * fences and must not be delegated solely to the candidate subquery.
 */
export function buildUpdateNodeSet(
  tables: Tables,
  dialect: "sqlite" | "postgres",
  params: UpdateNodeSetParams,
  timestamp: string,
): SQL {
  const { nodes } = tables;
  const adapter = getDialect(dialect);
  const patchedProps = toDrizzleSql(
    adapter.jsonSetProperties(
      portableSql.identifier(nodes.props.name),
      params.patch,
      params.unsetProperties ?? [],
    ),
    dialect,
  );
  const candidateIds = toDrizzleSql(params.candidateIds, dialect);
  const candidateIdColumn = toDrizzleSql(
    portableSql.identifier(params.candidateIdColumn),
    dialect,
  );

  return sql`
    UPDATE ${nodes}
    SET ${quotedColumn(nodes.props)} = ${patchedProps},
        ${quotedColumn(nodes.updatedAt)} = ${timestamp},
        ${quotedColumn(nodes.version)} = ${quotedColumn(nodes.version)} + 1
    WHERE ${nodes.graphId} = ${params.graphId}
      AND ${nodes.kind} = ${params.kind}
      AND ${nodes.deletedAt} IS NULL
      AND ${nodes.id} IN (
        SELECT ${candidateIdColumn}
        FROM (${candidateIds}) AS tg_set_candidates
      )
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
