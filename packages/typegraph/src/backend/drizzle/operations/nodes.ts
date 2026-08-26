import { type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../../errors";
import { getDialect } from "../../../query/dialect";
import { sql as portableSql } from "../../../query/sql-fragment";
import { resolveStampedValidityLowerBound } from "../../../utils/date";
import type {
  AtomicNodeBatchEntry,
  AtomicNodeBatchResultMode,
} from "../../capabilities/atomic-node-batch";
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
  castBoundValueForColumn,
  expectedValidFromPredicate,
  nodeColumnList,
  quotedColumn,
  sqlNull,
  type Tables,
} from "./shared";

function qualifiedColumn(
  alias: string,
  column: Readonly<{ name: string }>,
): SQL {
  return sql.raw(`"${alias}"."${column.name.replaceAll('"', '""')}"`);
}

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
  const conflictColumns = sql.join(
    [nodes.graphId, nodes.kind, nodes.id].map((column) =>
      sql.identifier(column.name),
    ),
    sql`, `,
  );

  return sql`
    INSERT INTO ${nodes} (${columns})
    VALUES (
      ${params.graphId}, ${params.kind}, ${params.id}, ${propsJson},
      1, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
    ON CONFLICT (${conflictColumns}) DO NOTHING
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
  const conflictColumns = sql.join(
    [nodes.graphId, nodes.kind, nodes.id].map((column) =>
      sql.identifier(column.name),
    ),
    sql`, `,
  );

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
    ON CONFLICT (${conflictColumns}) DO NOTHING
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
 * Builds one schema-fenced multi-row node insert with one minimal result per
 * inserted row. Callers need only the inserted count; returning node payloads
 * would waste transport bandwidth for a no-return Store operation.
 * The fence is a CTE so the same active schema row gates every VALUES member;
 * the dialect supplies the lock clause (`FOR SHARE` on PostgreSQL and empty on
 * SQLite, whose native writer boundary supplies the exclusion).
 */
export function buildInsertNodesBatchWithSchemaFence(
  tables: Tables,
  params: readonly InsertNodeParams[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  const { nodes, schemaVersions } = tables;
  const columns = nodeColumnList(nodes);
  const inputColumns = [
    nodes.graphId,
    nodes.kind,
    nodes.id,
    nodes.props,
    nodes.version,
    nodes.validFrom,
    nodes.validTo,
    nodes.createdAt,
    nodes.updatedAt,
  ];
  const inputColumnList = sql.raw(
    inputColumns
      .map((column) => `"${column.name.replaceAll('"', '""')}"`)
      .join(", "),
  );
  const inputSelect = sql.join(
    inputColumns.map((column) =>
      sql.raw(`"input_rows"."${column.name.replaceAll('"', '""')}"`),
    ),
    sql`, `,
  );
  const values = params.map((nodeParams) => {
    const propsJson = JSON.stringify(nodeParams.props);
    return sql`
      (
            ${castBoundValueForColumn(nodes.graphId, nodeParams.graphId)},
            ${castBoundValueForColumn(nodes.kind, nodeParams.kind)},
            ${castBoundValueForColumn(nodes.id, nodeParams.id)},
            ${castBoundValueForColumn(nodes.props, propsJson)},
            ${castBoundValueForColumn(nodes.version, 1)},
            ${castBoundValueForColumn(nodes.validFrom, sqlNull(resolveStampedValidityLowerBound(nodeParams.validFrom, nodeParams.validTo, timestamp)))},
            ${castBoundValueForColumn(nodes.validTo, sqlNull(nodeParams.validTo))},
            ${castBoundValueForColumn(nodes.createdAt, timestamp)},
            ${castBoundValueForColumn(nodes.updatedAt, timestamp)}
          )
    `;
  });

  return sql`
    WITH "schema_fence" AS (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
        AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    ), "input_rows" (${inputColumnList}) AS (
      VALUES ${sql.join(values, sql`, `)}
    )
    INSERT INTO ${nodes} (${columns})
    SELECT ${inputSelect}
    FROM "input_rows"
    CROSS JOIN "schema_fence"
    RETURNING 1 AS "inserted"
  `;
}

/**
 * Builds one schema-fenced atomic node batch statement.
 *
 * Generated identities use a plain INSERT. Caller identities use one
 * conflict-arbitrated upsert: tombstones are resurrected, while a live
 * incumbent assigns NULL to the NOT NULL `props` column. That deliberate
 * engine refusal is classified by the backend as a duplicate node identity,
 * and the native batch rolls back every earlier statement.
 */
export function buildAtomicNodeBatchWithSchemaFence(
  tables: Tables,
  entries: readonly AtomicNodeBatchEntry[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
  resultMode: AtomicNodeBatchResultMode,
): SQL {
  const firstEntry = entries[0];
  if (firstEntry === undefined) {
    throw new CompilerInvariantError(
      "An atomic node batch statement needs at least one entry.",
    );
  }
  if (!entries.every((entry) => entry.idSource === firstEntry.idSource)) {
    throw new CompilerInvariantError(
      "An atomic node batch statement cannot mix identity sources.",
    );
  }
  const generated = firstEntry.idSource === "generated";
  const { nodes, schemaVersions } = tables;
  const columns = nodeColumnList(nodes);
  const inputColumns = [
    nodes.graphId,
    nodes.kind,
    nodes.id,
    nodes.props,
    nodes.version,
    nodes.validFrom,
    nodes.validTo,
    nodes.createdAt,
    nodes.updatedAt,
  ];
  const inputColumnList = sql.raw(
    inputColumns
      .map((column) => `"${column.name.replaceAll('"', '""')}"`)
      .join(", "),
  );
  const inputSelect = sql.join(
    inputColumns.map((column) =>
      sql.raw(`"input_rows"."${column.name.replaceAll('"', '""')}"`),
    ),
    sql`, `,
  );
  const values = entries.map((entry) => {
    const nodeParams = entry.params;
    const propsJson = JSON.stringify(nodeParams.props);
    return sql`
      (
        ${castBoundValueForColumn(nodes.graphId, nodeParams.graphId)},
        ${castBoundValueForColumn(nodes.kind, nodeParams.kind)},
        ${castBoundValueForColumn(nodes.id, nodeParams.id)},
        ${castBoundValueForColumn(nodes.props, propsJson)},
        ${castBoundValueForColumn(nodes.version, 1)},
        ${castBoundValueForColumn(nodes.validFrom, sqlNull(resolveStampedValidityLowerBound(nodeParams.validFrom, nodeParams.validTo, timestamp)))},
        ${castBoundValueForColumn(nodes.validTo, sqlNull(nodeParams.validTo))},
        ${castBoundValueForColumn(nodes.createdAt, timestamp)},
        ${castBoundValueForColumn(nodes.updatedAt, timestamp)}
      )
    `;
  });
  const resultClause =
    resultMode === "rows" ? sql`RETURNING *` : sql`RETURNING 1 AS "inserted"`;
  const conflictColumns = sql.join(
    [nodes.graphId, nodes.kind, nodes.id].map((column) =>
      sql.identifier(column.name),
    ),
    sql`, `,
  );
  const targetAlias = "atomic_node_target";
  const currentVersion = qualifiedColumn(targetAlias, nodes.version);
  const currentValidFrom = qualifiedColumn(targetAlias, nodes.validFrom);
  const currentValidTo = qualifiedColumn(targetAlias, nodes.validTo);
  const currentDeletedAt = qualifiedColumn(targetAlias, nodes.deletedAt);
  const currentUpdatedAt = qualifiedColumn(targetAlias, nodes.updatedAt);
  const excluded = (column: Readonly<{ name: string }>): SQL =>
    sql.raw(`"excluded"."${column.name.replaceAll('"', '""')}"`);
  const resurrection = sql`
    ON CONFLICT (${conflictColumns}) DO UPDATE SET
      ${quotedColumn(nodes.props)} = CASE
        WHEN ${currentDeletedAt} IS NULL THEN NULL
        ELSE ${excluded(nodes.props)}
      END,
      ${quotedColumn(nodes.version)} = CASE
        WHEN ${currentDeletedAt} IS NULL THEN ${currentVersion}
        ELSE ${currentVersion} + 1
      END,
      ${quotedColumn(nodes.validFrom)} = CASE
        WHEN ${currentDeletedAt} IS NULL THEN ${currentValidFrom}
        ELSE ${excluded(nodes.validFrom)}
      END,
      ${quotedColumn(nodes.validTo)} = CASE
        WHEN ${currentDeletedAt} IS NULL THEN ${currentValidTo}
        ELSE ${excluded(nodes.validTo)}
      END,
      ${quotedColumn(nodes.deletedAt)} = CASE
        WHEN ${currentDeletedAt} IS NULL THEN ${currentDeletedAt}
        ELSE NULL
      END,
      ${quotedColumn(nodes.updatedAt)} = CASE
        WHEN ${currentDeletedAt} IS NULL THEN ${currentUpdatedAt}
        ELSE ${excluded(nodes.updatedAt)}
      END
  `;

  return sql`
    WITH "schema_fence" AS (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
        AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    ), "input_rows" (${inputColumnList}) AS (
      VALUES ${sql.join(values, sql`, `)}
    )
    INSERT INTO ${nodes} AS ${sql.identifier(targetAlias)} (${columns})
    SELECT ${inputSelect}
    FROM "input_rows"
    CROSS JOIN "schema_fence"
    ${
      // SQLite needs a WHERE clause to distinguish this INSERT ... SELECT's
      // trailing UPSERT clause from a join constraint.
      generated ? sql.empty() : sql`WHERE TRUE`
    }
    ${generated ? sql.empty() : resurrection}
    ${resultClause}
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
