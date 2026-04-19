/**
 * Reachability algorithms: `reachable`, `canReach`, and `neighbors`.
 *
 * All three share the same recursive-CTE skeleton; they differ only in how
 * they aggregate the resulting rows.
 */
import { sql } from "drizzle-orm";

import {
  type AlgorithmContext,
  assertEdgeKinds,
  DEFAULT_ALGORITHM_MAX_HOPS,
  DEFAULT_NEIGHBOR_DEPTH,
  type InternalTraversalOptions,
  resolveMaxHops,
} from "./context";
import { buildReachableCte } from "./recursive-cte";
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

/**
 * Returns every node reachable from `sourceId` within `maxHops` edges of the
 * allowed kinds. Each node carries the shortest depth at which it was
 * discovered.
 */
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
    dialect: ctx.dialect,
    schema: ctx.schema,
  });

  const sourceFilter =
    options.excludeSource === true ? sql` WHERE id != ${sourceId}` : sql``;

  // GROUP BY id + kind to keep the shortest depth per distinct node. The
  // recursive CTE may reach the same node via multiple paths, so MIN(depth)
  // is required for stable output regardless of cycle policy.
  const query = sql`${cte} SELECT id, kind, MIN(depth) AS depth FROM reachable${sourceFilter} GROUP BY id, kind ORDER BY depth ASC, id ASC`;

  const rows = await ctx.backend.execute<ReachableRow>(query);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    depth: Number(row.depth),
  }));
}

/**
 * Returns `true` iff `targetId` is reachable from `sourceId` within
 * `maxHops` edges. Short-circuits the query with `LIMIT 1` so the database
 * can stop traversing as soon as the first hit is found.
 */
export async function executeCanReach(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  options: InternalTraversalOptions,
): Promise<boolean> {
  assertEdgeKinds(options.edges);

  if (sourceId === targetId) return true;

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
    dialect: ctx.dialect,
    schema: ctx.schema,
  });

  const query = sql`${cte} SELECT 1 AS hit FROM reachable WHERE id = ${targetId} LIMIT 1`;

  const rows = await ctx.backend.execute<Readonly<{ hit: number }>>(query);
  return rows.length > 0;
}

/**
 * Returns every node within `depth` hops of `sourceId`, excluding the
 * source itself.
 */
export async function executeNeighbors(
  ctx: AlgorithmContext,
  sourceId: string,
  options: InternalNeighborsOptions,
): Promise<readonly ReachableNode[]> {
  assertEdgeKinds(options.edges);
  const depth = resolveMaxHops(options.depth, DEFAULT_NEIGHBOR_DEPTH, "depth");

  return executeReachable(ctx, sourceId, {
    edges: options.edges,
    maxHops: depth,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    excludeSource: true,
  });
}
