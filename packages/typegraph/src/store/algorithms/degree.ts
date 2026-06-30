import { type SQL, sql } from "drizzle-orm";

import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { asCompiledRowsSql } from "../../query/sql-intent";
import {
  type AlgorithmContext,
  type InternalTemporalOptions,
  resolveReadSchema,
  resolveTemporalFilter,
} from "./context";
import type { TraversalDirection } from "./types";

type InternalDegreeOptions = InternalTemporalOptions &
  Readonly<{
    edges?: readonly string[];
    direction?: TraversalDirection;
  }>;

export async function executeDegree(
  ctx: AlgorithmContext,
  nodeId: string,
  options: InternalDegreeOptions = {},
): Promise<number> {
  const direction = options.direction ?? "both";

  const whereClauses: SQL[] = [
    sql`graph_id = ${ctx.graphId}`,
    resolveTemporalFilter(ctx, options),
    compileDirectionFilter(direction, nodeId),
  ];
  if (options.edges !== undefined) {
    whereClauses.push(compileKindFilter(sql.raw("kind"), options.edges));
  }
  const schema = resolveReadSchema(ctx, options);

  // COUNT(DISTINCT id) collapses self-loops (from === to === nodeId) to a
  // single edge so they don't double-count under `"both"`.
  const countExpr =
    direction === "both" ? sql`COUNT(DISTINCT id)` : sql`COUNT(*)`;

  const query = sql`SELECT ${countExpr} AS count FROM ${schema.edgesTable} WHERE ${sql.join(whereClauses, sql` AND `)}`;

  const rows = await ctx.backend.execute<Readonly<{ count: number | string }>>(
    asCompiledRowsSql(query),
  );
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
