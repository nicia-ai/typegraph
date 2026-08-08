import { type SQL, sql } from "drizzle-orm";

import type {
  CountEdgesFromParams,
  DeleteEdgeParams,
  DeleteEdgesBatchParams,
  EdgeExistsBetweenParams,
  FindEdgesConnectedToParams,
  HardDeleteEdgeParams,
  InsertEdgeParams,
  UpdateEdgeParams,
} from "../../types";
import {
  edgeColumnList,
  expectedValidFromPredicate,
  quotedColumn,
  resolveValidFrom,
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
      ${propsJson}, ${sqlNull(resolveValidFrom(params.validFrom, timestamp))}, ${sqlNull(params.validTo)},
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
      ${propsJson}, ${sqlNull(resolveValidFrom(params.validFrom, timestamp))}, ${sqlNull(params.validTo)},
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
    return sql`(${edgeParams.graphId}, ${edgeParams.id}, ${edgeParams.kind}, ${edgeParams.fromKind}, ${edgeParams.fromId}, ${edgeParams.toKind}, ${edgeParams.toId}, ${propsJson}, ${sqlNull(resolveValidFrom(edgeParams.validFrom, timestamp))}, ${sqlNull(edgeParams.validTo)}, ${timestamp}, ${timestamp})`;
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
    return sql`(${edgeParams.graphId}, ${edgeParams.id}, ${edgeParams.kind}, ${edgeParams.fromKind}, ${edgeParams.fromId}, ${edgeParams.toKind}, ${edgeParams.toId}, ${propsJson}, ${sqlNull(resolveValidFrom(edgeParams.validFrom, timestamp))}, ${sqlNull(edgeParams.validTo)}, ${timestamp}, ${timestamp})`;
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
export function buildGetEdge(tables: Tables, graphId: string, id: string): SQL {
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

  return sql`
    SELECT * FROM ${edges}
    WHERE ${edges.graphId} = ${graphId}
      AND ${edges.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
  `;
}

/**
 * The `AND <column> = ?` conjunction an edge write carries for every immutable
 * identity component its caller ASSERTED (see {@link UpdateEdgeParams}'s
 * `kind` / `fromKind` / `fromId` / `toKind` / `toId`).
 *
 * This is what makes a kind-scoped edge write SELF-VERIFYING: the identity the
 * caller checked and the row the statement mutates are resolved by ONE `WHERE`,
 * in ONE statement, so nothing a concurrent session does between the check and
 * the write can re-point the id at a row that fails an assertion this write
 * made. Kind alone is not sufficient for that: a `hardDelete` + recreate under
 * the SAME kind with DIFFERENT endpoints slips past a kind-only predicate, and
 * an upsert that asserted endpoints would then have written to an edge whose
 * endpoints it never checked.
 *
 * Only ASSERTED components are emitted. A component the caller left undefined
 * is one it made no claim about, and inventing a predicate for it would refuse
 * writes that are legitimate: the node delete cascade states no kind at all
 * because it removes every connected edge whatever its kind, and a plain
 * `update` states kind without endpoints because the collection is kind-scoped
 * and never looked at where the edge points.
 *
 * One owner: every edge write statement that accepts an expected identity
 * builds its predicate here, so `UPDATE`, soft `DELETE`, and hard `DELETE`
 * cannot drift into disagreeing about what "the same edge" means.
 */
function expectedIdentityPredicate(
  tables: Tables,
  expected: Readonly<{
    kind?: string;
    fromKind?: string;
    fromId?: string;
    toKind?: string;
    toId?: string;
  }>,
): SQL {
  const { edges } = tables;
  const parts = [
    expected.kind === undefined ?
      undefined
    : sql` AND ${edges.kind} = ${expected.kind}`,
    expected.fromKind === undefined ?
      undefined
    : sql` AND ${edges.fromKind} = ${expected.fromKind}`,
    expected.fromId === undefined ?
      undefined
    : sql` AND ${edges.fromId} = ${expected.fromId}`,
    expected.toKind === undefined ?
      undefined
    : sql` AND ${edges.toKind} = ${expected.toKind}`,
    expected.toId === undefined ?
      undefined
    : sql` AND ${edges.toId} = ${expected.toId}`,
  ].filter((part): part is SQL => part !== undefined);
  return parts.length === 0 ? sql.empty() : sql.join(parts, sql``);
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

  // A resurrection that names `valid_from` is asserting a COMPLETE window, so
  // both endpoints are rewritten together — an omitted `valid_to` reopens the
  // window rather than leaving the tombstoned incarnation's upper bound behind
  // to truncate it. A resurrection that omits `valid_from` keeps the stored
  // window (only an explicit `valid_to` moves), which is what
  // `getOrCreateByEndpoints` relies on when it cardinality-checks the
  // tombstone's own `valid_to`.
  if (params.clearDeleted && params.validFrom !== undefined) {
    setParts.push(
      sql`${quotedColumn(edges.validFrom)} = ${sqlNull(resolveValidFrom(params.validFrom, timestamp))}`,
      sql`${quotedColumn(edges.validTo)} = ${sqlNull(params.validTo)}`,
    );
  } else if (params.validTo !== undefined) {
    setParts.push(sql`${quotedColumn(edges.validTo)} = ${params.validTo}`);
  }

  if (params.clearDeleted) {
    setParts.push(sql`${quotedColumn(edges.deletedAt)} = NULL`);
  }

  const setClause = sql.join(setParts, sql`, `);
  const expectedIdentity = expectedIdentityPredicate(tables, params);
  // The bound the CALLER read, when it read one. Not part of the immutable
  // identity above — `valid_from` is mutable — so it is built by the shared
  // NULL-safe helper both entities use; see
  // `UpdateEdgeParams.expectedValidFrom`.
  const expectedValidFrom = expectedValidFromPredicate(
    edges.validFrom,
    params.expectedValidFrom,
  );

  if (params.clearDeleted) {
    return sql`
      UPDATE ${edges}
      SET ${setClause}
      WHERE ${edges.graphId} = ${params.graphId}
        AND ${edges.id} = ${params.id}${expectedIdentity}${expectedValidFrom}
      RETURNING *
    `;
  }

  return sql`
    UPDATE ${edges}
    SET ${setClause}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.id} = ${params.id}${expectedIdentity}${expectedValidFrom}
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
      AND ${edges.id} = ${params.id}${expectedIdentityPredicate(tables, params.kind === undefined ? {} : { kind: params.kind })}
      AND ${edges.deletedAt} IS NULL
  `;
}

/**
 * Builds one soft-delete UPDATE covering a batch of edge ids. Matches
 * {@link buildDeleteEdge} semantics per row (idempotent via the
 * `deleted_at IS NULL` guard); the caller chunks ids to the bind budget.
 */
export function buildDeleteEdgesBatch(
  tables: Tables,
  params: DeleteEdgesBatchParams,
  timestamp: string,
): SQL {
  const { edges } = tables;

  return sql`
    UPDATE ${edges}
    SET ${quotedColumn(edges.deletedAt)} = ${timestamp}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.id} IN (${sql.join(
        params.ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND ${edges.deletedAt} IS NULL
  `;
}

/**
 * Builds one hard DELETE covering a batch of edge ids. Matches
 * {@link buildHardDeleteEdge} semantics per row; the caller chunks ids to
 * the bind budget.
 */
export function buildHardDeleteEdgesBatch(
  tables: Tables,
  params: DeleteEdgesBatchParams,
): SQL {
  const { edges } = tables;

  return sql`
    DELETE FROM ${edges}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.id} IN (${sql.join(
        params.ids.map((id) => sql`${id}`),
        sql`, `,
      )})
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
      AND ${edges.id} = ${params.id}${expectedIdentityPredicate(tables, params.kind === undefined ? {} : { kind: params.kind })}
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
