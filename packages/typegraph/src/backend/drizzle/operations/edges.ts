import { getTableName, type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../../errors";
import {
  resolveStampedValidityLowerBound,
  resolveStatedValidityLowerBound,
} from "../../../utils/date";
import { requireDefined } from "../../../utils/presence";
import type {
  AtomicEdgeConvergenceEntry,
  AtomicEdgeDeleteBatchInput,
  AtomicEdgeResolvedUpdateEntry,
} from "../../capabilities/atomic-mutation-program";
import type {
  CountEdgesFromParams,
  DeleteEdgeParams,
  DeleteEdgesBatchParams,
  EdgeConvergenceMatch,
  EdgeExistsBetweenParams,
  FindEdgesConnectedToParams,
  HardDeleteEdgeParams,
  InsertEdgeParams,
  SchemaWriteFenceParams,
  UpdateEdgeParams,
} from "../../types";
import { rowPropsToJsonText } from "../../types";
import {
  castBoundValueForColumn,
  edgeColumnList,
  expectedValidFromPredicate,
  quotedColumn,
  quotedTableName,
  sqlNull,
  type Tables,
} from "./shared";

// EdgeRow follows the public no-null convention, while the SQL predicate's
// three-state input uses null to mean "assert the stored column is SQL NULL."
// eslint-disable-next-line unicorn/no-null
const EXPECTED_SQL_NULL = null;

/**
 * Inputs for the dialect-specific edge convergence statement.
 *
 * `matchOn` is deliberately a call-level key: it is validated against the
 * edge schema by the store before it reaches this backend seam. The statement
 * still treats absent properties distinctly from JSON `null`, matching the
 * store's own-property comparison.
 */
export type ConvergeEdgeCreateParams = Readonly<{
  params: InsertEdgeParams;
  match: EdgeConvergenceMatch;
  timestamp: string;
  schemaFence?: SchemaWriteFenceParams;
  schemaLockClause?: SQL;
}>;

export type AtomicConvergeEdgesParams = Readonly<{
  entries: readonly AtomicEdgeConvergenceEntry[];
  timestamp: string;
  schemaFence: SchemaWriteFenceParams;
  schemaLockClause: SQL;
}>;

function qualifiedColumn(
  alias: string,
  column: Readonly<{ name: string }>,
): SQL {
  return sql.raw(`"${alias}"."${column.name.replaceAll('"', '""')}"`);
}

function atomicEdgeCreatePostimage(
  params: InsertEdgeParams,
  timestamp: string,
) {
  return {
    graphId: params.graphId,
    id: params.id,
    kind: params.kind,
    fromKind: params.fromKind,
    fromId: params.fromId,
    toKind: params.toKind,
    toId: params.toId,
    propsJson: JSON.stringify(params.props),
    matchIdentityName: params.matchIdentity?.name,
    matchIdentityKey: params.matchIdentity?.key,
    // The temporal inventory requires the owner and its input on one line.
    // prettier-ignore
    storedLowerBound: resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp),
    storedUpperBound: params.validTo,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as const;
}

function atomicEdgeUpdatePostimage(
  entry: AtomicEdgeResolvedUpdateEntry,
  timestamp: string,
) {
  const existing = entry.existing;
  return {
    graphId: existing.graph_id,
    id: existing.id,
    kind: existing.kind,
    fromKind: existing.from_kind,
    fromId: existing.from_id,
    toKind: existing.to_kind,
    toId: existing.to_id,
    propsJson: JSON.stringify(entry.props),
    matchIdentityName: existing.match_identity_name,
    matchIdentityKey: existing.match_identity_key,
    storedLowerBound: existing.valid_from,
    storedUpperBound: existing.valid_to,
    createdAt: existing.created_at,
    updatedAt: timestamp,
  } as const;
}

/**
 * Requires the exact source and target nodes to be live. All endpoint-guarded
 * edge insert statements use this one predicate so their liveness semantics
 * cannot diverge.
 */
function buildLiveEndpointPredicate(
  nodes: Tables["nodes"],
  params: InsertEdgeParams,
): SQL {
  const from = (column: Readonly<{ name: string }>): SQL =>
    qualifiedColumn("from_node", column);
  const to = (column: Readonly<{ name: string }>): SQL =>
    qualifiedColumn("to_node", column);

  return sql`
    ${from(nodes.graphId)} = ${params.graphId}
    AND ${from(nodes.kind)} = ${params.fromKind}
    AND ${from(nodes.id)} = ${params.fromId}
    AND ${from(nodes.deletedAt)} IS NULL
    AND ${to(nodes.graphId)} = ${params.graphId}
    AND ${to(nodes.kind)} = ${params.toKind}
    AND ${to(nodes.id)} = ${params.toId}
    AND ${to(nodes.deletedAt)} IS NULL
  `;
}

function buildMatchKeyPredicate(
  propsColumn: SQL,
  matchOn: readonly string[],
  matchProps: Record<string, unknown>,
): SQL {
  if (matchOn.length === 0) return sql`TRUE`;

  return sql.join(
    matchOn.map((field) => {
      const value =
        Object.prototype.hasOwnProperty.call(matchProps, field) ?
          matchProps[field]
        : undefined;
      if (value === undefined) {
        return sql`NOT (${propsColumn} ? ${field})`;
      }
      return sql`(${propsColumn} -> ${field}) = ${JSON.stringify(value)}::jsonb`;
    }),
    sql` AND `,
  );
}

/**
 * Builds an INSERT query for an edge.
 * Uses raw column names in the column list (required by SQL syntax).
 *
 * As for nodes, the stored lower bound is decided by
 * {@link resolveStampedValidityLowerBound} against the very `timestamp` this
 * statement binds into `created_at` / `updated_at` — see `buildInsertNode` for
 * why the decision lives in the builder rather than above it.
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
      ${propsJson}, ${sqlNull(params.matchIdentity?.name)}, ${sqlNull(params.matchIdentity?.key)},
      ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    )
    RETURNING *
  `;
}

/**
 * Inserts an edge through two live-node predicates, so the usual endpoint
 * validation reads and row INSERT are one database statement on the success
 * path. A missing returned row is deliberately ambiguous: callers must run
 * their normal ordered endpoint diagnostics to preserve which public
 * `EndpointNotFoundError` wins when both endpoints are unavailable.
 *
 * The edge primary key remains an ordinary INSERT constraint. Consequently a
 * duplicate identity still raises the database error that the common backend
 * classifies, rather than being confused with a failed endpoint predicate.
 */
export function buildInsertEdgeIfEndpointsLive(
  tables: Tables,
  params: InsertEdgeParams,
  timestamp: string,
): SQL {
  const { edges, nodes } = tables;
  const propsJson = JSON.stringify(params.props);
  const columns = edgeColumnList(edges);
  const nodeTable = quotedTableName(getTableName(nodes));

  return sql`
    INSERT INTO ${edges} (${columns})
    SELECT
      ${params.graphId}, ${params.id}, ${params.kind},
      ${params.fromKind}, ${params.fromId}, ${params.toKind}, ${params.toId},
      ${propsJson}, ${sqlNull(params.matchIdentity?.name)}, ${sqlNull(params.matchIdentity?.key)},
      ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    FROM ${nodeTable} AS "from_node"
    CROSS JOIN ${nodeTable} AS "to_node"
    WHERE ${buildLiveEndpointPredicate(nodes, params)}
    RETURNING *
  `;
}

/**
 * Atomically converges an edge create on its endpoint/match-key identity.
 *
 * The existing-row CTE is materialized so it chooses a live row before a
 * tombstone and is evaluated from the same statement snapshot as the insert.
 * When it is empty, the INSERT ... SELECT validates both endpoints and writes
 * the edge. The discriminator is intentionally returned as an extra column;
 * row mappers ignore it while the command executor can distinguish `found`
 * from `created` without a second round trip.
 *
 * The dialect adapter owns the JSON match predicate, so both bundled SQL
 * engines consume this common statement shape.
 */
export function buildConvergeEdgeCreate(
  tables: Tables,
  input: ConvergeEdgeCreateParams,
): SQL {
  const { edges, nodes } = tables;
  const { params, match, timestamp } = input;
  const propsJson = JSON.stringify(params.props);
  const columns = edgeColumnList(edges);
  const edgeTable = quotedTableName(getTableName(edges));
  const nodeTable = quotedTableName(getTableName(nodes));
  const edgeGraphId = qualifiedColumn("candidate", edges.graphId);
  const edgeKind = qualifiedColumn("candidate", edges.kind);
  const edgeFromKind = qualifiedColumn("candidate", edges.fromKind);
  const edgeFromId = qualifiedColumn("candidate", edges.fromId);
  const edgeToKind = qualifiedColumn("candidate", edges.toKind);
  const edgeToId = qualifiedColumn("candidate", edges.toId);
  const edgeProps = qualifiedColumn("candidate", edges.props);
  const edgeDeletedAt = qualifiedColumn("candidate", edges.deletedAt);
  const edgeCreatedAt = qualifiedColumn("candidate", edges.createdAt);
  const edgeId = qualifiedColumn("candidate", edges.id);

  if (match.kind === "durable") {
    const matchIdentityName = sql.identifier(edges.matchIdentityName.name);
    const matchIdentityKey = sql.identifier(edges.matchIdentityKey.name);
    const schemaFenceJoin =
      input.schemaFence === undefined ?
        sql``
      : sql`
        CROSS JOIN (
          SELECT ${tables.schemaVersions.version}
          FROM ${tables.schemaVersions}
          WHERE ${tables.schemaVersions.graphId} = ${input.schemaFence.graphId}
            AND ${tables.schemaVersions.version} = ${input.schemaFence.expectedVersion}
            AND ${tables.schemaVersions.isActive} = TRUE
          ${input.schemaLockClause ?? sql``}
        ) AS "schema_fence"
      `;
    return sql`
      INSERT INTO ${edges} (${columns})
      SELECT
        ${params.graphId}, ${params.id}, ${params.kind},
        ${params.fromKind}, ${params.fromId}, ${params.toKind}, ${params.toId},
        ${propsJson}, ${match.identity.name}, ${match.identity.key},
        ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
        ${timestamp}, ${timestamp}
      FROM (SELECT 1 AS present) AS "candidate_write"
      ${schemaFenceJoin}
      WHERE EXISTS (
        SELECT 1
        FROM ${nodeTable} AS "from_node"
        CROSS JOIN ${nodeTable} AS "to_node"
        WHERE ${buildLiveEndpointPredicate(nodes, params)}
      ) OR EXISTS (
        SELECT 1
        FROM ${edges} AS "identity_owner"
        WHERE ${qualifiedColumn("identity_owner", edges.graphId)} = ${params.graphId}
          AND ${qualifiedColumn("identity_owner", edges.kind)} = ${params.kind}
          AND ${qualifiedColumn("identity_owner", edges.matchIdentityName)} = ${match.identity.name}
          AND ${qualifiedColumn("identity_owner", edges.matchIdentityKey)} = ${match.identity.key}
      )
      ON CONFLICT (${sql.identifier(edges.graphId.name)}, ${sql.identifier(edges.kind.name)}, ${matchIdentityName}, ${matchIdentityKey})
      DO UPDATE SET ${matchIdentityKey} = excluded.${matchIdentityKey}
      WHERE ${edges.id} <> ${params.id}
      RETURNING *, CASE WHEN ${edges.id} = ${params.id} THEN 1 ELSE 0 END AS write_discriminator
    `;
  }

  return sql`
    WITH existing AS MATERIALIZED (
      SELECT "candidate".*, 0::integer AS write_discriminator
      FROM ${edgeTable} AS "candidate"
      WHERE ${edgeGraphId} = ${params.graphId}
        AND ${edgeKind} = ${params.kind}
        AND ${edgeFromKind} = ${params.fromKind}
        AND ${edgeFromId} = ${params.fromId}
        AND ${edgeToKind} = ${params.toKind}
        AND ${edgeToId} = ${params.toId}
        AND ${buildMatchKeyPredicate(edgeProps, match.matchOn, match.props)}
      ORDER BY ${edgeDeletedAt} IS NULL DESC, ${edgeCreatedAt} DESC, ${edgeId} DESC
      LIMIT 1
    ),
    inserted AS (
      INSERT INTO ${edges} (${columns})
      SELECT
        ${params.graphId}, ${params.id}, ${params.kind},
        ${params.fromKind}, ${params.fromId}, ${params.toKind}, ${params.toId},
        ${propsJson}, ${sqlNull(params.matchIdentity?.name)}, ${sqlNull(params.matchIdentity?.key)},
        ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
        ${timestamp}, ${timestamp}
      FROM ${nodeTable} AS "from_node"
      CROSS JOIN ${nodeTable} AS "to_node"
      WHERE NOT EXISTS (SELECT 1 FROM existing)
        AND ${buildLiveEndpointPredicate(nodes, params)}
      RETURNING *, 1::integer AS write_discriminator
    )
    SELECT * FROM existing
    UNION ALL
    SELECT * FROM inserted
    LIMIT 1
  `;
}

/**
 * Builds the closed-program form of durable edge convergence.
 *
 * Unlike the interactive command above, an atomic program cannot turn an
 * empty RETURNING slot into an error after earlier slots have committed.  The
 * input therefore carries an explicit NULL-primary-key sentinel for a stale
 * endpoint, while the identity arbiter uses a NOT NULL created_at sentinel
 * for the impossible same-id conflict.  A conflict with another id is a
 * no-op update and returns that incumbent row. Tombstones are returned
 * unchanged; the paired refusal statement rolls the whole program back so the
 * Store can run its schema-aware resurrection path.
 */
export function buildAtomicConvergeEdges(
  tables: Tables,
  input: AtomicConvergeEdgesParams,
): SQL {
  const { edges, nodes, schemaVersions } = tables;
  const { entries, timestamp, schemaFence, schemaLockClause } = input;
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.match.kind !== "durable")
  ) {
    throw new CompilerInvariantError(
      "Atomic edge convergence requires at least one durable identity.",
    );
  }
  const columns = edgeColumnList(edges);
  const inputColumns = [
    edges.graphId,
    edges.id,
    edges.kind,
    edges.fromKind,
    edges.fromId,
    edges.toKind,
    edges.toId,
    edges.props,
    edges.matchIdentityName,
    edges.matchIdentityKey,
    edges.validFrom,
    edges.validTo,
    edges.createdAt,
    edges.updatedAt,
  ];
  const inputColumnList = sql.raw(
    inputColumns
      .map((column) => `"${column.name.replaceAll('"', '""')}"`)
      .join(", "),
  );
  const values = sql.join(
    entries.map((entry) => {
      const { params, match } = entry;
      if (match.kind !== "durable") {
        throw new CompilerInvariantError(
          "Atomic edge convergence received a dynamic match key.",
        );
      }
      return sql`
        (
                ${castBoundValueForColumn(edges.graphId, params.graphId)},
                ${castBoundValueForColumn(edges.id, params.id)},
                ${castBoundValueForColumn(edges.kind, params.kind)},
                ${castBoundValueForColumn(edges.fromKind, params.fromKind)},
                ${castBoundValueForColumn(edges.fromId, params.fromId)},
                ${castBoundValueForColumn(edges.toKind, params.toKind)},
                ${castBoundValueForColumn(edges.toId, params.toId)},
                ${castBoundValueForColumn(edges.props, JSON.stringify(params.props))},
                ${castBoundValueForColumn(edges.matchIdentityName, match.identity.name)},
                ${castBoundValueForColumn(edges.matchIdentityKey, match.identity.key)},
                ${castBoundValueForColumn(edges.validFrom, sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp)))},
                ${castBoundValueForColumn(edges.validTo, sqlNull(params.validTo))},
                ${castBoundValueForColumn(edges.createdAt, timestamp)},
                ${castBoundValueForColumn(edges.updatedAt, timestamp)}
              )
      `;
    }),
    sql`, `,
  );
  const inputSelect = sql.join(
    inputColumns.map((column) =>
      sql.raw(`"write_rows"."${column.name.replaceAll('"', '""')}"`),
    ),
    sql`, `,
  );
  const sentinelSelect = sql.join(
    inputColumns.map((column) =>
      column === edges.id ?
        castBoundValueForColumn(column, sql.raw("NULL"))
      : sql.raw(`"input_rows"."${column.name.replaceAll('"', '""')}"`),
    ),
    sql`, `,
  );
  const endpointPredicate = sql`
    EXISTS (
      SELECT 1 FROM ${nodes} AS "from_node"
      CROSS JOIN ${nodes} AS "to_node"
      WHERE ${qualifiedColumn("from_node", nodes.graphId)} = ${qualifiedColumn("input_rows", edges.graphId)}
        AND ${qualifiedColumn("from_node", nodes.kind)} = ${qualifiedColumn("input_rows", edges.fromKind)}
        AND ${qualifiedColumn("from_node", nodes.id)} = ${qualifiedColumn("input_rows", edges.fromId)}
        AND ${qualifiedColumn("from_node", nodes.deletedAt)} IS NULL
        AND ${qualifiedColumn("to_node", nodes.graphId)} = ${qualifiedColumn("input_rows", edges.graphId)}
        AND ${qualifiedColumn("to_node", nodes.kind)} = ${qualifiedColumn("input_rows", edges.toKind)}
        AND ${qualifiedColumn("to_node", nodes.id)} = ${qualifiedColumn("input_rows", edges.toId)}
        AND ${qualifiedColumn("to_node", nodes.deletedAt)} IS NULL
    )
  `;
  const identityOwnerPredicate = sql`
    EXISTS (
      SELECT 1
      FROM ${edges} AS "identity_owner"
      WHERE ${qualifiedColumn("identity_owner", edges.graphId)} = ${qualifiedColumn("input_rows", edges.graphId)}
        AND ${qualifiedColumn("identity_owner", edges.kind)} = ${qualifiedColumn("input_rows", edges.kind)}
        AND ${qualifiedColumn("identity_owner", edges.matchIdentityName)} = ${qualifiedColumn("input_rows", edges.matchIdentityName)}
        AND ${qualifiedColumn("identity_owner", edges.matchIdentityKey)} = ${qualifiedColumn("input_rows", edges.matchIdentityKey)}
    )
  `;
  const fence = sql`
    SELECT ${schemaVersions.version}
    FROM ${schemaVersions}
    WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
      AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
      AND ${schemaVersions.isActive} = TRUE
    ${schemaLockClause}
  `;
  return sql`
    WITH "schema_fence" AS (${fence}),
    "input_rows" (${inputColumnList}) AS (VALUES ${values}),
    "valid_rows" AS (
      SELECT "input_rows".*
      FROM "input_rows"
      CROSS JOIN "schema_fence"
      WHERE ${endpointPredicate} OR ${identityOwnerPredicate}
    ),
    "invalid_rows" AS (
      SELECT "input_rows".*
      FROM "input_rows"
      CROSS JOIN "schema_fence"
      WHERE NOT (${endpointPredicate} OR ${identityOwnerPredicate})
    ), "write_rows" AS (
      SELECT * FROM "valid_rows"
      UNION ALL
      SELECT ${sentinelSelect}
      FROM "invalid_rows" AS "input_rows"
    )
    INSERT INTO ${edges} (${columns})
    SELECT ${inputSelect} FROM "write_rows"
    WHERE TRUE
    ON CONFLICT (
      ${sql.identifier(edges.graphId.name)},
      ${sql.identifier(edges.kind.name)},
      ${sql.identifier(edges.matchIdentityName.name)},
      ${sql.identifier(edges.matchIdentityKey.name)}
    ) DO UPDATE SET
      ${sql.identifier(edges.matchIdentityKey.name)} = excluded.${sql.identifier(edges.matchIdentityKey.name)},
      ${sql.identifier(edges.createdAt.name)} = CASE
        WHEN ${edges.id} = excluded.${sql.identifier(edges.id.name)} THEN NULL
        ELSE ${edges.createdAt}
      END
    RETURNING *
  `;
}

/**
 * Forces a tombstoned winner to roll the native program back.
 *
 * Resurrection merges a partial input through the edge's Zod update schema.
 * SQL cannot reproduce arbitrary user transforms without first returning the
 * incumbent to the Store, so the closed path refuses that state and lets the
 * complete portable path own it.
 */
export function buildAtomicConvergeEdgesTombstoneRefusal(
  tables: Tables,
  input: Omit<AtomicConvergeEdgesParams, "timestamp">,
): SQL {
  const { edges, schemaVersions } = tables;
  const { entries, schemaFence, schemaLockClause } = input;
  if (
    entries.length === 0 ||
    entries.some((entry) => entry.match.kind !== "durable")
  ) {
    throw new CompilerInvariantError(
      "Atomic edge tombstone refusal requires at least one durable identity.",
    );
  }
  const requested = sql.join(
    entries.map((entry) => {
      if (entry.match.kind !== "durable") {
        throw new CompilerInvariantError(
          "Atomic edge tombstone refusal received a dynamic match key.",
        );
      }
      return sql`
        (
                ${entry.params.graphId}, ${entry.params.kind},
                ${entry.match.identity.name}, ${entry.match.identity.key}
              )
      `;
    }),
    sql`, `,
  );
  return sql`
    WITH "requested" ("graph_id", "kind", "identity_name", "identity_key")
    AS (VALUES ${requested})
    UPDATE ${edges}
    SET ${sql.identifier(edges.updatedAt.name)} = NULL
    WHERE ${edges.deletedAt} IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "requested"
        WHERE "requested"."graph_id" = ${edges.graphId}
          AND "requested"."kind" = ${edges.kind}
          AND "requested"."identity_name" = ${edges.matchIdentityName}
          AND "requested"."identity_key" = ${edges.matchIdentityKey}
      )
      AND EXISTS (
        SELECT 1
        FROM ${schemaVersions}
        WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
          AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
          AND ${schemaVersions.isActive} = TRUE
        ${schemaLockClause}
      )
  `;
}

/**
 * Combines the schema-version shared fence, both live endpoint predicates and
 * the edge insert. PostgreSQL supplies `FOR SHARE`; SQLite supplies an empty
 * clause because its surrounding `BEGIN IMMEDIATE` is the fence.
 */
export function buildInsertEdgeIfEndpointsLiveWithSchemaFence(
  tables: Tables,
  params: InsertEdgeParams,
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  const { edges, nodes, schemaVersions } = tables;
  const propsJson = JSON.stringify(params.props);
  const columns = edgeColumnList(edges);
  const nodeTable = quotedTableName(getTableName(nodes));

  return sql`
    INSERT INTO ${edges} (${columns})
    SELECT
      ${params.graphId}, ${params.id}, ${params.kind},
      ${params.fromKind}, ${params.fromId}, ${params.toKind}, ${params.toId},
      ${propsJson}, ${sqlNull(params.matchIdentity?.name)}, ${sqlNull(params.matchIdentity?.key)},
      ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)},
      ${timestamp}, ${timestamp}
    FROM ${nodeTable} AS "from_node"
    CROSS JOIN ${nodeTable} AS "to_node"
    CROSS JOIN (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
        AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    ) AS "schema_fence"
    WHERE ${buildLiveEndpointPredicate(nodes, params)}
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
  const columns = edgeColumnList(edges);

  return sql`
    INSERT INTO ${edges} (${columns})
    VALUES ${edgeInsertValue(params, timestamp)}
  `;
}

function edgeInsertValue(params: InsertEdgeParams, timestamp: string): SQL {
  const propsJson = JSON.stringify(params.props);
  return sql`(${params.graphId}, ${params.id}, ${params.kind}, ${params.fromKind}, ${params.fromId}, ${params.toKind}, ${params.toId}, ${propsJson}, ${sqlNull(params.matchIdentity?.name)}, ${sqlNull(params.matchIdentity?.key)}, ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))}, ${sqlNull(params.validTo)}, ${timestamp}, ${timestamp})`;
}

function edgeInsertValues(
  params: readonly InsertEdgeParams[],
  timestamp: string,
): SQL[] {
  return params.map((edgeParams) => edgeInsertValue(edgeParams, timestamp));
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
  const values = edgeInsertValues(params, timestamp);

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
  const values = edgeInsertValues(params, timestamp);

  return sql`
    INSERT INTO ${edges} (${columns})
    VALUES ${sql.join(values, sql`, `)}
    RETURNING *
  `;
}

function buildInsertEdgesBatchWithSchemaFenceStatement(
  tables: Tables,
  params: readonly InsertEdgeParams[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
  returning: boolean,
): SQL {
  const { edges, nodes, schemaVersions } = tables;
  const inputColumns = [
    edges.graphId,
    edges.id,
    edges.kind,
    edges.fromKind,
    edges.fromId,
    edges.toKind,
    edges.toId,
    edges.props,
    edges.matchIdentityName,
    edges.matchIdentityKey,
    edges.validFrom,
    edges.validTo,
    edges.createdAt,
    edges.updatedAt,
  ];
  const inputColumnList = sql.raw(
    inputColumns
      .map((column) => `"${column.name.replaceAll('"', '""')}"`)
      .join(", "),
  );
  const inputSelect = sql.join(
    inputColumns.map((column) =>
      sql.raw(`"valid_rows"."${column.name.replaceAll('"', '""')}"`),
    ),
    sql`, `,
  );
  const sentinelSelect = sql.join(
    inputColumns.map((column) =>
      column === edges.id ?
        castBoundValueForColumn(column, sql.raw("NULL"))
      : sql.raw(`"input_rows"."${column.name.replaceAll('"', '""')}"`),
    ),
    sql`, `,
  );
  const values = params.map((edgeParams) => {
    const postimage = atomicEdgeCreatePostimage(edgeParams, timestamp);
    return sql`
      (
            ${castBoundValueForColumn(edges.graphId, postimage.graphId)},
            ${castBoundValueForColumn(edges.id, postimage.id)},
            ${castBoundValueForColumn(edges.kind, postimage.kind)},
            ${castBoundValueForColumn(edges.fromKind, postimage.fromKind)},
            ${castBoundValueForColumn(edges.fromId, postimage.fromId)},
            ${castBoundValueForColumn(edges.toKind, postimage.toKind)},
            ${castBoundValueForColumn(edges.toId, postimage.toId)},
            ${castBoundValueForColumn(edges.props, postimage.propsJson)},
            ${castBoundValueForColumn(edges.matchIdentityName, sqlNull(postimage.matchIdentityName))},
            ${castBoundValueForColumn(edges.matchIdentityKey, sqlNull(postimage.matchIdentityKey))},
            ${castBoundValueForColumn(edges.validFrom, sqlNull(postimage.storedLowerBound))},
            ${castBoundValueForColumn(edges.validTo, sqlNull(postimage.storedUpperBound))},
            ${castBoundValueForColumn(edges.createdAt, postimage.createdAt)},
            ${castBoundValueForColumn(edges.updatedAt, postimage.updatedAt)}
          )
    `;
  });
  const durableRowCount = params.filter(
    (edgeParams) => edgeParams.matchIdentity !== undefined,
  ).length;
  if (durableRowCount !== 0 && durableRowCount !== params.length) {
    throw new CompilerInvariantError(
      "An atomic edge batch cannot mix durable and ordinary rows.",
    );
  }
  const durableConflictRefusal =
    durableRowCount === 0 ?
      sql``
    : sql`
      ON CONFLICT (
        ${sql.identifier(edges.graphId.name)},
        ${sql.identifier(edges.kind.name)},
        ${sql.identifier(edges.matchIdentityName.name)},
        ${sql.identifier(edges.matchIdentityKey.name)}
      ) DO UPDATE SET ${sql.identifier(edges.createdAt.name)} = NULL
    `;
  const result = returning ? sql`RETURNING *` : sql`RETURNING 1 AS "inserted"`;

  // The invalid-endpoint arm deliberately inserts a NULL primary-key id. It
  // turns a missing endpoint into a statement error, so an atomic transport
  // rolls back earlier chunks instead of committing the valid chunks while a
  // later chunk quietly returns zero rows. A missing schema fence produces no
  // guard row, preserving the all-zero stale-fence sentinel for the store.
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
    ), "valid_rows" AS (
      SELECT "input_rows".*
      FROM "input_rows"
      CROSS JOIN "schema_fence"
      WHERE EXISTS (
        SELECT 1
        FROM ${nodes} AS "from_node"
        WHERE ${qualifiedColumn("from_node", nodes.graphId)} = ${qualifiedColumn("input_rows", edges.graphId)}
          AND ${qualifiedColumn("from_node", nodes.kind)} = ${qualifiedColumn("input_rows", edges.fromKind)}
          AND ${qualifiedColumn("from_node", nodes.id)} = ${qualifiedColumn("input_rows", edges.fromId)}
          AND ${qualifiedColumn("from_node", nodes.deletedAt)} IS NULL
      )
        AND EXISTS (
          SELECT 1
          FROM ${nodes} AS "to_node"
          WHERE ${qualifiedColumn("to_node", nodes.graphId)} = ${qualifiedColumn("input_rows", edges.graphId)}
            AND ${qualifiedColumn("to_node", nodes.kind)} = ${qualifiedColumn("input_rows", edges.toKind)}
            AND ${qualifiedColumn("to_node", nodes.id)} = ${qualifiedColumn("input_rows", edges.toId)}
            AND ${qualifiedColumn("to_node", nodes.deletedAt)} IS NULL
        )
    ), "invalid_endpoint" AS (
      SELECT 1 AS "present"
      FROM "input_rows"
      CROSS JOIN "schema_fence"
      WHERE (SELECT COUNT(*) FROM "valid_rows") <> (SELECT COUNT(*) FROM "input_rows")
      LIMIT 1
    )
    INSERT INTO ${edges} (${edgeColumnList(edges)})
    SELECT ${inputSelect}
    FROM "valid_rows"
    UNION ALL
    SELECT ${sentinelSelect}
    FROM "input_rows"
    CROSS JOIN "invalid_endpoint"
    LIMIT (SELECT COUNT(*) FROM "valid_rows") + (SELECT COUNT(*) FROM "invalid_endpoint")
    ${durableConflictRefusal}
    ${result}
  `;
}

/**
 * Builds one schema-fenced edge batch whose every input endpoint must be
 * live. A missing endpoint is a SQL error rather than a zero-row member, so
 * native multi-statement transports cannot commit earlier chunks partially.
 */
export function buildInsertEdgesBatchWithSchemaFence(
  tables: Tables,
  params: readonly InsertEdgeParams[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  return buildInsertEdgesBatchWithSchemaFenceStatement(
    tables,
    params,
    timestamp,
    schemaFence,
    schemaLockClause,
    false,
  );
}

/** Schema-fenced edge batch variant returning inserted edge rows. */
export function buildInsertEdgesBatchReturningWithSchemaFence(
  tables: Tables,
  params: readonly InsertEdgeParams[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  return buildInsertEdgesBatchWithSchemaFenceStatement(
    tables,
    params,
    timestamp,
    schemaFence,
    schemaLockClause,
    true,
  );
}

/**
 * Builds one durable-identity batch insert. Identity conflicts are deliberately
 * ignored and omitted from RETURNING; the store maps those omissions to the
 * typed durable-identity refusal, while primary-key conflicts still reach the
 * normal duplicate-key classifier.
 */
export function buildInsertEdgesDurableBatchReturning(
  tables: Tables,
  params: readonly InsertEdgeParams[],
  timestamp: string,
): SQL {
  const { edges } = tables;
  const columns = edgeColumnList(edges);
  const values = edgeInsertValues(params, timestamp);

  return sql`
    INSERT INTO ${edges} (${columns})
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (
      ${sql.identifier(edges.graphId.name)},
      ${sql.identifier(edges.kind.name)},
      ${sql.identifier(edges.matchIdentityName.name)},
      ${sql.identifier(edges.matchIdentityKey.name)}
    ) DO NOTHING
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
  //
  // So this is the one window-writing site in the backend that does NOT stamp:
  // the gate above guarantees the caller named a bound, and there is no instant
  // to judge. It therefore passes the stated value through
  // (`resolveStatedValidityLowerBound`) rather than routing through the stamping
  // owner, which would silently turn "the caller said this" into "the write
  // chose this" on a path where nothing was chosen.
  if (params.clearDeleted && params.validFrom !== undefined) {
    setParts.push(
      sql`${quotedColumn(edges.validFrom)} = ${sqlNull(resolveStatedValidityLowerBound(params.validFrom))}`,
      sql`${quotedColumn(edges.validTo)} = ${sqlNull(params.validTo)}`,
    );
  } else if (params.clearValidTo === true) {
    setParts.push(sql`${quotedColumn(edges.validTo)} = NULL`);
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
  const expectedValidTo = expectedValidFromPredicate(
    edges.validTo,
    params.expectedValidTo,
  );

  if (params.clearDeleted) {
    return sql`
      UPDATE ${edges}
      SET ${setClause}
      WHERE ${edges.graphId} = ${params.graphId}
        AND ${edges.id} = ${params.id}${expectedIdentity}${expectedValidFrom}${expectedValidTo}
      RETURNING *
    `;
  }

  return sql`
    UPDATE ${edges}
    SET ${setClause}
    WHERE ${edges.graphId} = ${params.graphId}
      AND ${edges.id} = ${params.id}${expectedIdentity}${expectedValidFrom}${expectedValidTo}
      AND ${edges.deletedAt} IS NULL
    RETURNING *
  `;
}

/** One guarded set update for distinct, live edge after-images. */
export function buildAtomicEdgeResolvedUpdateBatch(
  tables: Tables,
  entries: readonly AtomicEdgeResolvedUpdateEntry[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  const { edges, schemaVersions } = tables;
  const first = entries[0];
  if (first === undefined) return sql`SELECT 1 WHERE FALSE`;
  const firstPostimage = atomicEdgeUpdatePostimage(first, timestamp);
  const postimages = [
    firstPostimage,
    ...entries
      .slice(1)
      .map((entry) => atomicEdgeUpdatePostimage(entry, timestamp)),
  ];
  const propsCases = postimages.map(
    (postimage) =>
      sql`WHEN ${postimage.id} THEN ${castBoundValueForColumn(edges.props, postimage.propsJson)}`,
  );
  const expectedRows = entries.map((entry) => {
    const existing = entry.existing;
    return sql`
      (
            ${edges.id} = ${existing.id}
            AND ${edges.kind} = ${existing.kind}
            AND ${edges.fromKind} = ${existing.from_kind}
            AND ${edges.fromId} = ${existing.from_id}
            AND ${edges.toKind} = ${existing.to_kind}
            AND ${edges.toId} = ${existing.to_id}
            AND ${edges.updatedAt} = ${existing.updated_at}
            AND ${edges.props} = ${castBoundValueForColumn(edges.props, rowPropsToJsonText(existing.props))}
            ${expectedValidFromPredicate(edges.validFrom, existing.valid_from ?? EXPECTED_SQL_NULL)}
            ${expectedValidFromPredicate(edges.validTo, existing.valid_to ?? EXPECTED_SQL_NULL)}
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
    )
    UPDATE ${edges}
    SET ${quotedColumn(edges.props)} = CASE ${edges.id}
          ${sql.join(propsCases, sql` `)}
          ELSE ${edges.props}
        END,
        ${quotedColumn(edges.updatedAt)} = ${firstPostimage.updatedAt}
    WHERE ${edges.graphId} = ${first.existing.graph_id}
      AND ${edges.kind} = ${first.existing.kind}
      AND ${edges.deletedAt} IS NULL
      AND ${edges.id} IN (${sql.join(
        entries.map((entry) => sql`${entry.existing.id}`),
        sql`, `,
      )})
      AND (
        SELECT COUNT(*)
        FROM ${edges}
        CROSS JOIN "schema_fence"
        WHERE ${edges.graphId} = ${first.existing.graph_id}
          AND ${edges.deletedAt} IS NULL
          AND (${sql.join(expectedRows, sql` OR `)})
      ) = ${entries.length}
    RETURNING *
  `;
}

/**
 * Terminal database assertion for an atomic resolved edge mutation set.
 * A missing guarded postimage turns the refusal row's NOT NULL kind into the
 * rollback sentinel; its duplicate primary key independently refuses the row
 * when the first input still exists. A stale schema fence is diagnosed by the
 * Store after the same sentinel rolls the program back.
 */
export function buildAssertAtomicEdgeMutationPostimages(
  tables: Tables,
  creates: readonly InsertEdgeParams[],
  updates: readonly AtomicEdgeResolvedUpdateEntry[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
): SQL {
  const { edges, schemaVersions } = tables;
  const firstCreate = creates[0];
  const firstUpdate = updates[0];
  if (firstCreate === undefined && firstUpdate === undefined) {
    return sql`SELECT 1 WHERE FALSE`;
  }
  const first =
    firstCreate === undefined ?
      atomicEdgeUpdatePostimage(requireDefined(firstUpdate), timestamp)
    : atomicEdgeCreatePostimage(firstCreate, timestamp);
  const entries = [
    ...creates.map((params) => atomicEdgeCreatePostimage(params, timestamp)),
    ...updates.map((entry) => atomicEdgeUpdatePostimage(entry, timestamp)),
  ];
  const expectedRows = entries.map(
    (entry) => sql`
      (
            ${edges.id} = ${entry.id}
            AND ${edges.kind} = ${entry.kind}
            AND ${edges.fromKind} = ${entry.fromKind}
            AND ${edges.fromId} = ${entry.fromId}
            AND ${edges.toKind} = ${entry.toKind}
            AND ${edges.toId} = ${entry.toId}
            AND ${edges.props} = ${castBoundValueForColumn(edges.props, entry.propsJson)}
            AND ${edges.updatedAt} = ${entry.updatedAt}
          )
    `,
  );

  return sql`
    INSERT INTO ${edges} (${edgeColumnList(edges)})
    SELECT
      ${first.graphId},
      ${first.id},
      NULL,
      ${first.fromKind},
      ${first.fromId},
      ${first.toKind},
      ${first.toId},
      ${castBoundValueForColumn(edges.props, first.propsJson)},
      ${sqlNull(first.matchIdentityName)},
      ${sqlNull(first.matchIdentityKey)},
      ${sqlNull(first.storedLowerBound)},
      ${sqlNull(first.storedUpperBound)},
      ${first.createdAt},
      ${first.updatedAt}
    WHERE NOT EXISTS (
        SELECT 1
        FROM ${schemaVersions}
        WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
          AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
          AND ${schemaVersions.isActive} = TRUE
      ) OR (
        SELECT COUNT(*)
        FROM ${edges}
        WHERE ${edges.graphId} = ${first.graphId}
          AND ${edges.deletedAt} IS NULL
          AND (${sql.join(expectedRows, sql` OR `)})
      ) <> ${entries.length}
  `;
}

/** Reads the asserted rows only while the same schema fence remains current. */
export function buildReadAtomicEdgeMutationPostimages(
  tables: Tables,
  graphId: string,
  ids: readonly string[],
  schemaFence: SchemaWriteFenceParams,
): SQL {
  const { edges, schemaVersions } = tables;
  return sql`
    SELECT ${edges}.*
    FROM ${edges}
    CROSS JOIN ${schemaVersions}
    WHERE ${edges.graphId} = ${graphId}
      AND ${edges.id} IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND ${schemaVersions.graphId} = ${schemaFence.graphId}
      AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
      AND ${schemaVersions.isActive} = TRUE
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
      )})${expectedIdentityPredicate(tables, params.kind === undefined ? {} : { kind: params.kind })}
      AND ${edges.deletedAt} IS NULL
  `;
}

/**
 * Builds one closed, schema-fenced edge soft-delete statement.
 *
 * A foreign-kind row deliberately assigns NULL to the NOT NULL kind column,
 * aborting this statement and every earlier native-program chunk. A stale
 * fence selects no rows, preserving the side-effect-free zero-row sentinel.
 */
export function buildAtomicEdgeDeleteBatchWithSchemaFence(
  tables: Tables,
  input: AtomicEdgeDeleteBatchInput,
  timestamp: string,
  schemaLockClause: SQL,
): SQL {
  const { edges, schemaVersions } = tables;

  return sql`
    WITH "schema_fence" AS (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${input.schemaFence.graphId}
        AND ${schemaVersions.version} = ${input.schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    )
    UPDATE ${edges}
    SET ${quotedColumn(edges.deletedAt)} = CASE
          WHEN ${edges.kind} = ${input.expectedKind} THEN ${timestamp}
          ELSE ${edges.deletedAt}
        END,
        ${quotedColumn(edges.kind)} = CASE
          WHEN ${edges.kind} = ${input.expectedKind} THEN ${edges.kind}
          ELSE NULL
        END
    WHERE ${edges.graphId} = ${input.graphId}
      AND ${edges.id} IN (${sql.join(
        input.ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND EXISTS (SELECT 1 FROM "schema_fence")
      AND (${edges.deletedAt} IS NULL OR ${edges.kind} <> ${input.expectedKind})
    RETURNING ${edges.id}
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
      )})${expectedIdentityPredicate(tables, params.kind === undefined ? {} : { kind: params.kind })}
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
