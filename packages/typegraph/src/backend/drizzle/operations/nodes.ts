import { type SQL, sql } from "drizzle-orm";

import { getDialect } from "../../../query/dialect";
import { sql as portableSql } from "../../../query/sql-fragment";
import { resolveStampedValidityLowerBound } from "../../../utils/date";
import type {
  DeleteNodeParams,
  HardDeleteNodeParams,
  InsertNodeParams,
  SchemaWriteFenceParams,
  UpdateNodeParams,
  UpdateNodeSetParams,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import {
  expectedValidFromPredicate,
  nodeColumnList,
  quotedColumn,
  sqlNull,
  type Tables,
} from "./shared";

/**
 * Builds an INSERT query for a node.
 * Uses raw column names in the column list (required by SQL syntax).
 *
 * The stored lower bound is decided by {@link resolveStampedValidityLowerBound}
 * against the very `timestamp` this statement binds into `created_at` /
 * `updated_at`, so a row cannot be stamped with a bound that disagrees with the
 * instant it was created at. Deciding it HERE — below the store, below
 * interchange, below trusted import — is what makes "no write stores a window
 * readable at no coordinate" hold for every `GraphBackend` caller rather than for
 * the store paths one reviewer enumerated.
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
      1, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
    RETURNING *
  `;
}

/**
 * Builds an insert that reports an occupied node primary key as an ordinary
 * no-row result. This is deliberately a `DO NOTHING` rather than a caught
 * duplicate error: PostgreSQL marks a transaction failed after a constraint
 * violation, while this statement keeps the frame usable for the follow-up
 * live/tombstone read.
 */
export function buildInsertNodeIfAbsent(
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
      1, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
    ON CONFLICT (graph_id, kind, id) DO NOTHING
    RETURNING *
  `;
}

/**
 * The one-statement schema-fenced counterpart to `buildInsertNodeIfAbsent`.
 * The caller supplies the dialect-owned lock clause: PostgreSQL uses `FOR
 * SHARE`; SQLite's `BEGIN IMMEDIATE` is already its transaction fence.
 */
export function buildInsertNodeIfAbsentWithSchemaFence(
  tables: Tables,
  params: InsertNodeParams,
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  const { nodes, schemaVersions } = tables;
  const propsJson = JSON.stringify(params.props);
  const columns = nodeColumnList(nodes);

  return sql`
    INSERT INTO ${nodes} (${columns})
    SELECT
      ${params.graphId}, ${params.kind}, ${params.id}, ${propsJson},
      1, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    FROM (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
        AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    ) AS "schema_fence"
    WHERE TRUE
    ON CONFLICT (graph_id, kind, id) DO NOTHING
    RETURNING *
  `;
}

/** Schema-fenced fresh-id node insert; no identity conflict is expected. */
export function buildInsertNodeWithSchemaFence(
  tables: Tables,
  params: InsertNodeParams,
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  const { nodes, schemaVersions } = tables;
  const propsJson = JSON.stringify(params.props);
  const columns = nodeColumnList(nodes);

  return sql`
    INSERT INTO ${nodes} (${columns})
    SELECT
      ${params.graphId}, ${params.kind}, ${params.id}, ${propsJson},
      1, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    FROM (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
        AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    ) AS "schema_fence"
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
      1, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
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
    return sql`(${nodeParams.graphId}, ${nodeParams.kind}, ${nodeParams.id}, ${propsJson}, 1, ${sqlNull(resolveStampedValidityLowerBound(nodeParams.validFrom, nodeParams.validTo, timestamp))}, ${sqlNull(nodeParams.validTo)}, ${timestamp}, ${timestamp})`;
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
    return sql`(${nodeParams.graphId}, ${nodeParams.kind}, ${nodeParams.id}, ${propsJson}, 1, ${sqlNull(resolveStampedValidityLowerBound(nodeParams.validFrom, nodeParams.validTo, timestamp))}, ${sqlNull(nodeParams.validTo)}, ${timestamp}, ${timestamp})`;
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
  // retained (an edge retains it — see `buildUpdateEdge`), so this leg STAMPS a
  // bound when the caller states none, and it makes that choice through the same
  // owner every insert builder uses. Two consequences, both load-bearing. A
  // resurrection carrying only a past `validTo` — which `create` on a tombstoned
  // id reaches with nothing stated — stores NO lower bound instead of a window
  // readable at no coordinate, whoever called the backend (issue #407). And
  // `timestamp` remains only the fallback: the operations layer passes the
  // instant its inverted-window guard measured against as an explicit
  // `validFrom`, so the bound this stores is the bound that was checked rather
  // than a strictly later sample the guard never saw (issue #413).
  if (params.clearDeleted) {
    setParts.push(
      sql`${quotedColumn(nodes.validFrom)} = ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}`,
      sql`${quotedColumn(nodes.validTo)} = ${sqlNull(params.validTo)}`,
    );
  } else if (params.clearValidTo === true) {
    setParts.push(sql`${quotedColumn(nodes.validTo)} = NULL`);
  } else if (params.validTo !== undefined) {
    setParts.push(sql`${quotedColumn(nodes.validTo)} = ${params.validTo}`);
  }

  if (params.clearDeleted) {
    setParts.push(sql`${quotedColumn(nodes.deletedAt)} = NULL`);
  }

  const setClause = sql.join(setParts, sql`, `);
  // The bound the CALLER read, when it read one — see
  // `UpdateNodeParams.expectedValidFrom`. Emitted on both legs: a resurrecting
  // upsert that decided from the tombstone's window is fenced on the same terms
  // as a live-row update.
  const expectedValidFrom = expectedValidFromPredicate(
    nodes.validFrom,
    params.expectedValidFrom,
  );

  if (params.clearDeleted) {
    return sql`
      UPDATE ${nodes}
      SET ${setClause}
      WHERE ${nodes.graphId} = ${params.graphId}
        AND ${nodes.kind} = ${params.kind}
        AND ${nodes.id} = ${params.id}${expectedValidFrom}
        AND ${nodes.deletedAt} IS NOT NULL
      RETURNING *
    `;
  }

  return sql`
    UPDATE ${nodes}
    SET ${setClause}
    WHERE ${nodes.graphId} = ${params.graphId}
      AND ${nodes.kind} = ${params.kind}
      AND ${nodes.id} = ${params.id}${expectedValidFrom}
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
