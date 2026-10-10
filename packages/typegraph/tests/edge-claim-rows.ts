import { expect } from "vitest";

import { type GraphBackend } from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import {
  edgeCardinalityAxisReferences,
  edgeCardinalityClaims,
  edgeCardinalityClaimTarget,
  type EdgeCardinalityDeclarations,
  type EdgeClaimSubject,
} from "../src/store/claims/edge-claims";

export type EdgeClaimRow = Readonly<{
  axis: string;
  key: string;
  edge_id: string;
}>;

/**
 * Reads the raw `typegraph_edge_claims` rows of one graph, so a test can
 * assert what the claim relation holds rather than infer it from a later
 * write succeeding (a claim naming an edge that never existed is taken over
 * by design, so "a later create works" cannot see leftover residue).
 */
export async function readEdgeClaimRows(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
): Promise<readonly EdgeClaimRow[]> {
  const schema = createSqlSchema(backend.tableNames);
  return backend.execute<EdgeClaimRow>(
    asCompiledRowsSql(sql`
      SELECT axis, key, edge_id
      FROM ${sql.identifier(schema.tables.edgeClaims)}
      WHERE graph_id = ${graphId}
      ORDER BY axis, key
    `),
  );
}

/**
 * Asserts the claim relation holds exactly the rows `edges` reserve under
 * `declarations` — one per constrained axis per edge, each naming its edge —
 * and nothing else. The expected rows come from the claim owner, so a test
 * does not re-spell the axis encoding.
 */
export function expectOnlyClaimsOf(
  rows: readonly EdgeClaimRow[],
  graphId: string,
  declarations: EdgeCardinalityDeclarations,
  edges: readonly Omit<EdgeClaimSubject, "graphId">[],
): void {
  const expected = edges.flatMap((edge) =>
    edgeCardinalityClaims(edgeCardinalityAxisReferences(declarations), {
      ...edge,
      graphId,
    }).map((claim): EdgeClaimRow => {
      const target = edgeCardinalityClaimTarget(claim);
      return { axis: target.axis, key: target.key, edge_id: edge.id };
    }),
  );
  expect(rows).toHaveLength(expected.length);
  expect(rows).toEqual(expect.arrayContaining(expected));
}
