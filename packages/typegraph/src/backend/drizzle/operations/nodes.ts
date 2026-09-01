import { type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../../errors";
import { getDialect } from "../../../query/dialect";
import { jsonPointer } from "../../../query/json-pointer";
import { sql as portableSql } from "../../../query/sql-fragment";
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
  CompareAndSetNodeParams,
  DeleteNodeParams,
  HardDeleteNodeParams,
  InsertNodeParams,
  SchemaWriteFenceParams,
  UpdateNodeParams,
  UpdateNodeSetParams,
} from "../../types";
import { toDrizzleSql } from "../execution/types";
import type { AtomicContributionEvidence } from "./contribution-evidence";
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
  if (evidence.some((entry) => entry.graphId !== first.graphId)) {
    throw new CompilerInvariantError(
      "Atomic node projection evidence crossed graph storage.",
    );
  }
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

/**
 * Builds one set-based update over candidate ids selected by the shared query
 * compiler. The outer graph/kind/live-row predicates are deliberate write
 * fences and must not be delegated solely to the candidate subquery.
 */
export function buildUpdateNodeSet(
  tables: Tables,
  dialect: "sqlite" | "postgres",
  params: CompareAndSetNodeParams | UpdateNodeSetParams,
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
  const expectedPropertyPredicates = Object.entries(
    "expectedProperties" in params ? params.expectedProperties : {},
  ).map(([property, value]) =>
    toDrizzleSql(
      adapter.jsonPathEquals(
        portableSql.identifier(nodes.props.name),
        jsonPointer([property]),
        value,
      ),
      dialect,
    ),
  );
  const expectedAbsentPredicates = (
    "expectedAbsentProperties" in params ? params.expectedAbsentProperties : []
  ).map((property) =>
    toDrizzleSql(
      portableSql`NOT ${adapter.jsonHasPath(
        portableSql.identifier(nodes.props.name),
        jsonPointer([property]),
      )}`,
      dialect,
    ),
  );
  const expectedPredicate =
    expectedPropertyPredicates.length + expectedAbsentPredicates.length === 0 ?
      sql.empty()
    : sql` AND ${sql.join(
        [...expectedPropertyPredicates, ...expectedAbsentPredicates],
        sql` AND `,
      )}`;

  return sql`
    UPDATE ${nodes}
    SET ${quotedColumn(nodes.props)} = ${patchedProps},
        ${quotedColumn(nodes.updatedAt)} = ${timestamp},
        ${quotedColumn(nodes.version)} = ${quotedColumn(nodes.version)} + 1
    WHERE ${nodes.graphId} = ${params.graphId}
      AND ${nodes.kind} = ${params.kind}
      AND ${nodes.deletedAt} IS NULL
      ${expectedPredicate}
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
            WHERE ${edges.graphId} = ${nodes.graphId}
              AND ${edges.deletedAt} IS NULL
              AND (
                (${edges.fromKind} = ${nodes.kind} AND ${edges.fromId} = ${nodes.id})
                OR (${edges.toKind} = ${nodes.kind} AND ${edges.toId} = ${nodes.id})
              )
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
