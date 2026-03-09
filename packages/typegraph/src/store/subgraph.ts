/**
 * Subgraph Extraction
 *
 * Extracts a typed subgraph from a root node by traversing a set of edge kinds.
 * Uses a recursive CTE for BFS traversal with cycle detection, then hydrates
 * the reachable nodes and connecting edges in two parallel queries.
 */
import { type SQL, sql } from "drizzle-orm";

import type { GraphBackend } from "../backend/types";
import type {
  AllNodeTypes,
  EdgeKinds,
  GraphDef,
  NodeKinds,
} from "../core/define-graph";
import type { NodeId } from "../core/types";
import type { RecursiveCyclePolicy } from "../query/ast";
import { compileKindFilter } from "../query/compiler/predicate-utils";
import { MAX_RECURSIVE_DEPTH } from "../query/compiler/recursive";
import { DEFAULT_SQL_SCHEMA, type SqlSchema } from "../query/compiler/schema";
import type { DialectAdapter } from "../query/dialect/types";
import {
  type EdgeRow,
  type NodeRow,
  rowToEdge,
  rowToNode,
} from "./row-mappers";
import type { Edge, Node } from "./types";

// ============================================================
// Constants
// ============================================================

const DEFAULT_SUBGRAPH_MAX_DEPTH = 10;

/**
 * Normalizes a JSON column value to a string.
 * PostgreSQL JSONB columns return parsed objects; SQLite returns strings.
 */
function normalizeProps(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

// ============================================================
// Type Utilities
// ============================================================

/**
 * Discriminated union of all Node runtime types in a graph.
 *
 * Unlike `AllNodeTypes<G>` which gives the union of *type definitions*,
 * `AnyNode<G>` gives the union of *runtime node instances*.
 */
export type AnyNode<G extends GraphDef> = {
  [K in NodeKinds<G>]: Node<G["nodes"][K]["type"]>;
}[NodeKinds<G>];

/**
 * Discriminated union of all Edge runtime types in a graph.
 */
export type AnyEdge<G extends GraphDef> = {
  [K in EdgeKinds<G>]: Edge<G["edges"][K]["type"]>;
}[EdgeKinds<G>];

/**
 * Discriminated union of Node runtime types narrowed to a subset of kinds.
 */
export type SubsetNode<G extends GraphDef, K extends NodeKinds<G>> = {
  [Kind in K]: Node<G["nodes"][Kind]["type"]>;
}[K];

/**
 * Discriminated union of Edge runtime types narrowed to a subset of kinds.
 */
export type SubsetEdge<G extends GraphDef, K extends EdgeKinds<G>> = {
  [Kind in K]: Edge<G["edges"][Kind]["type"]>;
}[K];

// ============================================================
// Options & Result Types
// ============================================================

export type SubgraphOptions<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
> = Readonly<{
  /** Edge kinds to follow during traversal. Edges not listed are not traversed. */
  edges: readonly EK[];
  /** Maximum traversal depth from root (default: 10). */
  maxDepth?: number;
  /**
   * Node kinds to include in the result. Nodes of other kinds are still
   * traversed through but omitted from the output. When omitted, all
   * reachable node kinds are included.
   */
  includeKinds?: readonly NK[];
  /** Exclude the root node from the result (default: false). */
  excludeRoot?: boolean;
  /**
   * Edge direction policy (default: "out").
   * - "out": follow edges in their defined direction only
   * - "both": follow edges in both directions (undirected traversal)
   */
  direction?: "out" | "both";
  /** Cycle policy — reuse RecursiveCyclePolicy (default: "prevent"). */
  cyclePolicy?: RecursiveCyclePolicy;
}>;

export type SubgraphResult<
  G extends GraphDef,
  NK extends NodeKinds<G> = NodeKinds<G>,
  EK extends EdgeKinds<G> = EdgeKinds<G>,
> = Readonly<{
  nodes: readonly SubsetNode<G, NK>[];
  edges: readonly SubsetEdge<G, EK>[];
}>;

// ============================================================
// Execution Context
// ============================================================

type SubgraphContext = Readonly<{
  graphId: string;
  rootId: string;
  edgeKinds: readonly string[];
  maxDepth: number;
  includeKinds: readonly string[] | undefined;
  excludeRoot: boolean;
  direction: "out" | "both";
  cyclePolicy: RecursiveCyclePolicy;
  dialect: DialectAdapter;
  schema: SqlSchema;
  backend: GraphBackend;
}>;

// ============================================================
// Public API
// ============================================================

export async function executeSubgraph<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
>(params: {
  graphId: string;
  rootId: NodeId<AllNodeTypes<G>>;
  backend: GraphBackend;
  dialect: DialectAdapter;
  schema: SqlSchema | undefined;
  options: SubgraphOptions<G, EK, NK>;
}): Promise<SubgraphResult<G, NK, EK>> {
  const { options } = params;

  if (options.edges.length === 0) {
    return { nodes: [], edges: [] } as SubgraphResult<G, NK, EK>;
  }

  const maxDepth = Math.min(
    options.maxDepth ?? DEFAULT_SUBGRAPH_MAX_DEPTH,
    MAX_RECURSIVE_DEPTH,
  );

  const ctx: SubgraphContext = {
    graphId: params.graphId,
    rootId: params.rootId as string,
    edgeKinds: options.edges,
    maxDepth,
    includeKinds: options.includeKinds,
    excludeRoot: options.excludeRoot ?? false,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    dialect: params.dialect,
    schema: params.schema ?? DEFAULT_SQL_SCHEMA,
    backend: params.backend,
  };

  const reachableCte = buildReachableCte(ctx);
  const includedIdsCte = buildIncludedIdsCte(ctx);

  const [nodeRows, edgeRows] = await Promise.all([
    fetchSubgraphNodes(ctx, reachableCte, includedIdsCte),
    fetchSubgraphEdges(ctx, reachableCte, includedIdsCte),
  ]);

  const nodes = nodeRows.map((row) =>
    rowToNode({ ...row, props: normalizeProps(row.props) }),
  );
  const edges = edgeRows.map((row) =>
    rowToEdge({ ...row, props: normalizeProps(row.props) }),
  );

  return {
    nodes: nodes as unknown as SubgraphResult<G, NK, EK>["nodes"],
    edges: edges as unknown as SubgraphResult<G, NK, EK>["edges"],
  };
}

// ============================================================
// SQL Generation
// ============================================================

function buildReachableCte(ctx: SubgraphContext): SQL {
  const shouldTrackPath = ctx.cyclePolicy === "prevent";
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), ctx.edgeKinds);

  // Path operations for cycle detection
  const initialPath =
    shouldTrackPath ? ctx.dialect.initializePath(sql.raw("n.id")) : undefined;
  const pathExtension =
    shouldTrackPath ?
      ctx.dialect.extendPath(sql.raw("r.path"), sql.raw("n.id"))
    : undefined;
  const cycleCheck =
    shouldTrackPath ?
      ctx.dialect.cycleCheck(sql.raw("n.id"), sql.raw("r.path"))
    : undefined;

  // Base case: the root node
  const baseColumns: SQL[] = [sql`n.id`, sql`n.kind`, sql`0 AS depth`];
  if (initialPath !== undefined) {
    baseColumns.push(sql`${initialPath} AS path`);
  }

  const baseCase = sql`SELECT ${sql.join(baseColumns, sql`, `)} FROM ${ctx.schema.nodesTable} n WHERE n.graph_id = ${ctx.graphId} AND n.id = ${ctx.rootId} AND n.deleted_at IS NULL`;

  // Recursive case columns
  const recursiveColumns: SQL[] = [
    sql`n.id`,
    sql`n.kind`,
    sql`r.depth + 1 AS depth`,
  ];
  if (pathExtension !== undefined) {
    recursiveColumns.push(sql`${pathExtension} AS path`);
  }

  // Common WHERE clauses for recursive branches
  const recursiveWhereClauses: SQL[] = [
    sql`e.graph_id = ${ctx.graphId}`,
    edgeKindFilter,
    sql`e.deleted_at IS NULL`,
    sql`n.deleted_at IS NULL`,
    sql`r.depth < ${ctx.maxDepth}`,
  ];
  if (cycleCheck !== undefined) {
    recursiveWhereClauses.push(cycleCheck);
  }

  const forceWorktableOuterJoinOrder =
    ctx.dialect.capabilities.forceRecursiveWorktableOuterJoinOrder;

  const recursiveCase =
    ctx.direction === "both" ?
      compileBidirectionalBranch({
        recursiveColumns,
        whereClauses: recursiveWhereClauses,
        forceWorktableOuterJoinOrder,
        schema: ctx.schema,
      })
    : compileRecursiveBranch({
        recursiveColumns,
        whereClauses: recursiveWhereClauses,
        joinField: "from_id",
        targetField: "to_id",
        targetKindField: "to_kind",
        forceWorktableOuterJoinOrder,
        schema: ctx.schema,
      });

  return sql`WITH RECURSIVE reachable AS (${baseCase} UNION ALL ${recursiveCase})`;
}

function compileRecursiveBranch(params: {
  recursiveColumns: readonly SQL[];
  whereClauses: readonly SQL[];
  joinField: "from_id" | "to_id";
  targetField: "from_id" | "to_id";
  targetKindField: "from_kind" | "to_kind";
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}): SQL {
  const columns = [...params.recursiveColumns];
  const selectClause = sql`SELECT ${sql.join(columns, sql`, `)}`;
  const nodeJoin = sql`JOIN ${params.schema.nodesTable} n ON n.graph_id = e.graph_id AND n.id = e.${sql.raw(params.targetField)} AND n.kind = e.${sql.raw(params.targetKindField)}`;

  if (params.forceWorktableOuterJoinOrder) {
    // SQLite: worktable must be outer in the join — use CROSS JOIN + WHERE
    const allWhere = [
      ...params.whereClauses,
      sql`e.${sql.raw(params.joinField)} = r.id`,
    ];
    return sql`${selectClause} FROM reachable r CROSS JOIN ${params.schema.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  // PostgreSQL: standard JOIN ON
  const where = [...params.whereClauses];
  return sql`${selectClause} FROM reachable r JOIN ${params.schema.edgesTable} e ON e.${sql.raw(params.joinField)} = r.id ${nodeJoin} WHERE ${sql.join(where, sql` AND `)}`;
}

/**
 * Combines outbound and inbound traversal into a single recursive SELECT
 * using OR on the join condition. This avoids a second UNION ALL branch,
 * which PostgreSQL rejects because it treats the left side of a multi-part
 * UNION ALL as the non-recursive term.
 */
function compileBidirectionalBranch(params: {
  recursiveColumns: readonly SQL[];
  whereClauses: readonly SQL[];
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}): SQL {
  const columns = [...params.recursiveColumns];
  const selectClause = sql`SELECT ${sql.join(columns, sql`, `)}`;

  // Match node via either direction of the edge
  const nodeJoin = sql`JOIN ${params.schema.nodesTable} n ON n.graph_id = e.graph_id AND ((e.to_id = r.id AND n.id = e.from_id AND n.kind = e.from_kind) OR (e.from_id = r.id AND n.id = e.to_id AND n.kind = e.to_kind))`;

  if (params.forceWorktableOuterJoinOrder) {
    const allWhere = [
      ...params.whereClauses,
      sql`(e.from_id = r.id OR e.to_id = r.id)`,
    ];
    return sql`${selectClause} FROM reachable r CROSS JOIN ${params.schema.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  return sql`${selectClause} FROM reachable r JOIN ${params.schema.edgesTable} e ON (e.from_id = r.id OR e.to_id = r.id) ${nodeJoin} WHERE ${sql.join([...params.whereClauses], sql` AND `)}`;
}

function buildIncludedIdsCte(ctx: SubgraphContext): SQL {
  const filters: SQL[] = [];

  if (ctx.includeKinds !== undefined && ctx.includeKinds.length > 0) {
    filters.push(compileKindFilter(sql.raw("kind"), ctx.includeKinds));
  }

  if (ctx.excludeRoot) {
    filters.push(sql`id != ${ctx.rootId}`);
  }

  const whereClause =
    filters.length > 0 ? sql` WHERE ${sql.join(filters, sql` AND `)}` : sql``;

  return sql`, included_ids AS (SELECT DISTINCT id FROM reachable${whereClause})`;
}

async function fetchSubgraphNodes(
  ctx: SubgraphContext,
  reachableCte: SQL,
  includedIdsCte: SQL,
): Promise<NodeRow[]> {
  const query = sql`${reachableCte}${includedIdsCte} SELECT n.kind, n.id, n.props, n.version, n.valid_from, n.valid_to, n.created_at, n.updated_at, n.deleted_at FROM ${ctx.schema.nodesTable} n WHERE n.graph_id = ${ctx.graphId} AND n.id IN (SELECT id FROM included_ids)`;

  return ctx.backend.execute<NodeRow>(query) as Promise<NodeRow[]>;
}

async function fetchSubgraphEdges(
  ctx: SubgraphContext,
  reachableCte: SQL,
  includedIdsCte: SQL,
): Promise<EdgeRow[]> {
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), ctx.edgeKinds);

  const query = sql`${reachableCte}${includedIdsCte} SELECT e.id, e.kind, e.from_kind, e.from_id, e.to_kind, e.to_id, e.props, e.valid_from, e.valid_to, e.created_at, e.updated_at, e.deleted_at FROM ${ctx.schema.edgesTable} e WHERE e.graph_id = ${ctx.graphId} AND ${edgeKindFilter} AND e.deleted_at IS NULL AND e.from_id IN (SELECT id FROM included_ids) AND e.to_id IN (SELECT id FROM included_ids)`;

  return ctx.backend.execute<EdgeRow>(query) as Promise<EdgeRow[]>;
}
