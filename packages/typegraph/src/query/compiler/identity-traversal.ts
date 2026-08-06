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
 * Name of the query-level relation holding the identity classes a traversal
 * expands through. One per statement: the relation depends only on the graph,
 * the read coordinate and the identity profile, so every traversal step of a
 * query shares it.
 */
export const IDENTITY_CLASS_CTE_ALIAS = "identity_peer_class";

/** Alias the frontier expansion gives that relation inside a traversal step. */
const PEER_CLASS_ALIAS = "identity_peer";

/** Alias of the node row a current-coordinate member is checked visible through. */
const CURRENT_MEMBER_NODE_ALIAS = "member_node";

/**
 * Resolves the read coordinate an identity reconstruction must be evaluated at,
 * or `undefined` when the query reads the present and can therefore use the
 * materialized closure instead.
 */
function historicalCoordinate(
  input: Readonly<{
    ast: QueryAst;
    temporalFilterPass: TemporalFilterPass;
  }>,
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
 * The identity classes a **current** read expands through, as
 * `(seed_kind, seed_id, kind, id)` rows: the materialized closure joined to
 * itself on the class label, so every member of a class is paired with every
 * other, filtered to members visible now.
 *
 * The closure is the derived relation a current read already trusts, and the
 * identity service maintains it per the graph's `sameIdAcrossKinds` profile —
 * implicit same-id folds included. So the fold rules are not restated here; a
 * historical read reconstructs them from the ledger only because no closure
 * exists at a past coordinate (see {@link historicalIdentityPeerClassQuery}).
 *
 * Like the historical relation, this one covers only nodes that have a peer at
 * all: the closure stores no row for a singleton class, leaving the "member is
 * the seed itself" case to the consumer's `COALESCE` fallback. Its size
 * therefore tracks the folded/asserted population, not the whole graph.
 *
 * No `DISTINCT`: `(graph_id, member_kind, member_id)` is the closure's primary
 * key, so a member appears in exactly one class row, both self-join sides yield
 * distinct rows per class, and the node join is on the nodes primary key. One
 * `(seed, member)` pair cannot be produced twice — which is what keeps a
 * physical edge from being multiplied when the step joins this relation.
 */
function currentIdentityPeerClassQuery(
  input: Readonly<{
    ctx: PredicateCompilerContext;
    graphId: string;
    temporalFilterPass: TemporalFilterPass;
  }>,
): SqlFragment {
  const { ctx, graphId, temporalFilterPass } = input;
  const memberNode = sql.raw(CURRENT_MEMBER_NODE_ALIAS);
  return sql`
    SELECT seed_class.member_kind, seed_class.member_id,
           member_class.member_kind, member_class.member_id
    FROM ${ctx.schema.identityClosureTable} seed_class
    JOIN ${ctx.schema.identityClosureTable} member_class
      ON member_class.graph_id = seed_class.graph_id
     AND member_class.class_kind = seed_class.class_kind
     AND member_class.class_id = seed_class.class_id
    JOIN ${ctx.schema.nodesTable} ${memberNode}
      ON ${memberNode}.graph_id = seed_class.graph_id
     AND ${memberNode}.kind = member_class.member_kind
     AND ${memberNode}.id = member_class.member_id
    WHERE seed_class.graph_id = ${graphId}
      AND ${temporalFilterPass.forAlias(CURRENT_MEMBER_NODE_ALIAS)}
  `;
}

/**
 * Emits the query-level CTE definition backing identity expansion, or
 * `undefined` when no traversal in the query expands identity.
 *
 * Both coordinates produce the same `(seed_kind, seed_id, kind, id)` relation
 * under the same name, so {@link planIdentityFrontierExpansion} — and therefore
 * both emitters — consume one shape. Only the source differs: the materialized
 * closure for a current read, a reconstruction from the assertion ledger for a
 * historical one.
 *
 * Callers must place the definition ahead of the traversal relations that read
 * it. It depends on no other CTE, so the head of the `WITH` list is always
 * valid.
 */
export function compileIdentityClassCte(
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

  const peerClasses =
    coordinate === undefined ?
      currentIdentityPeerClassQuery({ ctx, graphId, temporalFilterPass })
    : historicalIdentityPeerClassQuery({
        schema: ctx.schema,
        graphId,
        coordinate,
        sameIdAcrossKinds: ctx.identitySameIdAcrossKinds ?? "fold",
      });
  // MATERIALIZED is load-bearing, not a hint. Left inlinable, SQLite pushes the
  // relation down to each reference site, and a per-step reference is then
  // rebuilt per candidate (source row, edge) pair — the quadratic term
  // typegraph#310 and typegraph#270 remove. The expansion below reads it from an
  // uncorrelated join for the same reason.
  return sql`
    ${sql.identifier(IDENTITY_CLASS_CTE_ALIAS)}(${IDENTITY_PEER_CLASS_COLUMNS}) AS MATERIALIZED (
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
 * Plans the frontier widening for an identity-expanded traversal step, at either
 * read coordinate: {@link compileIdentityClassCte} has already reduced the two to
 * one relation, so this is coordinate-independent.
 *
 * The widening is an outer join against that hoisted relation. The relation holds
 * only nodes that have at least one peer, so the `COALESCE` pair supplies the
 * frontier row itself both when it has no peers at all and, redundantly, as its
 * own class member. A frontier row is always visible at the read coordinate — the
 * relation it comes from filters on the same coordinate — so the self case needs
 * no separate visibility check, and peers carry theirs inside the relation.
 */
export function planIdentityFrontierExpansion(
  input: Readonly<{
    previousId: SqlFragment;
    previousKind: SqlFragment;
  }>,
): IdentityFrontierExpansion {
  const { previousId, previousKind } = input;
  const peer = sql.identifier(PEER_CLASS_ALIAS);
  return {
    frontierJoin: sql`
      LEFT JOIN ${sql.identifier(IDENTITY_CLASS_CTE_ALIAS)} ${peer}
        ON ${peer}.seed_kind = ${previousKind}
       AND ${peer}.seed_id = ${previousId}
    `,
    memberId: sql`COALESCE(${peer}.id, ${previousId})`,
    memberKind: sql`COALESCE(${peer}.kind, ${previousKind})`,
  };
}
