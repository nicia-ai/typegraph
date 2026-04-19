/**
 * Degree algorithm.
 *
 * Counts the number of active edges incident to a node. Direction selects
 * whether we count outgoing, incoming, or both. For `"both"` we count
 * distinct edge IDs so that a self-loop (from === to === node) contributes
 * exactly once rather than twice.
 */
import { sql } from "drizzle-orm";

import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { type AlgorithmContext } from "./context";
import type { TraversalDirection } from "./types";

type InternalDegreeOptions = Readonly<{
  edges?: readonly string[];
  direction?: TraversalDirection;
}>;

export async function executeDegree(
  ctx: AlgorithmContext,
  nodeId: string,
  options: InternalDegreeOptions = {},
): Promise<number> {
  const direction = options.direction ?? "both";

  // An empty `edges: []` array is treated literally as "no kinds" — the
  // caller explicitly asked to count nothing. Omitting the option entirely
  // (`edges === undefined`) counts across every kind.
  const kindFilter =
    options.edges === undefined ?
      sql`1 = 1`
    : compileKindFilter(sql.raw("kind"), options.edges);

  const directionFilter = compileDirectionFilter(direction, nodeId);
  const countExpr =
    direction === "both" ? sql`COUNT(DISTINCT id)` : sql`COUNT(*)`;

  const query = sql`SELECT ${countExpr} AS count FROM ${ctx.schema.edgesTable} WHERE graph_id = ${ctx.graphId} AND deleted_at IS NULL AND ${kindFilter} AND ${directionFilter}`;

  const rows =
    await ctx.backend.execute<Readonly<{ count: number | string }>>(query);
  return Number(rows[0]?.count ?? 0);
}

function compileDirectionFilter(
  direction: TraversalDirection,
  nodeId: string,
): ReturnType<typeof sql> {
  switch (direction) {
    case "out": {
      return sql`from_id = ${nodeId}`;
    }
    case "in": {
      return sql`to_id = ${nodeId}`;
    }
    case "both": {
      return sql`(from_id = ${nodeId} OR to_id = ${nodeId})`;
    }
  }
}
