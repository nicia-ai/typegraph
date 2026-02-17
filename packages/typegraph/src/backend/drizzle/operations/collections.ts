import { type SQL, sql } from "drizzle-orm";

import type {
  CountEdgesByKindParams,
  CountNodesByKindParams,
  FindEdgesByKindParams,
  FindNodesByKindParams,
} from "../../types";
import type { Tables } from "./shared";

/**
 * Builds temporal and soft-delete SQL conditions.
 *
 * - `includeTombstones`: no filtering at all (overrides excludeDeleted)
 * - `current` / `asOf`: exclude deleted + filter by validity range
 * - `includeEnded`: exclude deleted only
 * - no temporalMode: just apply excludeDeleted (backward-compatible)
 */
function buildTemporalConditions(
  table: Pick<Tables["nodes"], "deletedAt" | "validFrom" | "validTo">,
  params: Readonly<{
    temporalMode?: string;
    asOf?: string;
    excludeDeleted?: boolean;
  }>,
): SQL[] {
  const conditions: SQL[] = [];
  const mode = params.temporalMode;

  if (mode === "includeTombstones") return conditions;

  if (params.excludeDeleted !== false) {
    conditions.push(sql`${table.deletedAt} IS NULL`);
  }

  if (mode === "current" || mode === "asOf") {
    const asOf = params.asOf!;
    conditions.push(
      sql`(${table.validFrom} IS NULL OR ${table.validFrom} <= ${asOf})`,
      sql`(${table.validTo} IS NULL OR ${table.validTo} > ${asOf})`,
    );
  }

  return conditions;
}

/**
 * Builds a query to find nodes by kind.
 */
export function buildFindNodesByKind(
  tables: Tables,
  params: FindNodesByKindParams,
): SQL {
  const { nodes } = tables;

  const conditions: SQL[] = [
    sql`${nodes.graphId} = ${params.graphId}`,
    sql`${nodes.kind} = ${params.kind}`,
    ...buildTemporalConditions(nodes, params),
  ];

  const whereClause = sql.join(conditions, sql` AND `);

  if (params.limit !== undefined && params.offset !== undefined) {
    return sql`
      SELECT * FROM ${nodes}
      WHERE ${whereClause}
      ORDER BY ${nodes.createdAt} DESC
      LIMIT ${params.limit} OFFSET ${params.offset}
    `;
  }

  if (params.limit !== undefined) {
    return sql`
      SELECT * FROM ${nodes}
      WHERE ${whereClause}
      ORDER BY ${nodes.createdAt} DESC
      LIMIT ${params.limit}
    `;
  }

  return sql`
    SELECT * FROM ${nodes}
    WHERE ${whereClause}
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

  const conditions: SQL[] = [
    sql`${nodes.graphId} = ${params.graphId}`,
    sql`${nodes.kind} = ${params.kind}`,
    ...buildTemporalConditions(nodes, params),
  ];

  const whereClause = sql.join(conditions, sql` AND `);

  return sql`
    SELECT COUNT(*) as count FROM ${nodes}
    WHERE ${whereClause}
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

  const conditions: SQL[] = [
    sql`${edges.graphId} = ${params.graphId}`,
    sql`${edges.kind} = ${params.kind}`,
    ...buildTemporalConditions(edges, params),
  ];

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

  const conditions: SQL[] = [
    sql`${edges.graphId} = ${params.graphId}`,
    sql`${edges.kind} = ${params.kind}`,
    ...buildTemporalConditions(edges, params),
  ];

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
