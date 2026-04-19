import { type SQL, sql } from "drizzle-orm";

import { normalizePath } from "../../utils";
import { buildReachableCte } from "../recursive-cte";
import {
  type AlgorithmContext,
  assertEdgeKinds,
  DEFAULT_ALGORITHM_MAX_HOPS,
  type InternalTraversalOptions,
  resolveMaxHops,
  resolveTemporalFilter,
  resolveTemporalOptions,
} from "./context";
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
  // honouring the configured temporal mode via a lightweight existence check.
  if (sourceId === targetId) {
    const source = await fetchNodeKind(ctx, sourceId, options);
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
    ...resolveTemporalOptions(ctx, options),
    dialect: ctx.dialect,
    schema: ctx.schema,
  });

  // `cycleCheck` returns TRUE when id is NOT in path; negating it yields the
  // "id is in path" predicate needed to hydrate every hop's kind in one query.
  //
  // Cost model: the LEFT JOIN scans `reachable` with an O(path length) check
  // per row. Under cyclePolicy: "prevent" (default), |reachable| ≤ V, so this
  // is bounded by V × p. Under "allow" + high maxHops, |reachable| grows with
  // the CTE itself (O(V × maxHops)) — but that cost is proportional to the
  // CTE materialization the user already opted into, not a new asymptotic
  // class. If this ever dominates in a real workload, the path-unpack +
  // nodes-PK join variant is the likely next step.
  const pathContainsCheck = sql`NOT (${ctx.dialect.cycleCheck(sql.raw("r.id"), sql.raw("h.path"))})`;

  const query = sql`${cte}, hit AS (SELECT id, kind, depth, path FROM reachable WHERE id = ${targetId} ORDER BY depth ASC LIMIT 1) SELECT h.id AS hit_id, h.kind AS hit_kind, h.depth AS hit_depth, h.path AS hit_path, r.id AS node_id, r.kind AS node_kind FROM hit h LEFT JOIN reachable r ON ${pathContainsCheck}`;

  const rows = await ctx.backend.execute<ShortestPathRow>(query);
  const first = rows[0];
  if (first === undefined) return undefined;

  const pathIds = normalizePath(first.hit_path);
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
  options: InternalTraversalOptions,
): Promise<PathNode | undefined> {
  const temporalFilter = resolveTemporalFilter(ctx, options);
  const query: SQL = sql`SELECT id, kind FROM ${ctx.schema.nodesTable} WHERE graph_id = ${ctx.graphId} AND id = ${nodeId} AND ${temporalFilter} LIMIT 1`;
  const rows = await ctx.backend.execute<NodeKindRow>(query);
  const row = rows[0];
  if (row === undefined) return undefined;
  return { id: row.id, kind: row.kind };
}
