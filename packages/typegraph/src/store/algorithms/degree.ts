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
  const edgeKinds = options.edges ?? Object.keys(ctx.graph.edges);

  const directionFilter = compileDirectionFilter(
    ctx,
    direction,
    nodeId,
    edgeKinds,
  );
  // No declared endpoint kinds for the counted edge set means no edge can
  // match — provably zero without a round trip.
  if (directionFilter === undefined) return 0;

  const whereClauses: SQL[] = [
    sql`graph_id = ${ctx.graphId}`,
    resolveTemporalFilter(ctx, options),
    directionFilter,
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

/**
 * Endpoint kinds the graph declaration permits on one side of the counted
 * edge kinds, expanded through the subClassOf closure (a stored
 * `from_kind` / `to_kind` may be any subclass of a declared endpoint).
 * Edge writes validate endpoints against exactly this set, so enumerating
 * it here is complete.
 */
function collectEndpointKinds(
  ctx: AlgorithmContext,
  edgeKinds: readonly string[],
  side: "from" | "to",
): readonly string[] {
  const kinds = new Set<string>();
  for (const edgeKind of edgeKinds) {
    const registration = ctx.graph.edges[edgeKind];
    if (registration === undefined) continue;
    for (const endpoint of registration[side]) {
      for (const expanded of ctx.registry.expandSubClasses(endpoint.kind)) {
        kinds.add(expanded);
      }
    }
  }
  return [...kinds];
}

/**
 * Direction filter shaped for the default edge indexes: the endpoint-kind
 * equality comes first so `edges_from_idx (graph_id, from_kind, from_id, …)`
 * / `edges_to_idx (graph_id, to_kind, to_id, …)` can seek — a bare
 * `from_id = ?` scans the whole edge partition because both indexes lead
 * with the kind column. Returns `undefined` when the counted edge set
 * declares no endpoint on the required side (provably zero matches).
 */
function compileDirectionFilter(
  ctx: AlgorithmContext,
  direction: TraversalDirection,
  nodeId: string,
  edgeKinds: readonly string[],
): SQL | undefined {
  const fromSide = (): SQL | undefined => {
    const fromKinds = collectEndpointKinds(ctx, edgeKinds, "from");
    if (fromKinds.length === 0) return undefined;
    return sql`(${compileKindFilter(sql.raw("from_kind"), fromKinds)} AND from_id = ${nodeId})`;
  };
  const toSide = (): SQL | undefined => {
    const toKinds = collectEndpointKinds(ctx, edgeKinds, "to");
    if (toKinds.length === 0) return undefined;
    return sql`(${compileKindFilter(sql.raw("to_kind"), toKinds)} AND to_id = ${nodeId})`;
  };

  switch (direction) {
    case "out": {
      return fromSide();
    }
    case "in": {
      return toSide();
    }
    case "both": {
      const from = fromSide();
      const to = toSide();
      if (from === undefined) return to;
      if (to === undefined) return from;
      return sql`(${from} OR ${to})`;
    }
  }
}
