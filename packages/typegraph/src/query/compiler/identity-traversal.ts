import { optionalRecordedInstantParts } from "../../core/temporal";
import {
  historicalIdentityPeerClassQuery,
  type HistoricalIdentitySqlCoordinate,
  IDENTITY_PEER_CLASS_COLUMNS,
} from "../../identity/historical-sql";
import { type QueryAst } from "../ast";
import { sql, type SqlFragment } from "../sql-fragment";
import { type TemporalFilterPass } from "./passes";
import { type PredicateCompilerContext } from "./predicates";

/**
 * Name of the query-level relation holding reconstructed identity classes for a
 * historical read. One per statement: the relation depends only on the graph,
 * the read coordinate and the identity profile, so every traversal step of a
 * query shares it.
 */
export const HISTORICAL_IDENTITY_CLASS_CTE_ALIAS = "identity_peer_class";

/** Alias the frontier expansion gives that relation inside a traversal step. */
const PEER_CLASS_ALIAS = "identity_peer";

type IdentityCoordinateInput = Readonly<{
  ast: QueryAst;
  temporalFilterPass: TemporalFilterPass;
}>;

/**
 * Resolves the read coordinate an identity reconstruction must be evaluated at,
 * or `undefined` when the query reads the present and can therefore use the
 * materialized closure instead.
 */
function historicalCoordinate(
  input: IdentityCoordinateInput,
): HistoricalIdentitySqlCoordinate | undefined {
  const { ast, temporalFilterPass } = input;
  const recorded = optionalRecordedInstantParts(
    ast.recordedAsOf,
    "recordedAsOf",
  );
  if (recorded === undefined && ast.temporalMode.mode === "current") {
    return undefined;
  }
  return {
    validMode: ast.temporalMode.mode,
    validAsOf: ast.temporalMode.asOf,
    recorded,
    currentInstant: temporalFilterPass.currentInstant,
  };
}

/**
 * Emits the query-level CTE definition backing identity expansion under a
 * historical coordinate, or `undefined` when the query needs no such relation
 * (no identity-expanded traversal, or a current-coordinate read).
 *
 * Callers must place the definition ahead of the traversal relations that read
 * it. It depends on no other CTE, so the head of the `WITH` list is always
 * valid.
 */
export function compileHistoricalIdentityClassCte(
  input: Readonly<{
    ast: QueryAst;
    ctx: PredicateCompilerContext;
    graphId: string;
    temporalFilterPass: TemporalFilterPass;
  }>,
): SqlFragment | undefined {
  const { ast, ctx, graphId, temporalFilterPass } = input;
  const expandsIdentity = ast.traversals.some(
    (traversal) => traversal.includeIdentityMembers === true,
  );
  if (!expandsIdentity) return undefined;
  const coordinate = historicalCoordinate({ ast, temporalFilterPass });
  if (coordinate === undefined) return undefined;

  const peerClasses = historicalIdentityPeerClassQuery({
    schema: ctx.schema,
    graphId,
    coordinate,
    sameIdAcrossKinds: ctx.identitySameIdAcrossKinds ?? "fold",
  });
  // MATERIALIZED is load-bearing, not a hint. Left inlinable, SQLite pushes the
  // reconstruction down to each reference site; a reference inside a correlated
  // subquery is then rebuilt per candidate (source row, edge) pair, which is the
  // quadratic term typegraph#310 removes. The expansion below reads it from an
  // uncorrelated join for the same reason.
  return sql`
    ${sql.identifier(HISTORICAL_IDENTITY_CLASS_CTE_ALIAS)}(${IDENTITY_PEER_CLASS_COLUMNS}) AS MATERIALIZED (
      ${peerClasses}
    )
  `;
}

/**
 * How a traversal step reaches the identity class of its frontier rows.
 *
 * `frontierJoin` widens the step's FROM list from "the frontier" to "the
 * frontier's class members"; `memberKind`/`memberId` then name the member a
 * candidate edge must attach to, so the edge join is an ordinary equality — the
 * same shape a traversal without identity expansion uses.
 */
export type IdentityFrontierExpansion = Readonly<{
  frontierJoin: SqlFragment;
  memberId: SqlFragment;
  memberKind: SqlFragment;
}>;

/**
 * Plans the frontier widening for an identity-expanded traversal step under a
 * historical coordinate, or returns `undefined` at a current coordinate (which
 * reads the materialized closure through {@link compileIdentitySourcePredicate}
 * instead).
 *
 * The widening is an outer join against the hoisted class relation. That
 * relation holds only nodes that have at least one peer, so the `COALESCE` pair
 * supplies the frontier row itself both when it has no peers at all and,
 * redundantly, as its own class member. A frontier row is always visible at the
 * read coordinate — the relation it comes from filters on the same coordinate —
 * so the self case needs no separate visibility check, and peers carry theirs
 * inside the relation.
 *
 * This is the seam typegraph#270 extends: giving the current coordinate a peer
 * relation of the same `(seed_kind, seed_id, kind, id)` shape lets it reuse this
 * widening verbatim and drop its own correlated candidate-edge scan.
 */
export function planHistoricalIdentityFrontierExpansion(
  input: Readonly<{
    ast: QueryAst;
    previousId: SqlFragment;
    previousKind: SqlFragment;
    temporalFilterPass: TemporalFilterPass;
  }>,
): IdentityFrontierExpansion | undefined {
  const { ast, previousId, previousKind, temporalFilterPass } = input;
  if (historicalCoordinate({ ast, temporalFilterPass }) === undefined) {
    return undefined;
  }
  const peer = sql.identifier(PEER_CLASS_ALIAS);
  return {
    frontierJoin: sql`
      LEFT JOIN ${sql.identifier(HISTORICAL_IDENTITY_CLASS_CTE_ALIAS)} ${peer}
        ON ${peer}.seed_kind = ${previousKind}
       AND ${peer}.seed_id = ${previousId}
    `,
    memberId: sql`COALESCE(${peer}.id, ${previousId})`,
    memberKind: sql`COALESCE(${peer}.kind, ${previousKind})`,
  };
}

/**
 * Compiles the correlated membership predicate used by identity expansion at the
 * **current** coordinate: the candidate edge endpoint must be the frontier node
 * itself or a visible member of its class in the materialized closure.
 *
 * A historical read does not reach here — it widens the frontier up front (see
 * {@link planHistoricalIdentityFrontierExpansion}) because the reconstruction it
 * needs cannot be re-evaluated per candidate row affordably. Removing the
 * remaining correlation here is typegraph#270.
 */
export function compileIdentitySourcePredicate(
  input: Readonly<{
    ctx: PredicateCompilerContext;
    edgeId: SqlFragment;
    edgeKind: SqlFragment;
    graphId: string;
    previousId: SqlFragment;
    previousKind: SqlFragment;
    temporalFilterPass: TemporalFilterPass;
  }>,
): SqlFragment {
  const {
    ctx,
    edgeId,
    edgeKind,
    graphId,
    previousId,
    previousKind,
    temporalFilterPass,
  } = input;
  const memberVisibility = temporalFilterPass.forAlias("im");

  return sql`
    EXISTS (
      SELECT 1
      FROM ${ctx.schema.nodesTable} im
      WHERE im.graph_id = ${graphId}
        AND im.kind = ${edgeKind}
        AND im.id = ${edgeId}
        AND ${memberVisibility}
        AND (
          (im.kind = ${previousKind} AND im.id = ${previousId})
          OR EXISTS (
            SELECT 1
            FROM ${ctx.schema.identityClosureTable} seed_class
            JOIN ${ctx.schema.identityClosureTable} member_class
              ON member_class.graph_id = seed_class.graph_id
             AND member_class.class_kind = seed_class.class_kind
             AND member_class.class_id = seed_class.class_id
            WHERE seed_class.graph_id = ${graphId}
              AND seed_class.member_kind = ${previousKind}
              AND seed_class.member_id = ${previousId}
              AND member_class.member_kind = im.kind
              AND member_class.member_id = im.id
          )
        )
    )
  `;
}
