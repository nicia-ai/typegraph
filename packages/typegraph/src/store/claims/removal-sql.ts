/**
 * Statement builders for the claim relations' bulk-removal paths.
 *
 * These are statements over the claim relations — the uniqueness claims a
 * kind's nodes own, and the edge-cardinality claims an edge kind's edges
 * hold — so their owner is `src/store/claims/`, exactly like every other
 * claim decision. `edgeCardinalityAxesForKind` already lives here (see
 * `./edge-claims`), so this module reads it directly instead of reaching
 * back out to an adapter that reaches back in.
 *
 * `src/backend/drizzle/operations/uniques.ts` and
 * `src/backend/drizzle/operations/edge-claims.ts` re-export these three
 * builders from their previous addresses, so `CommonOperationStrategy` and
 * `operation-backend-core.ts` see no change: one owner, two addresses, no
 * duplicate.
 */
import type { HardDeleteUniquesByConcreteKindParams } from "../../backend/types";
import { sql as fragmentSql, type SqlFragment } from "../../query/sql-fragment";
import { edgeCardinalityAxesForKind } from "./edge-claims";

/**
 * THE definition of "the uniqueness claims nodes of this kind own": every row
 * whose `concrete_kind` is the kind, at whatever axis the row sits on.
 *
 * Kind reaping is a different predicate from a lifecycle release — "every claim
 * this kind's nodes own" rather than "this node's claim for one constraint and
 * key" — and it is a hard delete rather than a tombstone, so it is its own
 * builder. It is nonetheless the ONLY spelling of that predicate: both the
 * `hardDeleteUniquesByConcreteKind` backend member and `materializeRemovals`'
 * removed-kind cleanup compile this fragment. Keying on `node_kind` instead
 * would leak a claim whose axis is a sibling kind, delete a surviving sibling's
 * claim when the removed kind IS the axis, and never match a claim whose axis
 * is not a kind at all.
 *
 * Takes the relation NAME rather than the Drizzle table so the store-side
 * caller, which knows only its configured table names, can build the same
 * statement; the fragment renders on either dialect.
 */
export function buildHardDeleteUniquesByConcreteKind(
  uniquesTableName: string,
  params: HardDeleteUniquesByConcreteKindParams,
): SqlFragment {
  return fragmentSql`DELETE FROM ${fragmentSql.identifier(uniquesTableName)} WHERE ${fragmentSql.identifier("graph_id")} = ${params.graphId} AND ${fragmentSql.identifier("concrete_kind")} = ${params.concreteKind}`;
}

/**
 * THE definition of "the cardinality claims an edge kind owns": every row at
 * one of the kind's declared-cardinality axes.
 *
 * Keyed on the axis rather than on the holder's id because a removed kind's
 * edges are deleted in the same pass, which would leave a claim naming a row
 * that no longer exists — takeable, but never reaped. Takes the relation NAME
 * rather than the Drizzle table so `materializeRemovals`, which knows only its
 * configured table names, compiles the same statement.
 */
export function buildHardDeleteEdgeClaimsByEdgeKind(
  edgeClaimsTableName: string,
  params: Readonly<{ graphId: string; edgeKind: string }>,
): SqlFragment {
  const axes = edgeCardinalityAxesForKind(params.edgeKind).map(
    (axis) => fragmentSql`${axis}`,
  );
  return fragmentSql`DELETE FROM ${fragmentSql.identifier(edgeClaimsTableName)} WHERE ${fragmentSql.identifier("graph_id")} = ${params.graphId} AND ${fragmentSql.identifier("axis")} IN (${fragmentSql.join(axes, fragmentSql`, `)})`;
}

/**
 * Housekeeping for node-kind removal: deletes every claim held by an edge whose
 * source or target has the removed kind.
 *
 * The holder ids are selected before those edges are deleted. Filtering claim
 * axes cannot express this ownership: an edge kind may connect several node
 * kinds, while its claim axis names only its cardinality and edge kind.
 */
export function buildHardDeleteEdgeClaimsByNodeKind(
  edgeClaimsTableName: string,
  edgesTableName: string,
  params: Readonly<{ graphId: string; nodeKind: string }>,
): SqlFragment {
  return fragmentSql`DELETE FROM ${fragmentSql.identifier(edgeClaimsTableName)} WHERE ${fragmentSql.identifier("graph_id")} = ${params.graphId} AND ${fragmentSql.identifier("edge_id")} IN (SELECT ${fragmentSql.identifier("id")} FROM ${fragmentSql.identifier(edgesTableName)} WHERE ${fragmentSql.identifier("graph_id")} = ${params.graphId} AND (${fragmentSql.identifier("from_kind")} = ${params.nodeKind} OR ${fragmentSql.identifier("to_kind")} = ${params.nodeKind}))`;
}
