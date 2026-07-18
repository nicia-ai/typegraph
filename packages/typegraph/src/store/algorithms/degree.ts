import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { sql, type SqlFragment } from "../../query/sql-fragment";
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
  // A graph that declares no edge kinds has no edges to count — provably zero
  // without a round trip.
  if (edgeKinds.length === 0) return 0;

  const schema = resolveReadSchema(ctx, options);
  const whereClauses: SqlFragment[] = [
    sql`graph_id = ${ctx.graphId}`,
    resolveTemporalFilter(ctx, options),
    compileDirectionFilter(ctx, direction, nodeId, schema.nodesTable),
  ];
  if (options.edges !== undefined) {
    whereClauses.push(compileKindFilter(sql.raw("kind"), options.edges));
  }

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
 * The counted node's own kind, as a scalar subquery.
 *
 * Every edge row stores the *actual* kind of each endpoint node — the write
 * path takes `from_kind` straight off the `from` node reference, and a node's
 * kind is immutable for the life of its id. So for any edge incident to
 * `nodeId`, the endpoint kind on `nodeId`'s side equals `nodeId`'s kind, and
 * nothing else. That makes this an equality the composite edge indexes seek on
 * directly, and it stays true no matter how the graph's endpoint declarations
 * evolve.
 *
 * (Enumerating the *declared* endpoint kinds instead — the shape this replaced
 * — held only for rows written under the current declaration. Narrow an edge's
 * `from: [Person]` to `from: [Employee]` and every `Person`-rooted edge already
 * on disk drops out of the filter, silently undercounting.)
 *
 * The subquery is uncorrelated, so both engines evaluate it once and treat the
 * result as a constant: Postgres hoists it to an InitPlan, SQLite runs it as a
 * one-shot scalar subquery. `LIMIT 1` is required in recorded-time mode, where
 * the resolved nodes relation holds one row per recorded version of the node.
 * An unknown `nodeId` yields NULL, and `from_kind = NULL` matches nothing —
 * degree 0, which is what a node that does not exist has.
 */
function nodeKindSubquery(
  ctx: AlgorithmContext,
  nodeId: string,
  nodesTable: SqlFragment,
): SqlFragment {
  return sql`(SELECT kind FROM ${nodesTable} WHERE graph_id = ${ctx.graphId} AND id = ${nodeId} LIMIT 1)`;
}

/**
 * Direction filter shaped for the default edge indexes: the endpoint-kind
 * equality comes first so `edges_from_idx (graph_id, from_kind, from_id, …)`
 * / `edges_to_idx (graph_id, to_kind, to_id, …)` can seek — a bare
 * `from_id = ?` scans the whole edge partition because both indexes lead
 * with the kind column.
 */
function compileDirectionFilter(
  ctx: AlgorithmContext,
  direction: TraversalDirection,
  nodeId: string,
  nodesTable: SqlFragment,
): SqlFragment {
  const nodeKind = nodeKindSubquery(ctx, nodeId, nodesTable);
  const fromSide = sql`(from_kind = ${nodeKind} AND from_id = ${nodeId})`;
  const toSide = sql`(to_kind = ${nodeKind} AND to_id = ${nodeId})`;

  switch (direction) {
    case "out": {
      return fromSide;
    }
    case "in": {
      return toSide;
    }
    case "both": {
      return sql`(${fromSide} OR ${toSide})`;
    }
  }
}
