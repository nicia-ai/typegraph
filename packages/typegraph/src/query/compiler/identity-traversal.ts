import { optionalRecordedInstantParts } from "../../core/temporal";
import {
  historicalIdentityPeerClassQuery,
  type HistoricalIdentitySqlCoordinate,
  IDENTITY_PEER_CLASS_COLUMNS,
} from "../../identity/historical-sql";
import { type QueryAst } from "../ast";
import { sql, type SqlFragment } from "../sql-fragment";
import { type TemporalFilterPass } from "./passes";
import {
  type PredicateCompilerContext,
  requireRecursiveTraversalVerdict,
} from "./predicates";

/**
 * Name of the query-level relation holding the identity classes a **historical**
 * traversal expands through. One per statement: the relation depends only on the
 * graph, the read coordinate and the identity profile, so every traversal step of
 * a query shares it.
 */
export const IDENTITY_CLASS_CTE_ALIAS = "identity_peer_class";

/** Alias the frontier expansion gives the peer members of a frontier row's class. */
const PEER_CLASS_ALIAS = "identity_peer";

/** Alias of the closure row naming the class a current-coordinate frontier row is in. */
const CURRENT_SEED_CLASS_ALIAS = "identity_seed_class";

/** Alias of the node row a current-coordinate member is checked visible through. */
const CURRENT_MEMBER_NODE_ALIAS = "identity_peer_node";

/**
 * Resolves the read coordinate an identity reconstruction must be evaluated at,
 * or `undefined` when the query reads the present and can therefore reach the
 * maintained closure directly.
 *
 * Sole owner of the current/historical split: {@link compileIdentityClassCte}
 * and {@link planIdentityFrontierExpansion} pick opposite strategies off this one
 * answer, and a query whose CTE and whose traversal steps disagreed about the
 * coordinate would compile a step reading a relation that was never emitted.
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
 * Emits the query-level CTE definition backing **historical** identity expansion,
 * or `undefined` when the query expands no identity or reads the present.
 *
 * A past coordinate has no closure to read — the relation has to be
 * reconstructed from the assertion ledger (see
 * {@link historicalIdentityPeerClassQuery}), which is a recursive fixed point
 * over the whole ledger no frontier row can narrow. Paying for it once per
 * statement rather than once per traversal step is what typegraph#310 bought, so
 * it stays hoisted and materialized. The current coordinate needs no such
 * relation: the closure is already the answer, and
 * {@link planIdentityFrontierExpansion} seeks into it from the frontier instead.
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
  if (coordinate === undefined) return undefined;

  const recursiveTraversal = requireRecursiveTraversalVerdict(
    ctx,
    "historical identity expansion",
  );
  const peerClasses = historicalIdentityPeerClassQuery({
    schema: ctx.schema,
    graphId,
    coordinate,
    sameIdAcrossKinds: ctx.identitySameIdAcrossKinds ?? "fold",
    recursiveTraversal,
  });
  // MATERIALIZED is load-bearing, not a hint. Left inlinable, SQLite pushes the
  // relation down to each reference site, and a per-step reference is then
  // rebuilt per candidate (source row, edge) pair — the quadratic term
  // typegraph#310 removes. The expansion below reads it from an uncorrelated
  // join for the same reason.
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
 * same shape a traversal without identity expansion uses. `whereClauses` carries
 * conditions the widening needs in the step's WHERE rather than in a join
 * condition; emitters must include them in every branch of the step.
 */
export type IdentityFrontierExpansion = Readonly<{
  frontierJoin: SqlFragment;
  memberId: SqlFragment;
  memberKind: SqlFragment;
  whereClauses: readonly SqlFragment[];
}>;

/**
 * Widens a **current**-coordinate traversal step's frontier to the identity
 * classes of its rows, seeking from the frontier rather than from the closure.
 *
 * Three seeks per frontier row, each one bounded by the row before it:
 *
 * 1. the frontier row's class label, through the closure's
 *    `(graph_id, member_kind, member_id)` primary key;
 * 2. that class's members, through the closure's
 *    `(graph_id, class_kind, class_id)` index;
 * 3. each member's node row, through the nodes primary key, filtered to members
 *    visible at the read coordinate.
 *
 * The peer relation — every member paired with every other — is therefore never
 * built for classes the query does not touch. Building it graph-wide instead
 * costs the sum of the squares of *all* class sizes before a single frontier
 * predicate applies, which is quadratic in the identity population for a
 * traversal that reads one row (typegraph#432).
 *
 * The joins are outer so a frontier row in no class survives: the closure stores
 * no row for a singleton class, and the `COALESCE` pair below then supplies the
 * frontier row itself. A row whose class *is* stored appears among its own class
 * members, so the fallback is not double-counted.
 *
 * Member visibility cannot ride the node join alone: an outer join keeps the
 * member row when its node is invisible, and `COALESCE` would then read that row
 * as the "no class" case and re-emit the frontier row once per invisible peer.
 * The guard states the distinction the join cannot — a member row is admitted
 * only with a visible node behind it, and only the genuine no-class row reaches
 * the fallback.
 *
 * No `DISTINCT`: `(graph_id, member_kind, member_id)` is the closure's primary
 * key, so the frontier row seeks at most one class label and each member of that
 * class yields exactly one row, with the node join on the nodes primary key. One
 * `(frontier row, member)` pair cannot be produced twice — which is what keeps a
 * physical edge from being multiplied when the step joins the widened frontier.
 */
function planCurrentIdentityFrontierExpansion(
  input: Readonly<{
    ctx: PredicateCompilerContext;
    graphId: string;
    previousId: SqlFragment;
    previousKind: SqlFragment;
    temporalFilterPass: TemporalFilterPass;
  }>,
): IdentityFrontierExpansion {
  const { ctx, graphId, previousId, previousKind, temporalFilterPass } = input;
  const seedClass = sql.raw(CURRENT_SEED_CLASS_ALIAS);
  const peer = sql.raw(PEER_CLASS_ALIAS);
  const memberNode = sql.raw(CURRENT_MEMBER_NODE_ALIAS);
  return {
    frontierJoin: sql`
      LEFT JOIN ${ctx.schema.identityClosureTable} ${seedClass}
        ON ${seedClass}.graph_id = ${graphId}
       AND ${seedClass}.member_kind = ${previousKind}
       AND ${seedClass}.member_id = ${previousId}
      LEFT JOIN ${ctx.schema.identityClosureTable} ${peer}
        ON ${peer}.graph_id = ${seedClass}.graph_id
       AND ${peer}.class_kind = ${seedClass}.class_kind
       AND ${peer}.class_id = ${seedClass}.class_id
      LEFT JOIN ${ctx.schema.nodesTable} ${memberNode}
        ON ${memberNode}.graph_id = ${peer}.graph_id
       AND ${memberNode}.kind = ${peer}.member_kind
       AND ${memberNode}.id = ${peer}.member_id
       AND ${temporalFilterPass.forAlias(CURRENT_MEMBER_NODE_ALIAS)}
    `,
    memberId: sql`COALESCE(${peer}.member_id, ${previousId})`,
    memberKind: sql`COALESCE(${peer}.member_kind, ${previousKind})`,
    whereClauses: [
      sql`(${peer}.member_id IS NULL OR ${memberNode}.id IS NOT NULL)`,
    ],
  };
}

/**
 * Widens a **historical**-coordinate traversal step's frontier from the hoisted
 * class relation {@link compileIdentityClassCte} emitted.
 *
 * The widening is an outer join against that relation. It holds only nodes that
 * have at least one peer, so the `COALESCE` pair supplies the frontier row itself
 * both when it has no peers at all and, redundantly, as its own class member. A
 * frontier row is always visible at the read coordinate — the relation it comes
 * from filters on the same coordinate — so the self case needs no separate
 * visibility check, and peers carry theirs inside the relation.
 */
function planHistoricalIdentityFrontierExpansion(
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
    whereClauses: [],
  };
}

/**
 * Plans the frontier widening for an identity-expanded traversal step, at either
 * read coordinate.
 *
 * The two coordinates are deliberately *different* strategies rather than one
 * relation with two sources. A historical class is a fixed point over the
 * assertion ledger that no frontier row narrows, so it is reconstructed once per
 * statement and read from a hoisted relation; the current class is a key seek
 * into a maintained closure, so it is reached from the frontier and never
 * materialized graph-wide. Both are one shared compilation path across dialects:
 * neither branches on the backend.
 *
 * Both produce the same downstream shape — a widened frontier plus the
 * `(kind, id)` a candidate edge must attach to — so the emitters consume one
 * interface.
 */
export function planIdentityFrontierExpansion(
  input: Readonly<{
    ast: QueryAst;
    ctx: PredicateCompilerContext;
    graphId: string;
    previousId: SqlFragment;
    previousKind: SqlFragment;
    temporalFilterPass: TemporalFilterPass;
  }>,
): IdentityFrontierExpansion {
  const { ast, ctx, graphId, previousId, previousKind, temporalFilterPass } =
    input;
  const coordinate = historicalCoordinate({ ast, temporalFilterPass });
  if (coordinate !== undefined) {
    return planHistoricalIdentityFrontierExpansion({
      previousId,
      previousKind,
    });
  }
  return planCurrentIdentityFrontierExpansion({
    ctx,
    graphId,
    previousId,
    previousKind,
    temporalFilterPass,
  });
}
