import { optionalRecordedInstantParts } from "../../core/temporal";
import {
  historicalIdentityReconstructionCtes,
  type HistoricalIdentitySqlCoordinate,
} from "../../identity/historical-sql";
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

  const coordinate: HistoricalIdentitySqlCoordinate = {
    validMode: ast.temporalMode.mode,
    validAsOf: ast.temporalMode.asOf,
    recorded,
    currentInstant: temporalFilterPass.currentInstant,
  };
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
  const reconstruction = historicalIdentityReconstructionCtes({
    schema: ctx.schema,
    graphId,
    coordinate,
    seedSource: sql`SELECT ${previousKind}, ${previousId}`,
    sameIdAcrossKinds: ctx.identitySameIdAcrossKinds ?? "fold",
  });

  return sql`
    EXISTS (
      WITH RECURSIVE
      ${reconstruction}
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
