import { type SQL, sql } from "drizzle-orm";

import { type QueryAst } from "../ast";
import { type TemporalFilterPass } from "./passes";
import { type PredicateCompilerContext } from "./predicates";

export function compileIdentitySourcePredicate(
  input: Readonly<{
    ast: QueryAst;
    ctx: PredicateCompilerContext;
    edgeId: SQL;
    edgeKind: SQL;
    graphId: string;
    previousId: SQL;
    previousKind: SQL;
    temporalFilterPass: TemporalFilterPass;
  }>,
): SQL {
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
  const historical =
    ast.recordedAsOf !== undefined || ast.temporalMode.mode !== "current";

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
    ast.recordedAsOf === undefined ?
      ctx.schema.identityAssertionsTable
    : ctx.schema.recordedIdentityAssertionsTable;
  const assertionVisibility = temporalFilterPass.forAlias("ia");
  const recordedStructuralFilter =
    ast.recordedAsOf === undefined ?
      sql``
    : sql`
      AND structural_node.recorded_from <= ${ast.recordedAsOf}
      AND structural_node.recorded_to > ${ast.recordedAsOf}
    `;

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
        UNION ALL
        SELECT left_node.kind, left_node.id, right_node.kind, right_node.id
        FROM structural_nodes left_node
        JOIN structural_nodes right_node
          ON right_node.id = left_node.id
         AND right_node.kind <> left_node.kind
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
