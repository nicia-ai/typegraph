import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

import { type TemporalMode } from "../../../core/types";
import type {
  CountEdgesByKindParams,
  CountNodesByKindParams,
  FindEdgesByEndpointSetParams,
  FindEdgesByHeterogeneousEndpointSetParams,
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
    temporalMode?: TemporalMode;
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
    if (params.asOf === undefined) {
      throw new Error(`asOf timestamp is required for temporal mode "${mode}"`);
    }
    conditions.push(
      sql`(${table.validFrom} IS NULL OR ${table.validFrom} <= ${params.asOf})`,
      sql`(${table.validTo} IS NULL OR ${table.validTo} > ${params.asOf})`,
    );
  }

  return conditions;
}

/**
 * Builds a query to find nodes by kind.
 *
 * Two pagination shapes are supported:
 * - Offset pagination (`limit` + `offset`): keeps the historical
 *   `ORDER BY created_at DESC` ordering and adds `id DESC` as a
 *   deterministic tiebreaker so shared timestamps don't shuffle rows.
 * - Keyset pagination (`orderBy: "id"` + optional `after`): iterates
 *   by `id ASC` for stability under concurrent writes and shared
 *   timestamps. Required by `rebuildFulltextIndex`.
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

  if (params.orderBy === "id" && params.after !== undefined) {
    conditions.push(sql`${nodes.id} > ${params.after}`);
  }

  const whereClause = sql.join(conditions, sql` AND `);

  const orderByClause =
    params.orderBy === "id" ?
      sql`${nodes.id} ASC`
    : sql`${nodes.createdAt} DESC, ${nodes.id} DESC`;

  if (params.limit !== undefined && params.offset !== undefined) {
    return sql`
      SELECT * FROM ${nodes}
      WHERE ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT ${params.limit} OFFSET ${params.offset}
    `;
  }

  if (params.limit !== undefined) {
    return sql`
      SELECT * FROM ${nodes}
      WHERE ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT ${params.limit}
    `;
  }

  return sql`
    SELECT * FROM ${nodes}
    WHERE ${whereClause}
    ORDER BY ${orderByClause}
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

/** Builds an `IN (...)` membership predicate over a non-empty id list. */
function buildIdSetCondition(
  column: SQLWrapper,
  ids: readonly string[],
): SQL {
  return sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

/**
 * The edge read ordering in its two equivalent forms. `qualified` addresses the
 * edges table directly; `bare` addresses the derived table the per-endpoint
 * `ROW_NUMBER()` wrapper selects from, which re-exposes the same column names
 * under a different relation name. Both come from here so the window's ordering
 * and the statement's final ordering cannot drift apart.
 */
function buildEdgeOrdering(
  tables: Tables,
  orderBy: FindEdgesByKindParams["orderBy"],
): Readonly<{ qualified: SQL; bare: SQL }> {
  const { edges } = tables;
  return orderBy === "id" ?
      { qualified: sql`${edges.id} ASC`, bare: sql.raw(`"id" ASC`) }
    : {
        qualified: sql`${edges.createdAt} DESC, ${edges.id} DESC`,
        bare: sql.raw(`"created_at" DESC, "id" DESC`),
      };
}

/**
 * Builds a query to find edges by kind with optional endpoint filters.
 *
 * Pagination mirrors {@link buildFindNodesByKind}:
 * - Offset pagination (`limit` + `offset`): keeps the historical
 *   `ORDER BY created_at DESC` and adds `id DESC` as a deterministic tiebreaker
 *   so a non-unique `created_at` can no longer shuffle rows across pages.
 * - Keyset pagination (`orderBy: "id"` + optional `after`): iterates by `id ASC`
 *   over the unique `id`, a TOTAL order, so a full enumeration can neither skip
 *   nor duplicate a row even when many edges share a `created_at`.
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

  if (params.orderBy === "id" && params.after !== undefined) {
    conditions.push(sql`${edges.id} > ${params.after}`);
  }

  const whereClause = sql.join(conditions, sql` AND `);

  const { qualified: orderByClause } = buildEdgeOrdering(
    tables,
    params.orderBy,
  );

  if (params.limit !== undefined && params.offset !== undefined) {
    return sql`
      SELECT * FROM ${edges}
      WHERE ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT ${params.limit} OFFSET ${params.offset}
    `;
  }

  if (params.limit !== undefined) {
    return sql`
      SELECT * FROM ${edges}
      WHERE ${whereClause}
      ORDER BY ${orderByClause}
      LIMIT ${params.limit}
    `;
  }

  return sql`
    SELECT * FROM ${edges}
    WHERE ${whereClause}
    ORDER BY ${orderByClause}
  `;
}

/**
 * Builds a query to read the edges of a SET of endpoints.
 *
 * The id list compiles to `IN (...)` on the fanned-out side, scoped to one
 * `endpointKind` so the predicate is a prefix seek on the edge relation's
 * system index rather than a scan. `limitPerEndpoint` wraps the read in a
 * `ROW_NUMBER()` partitioned by that same column, capping each endpoint's rows
 * inside the statement instead of in the caller.
 *
 * Ordering matches {@link buildFindEdgesByKind}'s default so a set read
 * returns each endpoint's edges in the same order the singleton read does.
 */
export function buildFindEdgesByEndpointSet(
  tables: Tables,
  params: FindEdgesByEndpointSetParams,
  endpointIds: readonly string[],
): SQL {
  const { edges } = tables;
  const fromSide = params.side === "from";
  const kindColumn = fromSide ? edges.fromKind : edges.toKind;
  const idColumn = fromSide ? edges.fromId : edges.toId;

  const whereClause = sql.join(
    [
      sql`${edges.graphId} = ${params.graphId}`,
      sql`${edges.kind} = ${params.kind}`,
      ...buildTemporalConditions(edges, params),
      sql`${kindColumn} = ${params.endpointKind}`,
      buildIdSetCondition(idColumn, endpointIds),
    ],
    sql` AND `,
  );

  const { qualified: orderByClause, bare: derivedOrderByClause } =
    buildEdgeOrdering(tables, undefined);

  if (params.limitPerEndpoint === undefined) {
    return sql`
      SELECT * FROM ${edges}
      WHERE ${whereClause}
      ORDER BY ${orderByClause}
    `;
  }

  const ranked = sql`
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY ${idColumn} ORDER BY ${orderByClause}
    ) AS endpoint_rank
    FROM ${edges}
    WHERE ${whereClause}
  `;
  return sql`
    SELECT * FROM (${ranked}) AS ranked_edges
    WHERE endpoint_rank <= ${params.limitPerEndpoint}
    ORDER BY ${derivedOrderByClause}
  `;
}

/**
 * Builds a multi-kind edge read from a heterogeneous endpoint relation.
 *
 * Joining a `VALUES` relation lets both engines seek the composite endpoint
 * index without generating one SQL branch for every licensed edge/source-kind
 * combination.
 */
export function buildFindEdgesByHeterogeneousEndpointSet(
  tables: Tables,
  params: FindEdgesByHeterogeneousEndpointSetParams,
  endpoints: FindEdgesByHeterogeneousEndpointSetParams["endpoints"],
  edgeKinds: readonly string[],
): SQL {
  const { edges } = tables;
  const fromSide = params.side === "from";
  const kindColumn = fromSide ? edges.fromKind : edges.toKind;
  const idColumn = fromSide ? edges.fromId : edges.toId;
  const requestedKind = sql.raw(`requested_endpoints."endpoint_kind"`);
  const requestedId = sql.raw(`requested_endpoints."endpoint_id"`);
  const requestedOppositeKind = sql.raw(
    `requested_endpoints."opposite_kind"`,
  );
  const requestedOppositeId = sql.raw(`requested_endpoints."opposite_id"`);
  const oppositeKindColumn = fromSide ? edges.toKind : edges.fromKind;
  const oppositeIdColumn = fromSide ? edges.toId : edges.fromId;
  const readsExactPairs = endpoints[0]?.opposite !== undefined;
  const requestedRows = sql.join(
    endpoints.map((endpoint) =>
      endpoint.opposite === undefined ?
        sql`(${endpoint.kind}, ${endpoint.id}, NULL, NULL)`
      : sql`(${endpoint.kind}, ${endpoint.id}, ${endpoint.opposite.kind}, ${endpoint.opposite.id})`,
    ),
    sql`, `,
  );
  const whereClause = sql.join(
    [
      sql`${edges.graphId} = ${params.graphId}`,
      buildIdSetCondition(edges.kind, edgeKinds),
      ...buildTemporalConditions(edges, params),
    ],
    sql` AND `,
  );
  const oppositeJoinClause =
    readsExactPairs ?
      sql`
        AND ${oppositeKindColumn} = ${requestedOppositeKind}
        AND ${oppositeIdColumn} = ${requestedOppositeId}
      `
    : sql``;
  const joinClause = sql`
    FROM ${edges}
    INNER JOIN requested_endpoints
      ON ${kindColumn} = ${requestedKind}
     AND ${idColumn} = ${requestedId}
     ${oppositeJoinClause}
    WHERE ${whereClause}
  `;
  const { qualified: orderByClause, bare: derivedOrderByClause } =
    buildEdgeOrdering(tables, undefined);

  if (params.limitPerEndpoint === undefined) {
    return sql`
      WITH requested_endpoints(endpoint_kind, endpoint_id, opposite_kind, opposite_id) AS (
        VALUES ${requestedRows}
      )
      SELECT ${edges}.*
      ${joinClause}
      ORDER BY ${orderByClause}
    `;
  }

  const ranked = sql`
    SELECT ${edges}.*, ROW_NUMBER() OVER (
      PARTITION BY ${requestedKind}, ${requestedId}, ${requestedOppositeKind}, ${requestedOppositeId}
      ORDER BY ${orderByClause}
    ) AS endpoint_rank
    ${joinClause}
  `;
  return sql`
    WITH requested_endpoints(endpoint_kind, endpoint_id, opposite_kind, opposite_id) AS (
      VALUES ${requestedRows}
    )
    SELECT * FROM (${ranked}) AS ranked_edges
    WHERE endpoint_rank <= ${params.limitPerEndpoint}
    ORDER BY ${derivedOrderByClause}
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
