import { getTableName, type SQL, sql } from "drizzle-orm";

import {
  type ConstrainedCardinality,
  EDGE_CARDINALITY_SPECS,
  edgeCardinalityClaimTarget,
  type EdgeCardinalitySpec,
} from "../../../store/claims/edge-claims";
import { resolveStampedValidityLowerBound } from "../../../utils/date";
import type {
  ClaimEdgeCardinalityParams,
  InsertEdgeParams,
  PurgeEdgeClaimsParams,
  SchemaWriteFenceParams,
} from "../../types";
import {
  castBoundValueForColumn,
  edgeColumnList,
  quotedColumn,
  quotedTableName,
  sqlNull,
  type Tables,
} from "./shared";

/**
 * Qualifies a column with its relation, the one rendering both dialects read
 * identically. The claim statements name TWO relations (the claim rows and the
 * edges their holders are), so a bare column name would be ambiguous in the
 * takeover statement's correlated subquery.
 */
function qualified(tableName: string, column: Readonly<{ name: string }>): SQL {
  return sql.raw(`"${tableName}"."${column.name}"`);
}

function qualifiedAlias(
  alias: string,
  column: Readonly<{ name: string }>,
): SQL {
  return sql.raw(`"${alias}"."${column.name.replaceAll('"', '""')}"`);
}

/**
 * WHERE a claim statement reads the per-edge values its predicates compare
 * against.
 *
 * A single-row statement binds them as parameters; a batch statement reads
 * them as columns of the `proposed` relation it drives from. Every claim
 * predicate below is rendered from this record and nothing else, so the two
 * families cannot decide an axis differently — the batch path is a change of
 * where the values come from, never of what they mean.
 */
type ClaimValueSource = Readonly<{
  graphId: SQL;
  edgeId: SQL;
  edgeKind: SQL;
  fromKind: SQL;
  fromId: SQL;
  toKind: SQL;
  toId: SQL;
}>;

function boundClaimValues(params: ClaimEdgeCardinalityParams): ClaimValueSource {
  return {
    graphId: sql`${params.graphId}`,
    edgeId: sql`${params.edgeId}`,
    edgeKind: sql`${params.edgeKind}`,
    fromKind: sql`${params.fromKind}`,
    fromId: sql`${params.fromId}`,
    toKind: sql`${params.toKind}`,
    toId: sql`${params.toId}`,
  };
}

/**
 * The relation a batch claim statement drives from: one row per proposed edge,
 * carrying its axis, its key, and every value the predicates compare against.
 *
 * This is the whole point of the batch shape. Spelling one predicate arm per
 * proposed row instead produces a statement whose executor state — two
 * `EXISTS` and one `NOT EXISTS` subplan per arm — grows with the chunk, so a
 * chunk the bind budget permits takes minutes and gigabytes and runs long
 * stretches without reaching a cancellation check. Driving from a relation
 * gives the planner ONE plan whose per-row work is an index probe.
 */
const PROPOSED_RELATION = "proposed";

const PROPOSED_COLUMNS = {
  graphId: "graph_id",
  axis: "axis",
  key: "key",
  edgeId: "edge_id",
  edgeKind: "edge_kind",
  fromKind: "from_kind",
  fromId: "from_id",
  toKind: "to_kind",
  toId: "to_id",
} as const;

type ProposedColumn = keyof typeof PROPOSED_COLUMNS;

const PROPOSED_RELATION_REF: SQL = sql.raw(`"${PROPOSED_RELATION}"`);

const PROPOSED_COLUMN_ORDER = [
  "graphId",
  "axis",
  "key",
  "edgeId",
  "edgeKind",
  "fromKind",
  "fromId",
  "toKind",
  "toId",
] as const satisfies readonly ProposedColumn[];

/**
 * How many bind parameters one proposed row costs. Read by the caller that
 * chunks a claim batch against the backend's bind budget; asserted against the
 * rendered statements by `tests/atomic-edge-claim-relation.test.ts` so the two
 * cannot drift.
 */
export const ATOMIC_EDGE_CLAIM_PROPOSED_COLUMN_COUNT =
  PROPOSED_COLUMN_ORDER.length;

function proposedValue(column: ProposedColumn): SQL {
  return qualifiedAlias(PROPOSED_RELATION, { name: PROPOSED_COLUMNS[column] });
}

const PROPOSED_CLAIM_VALUES: ClaimValueSource = {
  graphId: proposedValue("graphId"),
  edgeId: proposedValue("edgeId"),
  edgeKind: proposedValue("edgeKind"),
  fromKind: proposedValue("fromKind"),
  fromId: proposedValue("fromId"),
  toKind: proposedValue("toKind"),
  toId: proposedValue("toId"),
};

/**
 * The column each proposed value is CAST to. PostgreSQL resolves a `VALUES`
 * relation's column types from its literals, and a bound parameter carries
 * none, so an uncast relation would compare `unknown` against a stored column
 * and lose every index probe this shape exists to gain.
 */
function proposedColumnTypeSources(
  tables: Tables,
): Readonly<Record<ProposedColumn, Readonly<{ getSQLType: () => string }>>> {
  const { edgeClaims, edges } = tables;
  return {
    graphId: edgeClaims.graphId,
    axis: edgeClaims.axis,
    key: edgeClaims.key,
    edgeId: edgeClaims.edgeId,
    edgeKind: edges.kind,
    fromKind: edges.fromKind,
    fromId: edges.fromId,
    toKind: edges.toKind,
    toId: edges.toId,
  };
}

function proposedRelationCte(
  tables: Tables,
  entries: readonly ClaimEdgeCardinalityParams[],
): SQL {
  const columnTypes = proposedColumnTypeSources(tables);
  const header = sql.raw(
    PROPOSED_COLUMN_ORDER.map(
      (column) => `"${PROPOSED_COLUMNS[column]}"`,
    ).join(", "),
  );
  const rows = entries.map((entry) => {
    const target = edgeCardinalityClaimTarget(entry);
    const values: Readonly<Record<ProposedColumn, string>> = {
      graphId: entry.graphId,
      axis: target.axis,
      key: target.key,
      edgeId: entry.edgeId,
      edgeKind: entry.edgeKind,
      fromKind: entry.fromKind,
      fromId: entry.fromId,
      toKind: entry.toKind,
      toId: entry.toId,
    };
    return sql`(${sql.join(
      PROPOSED_COLUMN_ORDER.map((column) =>
        castBoundValueForColumn(columnTypes[column], values[column]),
      ),
      sql`, `,
    )})`;
  });
  return sql`
    ${PROPOSED_RELATION_REF} (${header}) AS (
      VALUES ${sql.join(rows, sql`, `)}
    )
  `;
}

/**
 * Splits a chunk into the groups that can share one statement.
 *
 * The claim predicates are shaped by {@link EdgeCardinalitySpec}: which
 * endpoints the axis key covers, and what a holder must still be. Those are
 * predicate SHAPE, not values, so they cannot ride in the `proposed` relation
 * without becoming OR-guarded terms the planner can no longer seek on — which
 * is the cost this rewrite exists to remove. One statement per distinct
 * cardinality keeps every term index-seekable; a chunk of one edge kind, the
 * ordinary case, still renders exactly one statement.
 *
 * First-appearance order, so a rendered program is deterministic.
 */
function groupEntriesByCardinality(
  entries: readonly ClaimEdgeCardinalityParams[],
): readonly (readonly ClaimEdgeCardinalityParams[])[] {
  const groups = new Map<ConstrainedCardinality, ClaimEdgeCardinalityParams[]>();
  for (const entry of entries) {
    const group = groups.get(entry.cardinality);
    if (group === undefined) groups.set(entry.cardinality, [entry]);
    else group.push(entry);
  }
  return [...groups.values()];
}

function specOf(
  entries: readonly ClaimEdgeCardinalityParams[],
): EdgeCardinalitySpec {
  const [first] = entries;
  if (first === undefined) {
    throw new TypeError("A cardinality group is never empty.");
  }
  return EDGE_CARDINALITY_SPECS[first.cardinality];
}

/**
 * The live entity predicate a claim guards, excluding the proposed holder.
 * Both the guarded lock and guarded takeover use this exact fragment so the
 * fast path cannot disagree about what constitutes a claimless incumbent.
 */
function competingLiveEdgePredicate(
  tables: Tables,
  values: ClaimValueSource,
  spec: EdgeCardinalitySpec,
): SQL {
  const { edges } = tables;
  const edgesName = getTableName(edges);
  const toEndpointTerms =
    spec.keyShape === "fromAndTo" ?
      sql` AND ${qualified(edgesName, edges.toKind)} = ${values.toKind} AND ${qualified(edgesName, edges.toId)} = ${values.toId}`
    : sql``;
  const activeTerm =
    spec.holderLiveness === "liveAndActive" ?
      sql` AND ${qualified(edgesName, edges.validTo)} IS NULL`
    : sql``;

  return sql`
    ${qualified(edgesName, edges.graphId)} = ${values.graphId}
      AND ${qualified(edgesName, edges.id)} <> ${values.edgeId}
      AND ${qualified(edgesName, edges.deletedAt)} IS NULL
      AND ${qualified(edgesName, edges.kind)} = ${values.edgeKind}
      AND ${qualified(edgesName, edges.fromKind)} = ${values.fromKind}
      AND ${qualified(edgesName, edges.fromId)} = ${values.fromId}${toEndpointTerms}${activeTerm}
  `;
}

function proposedEndpointsLivePredicate(
  tables: Tables,
  values: ClaimValueSource,
): SQL {
  const { nodes } = tables;
  return sql`
    EXISTS (
      SELECT 1 FROM ${nodes} AS "from_node"
      WHERE ${qualifiedAlias("from_node", nodes.graphId)} = ${values.graphId}
        AND ${qualifiedAlias("from_node", nodes.kind)} = ${values.fromKind}
        AND ${qualifiedAlias("from_node", nodes.id)} = ${values.fromId}
        AND ${qualifiedAlias("from_node", nodes.deletedAt)} IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM ${nodes} AS "to_node"
      WHERE ${qualifiedAlias("to_node", nodes.graphId)} = ${values.graphId}
        AND ${qualifiedAlias("to_node", nodes.kind)} = ${values.toKind}
        AND ${qualifiedAlias("to_node", nodes.id)} = ${values.toId}
        AND ${qualifiedAlias("to_node", nodes.deletedAt)} IS NULL
    )
  `;
}

function schemaFenceCte(
  tables: Tables,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): SQL {
  const { schemaVersions } = tables;
  return sql`
    "schema_fence" AS (
      SELECT ${schemaVersions.version}
      FROM ${schemaVersions}
      WHERE ${schemaVersions.graphId} = ${schemaFence.graphId}
        AND ${schemaVersions.version} = ${schemaFence.expectedVersion}
        AND ${schemaVersions.isActive} = TRUE
      ${schemaLockClause}
    )
  `;
}

/**
 * Whether the edge a claim row NAMES is still an edge that claim describes.
 *
 * Correlated to the claim relation, not to a bound id: a claim is stale
 * exactly when its recorded holder no longer satisfies this, which is what
 * makes an abandoned claim self-healing without any release path having run.
 */
function recordedClaimHolderIsLivePredicate(
  tables: Tables,
  values: ClaimValueSource,
  spec: EdgeCardinalitySpec,
): SQL {
  const { edgeClaims, edges } = tables;
  const claimsName = getTableName(edgeClaims);
  const edgesName = getTableName(edges);
  const toEndpointTerms =
    spec.keyShape === "fromAndTo" ?
      sql` AND ${qualified(edgesName, edges.toKind)} = ${values.toKind} AND ${qualified(edgesName, edges.toId)} = ${values.toId}`
    : sql``;
  const activeTerm =
    spec.holderLiveness === "liveAndActive" ?
      sql` AND ${qualified(edgesName, edges.validTo)} IS NULL`
    : sql``;
  return sql`
    ${qualified(edgesName, edges.graphId)} = ${qualified(claimsName, edgeClaims.graphId)}
      AND ${qualified(edgesName, edges.id)} = ${qualified(claimsName, edgeClaims.edgeId)}
      AND ${qualified(edgesName, edges.deletedAt)} IS NULL
      AND ${qualified(edgesName, edges.kind)} = ${values.edgeKind}
      AND ${qualified(edgesName, edges.fromKind)} = ${values.fromKind}
      AND ${qualified(edgesName, edges.fromId)} = ${values.fromId}${toEndpointTerms}${activeTerm}
  `;
}

/**
 * Removes stale foreign holders before the guarded edge rows are inserted.
 * The schema and endpoint gates ensure a stale fence remains a side-effect-free
 * no-op; a later edge refusal rolls this mutation back with the whole program.
 *
 * One statement per cardinality group; see {@link groupEntriesByCardinality}.
 *
 * The `stale` CTE names its projection distinctly (`stale_graph_id`, …): the
 * row-value comparison the DELETE ends with is against the target relation's
 * OWN columns, whatever a custom table calls them, and must not resolve to the
 * CTE's.
 */
export function buildDeleteStaleAtomicEdgeClaims(
  tables: Tables,
  entries: readonly ClaimEdgeCardinalityParams[],
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): readonly SQL[] {
  const { edgeClaims, edges } = tables;
  const claimsName = getTableName(edgeClaims);
  const values = PROPOSED_CLAIM_VALUES;
  return groupEntriesByCardinality(entries).map((group) => {
    const spec = specOf(group);
    return sql`
      WITH ${schemaFenceCte(tables, schemaFence, schemaLockClause)},
      ${proposedRelationCte(tables, group)},
      "stale" AS (
        SELECT
          ${qualified(claimsName, edgeClaims.graphId)} AS "stale_graph_id",
          ${qualified(claimsName, edgeClaims.axis)} AS "stale_axis",
          ${qualified(claimsName, edgeClaims.key)} AS "stale_key"
        FROM ${edgeClaims}
        JOIN ${PROPOSED_RELATION_REF}
          ON ${qualified(claimsName, edgeClaims.graphId)} = ${values.graphId}
          AND ${qualified(claimsName, edgeClaims.axis)} = ${proposedValue("axis")}
          AND ${qualified(claimsName, edgeClaims.key)} = ${proposedValue("key")}
        WHERE ${qualified(claimsName, edgeClaims.edgeId)} <> ${values.edgeId}
          AND EXISTS (SELECT 1 FROM "schema_fence")
          AND ${proposedEndpointsLivePredicate(tables, values)}
          AND NOT EXISTS (
            SELECT 1 FROM ${edges}
            WHERE ${recordedClaimHolderIsLivePredicate(tables, values, spec)}
          )
      )
      DELETE FROM ${edgeClaims}
      WHERE (
        ${quotedColumn(edgeClaims.graphId)},
        ${quotedColumn(edgeClaims.axis)},
        ${quotedColumn(edgeClaims.key)}
      ) IN (SELECT "stale_graph_id", "stale_axis", "stale_key" FROM "stale")
    `;
  });
}

/**
 * Acquires every still-unowned axis before inserting the guarded edge rows.
 *
 * One statement per cardinality group; see {@link groupEntriesByCardinality}.
 */
export function buildAcquireAtomicEdgeClaims(
  tables: Tables,
  entries: readonly ClaimEdgeCardinalityParams[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): readonly SQL[] {
  const { edgeClaims, edges } = tables;
  const columns = sql.raw(
    `"${edgeClaims.graphId.name}", "${edgeClaims.axis.name}", "${edgeClaims.key.name}", "${edgeClaims.edgeId.name}", "${edgeClaims.updatedAt.name}"`,
  );
  const conflictColumns = sql.raw(
    `"${edgeClaims.graphId.name}", "${edgeClaims.axis.name}", "${edgeClaims.key.name}"`,
  );
  const values = PROPOSED_CLAIM_VALUES;
  return groupEntriesByCardinality(entries).map((group) => {
    const spec = specOf(group);
    return sql`
      WITH ${schemaFenceCte(tables, schemaFence, schemaLockClause)},
      ${proposedRelationCte(tables, group)}
      INSERT INTO ${edgeClaims} (${columns})
      SELECT
        ${values.graphId},
        ${proposedValue("axis")},
        ${proposedValue("key")},
        ${values.edgeId},
        ${castBoundValueForColumn(edgeClaims.updatedAt, timestamp)}
      FROM "schema_fence" CROSS JOIN ${PROPOSED_RELATION_REF}
      WHERE ${proposedEndpointsLivePredicate(tables, values)}
        AND NOT EXISTS (
          SELECT 1 FROM ${edges}
          WHERE ${competingLiveEdgePredicate(tables, values, spec)}
        )
      ON CONFLICT (${conflictColumns}) DO NOTHING
    `;
  });
}

/**
 * Aborts the atomic transport when any proposed edge does not own its declared
 * axis. The NULL axis is an internal sentinel classified at the backend seam;
 * the surrounding native transaction rolls the earlier claim mutations back.
 *
 * The projection aliases name the target columns. INSERT maps positionally and
 * ignores them, but they are what makes this statement identifiable as the
 * refusal leg in a rendered program — the backend tests discriminate the three
 * claim phases by them.
 *
 * One statement per cardinality group; see {@link groupEntriesByCardinality}.
 */
export function buildAssertAtomicEdgeClaimsOwned(
  tables: Tables,
  entries: readonly ClaimEdgeCardinalityParams[],
  timestamp: string,
  schemaFence: SchemaWriteFenceParams,
  schemaLockClause: SQL,
): readonly SQL[] {
  const { edgeClaims } = tables;
  const claimsName = getTableName(edgeClaims);
  const columns = sql.raw(
    `"${edgeClaims.graphId.name}", "${edgeClaims.axis.name}", "${edgeClaims.key.name}", "${edgeClaims.edgeId.name}", "${edgeClaims.updatedAt.name}"`,
  );
  const values = PROPOSED_CLAIM_VALUES;
  return groupEntriesByCardinality(entries).map(
    (group) => sql`
      WITH ${schemaFenceCte(tables, schemaFence, schemaLockClause)},
      ${proposedRelationCte(tables, group)}
      INSERT INTO ${edgeClaims} (${columns})
      SELECT
        ${values.graphId} AS graph_id,
        ${castBoundValueForColumn(edgeClaims.axis, sql.raw("NULL"))} AS axis,
        ${proposedValue("key")} AS key,
        ${values.edgeId} AS edge_id,
        ${castBoundValueForColumn(edgeClaims.updatedAt, timestamp)} AS updated_at
      FROM "schema_fence" CROSS JOIN ${PROPOSED_RELATION_REF}
      WHERE ${proposedEndpointsLivePredicate(tables, values)}
        AND NOT EXISTS (
          SELECT 1 FROM ${edgeClaims}
          WHERE ${qualified(claimsName, edgeClaims.graphId)} = ${values.graphId}
            AND ${qualified(claimsName, edgeClaims.axis)} = ${proposedValue("axis")}
            AND ${qualified(claimsName, edgeClaims.key)} = ${proposedValue("key")}
            AND ${qualified(claimsName, edgeClaims.edgeId)} = ${values.edgeId}
        )
      LIMIT 1
    `,
  );
}

/**
 * Statement 1 — create-or-lock, decision-free.
 *
 * Its only job is to make the row exist, take its row lock, and report the
 * COMMITTED holder. The `DO UPDATE SET updated_at = <existing>.updated_at` is a
 * deliberate no-op write: it is what makes a conflicting row lock and report
 * itself through RETURNING, which a bare `DO NOTHING` would not. This is the
 * same statement shape `insertUnique` already uses, through the same
 * existing-row qualification, so it introduces no new dialect surface.
 *
 * A returned holder equal to the proposed edge means this writer owns the axis
 * and is done. Any other holder is decided by {@link buildTakeOverEdgeClaim},
 * against a FRESH snapshot — deciding inside this statement would read the
 * pre-lock snapshot of the edges relation and accept two concurrent writers.
 */
export function buildLockEdgeClaims(
  tables: Tables,
  entries: readonly ClaimEdgeCardinalityParams[],
  timestamp: string,
): SQL {
  const { edgeClaims } = tables;
  const claimsName = getTableName(edgeClaims);

  const columns = sql.raw(
    `"${edgeClaims.graphId.name}", "${edgeClaims.axis.name}", "${edgeClaims.key.name}", "${edgeClaims.edgeId.name}", "${edgeClaims.updatedAt.name}"`,
  );
  const conflictColumns = sql.raw(
    `"${edgeClaims.graphId.name}", "${edgeClaims.axis.name}", "${edgeClaims.key.name}"`,
  );
  const valueRows = sql.join(
    entries.map((entry) => {
      const target = edgeCardinalityClaimTarget(entry);
      return sql`(${entry.graphId}, ${target.axis}, ${target.key}, ${entry.edgeId}, ${timestamp})`;
    }),
    sql`, `,
  );

  return sql`
    INSERT INTO ${edgeClaims} (${columns})
    VALUES ${valueRows}
    ON CONFLICT (${conflictColumns})
    DO UPDATE SET ${quotedColumn(edgeClaims.updatedAt)} = ${qualified(claimsName, edgeClaims.updatedAt)}
    RETURNING
      ${quotedColumn(edgeClaims.axis)} as axis,
      ${quotedColumn(edgeClaims.key)} as key,
      ${quotedColumn(edgeClaims.edgeId)} as holder_edge_id
  `;
}

/**
 * Single-row create-or-lock with an entity-relation guard in its RETURNING
 * projection. The upsert first establishes the cardinality-axis row lock; its
 * returned holder resolves concurrent claimants, while `has_incumbent`
 * catches rows imported or written before the claim relation existed.
 *
 * A matching row with the proposed id is excluded. That is the legitimate
 * resurrection/reopen case: the same edge is reclaiming the same axis.
 * PostgreSQL's READ COMMITTED snapshot does not refresh this `EXISTS` after an
 * `ON CONFLICT` wait. Managed constrained writes consume the probe-folding
 * contract only while holding TypeGraph's graph advisory lock, so committed
 * preexisting rows are visible and peers cannot publish a claimless row during
 * this statement. Claim-aware writers outside that lock still serialize on the
 * returned claim holder. A direct writer that bypasses both TypeGraph's lock
 * and its claim relation is outside the enforceable cardinality contract.
 */
export function buildLockEdgeClaimGuarded(
  tables: Tables,
  params: ClaimEdgeCardinalityParams,
  timestamp: string,
): SQL {
  const { edgeClaims, edges } = tables;
  const claimsName = getTableName(edgeClaims);
  const target = edgeCardinalityClaimTarget(params);

  return sql`
    INSERT INTO ${edgeClaims} (
      ${sql.identifier(edgeClaims.graphId.name)},
      ${sql.identifier(edgeClaims.axis.name)},
      ${sql.identifier(edgeClaims.key.name)},
      ${sql.identifier(edgeClaims.edgeId.name)},
      ${sql.identifier(edgeClaims.updatedAt.name)}
    ) VALUES (
      ${params.graphId}, ${target.axis}, ${target.key}, ${params.edgeId}, ${timestamp}
    )
    ON CONFLICT (
      ${sql.identifier(edgeClaims.graphId.name)},
      ${sql.identifier(edgeClaims.axis.name)},
      ${sql.identifier(edgeClaims.key.name)}
    ) DO UPDATE SET
      ${quotedColumn(edgeClaims.updatedAt)} = ${qualified(claimsName, edgeClaims.updatedAt)}
    RETURNING
      ${quotedColumn(edgeClaims.edgeId)} AS holder_edge_id,
      EXISTS (
        SELECT 1 FROM ${edges}
        WHERE ${competingLiveEdgePredicate(tables, boundClaimValues(params), EDGE_CARDINALITY_SPECS[params.cardinality])}
      ) AS has_incumbent
  `;
}

/**
 * Endpoint-dependent constrained edge write.
 *
 * The endpoint CTE is deliberately the dependency of the claim INSERT. An
 * unavailable endpoint therefore produces no claim row and no claim refresh.
 * A foreign claim is reported, not taken over: PostgreSQL data-modifying CTEs
 * share one snapshot, so stale-holder takeover remains a separate fresh
 * statement in the caller.
 */
export function buildInsertEdgeIfEndpointsLiveWithCardinalityClaim(
  tables: Tables,
  params: InsertEdgeParams,
  claim: ClaimEdgeCardinalityParams,
  timestamp: string,
): SQL {
  const { edgeClaims, edges, nodes } = tables;
  const claimsName = getTableName(edgeClaims);
  const nodeTable = quotedTableName(getTableName(nodes));
  const propsJson = JSON.stringify(params.props);
  const columns = edgeColumnList(edges);
  const target = edgeCardinalityClaimTarget(claim);
  const from = (column: Readonly<{ name: string }>): SQL =>
    qualifiedAlias("from_node", column);
  const to = (column: Readonly<{ name: string }>): SQL =>
    qualifiedAlias("to_node", column);

  return sql`
    WITH live_endpoints AS MATERIALIZED (
      SELECT 1 AS present
      FROM ${nodeTable} AS "from_node"
      CROSS JOIN ${nodeTable} AS "to_node"
      WHERE ${from(nodes.graphId)} = ${params.graphId}
        AND ${from(nodes.kind)} = ${params.fromKind}
        AND ${from(nodes.id)} = ${params.fromId}
        AND ${from(nodes.deletedAt)} IS NULL
        AND ${to(nodes.graphId)} = ${params.graphId}
        AND ${to(nodes.kind)} = ${params.toKind}
        AND ${to(nodes.id)} = ${params.toId}
        AND ${to(nodes.deletedAt)} IS NULL
    ),
    claimable_axis AS MATERIALIZED (
      SELECT present
      FROM live_endpoints
      WHERE NOT EXISTS (
        SELECT 1 FROM ${edges}
        WHERE ${competingLiveEdgePredicate(tables, boundClaimValues(claim), EDGE_CARDINALITY_SPECS[claim.cardinality])}
      )
    ),
    claim AS (
      INSERT INTO ${edgeClaims} (
        ${sql.identifier(edgeClaims.graphId.name)},
        ${sql.identifier(edgeClaims.axis.name)},
        ${sql.identifier(edgeClaims.key.name)},
        ${sql.identifier(edgeClaims.edgeId.name)},
        ${sql.identifier(edgeClaims.updatedAt.name)}
      )
      SELECT
        ${claim.graphId}, ${target.axis}, ${target.key},
        ${claim.edgeId}, ${timestamp}
      FROM claimable_axis
      ON CONFLICT (
        ${sql.identifier(edgeClaims.graphId.name)},
        ${sql.identifier(edgeClaims.axis.name)},
        ${sql.identifier(edgeClaims.key.name)}
      ) DO UPDATE SET
        ${quotedColumn(edgeClaims.updatedAt)} = ${qualified(claimsName, edgeClaims.updatedAt)}
      RETURNING
        ${quotedColumn(edgeClaims.edgeId)} AS holder_edge_id
    ),
    inserted AS (
      INSERT INTO ${edges} (${columns})
      SELECT
        ${params.graphId}, ${params.id}, ${params.kind},
        ${params.fromKind}, ${params.fromId}, ${params.toKind}, ${params.toId},
        ${propsJson},
        ${sqlNull(params.matchIdentity?.name)},
        ${sqlNull(params.matchIdentity?.key)},
        ${sqlNull(resolveStampedValidityLowerBound(params.validFrom, params.validTo, timestamp))},
        ${sqlNull(params.validTo)}, ${timestamp}, ${timestamp}
      FROM live_endpoints
      CROSS JOIN claim
      WHERE claim.holder_edge_id = ${claim.edgeId}
      RETURNING *
    )
    SELECT * FROM inserted
  `;
}

/**
 * Statement 2 — conditional takeover, on a fresh snapshot.
 *
 * Issued only when statement 1 reported a different holder. It succeeds exactly
 * when that holder is no longer an edge this axis and key describe, which is
 * what makes an abandoned claim self-healing: no release path has to have run
 * for a dead holder's axis to be reusable.
 *
 * **The holder is identified by more than its id.** Edge ids are
 * caller-suppliable and graph-unique, so a hard-deleted id can be reused by a
 * DIFFERENT edge; a claim naming that id would otherwise read as a live holder
 * and block its axis forever. The extra terms are exactly the components the
 * axis and key were built from — and exactly the columns `countEdgesFrom` /
 * `edgeExistsBetween` filter on — so the fence's liveness predicate and the
 * probe's read the same shape.
 *
 * The `valid_to IS NULL` term and the to-endpoint terms are not spelled here:
 * they are read from {@link EDGE_CARDINALITY_SPECS}, the same table the
 * TypeScript probe reads.
 */
export function buildTakeOverEdgeClaim(
  tables: Tables,
  params: ClaimEdgeCardinalityParams,
  timestamp: string,
): SQL {
  const { edgeClaims, edges } = tables;
  const claimsName = getTableName(edgeClaims);
  const spec = EDGE_CARDINALITY_SPECS[params.cardinality];
  const target = edgeCardinalityClaimTarget(params);

  return sql`
    UPDATE ${edgeClaims}
    SET ${quotedColumn(edgeClaims.edgeId)} = ${params.edgeId},
        ${quotedColumn(edgeClaims.updatedAt)} = ${timestamp}
    WHERE ${qualified(claimsName, edgeClaims.graphId)} = ${params.graphId}
      AND ${qualified(claimsName, edgeClaims.axis)} = ${target.axis}
      AND ${qualified(claimsName, edgeClaims.key)} = ${target.key}
      AND ${qualified(claimsName, edgeClaims.edgeId)} <> ${params.edgeId}
      AND NOT EXISTS (
        SELECT 1 FROM ${edges}
        WHERE ${recordedClaimHolderIsLivePredicate(tables, boundClaimValues(params), spec)}
      )
    RETURNING ${quotedColumn(edgeClaims.edgeId)} as holder_edge_id
  `;
}

/**
 * Guarded takeover: a stale claim can move only when the whole declared axis,
 * not merely the recorded holder id, contains no competing live edge. This is
 * what makes takeover safe for legacy/imported rows that have no sidecar.
 */
export function buildTakeOverEdgeClaimGuarded(
  tables: Tables,
  params: ClaimEdgeCardinalityParams,
  timestamp: string,
): SQL {
  const { edgeClaims, edges } = tables;
  const claimsName = getTableName(edgeClaims);
  const target = edgeCardinalityClaimTarget(params);

  return sql`
    UPDATE ${edgeClaims}
    SET ${quotedColumn(edgeClaims.edgeId)} = ${params.edgeId},
        ${quotedColumn(edgeClaims.updatedAt)} = ${timestamp}
    WHERE ${qualified(claimsName, edgeClaims.graphId)} = ${params.graphId}
      AND ${qualified(claimsName, edgeClaims.axis)} = ${target.axis}
      AND ${qualified(claimsName, edgeClaims.key)} = ${target.key}
      AND ${qualified(claimsName, edgeClaims.edgeId)} <> ${params.edgeId}
      AND NOT EXISTS (
        SELECT 1 FROM ${edges}
        WHERE ${competingLiveEdgePredicate(tables, boundClaimValues(params), EDGE_CARDINALITY_SPECS[params.cardinality])}
      )
    RETURNING ${quotedColumn(edgeClaims.edgeId)} as holder_edge_id
  `;
}

/**
 * Housekeeping: drops the claims named edges hold.
 *
 * A hard delete or a `clearGraph` removes the edges a claim's liveness
 * predicate reads, so the claim would already be takeable; this only stops the
 * relation from growing without bound.
 */
export function buildPurgeEdgeClaims(
  tables: Tables,
  params: PurgeEdgeClaimsParams,
): SQL {
  const { edgeClaims } = tables;
  return sql`
    DELETE FROM ${edgeClaims}
    WHERE ${edgeClaims.graphId} = ${params.graphId}
      AND ${edgeClaims.edgeId} IN (${sql.join(
        params.edgeIds.map((edgeId) => sql`${edgeId}`),
        sql`, `,
      )})
  `;
}

// Re-exported from their new owner. Resolved only by
// `tests/claim-owner-sql-golden.test.ts` — that import is what keeps knip
// from reporting these two re-exports as unused.
export {
  buildHardDeleteEdgeClaimsByEdgeKind,
  buildHardDeleteEdgeClaimsByNodeKind,
} from "../../../store/claims/removal-sql";
