import { type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../../errors";
import { getDialect } from "../../../query/dialect";
import type {
  BuiltinDialectAdapter,
  DialectAdapter,
} from "../../../query/dialect/types";
import { jsonPointer } from "../../../query/json-pointer";
import {
  sql as portableSql,
  type SqlFragment,
} from "../../../query/sql-fragment";
import { resolveStampedValidityLowerBound } from "../../../utils/date";
import type {
  AtomicNodeBatchEntry,
  AtomicNodeBatchResultMode,
  AtomicNodeDeleteBatchInput,
  AtomicNodePostimageEntry,
  AtomicNodeReplacementEntry,
  AtomicNodeResolvedUpdateEntry,
} from "../../capabilities/atomic-mutation-program";
import type {
  DeleteNodeParams,
  HardDeleteNodeParams,
  HardDeleteNodesBatchParams,
  InsertNodeParams,
  NodePropertyExpectation,
  PreviewNodeSetUpdateParams,
  ResolvedNodeUpdateBatchParams,
  SchemaWriteFenceParams,
  SqlDialect,
  UpdateNodeParams,
  UpdateNodeSetParams,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import type { AtomicContributionEvidence } from "./contribution-evidence";
import {
  castBoundValueForColumn,
  codePointOrderKey,
  edgeAtEitherEndpoint,
  expectedValidFromPredicate,
  nodeColumnList,
  qualifiedColumn,
  quotedColumn,
  type RowLockClause,
  sqlNull,
  type Tables,
} from "./shared";
import { statementRelationNames } from "./statement-relation-names";

const INITIAL_NODE_VERSION = 1;
const NODE_VERSION_INCREMENT = 1;

function atomicNodeCreatePostimage(
  entry: Pick<AtomicNodePostimageEntry, "params">,
  timestamp: string,
) {
  const params = entry.params;
  return {
    graphId: params.graphId,
    kind: params.kind,
    id: params.id,
    propsJson: JSON.stringify(params.props),
    version: INITIAL_NODE_VERSION,
    // The temporal inventory requires the owner and its input on one line.
    // prettier-ignore
    validFrom: resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp),
    validTo: params.validTo,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
}

function atomicNodeUpdatePostimage(
  entry: AtomicNodeResolvedUpdateEntry,
  timestamp: string,
) {
  return {
    graphId: entry.graphId,
    kind: entry.kind,
    id: entry.id,
    propsJson: JSON.stringify(entry.props),
    version: entry.expectedVersion + NODE_VERSION_INCREMENT,
    updatedAt: timestamp,
  } as const;
}

function isAtomicNodeBatchEntry(
  entry: AtomicNodePostimageEntry,
): entry is AtomicNodeBatchEntry {
  return "idSource" in entry;
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
function buildAtomicNodeWriteBatchWithSchemaFence(
  tables: Tables,
  entries: readonly AtomicNodePostimageEntry[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
  resultMode: AtomicNodeBatchResultMode,
  writeMode: "create" | "replace",
  writeGate?: SQL,
): SQL {
  const firstEntry = entries[0];
  if (firstEntry === undefined) {
    throw new CompilerInvariantError(
      "An atomic node batch statement needs at least one entry.",
    );
  }
  if (
    writeMode === "create" &&
    (!isAtomicNodeBatchEntry(firstEntry) ||
      !entries.every(
        (entry) =>
          isAtomicNodeBatchEntry(entry) &&
          entry.idSource === firstEntry.idSource,
      ))
  ) {
    throw new CompilerInvariantError(
      "An atomic node batch statement cannot mix identity sources.",
    );
  }
  const generated =
    writeMode === "create" &&
    isAtomicNodeBatchEntry(firstEntry) &&
    firstEntry.idSource === "generated";
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
    const postimage = atomicNodeCreatePostimage(entry, timestamp);
    return sql`
      (
        ${castBoundValueForColumn(nodes.graphId, postimage.graphId)},
        ${castBoundValueForColumn(nodes.kind, postimage.kind)},
        ${castBoundValueForColumn(nodes.id, postimage.id)},
        ${castBoundValueForColumn(nodes.props, postimage.propsJson)},
        ${castBoundValueForColumn(nodes.version, postimage.version)},
        ${castBoundValueForColumn(nodes.validFrom, sqlNull(postimage.validFrom))},
        ${castBoundValueForColumn(nodes.validTo, sqlNull(postimage.validTo))},
        ${castBoundValueForColumn(nodes.createdAt, postimage.createdAt)},
        ${castBoundValueForColumn(nodes.updatedAt, postimage.updatedAt)}
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
  const replacement = sql`
    ON CONFLICT (${conflictColumns}) DO UPDATE SET
      ${quotedColumn(nodes.props)} = ${excluded(nodes.props)},
      ${quotedColumn(nodes.version)} = ${currentVersion} + 1,
      ${quotedColumn(nodes.validFrom)} = CASE
        WHEN ${currentDeletedAt} IS NULL THEN ${currentValidFrom}
        ELSE ${excluded(nodes.validFrom)}
      END,
      ${quotedColumn(nodes.validTo)} = CASE
        WHEN ${currentDeletedAt} IS NULL THEN ${currentValidTo}
        ELSE ${excluded(nodes.validTo)}
      END,
      ${quotedColumn(nodes.deletedAt)} = NULL,
      ${quotedColumn(nodes.updatedAt)} = ${excluded(nodes.updatedAt)}
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
      writeGate === undefined ?
        generated ? sql.empty()
        : sql`WHERE TRUE`
      : sql`WHERE ${writeGate}`
    }
    ${
      writeMode === "replace" ? replacement
      : generated ? sql.empty()
      : resurrection
    }
    ${resultClause}
  `;
}

/** Schema-fenced create batch with caller-id resurrection semantics. */
export function buildAtomicNodeBatchWithSchemaFence(
  tables: Tables,
  entries: readonly AtomicNodeBatchEntry[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
  resultMode: AtomicNodeBatchResultMode,
  writeGate?: SQL,
): SQL {
  return buildAtomicNodeWriteBatchWithSchemaFence(
    tables,
    entries,
    timestamp,
    schemaFence,
    schemaLockClause,
    resultMode,
    "create",
    writeGate,
  );
}

/** Schema-fenced blind replacement: create missing, replace live, revive tombstones. */
export function buildAtomicNodeReplacementBatchWithSchemaFence(
  tables: Tables,
  entries: readonly AtomicNodeReplacementEntry[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
  writeGate?: SQL,
): SQL {
  return buildAtomicNodeWriteBatchWithSchemaFence(
    tables,
    entries,
    timestamp,
    schemaFence,
    schemaLockClause,
    "rows",
    "replace",
    writeGate,
  );
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
 * Builds the `getNodes` read, ordered by id and row-locked by `rowLock`, so
 * concurrent lockers of overlapping id sets acquire their locks in one order.
 */
export function buildLockNodes(
  tables: Tables,
  dialect: SqlDialect,
  graphId: string,
  kind: string,
  ids: readonly string[],
  rowLock: RowLockClause,
): SQL {
  return sql`
    ${buildGetNodes(tables, graphId, kind, ids)}
    ORDER BY ${nodeIdLockOrder(dialect)}
    ${rowLock()}
  `;
}

/**
 * The order node-row lock statements acquire their rows in: code point, the
 * order `compareCodePoints` sorts their chunks in, rather than the column's
 * collation, so chunk order and in-statement order agree on every database.
 */
function nodeIdLockOrder(dialect: SqlDialect): SQL {
  return codePointOrderKey(portableSql.identifier("id"), dialect);
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
 * Builds one guarded set update for distinct, live node after-images.
 * The preimage version predicates are evaluated as one count gate, so either
 * every resolved row still matches or the statement updates none of them.
 */
export function buildAtomicNodeResolvedUpdateBatch(
  tables: Tables,
  entries: readonly AtomicNodeResolvedUpdateEntry[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  const { nodes, schemaVersions } = tables;
  const first = entries[0];
  if (first === undefined) return sql`SELECT 1 WHERE FALSE`;
  const firstPostimage = atomicNodeUpdatePostimage(first, timestamp);
  const postimages = [
    firstPostimage,
    ...entries
      .slice(1)
      .map((entry) => atomicNodeUpdatePostimage(entry, timestamp)),
  ];
  const propsCases = postimages.map(
    (postimage) =>
      sql`WHEN ${postimage.id} THEN ${castBoundValueForColumn(nodes.props, postimage.propsJson)}`,
  );
  const expectedRows = entries.map(
    (entry) =>
      sql`(${nodes.id} = ${entry.id} AND ${nodes.version} = ${entry.expectedVersion})`,
  );

  return sql`
    WITH "schema_fence" AS (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
        AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    )
    UPDATE ${nodes}
    SET ${quotedColumn(nodes.props)} = CASE ${nodes.id}
          ${sql.join(propsCases, sql` `)}
          ELSE ${nodes.props}
        END,
        ${quotedColumn(nodes.updatedAt)} = ${firstPostimage.updatedAt},
        ${quotedColumn(nodes.version)} = ${nodes.version} + ${sql.raw(String(NODE_VERSION_INCREMENT))}
    WHERE ${nodes.graphId} = ${first.graphId}
      AND ${nodes.kind} = ${first.kind}
      AND ${nodes.deletedAt} IS NULL
      AND ${nodes.id} IN (${sql.join(
        entries.map((entry) => sql`${entry.id}`),
        sql`, `,
      )})
      AND (
        SELECT COUNT(*)
        FROM ${nodes}
        CROSS JOIN "schema_fence"
        WHERE ${nodes.graphId} = ${first.graphId}
          AND ${nodes.kind} = ${first.kind}
          AND ${nodes.deletedAt} IS NULL
          AND (${sql.join(expectedRows, sql` OR `)})
      ) = ${entries.length}
    RETURNING *
  `;
}

/**
 * Builds the portable half of a resolved update batch. Unlike the atomic
 * program form this deliberately has no schema fence: its caller already owns
 * the graph write transaction and may be capture-wrapped. The version count
 * gate still makes every replacement one all-or-nothing row transition.
 */
export function buildResolvedNodeUpdateBatch(
  tables: Tables,
  params: ResolvedNodeUpdateBatchParams,
  timestamp: string,
  rowLockClause: SQL,
): SQL {
  const entries = params.entries;
  const first = entries[0];
  if (first === undefined) return sql`SELECT 1 WHERE FALSE`;
  const expected = sql.identifier("expected_updates");
  const eligible = sql.identifier("eligible_updates");
  const id = sql.identifier("id");
  const props = sql.identifier("props");
  const expectedVersion = sql.identifier("expected_version");
  const expectedColumns = sql.join([id, props, expectedVersion], sql`, `);
  const expectedRows = entries.map(
    (entry) =>
      sql`(${castBoundValueForColumn(tables.nodes.id, entry.id)}, ${castBoundValueForColumn(tables.nodes.props, JSON.stringify(entry.props))}, ${castBoundValueForColumn(tables.nodes.version, entry.expectedVersion)})`,
  );
  return sql`
    WITH ${expected} (${expectedColumns}) AS (
      VALUES ${sql.join(expectedRows, sql`, `)}
    ),
    ${eligible} (${id}) AS (
      SELECT ${expected}.${id}
      FROM ${tables.nodes}
      JOIN ${expected}
        ON ${tables.nodes.id} = ${expected}.${id}
       AND ${tables.nodes.version} = ${expected}.${expectedVersion}
      WHERE ${tables.nodes.graphId} = ${first.graphId}
        AND ${tables.nodes.kind} = ${first.kind}
        AND ${tables.nodes.deletedAt} IS NULL
      ORDER BY ${tables.nodes.id}
      ${rowLockClause}
    )
    UPDATE ${tables.nodes}
    SET ${quotedColumn(tables.nodes.props)} = (
          SELECT ${expected}.${props}
          FROM ${expected}
          WHERE ${expected}.${id} = ${tables.nodes.id}
        ),
        ${quotedColumn(tables.nodes.updatedAt)} = ${timestamp},
        ${quotedColumn(tables.nodes.version)} = ${tables.nodes.version} + ${sql.raw(String(NODE_VERSION_INCREMENT))}
    WHERE ${tables.nodes.graphId} = ${first.graphId}
      AND ${tables.nodes.kind} = ${first.kind}
      AND ${tables.nodes.deletedAt} IS NULL
      AND ${tables.nodes.id} IN (SELECT ${id} FROM ${eligible})
      AND EXISTS (
        SELECT 1
        FROM ${expected}
        WHERE ${expected}.${id} = ${tables.nodes.id}
          AND ${expected}.${expectedVersion} = ${tables.nodes.version}
      )
      AND (SELECT COUNT(*) FROM ${eligible}) = ${entries.length}
    RETURNING *
  `;
}

/**
 * Terminal database assertion for an atomic resolved node mutation set.
 *
 * Every earlier slot is schema-fenced, but a guarded update can legitimately
 * return no rows when one preimage moved. The transport cannot discover that
 * after committing: this final slot rechecks the complete postimage set and
 * deliberately violates the node table's NOT NULL created_at column when it is
 * incomplete or the fence is stale, forcing the native batch to roll every
 * preceding row and projection statement back. The refusal row is built from
 * expected postimage constants rather than a created database row, so the same
 * assertion protects create-only, update-only, and mixed programs even when a
 * stale fence prevented every row mutation.
 */
export function buildAssertAtomicNodeMutationPostimages(
  tables: Tables,
  creates: readonly AtomicNodePostimageEntry[],
  updates: readonly AtomicNodeResolvedUpdateEntry[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
): SQL {
  const { nodes, schemaVersions } = tables;
  const entries = [
    ...creates.map((entry) => atomicNodeCreatePostimage(entry, timestamp)),
    ...updates.map((entry) => atomicNodeUpdatePostimage(entry, timestamp)),
  ];
  const first = entries[0];
  if (first === undefined) return sql`SELECT 1 WHERE FALSE`;
  if (entries.some((entry) => entry.graphId !== schemaFence.graphId)) {
    throw new CompilerInvariantError(
      "An atomic node postimage assertion cannot span graph fences.",
    );
  }
  const expectedByKind = new Map<
    string,
    (
      | Readonly<{
          kind: "create";
          postimage: ReturnType<typeof atomicNodeCreatePostimage>;
        }>
      | Readonly<{
          kind: "update";
          postimage: ReturnType<typeof atomicNodeUpdatePostimage>;
        }>
    )[]
  >();
  for (const entry of creates) {
    const postimage = atomicNodeCreatePostimage(entry, timestamp);
    const expected = expectedByKind.get(postimage.kind) ?? [];
    expected.push({ kind: "create", postimage });
    expectedByKind.set(postimage.kind, expected);
  }
  for (const entry of updates) {
    const postimage = atomicNodeUpdatePostimage(entry, timestamp);
    const expected = expectedByKind.get(postimage.kind) ?? [];
    expected.push({ kind: "update", postimage });
    expectedByKind.set(postimage.kind, expected);
  }
  const expectedKinds = [...expectedByKind].map(([kind, expected]) => {
    const expectedRows = expected.map(
      ({ kind: operation, postimage }) => sql`
        (
          ${nodes.id} = ${postimage.id}
          AND ${nodes.props} = ${castBoundValueForColumn(nodes.props, postimage.propsJson)}
          ${
            operation === "update" ?
              sql`AND ${nodes.version} = ${postimage.version}`
            : sql.empty()
          }
          AND ${nodes.updatedAt} = ${postimage.updatedAt}
        )
      `,
    );
    return sql`(${nodes.kind} = ${kind} AND (${sql.join(expectedRows, sql` OR `)}))`;
  });

  return sql`
    INSERT INTO ${nodes} (${nodeColumnList(nodes)})
    SELECT
      ${first.graphId},
      ${first.kind},
      ${first.id},
      ${castBoundValueForColumn(nodes.props, first.propsJson)},
      ${first.version},
      NULL,
      NULL,
      NULL,
      ${first.updatedAt}
    WHERE NOT EXISTS (
        SELECT 1
        FROM ${schemaVersions}
        WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
          AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
          AND ${schemaVersions.isActive} = TRUE
      ) OR (
        SELECT COUNT(*)
        FROM ${nodes}
        WHERE ${nodes.graphId} = ${schemaFence.graphId}
          AND ${nodes.deletedAt} IS NULL
          AND (${sql.join(expectedKinds, sql` OR `)})
      ) <> ${entries.length}
  `;
}

/**
 * Terminal durable-marker assertion for atomic node projections.
 *
 * A cold backend resolves marker signatures locally, then this statement
 * proves their exact database rows inside the same atomic submission as the
 * node and projection writes. Missing, stale, failed, or unmaterialized
 * evidence deliberately writes a null signature through the marker's own
 * conflict target, forcing a distinct NOT NULL refusal and rolling the
 * complete transport submission back.
 */
export function buildAssertAtomicNodeProjectionEvidence(
  tables: Tables,
  timestamp: string,
  evidence: readonly AtomicContributionEvidence[],
): SQL {
  const { contributionMaterializations } = tables;
  const first = evidence[0];
  if (first === undefined) {
    return sql`SELECT 1 WHERE FALSE`;
  }
  // Deployment-scoped contributions are attested under the deployment
  // marker key while the graph's logical activation remains graph-scoped.
  // One atomic assertion may therefore intentionally contain marker rows
  // from two graph-id namespaces.
  const expectedMarkers = evidence.map(
    (entry) => sql`
      (
        ${contributionMaterializations.graphId} = ${entry.graphId}
        AND ${contributionMaterializations.logicalName} = ${entry.logicalName}
        AND ${contributionMaterializations.owner} = ${entry.owner}
        AND ${contributionMaterializations.tableName} = ${entry.tableName}
        AND ${contributionMaterializations.signature} = ${entry.signature}
      )
    `,
  );

  return sql`
    INSERT INTO ${contributionMaterializations} (
      ${sql.identifier(contributionMaterializations.graphId.name)},
      ${sql.identifier(contributionMaterializations.logicalName.name)},
      ${sql.identifier(contributionMaterializations.owner.name)},
      ${sql.identifier(contributionMaterializations.tableName.name)},
      ${sql.identifier(contributionMaterializations.signature.name)},
      ${sql.identifier(contributionMaterializations.materializedAt.name)},
      ${sql.identifier(contributionMaterializations.lastAttemptedAt.name)},
      ${sql.identifier(contributionMaterializations.lastError.name)}
    )
    SELECT
      ${first.graphId},
      ${first.logicalName},
      ${first.owner},
      ${first.tableName},
      NULL,
      NULL,
      ${castBoundValueForColumn(
        contributionMaterializations.lastAttemptedAt,
        timestamp,
      )},
      NULL
    WHERE (
      SELECT COUNT(*)
      FROM ${contributionMaterializations}
      WHERE (${sql.join(expectedMarkers, sql` OR `)})
        AND ${contributionMaterializations.materializedAt} IS NOT NULL
        AND ${contributionMaterializations.lastError} IS NULL
    ) <> ${evidence.length}
    ON CONFLICT (
      ${sql.identifier(contributionMaterializations.graphId.name)},
      ${sql.identifier(contributionMaterializations.logicalName.name)},
      ${sql.identifier(contributionMaterializations.owner.name)},
      ${sql.identifier(contributionMaterializations.tableName.name)}
    ) DO UPDATE SET
      ${sql.identifier(contributionMaterializations.signature.name)} = NULL
  `;
}

/** Reads the asserted rows only while the same schema fence remains current. */
export function buildReadAtomicNodeMutationPostimages(
  tables: Tables,
  graphId: string,
  kind: string,
  ids: readonly string[],
  schemaFence: SchemaWriteFenceParams,
): SQL {
  const { nodes, schemaVersions } = tables;
  return sql`
    SELECT ${nodes}.*
    FROM ${nodes}
    CROSS JOIN ${schemaVersions}
    WHERE ${nodes.graphId} = ${graphId}
      AND ${nodes.kind} = ${kind}
      AND ${nodes.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND ${schemaVersions.graphId} = ${schemaFence.graphId}
      AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
      AND ${schemaVersions.isActive} = TRUE
  `;
}

function buildNodeExpectationPredicate(
  adapter: DialectAdapter,
  propsColumn: SqlFragment,
  property: string,
  expectation: NodePropertyExpectation,
): SqlFragment {
  const pointer = jsonPointer([property]);
  if (expectation.kind === "absent") {
    return portableSql`NOT ${adapter.jsonHasPath(propsColumn, pointer)}`;
  }
  return adapter.jsonScalarPathEquals(propsColumn, pointer, expectation.value);
}

/**
 * The relations the set update's statements introduce, by preferred name (see
 * {@link buildPreviewNodeSetUpdate}). They are resolved per schema through
 * {@link statementRelationNames}, so a configured table carrying one of these
 * names is never shadowed.
 */
const SET_KEYS = "tg_set_keys";
const SET_SELECTED = "tg_set_selected";
const SET_CANDIDATES = "tg_set_candidates";
const SET_KEY_ROWS = "tg_set_key_rows";
const SET_LOCKED = "tg_set_locked";
const SET_RELATIONS = [
  SET_KEYS,
  SET_SELECTED,
  SET_CANDIDATES,
  SET_KEY_ROWS,
  SET_LOCKED,
] as const;

/** The column aliases of the set update's key CTE. */
const SET_KEY_GRAPH_ID = "tg_set_key_graph_id";
const SET_KEY_KIND = "tg_set_key_kind";
const SET_KEY_ID = "tg_set_key_id";
const SET_KEY_TOKEN = "tg_set_key_token";

/** The column the dry-run projects each row's token under. */
export const SET_ROW_TOKEN_COLUMN = "tg_set_row_token";

type SetRelationNames = Readonly<
  Record<(typeof SET_RELATIONS)[number], string>
>;

/**
 * The token naming one stored node row — its id, version, stored properties,
 * validity window and creation time — as JSON text. THE one spelling of "the row the dry-run read" — the dry-run
 * projects it and the keyed write compares against it, so the two cannot
 * disagree about what makes a row the same row. JSON encoding keeps the parts
 * apart. The version alone cannot name a row: a row deleted and re-created
 * under the same id starts again at the version the original may still have.
 * With the stored properties, the window and the creation time beside it, a
 * re-created row is told apart unless it is identical in every stored column
 * but the timestamp of its last write — a row the dry-run's after-image and
 * validation describe exactly.
 *
 * `relation` qualifies the columns; omitted, they resolve against the
 * statement's single target table.
 */
function setRowToken(
  adapter: DialectAdapter,
  nodes: Tables["nodes"],
  relation?: string,
): SqlFragment {
  const column = (name: string): SqlFragment =>
    relation === undefined ?
      portableSql.identifier(name)
    : portableSql`${portableSql.identifier(relation)}.${portableSql.identifier(name)}`;
  return portableSql`CAST(${adapter.textJsonArray([
    column(nodes.id.name),
    column(nodes.version.name),
    column(nodes.props.name),
    column(nodes.validFrom.name),
    column(nodes.validTo.name),
    column(nodes.createdAt.name),
  ])} AS TEXT)`;
}

/**
 * The key CTE both set-update statements open with: one `(graph, kind, id)`
 * row per distinct id `source` yields — with the row token `token` names,
 * for the keyed write.
 *
 * The graph/kind fences are written as columns of the key subquery, not as
 * constant predicates on the nodes table. A constant `graph_id = ? AND
 * kind = ?` on the nodes table lets PostgreSQL estimate that range from its
 * column statistics, and statistics taken before a bulk load put a large
 * fresh kind at one row: the planner then drives a nested loop from that range
 * and rescans the candidates once per row, which is quadratic (a version
 * join made it cubic). Carried through a `DISTINCT` subquery — which the
 * planner does not flatten, so it cannot fold the constants back onto the
 * nodes table — the same fences reach the nodes table only as join keys. The
 * nodes table then has no range for stale statistics to shrink, and every
 * alternative to keyed lookups has to scan the whole table once.
 *
 * `id` may carry any collation (a direct port caller writes its own candidate
 * SQL), and that collation would decide both this DISTINCT and the match on
 * the nodes table: SQLite's `NOCASE` would collapse two ids that differ only
 * by case into one key, and a case-insensitive PostgreSQL collation would
 * match a non-candidate twin. The key column's own collation makes both use
 * the primary key's equality.
 *
 * The keys are a CTE so that `source` is evaluated once on every engine:
 * SQLite codes a row-value IN that drives a prefix of an index twice (once to
 * walk the primary key, once to test the whole row value) and would run an
 * inlined source once per coding. PostgreSQL inlines the CTE as the subquery
 * it is, so its plan is unchanged.
 */
function setKeysCte(
  adapter: BuiltinDialectAdapter,
  dialect: SqlDialect,
  relationNames: SetRelationNames,
  scope: Readonly<{ graphId: string; kind: string }>,
  source: SqlFragment,
  id: SqlFragment,
  token?: SqlFragment,
): SQL {
  return toDrizzleSql(
    adapter.singleEvaluationCte(
      portableSql.identifier(relationNames[SET_KEYS]),
      portableSql`
              SELECT DISTINCT
                CAST(${scope.graphId} AS TEXT) AS ${portableSql.identifier(SET_KEY_GRAPH_ID)},
                CAST(${scope.kind} AS TEXT) AS ${portableSql.identifier(SET_KEY_KIND)},
                ${adapter.keyText(id)} AS ${portableSql.identifier(SET_KEY_ID)}${
                  token === undefined ?
                    portableSql.empty()
                  : portableSql`,
                ${token} AS ${portableSql.identifier(SET_KEY_TOKEN)}`
                }
              FROM ${source}
            `,
    ),
    dialect,
  );
}

/** The key CTE's columns, qualified. */
function setKeyColumns(relationNames: SetRelationNames) {
  const keys = sql.identifier(relationNames[SET_KEYS]);
  return {
    keys,
    graphId: sql`${keys}.${sql.identifier(SET_KEY_GRAPH_ID)}`,
    kind: sql`${keys}.${sql.identifier(SET_KEY_KIND)}`,
    id: sql`${keys}.${sql.identifier(SET_KEY_ID)}`,
    token: sql`${keys}.${sql.identifier(SET_KEY_TOKEN)}`,
  } as const;
}

/** The patched properties, from one builder call shared by both statements. */
function setPatchedProps(
  adapter: DialectAdapter,
  dialect: SqlDialect,
  nodes: Tables["nodes"],
  params: Pick<UpdateNodeSetParams, "patch" | "unsetProperties">,
): SQL {
  return toDrizzleSql(
    adapter.jsonSetProperties(
      portableSql.identifier(nodes.props.name),
      params.patch,
      params.unsetProperties ?? [],
    ),
    dialect,
  );
}

/**
 * Builds the locked dry-run of a set update over candidate ids selected by the
 * shared query compiler: every live row the selection names, with its
 * after-image and its row token (see {@link setRowToken}), writing nothing.
 *
 * It is one statement on purpose: the candidates are read in the same
 * snapshot the rows are read and locked from, so the rows selected are the
 * rows returned. `rowLock` is the clause the backend's node-row lock plan
 * gives (PostgreSQL `FOR NO KEY UPDATE`, the lock an UPDATE of these rows
 * takes; empty where writers already serialize), so the keyed write that
 * follows in the same transaction finds them unchanged by any other session.
 *
 * The write phase this statement keeps bounded is the read of the nodes
 * table, and {@link setKeysCte} explains why that read is keyed: it is bounded
 * by one table scan plus constant work per candidate, and never rescans,
 * while ids are unique within a graph across kinds: a lookup by `(graph_id,
 * id)` checks the kind afterwards, so an id that K other kinds of the graph
 * hold can cost K more index entries. Which side PostgreSQL takes follows its
 * estimate of the candidate count: estimated small, each candidate is looked
 * up by `(graph_id, id)` or the primary key; estimated large — as when the
 * graph and the kind are each in the statistics but never together, so their
 * frequencies are multiplied — the keys are hashed against one sequential
 * scan, even for one actual candidate. The fences themselves are unchanged: a
 * row is read only when its graph, kind and id equal a key's.
 */
export function buildPreviewNodeSetUpdate(
  tables: Tables,
  dialect: SqlDialect,
  params: PreviewNodeSetUpdateParams,
  rowLock: RowLockClause,
): SQL {
  const { nodes } = tables;
  const adapter = getDialect(dialect);
  const propsColumn = portableSql.identifier(nodes.props.name);
  const expectedPredicates =
    params.operation === "compareAndSet" ?
      Object.entries(params.expected).map(([property, expectation]) =>
        toDrizzleSql(
          buildNodeExpectationPredicate(
            adapter,
            propsColumn,
            property,
            expectation,
          ),
          dialect,
        ),
      )
    : [];
  const expectedPredicate =
    expectedPredicates.length === 0 ?
      sql.empty()
    : sql` AND ${sql.join(expectedPredicates, sql` AND `)}`;

  const relationNames = statementRelationNames(tables, SET_RELATIONS);
  const selected = relationNames[SET_SELECTED];
  // Resolved names are plain lowercase identifiers, emitted unquoted as the
  // candidates alias always was.
  const candidates = portableSql.raw(relationNames[SET_CANDIDATES]);
  const key = setKeyColumns(relationNames);
  const keysCte = setKeysCte(
    adapter,
    dialect,
    relationNames,
    params,
    portableSql`(${params.candidateIds}) AS ${candidates}`,
    portableSql`${candidates}.${portableSql.identifier(params.candidateIdColumn)}`,
  );

  // The candidate query is evaluated once, against the statement's snapshot,
  // and yields only ids. Under PostgreSQL READ COMMITTED a row a concurrent
  // writer changes and commits while this statement waits for its lock is
  // re-checked against the outer conditions only, never against the
  // candidate predicates — so for `updateWhere`, whose `where` / `exists` /
  // `candidates` selectors live in that query, matching on the id alone reads
  // a row selected from its previous state. Pairing each candidate id with
  // the version the snapshot held makes the read conditional on the row being
  // exactly the one the selectors chose: every row write bumps `version` (a
  // tombstone is fenced by `deleted_at IS NULL` below), so a row changed since
  // the snapshot is skipped and absent from the preview. The re-check follows
  // the row's own version chain, so a row deleted and re-created under the
  // same id — whose version starts again and can equal the snapshot's — is a
  // different row and is never read either.
  //
  // `compareAndSet` keeps the id match. Its candidate query selects by id,
  // which a concurrent write cannot falsify, and its guard is the `expected`
  // predicates above, which the lock re-checks on the row, so a concurrent
  // change to an unrelated property must not fail it.
  const candidateMatch =
    params.operation === "compareAndSet" ?
      sql`
        (${nodes.graphId}, ${nodes.kind}, ${nodes.id}) IN (
                SELECT ${key.graphId}, ${key.kind}, ${key.id}
                FROM ${key.keys}
              )
      `
    : sql`
      (${nodes.graphId}, ${nodes.kind}, ${nodes.id}, ${nodes.version}) IN (
              SELECT ${qualifiedColumn(selected, nodes.graphId)}, ${qualifiedColumn(selected, nodes.kind)}, ${qualifiedColumn(selected, nodes.id)}, ${qualifiedColumn(selected, nodes.version)}
              FROM ${key.keys}
              JOIN ${nodes} AS ${sql.identifier(selected)}
                ON ${qualifiedColumn(selected, nodes.graphId)} = ${key.graphId}
               AND ${qualifiedColumn(selected, nodes.kind)} = ${key.kind}
               AND ${qualifiedColumn(selected, nodes.id)} = ${key.id}
            )
    `;
  return sql`
    ${keysCte}
    SELECT ${nodes.graphId},
           ${nodes.kind},
           ${nodes.id},
           ${setPatchedProps(adapter, dialect, nodes, params)} AS ${quotedColumn(nodes.props)},
           ${nodes.version},
           ${nodes.validFrom},
           ${nodes.validTo},
           ${nodes.createdAt},
           ${nodes.updatedAt},
           ${nodes.deletedAt},
           ${toDrizzleSql(setRowToken(adapter, nodes), dialect)} AS ${sql.identifier(SET_ROW_TOKEN_COLUMN)}
    FROM ${nodes}
    WHERE ${nodes.deletedAt} IS NULL
      ${expectedPredicate}
      AND ${candidateMatch}
    ${rowLock()}
  `;
}

/**
 * Builds the keyed write of a set update: the patch, applied to exactly the
 * rows a {@link buildPreviewNodeSetUpdate} returned, all or nothing.
 *
 * The rows are bound as ONE value, a JSON object from each id to its row
 * token, so the statement binds a constant number of parameters however many
 * rows it writes. The key CTE carries both: the id drives a keyed lookup of
 * each row, as in the dry-run, and the token, compared on the row that lookup
 * found, makes the match exact (see {@link setRowToken}). The token is
 * compared with the null-safe equality, which no engine hashes or merges on:
 * it stays a filter on the rows the key matched, so the planner joins on the
 * key alone and computes no token for a row the key does not name — even when,
 * on a table with no statistics, it hashes the whole table.
 *
 * All or nothing: the `tg_set_locked` CTE first locks every keyed row that
 * still carries its token (`rowLock`, as the dry-run did; a no-op when the
 * dry-run's locks are held), the UPDATE writes exactly those rows by key, and
 * only when their count equals the number of rows validated. Locking before counting is what makes the
 * count exact on PostgreSQL READ COMMITTED: an unlocked count could include a
 * row a concurrent writer is changing, which the UPDATE's own recheck would
 * then skip while writing the rest. When any row was changed, deleted or
 * re-created since the dry-run, the count is short, the statement writes no
 * row, and the caller reports the mismatch — a row the caller did not
 * validate is never written, and neither is part of a set it refused.
 *
 * The `SET` clause is the dry-run's after-image expression
 * ({@link setPatchedProps}) over the same stored row, so the row written is
 * the row validated.
 */
export function buildUpdateNodeSet(
  tables: Tables,
  dialect: SqlDialect,
  params: UpdateNodeSetParams,
  timestamp: string,
  rowLock: RowLockClause,
): SQL {
  const { nodes } = tables;
  const adapter = getDialect(dialect);
  const relationNames = statementRelationNames(tables, SET_RELATIONS);
  const selected = relationNames[SET_SELECTED];
  const locked = sql.identifier(relationNames[SET_LOCKED]);
  const keyRows = portableSql.identifier(relationNames[SET_KEY_ROWS]);
  const key = setKeyColumns(relationNames);
  // Built entry by entry rather than through `Object.fromEntries`, so no id
  // is ever read as an object's special key: each entry is JSON as written.
  const packedRows = `{${params.rows
    .map((row) => `${JSON.stringify(row.id)}:${JSON.stringify(row.rowToken)}`)
    .join(",")}}`;
  const keysCte = setKeysCte(
    adapter,
    dialect,
    relationNames,
    params,
    adapter.textMapParameterRows(portableSql`${packedRows}`, keyRows),
    portableSql`${keyRows}.${portableSql.identifier("key")}`,
    portableSql`${keyRows}.${portableSql.identifier("value")}`,
  );
  const tokenMatches = toDrizzleSql(
    adapter.nullSafeEquals(
      setRowToken(adapter, nodes, selected),
      portableSql`${portableSql.identifier(relationNames[SET_KEYS])}.${portableSql.identifier(SET_KEY_TOKEN)}`,
    ),
    dialect,
  );
  return sql`
    ${keysCte},
    ${locked} AS MATERIALIZED (
      SELECT ${qualifiedColumn(selected, nodes.graphId)},
             ${qualifiedColumn(selected, nodes.kind)},
             ${qualifiedColumn(selected, nodes.id)}
      FROM ${key.keys}
      JOIN ${nodes} AS ${sql.identifier(selected)}
        ON ${qualifiedColumn(selected, nodes.graphId)} = ${key.graphId}
       AND ${qualifiedColumn(selected, nodes.kind)} = ${key.kind}
       AND ${qualifiedColumn(selected, nodes.id)} = ${key.id}
      WHERE ${qualifiedColumn(selected, nodes.deletedAt)} IS NULL
        AND ${tokenMatches}
      ${rowLock([selected])}
    )
    UPDATE ${nodes}
    SET ${quotedColumn(nodes.props)} = ${setPatchedProps(adapter, dialect, nodes, params)},
        ${quotedColumn(nodes.updatedAt)} = ${timestamp},
        ${quotedColumn(nodes.version)} = ${quotedColumn(nodes.version)} + ${sql.raw(String(NODE_VERSION_INCREMENT))}
    WHERE ${nodes.deletedAt} IS NULL
      AND (${nodes.graphId}, ${nodes.kind}, ${nodes.id}) IN (
            SELECT ${quotedColumn(nodes.graphId)}, ${quotedColumn(nodes.kind)}, ${quotedColumn(nodes.id)}
            FROM ${locked}
          )
      AND (SELECT COUNT(*) FROM ${locked}) = ${params.rows.length}
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
 * The leading statement of the closed node-delete program: locks the target
 * rows with the delete lock before the delete statement's connected-edge
 * check runs, so that check — a later statement with its own snapshot — sees
 * every edge an endpoint-locked writer committed while this one waited. The
 * schema fence is the statement's first acquisition, preserving the store's
 * lock order (schema fence, then row work). It returns the locked ids;
 * missing and tombstoned ids lock nothing the delete would write.
 */
export function buildLockNodesForAtomicDeleteWithSchemaFence(
  tables: Tables,
  dialect: SqlDialect,
  input: AtomicNodeDeleteBatchInput,
  schemaLockClause: SQL,
  rowLock: RowLockClause,
): SQL {
  const { nodes, schemaVersions } = tables;

  return sql`
    WITH "schema_fence" AS (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${input.schemaFence.graphId}
        AND ${schemaVersions.version} = ${input.schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    )
    SELECT ${nodes.id}
    FROM ${nodes}
    WHERE ${nodes.graphId} = ${input.graphId}
      AND ${nodes.kind} = ${input.kind}
      AND ${nodes.id} IN (${sql.join(
        input.ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND EXISTS (SELECT 1 FROM "schema_fence")
    ORDER BY ${nodeIdLockOrder(dialect)}
    ${rowLock()}
  `;
}

/**
 * Builds a closed, schema-fenced soft delete for claim- and projection-free
 * nodes whose delete behavior is `restrict`.
 *
 * A connected live edge assigns NULL to the NOT NULL props column, aborting
 * the whole native program. Missing and already-tombstoned ids remain no-ops.
 */
export function buildAtomicNodeDeleteBatchWithSchemaFence(
  tables: Tables,
  input: AtomicNodeDeleteBatchInput,
  timestamp: string,
  schemaLockClause: SQL,
): SQL {
  const { edges, nodes, schemaVersions } = tables;

  return sql`
    WITH "schema_fence" AS (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${input.schemaFence.graphId}
        AND ${schemaVersions.version} = ${input.schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    )
    UPDATE ${nodes}
    SET ${quotedColumn(nodes.deletedAt)} = ${timestamp},
        ${quotedColumn(nodes.props)} = CASE
          WHEN EXISTS (
            SELECT 1
            FROM ${edges}
            WHERE ${edges.deletedAt} IS NULL
              AND ${edgeAtEitherEndpoint(edges, { graphId: nodes.graphId, kind: nodes.kind, id: nodes.id })}
          ) THEN NULL
          ELSE ${nodes.props}
        END
    WHERE ${nodes.graphId} = ${input.graphId}
      AND ${nodes.kind} = ${input.kind}
      AND ${nodes.id} IN (${sql.join(
        input.ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND ${nodes.deletedAt} IS NULL
      AND EXISTS (SELECT 1 FROM "schema_fence")
    RETURNING ${nodes.id}
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

/**
 * Builds a hard DELETE for one bind-budget chunk of one kind's nodes, returning
 * the id of every row it removed — the set the batch's sidecar deletes are
 * then scoped to. The kind is part of the key, so an id present only under
 * another kind matches nothing.
 */
export function buildHardDeleteNodesBatch(
  tables: Tables,
  params: HardDeleteNodesBatchParams,
): SQL {
  const { nodes } = tables;

  return sql`
    DELETE FROM ${nodes}
    WHERE ${nodes.graphId} = ${params.graphId}
      AND ${nodes.kind} = ${params.kind}
      AND ${nodes.id} IN (${sql.join(
        params.ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    RETURNING ${nodes.id}
  `;
}
