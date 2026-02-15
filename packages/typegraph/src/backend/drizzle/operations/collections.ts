import { type SQL, sql } from "drizzle-orm";

import type {
  CountEdgesByKindParams,
  CountNodesByKindParams,
  FindEdgesByKindParams,
  FindNodesByKindParams,
} from "../../types";
import type { Tables } from "./shared";

/**
 * Builds a query to find nodes by kind.
 */
export function buildFindNodesByKind(
  tables: Tables,
  params: FindNodesByKindParams,
): SQL {
  const { nodes } = tables;
  const excludeDeleted = params.excludeDeleted ?? true;

  const baseCondition = excludeDeleted
    ? sql`${nodes.graphId} = ${params.graphId} AND ${nodes.kind} = ${params.kind} AND ${nodes.deletedAt} IS NULL`
    : sql`${nodes.graphId} = ${params.graphId} AND ${nodes.kind} = ${params.kind}`;

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

  const whereClause = sql.join(conditions, sql` AND `);

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

  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    SELECT COUNT(*) as count FROM ${edges}
    WHERE ${whereClause}
  `;
}
