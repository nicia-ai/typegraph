import { sql } from "drizzle-orm";

import { buildReachableCte } from "../recursive-cte";
import {
  type AlgorithmContext,
  assertEdgeKinds,
  DEFAULT_ALGORITHM_MAX_HOPS,
  DEFAULT_NEIGHBOR_DEPTH,
  type InternalTraversalOptions,
  resolveMaxHops,
  resolveTemporalOptions,
} from "./context";
import type { ReachableNode } from "./types";

type InternalReachableOptions = InternalTraversalOptions &
  Readonly<{ excludeSource?: boolean }>;

type InternalNeighborsOptions = Omit<InternalTraversalOptions, "maxHops"> &
  Readonly<{ depth?: number }>;

type ReachableRow = Readonly<{
  id: string;
  kind: string;
  depth: number | string;
}>;

export async function executeReachable(
  ctx: AlgorithmContext,
  sourceId: string,
  options: InternalReachableOptions,
): Promise<readonly ReachableNode[]> {
  assertEdgeKinds(options.edges);
  const maxHops = resolveMaxHops(
    options.maxHops,
    DEFAULT_ALGORITHM_MAX_HOPS,
    "maxHops",
  );

  const cte = buildReachableCte({
    graphId: ctx.graphId,
    sourceId,
    edgeKinds: options.edges,
    maxHops,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    includePath: false,
    ...resolveTemporalOptions(ctx, options),
    dialect: ctx.dialect,
    schema: ctx.schema,
  });

  const sourceFilter =
    options.excludeSource === true ? sql` WHERE id != ${sourceId}` : sql``;

  const query = sql`${cte} SELECT id, kind, MIN(depth) AS depth FROM reachable${sourceFilter} GROUP BY id, kind ORDER BY depth ASC, id ASC`;

  const rows = await ctx.backend.execute<ReachableRow>(query);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    depth: Number(row.depth),
  }));
}

export async function executeCanReach(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  options: InternalTraversalOptions,
): Promise<boolean> {
  assertEdgeKinds(options.edges);

  const maxHops = resolveMaxHops(
    options.maxHops,
    DEFAULT_ALGORITHM_MAX_HOPS,
    "maxHops",
  );

  // Self-case (sourceId === targetId) is not short-circuited: the CTE base
  // case emits the source row only if it passes the temporal filter, so
  // `canReach(a, a)` correctly returns false when `a` is not visible under
  // the resolved mode — consistent with `shortestPath(a, a)`.
  const cte = buildReachableCte({
    graphId: ctx.graphId,
    sourceId,
    edgeKinds: options.edges,
    maxHops,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    includePath: false,
    ...resolveTemporalOptions(ctx, options),
    dialect: ctx.dialect,
    schema: ctx.schema,
  });

  const query = sql`${cte} SELECT 1 AS hit FROM reachable WHERE id = ${targetId} LIMIT 1`;

  const rows = await ctx.backend.execute<Readonly<{ hit: number }>>(query);
  return rows.length > 0;
}

export async function executeNeighbors(
  ctx: AlgorithmContext,
  sourceId: string,
  options: InternalNeighborsOptions,
): Promise<readonly ReachableNode[]> {
  const depth = resolveMaxHops(options.depth, DEFAULT_NEIGHBOR_DEPTH, "depth");

  return executeReachable(ctx, sourceId, {
    edges: options.edges,
    maxHops: depth,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    ...(options.temporalMode !== undefined && {
      temporalMode: options.temporalMode,
    }),
    ...(options.asOf !== undefined && { asOf: options.asOf }),
    excludeSource: true,
  });
}
