/**
 * Shortest-path algorithm.
 *
 * Runs the shared recursive CTE with path tracking, filters the frontier to
 * the target row with the smallest depth, and decodes the dialect-encoded
 * path column into an ordered list of node IDs. Node kinds for every hop
 * are produced by the same CTE, so the full path is hydrated in a single
 * round-trip by joining the hit row against the `reachable` CTE using the
 * dialect's path-containment predicate.
 */
import { type SQL, sql } from "drizzle-orm";

import {
  type AlgorithmContext,
  assertEdgeKinds,
  DEFAULT_ALGORITHM_MAX_HOPS,
  type InternalTraversalOptions,
  resolveMaxHops,
} from "./context";
import { buildReachableCte, decodePathColumn } from "./recursive-cte";
import type { PathNode, ShortestPathResult } from "./types";

type ShortestPathRow = Readonly<{
  hit_id: string;
  hit_kind: string;
  hit_depth: number | string;
  hit_path: unknown;
  node_id: string | undefined;
  node_kind: string | undefined;
}>;

type NodeKindRow = Readonly<{ id: string; kind: string }>;

export async function executeShortestPath(
  ctx: AlgorithmContext,
  sourceId: string,
  targetId: string,
  options: InternalTraversalOptions,
): Promise<ShortestPathResult | undefined> {
  assertEdgeKinds(options.edges);
  const maxHops = resolveMaxHops(
    options.maxHops,
    DEFAULT_ALGORITHM_MAX_HOPS,
    "maxHops",
  );

  // Self-path short-circuit: avoids the recursive CTE entirely while still
  // honouring soft-delete semantics via a lightweight existence check.
  if (sourceId === targetId) {
    const source = await fetchNodeKind(ctx, sourceId);
    if (source === undefined) return undefined;
    return { nodes: [source], depth: 0 };
  }

  const cte = buildReachableCte({
    graphId: ctx.graphId,
    sourceId,
    edgeKinds: options.edges,
    maxHops,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    includePath: true,
    dialect: ctx.dialect,
    schema: ctx.schema,
  });

  // `cycleCheck` returns TRUE when id is NOT in path, so its negation is the
  // "id is in path" predicate we need to join every hop's kind in one query.
  const pathContainsCheck = sql`NOT (${ctx.dialect.cycleCheck(sql.raw("r.id"), sql.raw("h.path"))})`;

  const query = sql`${cte}, hit AS (SELECT id, kind, depth, path FROM reachable WHERE id = ${targetId} ORDER BY depth ASC LIMIT 1) SELECT h.id AS hit_id, h.kind AS hit_kind, h.depth AS hit_depth, h.path AS hit_path, r.id AS node_id, r.kind AS node_kind FROM hit h LEFT JOIN reachable r ON ${pathContainsCheck}`;

  const rows = await ctx.backend.execute<ShortestPathRow>(query);
  const first = rows[0];
  if (first === undefined) return undefined;

  const pathIds = decodePathColumn(first.hit_path);
  const kindById = buildKindIndex(rows);

  const pathNodes: PathNode[] = pathIds.map((id) => ({
    id,
    kind: kindById.get(id) ?? "",
  }));

  return { nodes: pathNodes, depth: Number(first.hit_depth) };
}

function buildKindIndex(
  rows: readonly ShortestPathRow[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.node_id !== undefined && row.node_kind !== undefined) {
      map.set(row.node_id, row.node_kind);
    }
  }
  return map;
}

async function fetchNodeKind(
  ctx: AlgorithmContext,
  nodeId: string,
): Promise<PathNode | undefined> {
  const query: SQL = sql`SELECT id, kind FROM ${ctx.schema.nodesTable} WHERE graph_id = ${ctx.graphId} AND id = ${nodeId} AND deleted_at IS NULL LIMIT 1`;
  const rows = await ctx.backend.execute<NodeKindRow>(query);
  const row = rows[0];
  if (row === undefined) return undefined;
  return { id: row.id, kind: row.kind };
}
