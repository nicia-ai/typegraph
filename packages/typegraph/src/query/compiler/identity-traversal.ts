import {
  optionalRecordedInstantParts,
  type RecordedInstantParts,
} from "../../core/temporal";
import { type QueryAst } from "../ast";
import { sql, type SqlFragment } from "../sql-fragment";
import { type TemporalFilterPass } from "./passes";
import { type PredicateCompilerContext } from "./predicates";

export function compileIdentitySourcePredicate(
  input: Readonly<{
    ast: QueryAst;
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
    ast,
    ctx,
    edgeId,
    edgeKind,
    graphId,
    previousId,
    previousKind,
    temporalFilterPass,
  } = input;
  const memberVisibility = temporalFilterPass.forAlias("im");
  const recorded = optionalRecordedInstantParts(
    ast.recordedAsOf,
    "recordedAsOf",
  );
  const historical =
    recorded !== undefined || ast.temporalMode.mode !== "current";

  if (!historical) {
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

  const assertionTable =
    recorded === undefined ?
      ctx.schema.identityAssertionsTable
    : ctx.schema.recordedIdentityAssertionsTable;
  // Assertion validity is a point-in-time window that must NOT widen with the
  // node-visibility mode: under view({mode:"includeEnded"}) node visibility
  // relaxes to `deleted_at IS NULL`, but a RETRACTED (ended) same-assertion
  // must still stop conducting identity at the read instant. forAlias("ia")
  // would compile to just `deleted_at IS NULL` here and route through it.
  // Mirrors src/identity/service.ts assertionSnapshotSource.
  const assertionVisibility = compileAssertionValidityFilter(
    ast,
    recorded,
    temporalFilterPass,
  );
  const recordedStructuralFilter =
    recorded === undefined ?
      sql``
    : sql`
      AND structural_node.recorded_from <= ${recorded.revision}
      AND structural_node.recorded_to > ${recorded.revision}
    `;
  // COST: this whole block is a correlated subquery — it rebuilds the identity
  // class from the assertion ledger once per source row, and under "fold" the
  // structural relation it joins spans every live node in the graph. A
  // historical expanded hop therefore costs ~(source rows × graph size), which
  // measures as clean quadratic growth (SQLite, n nodes all acting as source
  // rows: 45ms at n=250, 172ms at 500, 671ms at 1000, 2.8s at 2000). The
  // current-coordinate branch above has no such term: it seeks the
  // materialized closure table, which only exists for the present.
  //
  // Seeding the structural relation from the queried refs instead was measured
  // and REJECTED: restricting it to (seed id + assertion endpoint ids) is
  // closure-equivalent, but it makes the relation correlated on the seed, so
  // the engine re-materializes it per source row instead of hoisting one scan.
  // That was 5-7x SLOWER on the same benchmark (931ms-1.16s vs 172ms at
  // n=500). Removing the quadratic term needs the closure hoisted to a
  // query-level CTE keyed by all seeds, not a narrower per-seed relation.
  // Tracked in typegraph#310.
  const sameIdEdges =
    (ctx.identitySameIdAcrossKinds ?? "fold") === "fold" ?
      sql`
        UNION ALL
        SELECT left_node.kind, left_node.id, right_node.kind, right_node.id
        FROM structural_nodes left_node
        JOIN structural_nodes right_node
          ON right_node.id = left_node.id
         AND right_node.kind <> left_node.kind
      `
    : sql``;

  return sql`
    EXISTS (
      WITH RECURSIVE
      structural_nodes(kind, id) AS (
        SELECT structural_node.kind, structural_node.id
        FROM ${ctx.schema.nodesTable} structural_node
        WHERE structural_node.graph_id = ${graphId}
          AND structural_node.deleted_at IS NULL
          ${recordedStructuralFilter}
      ),
      same_assertions(a_kind, a_id, b_kind, b_id) AS (
        SELECT ia.a_kind, ia.a_id, ia.b_kind, ia.b_id
        FROM ${assertionTable} ia
        WHERE ia.graph_id = ${graphId}
          AND ia.rel = 'same'
          AND ${assertionVisibility}
      ),
      identity_edges(a_kind, a_id, b_kind, b_id) AS (
        SELECT a_kind, a_id, b_kind, b_id FROM same_assertions
        UNION ALL
        SELECT b_kind, b_id, a_kind, a_id FROM same_assertions
        ${sameIdEdges}
      ),
      identity_members(kind, id) AS (
        SELECT ${previousKind}, ${previousId}
        UNION
        SELECT identity_edge.b_kind, identity_edge.b_id
        FROM identity_members identity_member
        JOIN identity_edges identity_edge
          ON identity_edge.a_kind = identity_member.kind
         AND identity_edge.a_id = identity_member.id
      )
      SELECT 1
      FROM identity_members identity_member
      JOIN ${ctx.schema.nodesTable} im
        ON im.graph_id = ${graphId}
       AND im.kind = identity_member.kind
       AND im.id = identity_member.id
      WHERE im.kind = ${edgeKind}
        AND im.id = ${edgeId}
        AND ${memberVisibility}
    )
  `;
}

/**
 * The instant an identity assertion's valid-time window is measured against.
 *
 * Mirrors the node-visibility read coordinate exactly (see
 * src/identity/service.ts `assertionValidityInstant`): a valid-time `asOf`
 * pins to that instant; otherwise a recorded `asOf` pins there; otherwise the
 * pass's bound current read instant. Unlike node visibility, the widening
 * modes (`includeEnded`/`includeTombstones`) never relax this window — they
 * fall through to the current instant so a retracted assertion stops
 * conducting identity even while ended nodes remain visible.
 */
function resolveAssertionValidityInstant(
  ast: QueryAst,
  recorded: RecordedInstantParts | undefined,
  temporalFilterPass: TemporalFilterPass,
): SqlFragment {
  if (ast.temporalMode.mode === "asOf" && ast.temporalMode.asOf !== undefined) {
    return sql`${ast.temporalMode.asOf}`;
  }
  if (recorded !== undefined) {
    return sql`${recorded.recordedAt}`;
  }
  return temporalFilterPass.currentInstant;
}

/**
 * Point-in-time validity predicate for the `ia` assertion alias: not deleted,
 * and valid at the read instant. When a recorded instant is pinned it is also
 * scoped to the recorded system-time window, matching the recorded assertions
 * table's `recorded_from`/`recorded_to` columns.
 */
function compileAssertionValidityFilter(
  ast: QueryAst,
  recorded: RecordedInstantParts | undefined,
  temporalFilterPass: TemporalFilterPass,
): SqlFragment {
  const instant = resolveAssertionValidityInstant(
    ast,
    recorded,
    temporalFilterPass,
  );
  const validity = sql`ia.deleted_at IS NULL AND ia.valid_from <= ${instant} AND (ia.valid_to IS NULL OR ia.valid_to > ${instant})`;
  if (recorded === undefined) {
    return validity;
  }
  return sql`${validity} AND ia.recorded_from <= ${recorded.revision} AND ia.recorded_to > ${recorded.revision}`;
}
