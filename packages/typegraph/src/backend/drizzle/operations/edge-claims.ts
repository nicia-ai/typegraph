import { getTableName, type SQL, sql } from "drizzle-orm";

import {
  EDGE_CARDINALITY_SPECS,
  edgeCardinalityClaimTarget,
} from "../../../store/claims/edge-claims";
import type {
  ClaimEdgeCardinalityParams,
  PurgeEdgeClaimsParams,
} from "../../types";
import { quotedColumn, type Tables } from "./shared";

/**
 * Qualifies a column with its relation, the one rendering both dialects read
 * identically. The claim statements name TWO relations (the claim rows and the
 * edges their holders are), so a bare column name would be ambiguous in the
 * takeover statement's correlated subquery.
 */
function qualified(tableName: string, column: Readonly<{ name: string }>): SQL {
  return sql.raw(`"${tableName}"."${column.name}"`);
}

/**
 * The live entity predicate a claim guards, excluding the proposed holder.
 * Both the guarded lock and guarded takeover use this exact fragment so the
 * fast path cannot disagree about what constitutes a claimless incumbent.
 */
function competingLiveEdgePredicate(
  tables: Tables,
  params: ClaimEdgeCardinalityParams,
): SQL {
  const { edges } = tables;
  const edgesName = getTableName(edges);
  const spec = EDGE_CARDINALITY_SPECS[params.cardinality];
  const toEndpointTerms =
    spec.keyShape === "fromAndTo" ?
      sql` AND ${qualified(edgesName, edges.toKind)} = ${params.toKind} AND ${qualified(edgesName, edges.toId)} = ${params.toId}`
    : sql``;
  const activeTerm =
    spec.holderLiveness === "liveAndActive" ?
      sql` AND ${qualified(edgesName, edges.validTo)} IS NULL`
    : sql``;

  return sql`
    ${qualified(edgesName, edges.graphId)} = ${params.graphId}
      AND ${qualified(edgesName, edges.id)} <> ${params.edgeId}
      AND ${qualified(edgesName, edges.deletedAt)} IS NULL
      AND ${qualified(edgesName, edges.kind)} = ${params.edgeKind}
      AND ${qualified(edgesName, edges.fromKind)} = ${params.fromKind}
      AND ${qualified(edgesName, edges.fromId)} = ${params.fromId}${toEndpointTerms}${activeTerm}
  `;
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
        WHERE ${competingLiveEdgePredicate(tables, params)}
      ) AS has_incumbent
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
  const edgesName = getTableName(edges);
  const spec = EDGE_CARDINALITY_SPECS[params.cardinality];
  const target = edgeCardinalityClaimTarget(params);

  const toEndpointTerms =
    spec.keyShape === "fromAndTo" ?
      sql` AND ${qualified(edgesName, edges.toKind)} = ${params.toKind} AND ${qualified(edgesName, edges.toId)} = ${params.toId}`
    : sql``;
  const activeTerm =
    spec.holderLiveness === "liveAndActive" ?
      sql` AND ${qualified(edgesName, edges.validTo)} IS NULL`
    : sql``;

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
        WHERE ${qualified(edgesName, edges.graphId)} = ${qualified(claimsName, edgeClaims.graphId)}
          AND ${qualified(edgesName, edges.id)} = ${qualified(claimsName, edgeClaims.edgeId)}
          AND ${qualified(edgesName, edges.deletedAt)} IS NULL
          AND ${qualified(edgesName, edges.kind)} = ${params.edgeKind}
          AND ${qualified(edgesName, edges.fromKind)} = ${params.fromKind}
          AND ${qualified(edgesName, edges.fromId)} = ${params.fromId}${toEndpointTerms}${activeTerm}
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
        WHERE ${competingLiveEdgePredicate(tables, params)}
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
