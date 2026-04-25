/**
 * Query Compiler Module
 *
 * Main entry point for compiling query ASTs to SQL.
 * Re-exports individual compiler modules and provides the main compile functions.
 */

// Re-export sub-modules
export {
  type LogicalPlan,
  type LogicalPlanNode,
  lowerRecursiveQueryToLogicalPlan,
  lowerSetOperationToLogicalPlan,
  lowerStandardQueryToLogicalPlan,
} from "./plan";
export {
  compileAggregateExpr,
  compileFieldColumn,
  compileFieldValue,
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";
export {
  compileVariableLengthQuery,
  hasVariableLengthTraversal,
  MAX_EXPLICIT_RECURSIVE_DEPTH,
  MAX_RECURSIVE_DEPTH,
} from "./recursive";
export {
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
  type SqlSchema,
  type SqlTableNames,
} from "./schema";
export {
  compileTemporalFilter,
  extractTemporalOptions,
  type TemporalFilterOptions,
} from "./temporal";

// Re-export dialect types
export { type DialectAdapter, getDialect, type SqlDialect } from "../dialect";

import { type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../errors";
import {
  type AggregateExpr,
  type FulltextMatchPredicate,
  type HybridFusionOptions,
  type QueryAst,
  type SetOperation,
  type VectorSimilarityPredicate,
} from "../ast";
import {
  type DialectAdapter,
  type DialectStandardQueryStrategy,
  type FulltextStrategy,
  getDialect,
  type SqlDialect,
} from "../dialect";
import { emitStandardQuerySql } from "./emitter";
import {
  buildLimitOffsetClause,
  buildStandardEmbeddingsCte,
  buildStandardFromClause,
  buildStandardFulltextCte,
  buildStandardFulltextOrderBy,
  buildStandardGroupBy,
  buildStandardHaving,
  buildStandardHybridCandidateCte,
  buildStandardHybridRrfOrderBy,
  buildStandardOrderBy,
  buildStandardProjection,
  buildStandardStartCte,
  buildStandardTraversalCte,
  buildStandardVectorOrderBy,
} from "./emitter";
import { type TemporalFilterPass } from "./passes";
import { type LogicalPlan, type LogicalPlanNode } from "./plan";
import {
  compileKindFilter,
  compilePredicateClauses,
  getHybridTargetAlias,
  getNodeKindsForAlias,
  getPredicatesForAlias,
  type PredicateIndex,
} from "./predicate-utils";
import { compileFieldValue, type PredicateCompilerContext } from "./predicates";
import {
  compileVariableLengthQuery,
  hasVariableLengthTraversal,
} from "./recursive";
import { DEFAULT_SQL_SCHEMA, type SqlSchema } from "./schema";
import { compileSetOperation as compileSetOp } from "./set-operations";
import {
  runStandardQueryPassPipeline,
  shouldMaterializeTraversalCte,
} from "./standard-pass-pipeline";
import {
  isAggregateExpr,
  isIdFieldRef,
  quoteIdentifier,
  type RequiredColumnsByAlias,
} from "./utils";

// ============================================================
// Main Query Compiler
// ============================================================

/**
 * Options for query compilation.
 */
export type CompileQueryOptions = Readonly<{
  /** SQL dialect ("sqlite" or "postgres"). Defaults to "sqlite". */
  dialect?: SqlDialect | undefined;
  /** SQL schema configuration for table names. Defaults to standard names. */
  schema?: SqlSchema | undefined;
  /**
   * Fulltext strategy override. When set, overrides the dialect's
   * default fulltext strategy for `$fulltext.matches()` compilation.
   * Callers typically read this from `backend.fulltextStrategy` so a
   * backend-declared strategy (e.g. ParadeDB) wins over the dialect
   * default (tsvector).
   */
  fulltextStrategy?: FulltextStrategy | undefined;
}>;

/**
 * Compiles a query AST to SQL.
 *
 * This is the main entry point for query compilation. It dispatches to
 * the appropriate compiler based on the query type (standard, recursive,
 * or set operation).
 *
 * @param ast - The query AST to compile
 * @param graphId - The graph ID for filtering
 * @param options - Compilation options (dialect, schema)
 * @returns Drizzle SQL object ready for execution
 *
 * @example
 * ```typescript
 * const ast = query.toAst();
 * const sql = compileQuery(ast, "my_graph", { dialect: "postgres" });
 * const results = await db.execute(sql);
 * ```
 *
 * @example
 * ```typescript
 * // With custom table names
 * const schema = createSqlSchema({ nodes: "myapp_nodes", edges: "myapp_edges" });
 * const sql = compileQuery(ast, "my_graph", { dialect: "postgres", schema });
 * ```
 */
export function compileQuery(
  ast: QueryAst,
  graphId: string,
  options: CompileQueryOptions | SqlDialect = "sqlite",
): SQL {
  // Support legacy signature: compileQuery(ast, graphId, dialect)
  const options_: CompileQueryOptions =
    typeof options === "string" ? { dialect: options } : options;
  const dialect = options_.dialect ?? "sqlite";
  const schema = options_.schema ?? DEFAULT_SQL_SCHEMA;

  const adapter = resolveDialectAdapter(dialect, options_.fulltextStrategy);
  const ctx: PredicateCompilerContext = {
    dialect: adapter,
    schema,
    compileQuery: (subAst, subGraphId) =>
      compileQuery(subAst, subGraphId, propagateOptions(options_)),
  };

  // Check for variable-length traversals
  if (hasVariableLengthTraversal(ast)) {
    const lowered = tryLowerSingleHopRecursiveTraversal(ast);
    if (lowered !== undefined) {
      return compileStandardQuery(lowered, graphId, ctx);
    }
    return compileVariableLengthQuery(ast, graphId, ctx);
  }

  // Standard query compilation
  return compileStandardQuery(ast, graphId, ctx);
}

function tryLowerSingleHopRecursiveTraversal(
  ast: QueryAst,
): QueryAst | undefined {
  if (ast.traversals.length !== 1) {
    return undefined;
  }

  const traversal = ast.traversals[0]!;
  const variableLength = traversal.variableLength;
  if (!variableLength) {
    return undefined;
  }

  if (variableLength.minDepth !== 1 || variableLength.maxDepth !== 1) {
    return undefined;
  }
  if (
    variableLength.pathAlias !== undefined ||
    variableLength.depthAlias !== undefined
  ) {
    return undefined;
  }

  const { variableLength: _vl, ...nonRecursiveTraversal } = traversal;

  return {
    ...ast,
    traversals: [nonRecursiveTraversal],
  };
}

/**
 * Compiles a set operation (UNION/INTERSECT/EXCEPT) to SQL.
 *
 * @param op - The set operation AST
 * @param graphId - The graph ID for filtering
 * @param options - Compilation options (dialect, schema)
 * @returns Drizzle SQL object
 */
export function compileSetOperation(
  op: SetOperation,
  graphId: string,
  options: CompileQueryOptions | SqlDialect = "sqlite",
): SQL {
  // Support legacy signature: compileSetOperation(op, graphId, dialect)
  const options_: CompileQueryOptions =
    typeof options === "string" ? { dialect: options } : options;
  const dialect = options_.dialect ?? "sqlite";
  const schema = options_.schema ?? DEFAULT_SQL_SCHEMA;

  const adapter = resolveDialectAdapter(dialect, options_.fulltextStrategy);
  return compileSetOp(op, graphId, adapter, schema, (ast, gid) =>
    compileQuery(ast, gid, propagateOptions(options_)),
  );
}

/**
 * Builds the dialect adapter the compiler actually runs against,
 * applying a caller-supplied fulltext strategy override on top of the
 * dialect default. Returns the unmodified adapter when the override is
 * absent or identical to the dialect default — shipped backends always
 * set `fulltextStrategy`, so this short-circuit keeps the common path
 * from allocating a fresh adapter on every compile.
 */
function resolveDialectAdapter(
  dialect: SqlDialect,
  fulltextStrategy: FulltextStrategy | undefined,
): DialectAdapter {
  const baseAdapter = getDialect(dialect);
  if (
    fulltextStrategy === undefined ||
    fulltextStrategy === baseAdapter.fulltext
  ) {
    return baseAdapter;
  }
  return { ...baseAdapter, fulltext: fulltextStrategy };
}

/** Forwards compile options into recursive sub-compile calls. */
function propagateOptions(options_: CompileQueryOptions): CompileQueryOptions {
  return {
    dialect: options_.dialect ?? "sqlite",
    ...(options_.schema === undefined ? {} : { schema: options_.schema }),
    ...(options_.fulltextStrategy === undefined ?
      {}
    : { fulltextStrategy: options_.fulltextStrategy }),
  };
}

// ============================================================
// Standard Query Compilation
// ============================================================

type CountAggregateFastPathPlan = Readonly<{
  traversal: QueryAst["traversals"][number];
  /** Aggregate references `traversal.nodeAlias` (count of live target nodes). */
  requiresNodeCount: boolean;
  /** countDistinct over `traversal.nodeAlias`. */
  requiresNodeCountDistinct: boolean;
  /** Aggregate references `traversal.edgeAlias` (count of live edges). */
  requiresEdgeCount: boolean;
  /** countDistinct over `traversal.edgeAlias`. */
  requiresEdgeCountDistinct: boolean;
}>;

function resolveCountAggregateFastPath(
  ast: QueryAst,
): CountAggregateFastPathPlan | undefined {
  if (ast.traversals.length !== 1) {
    return undefined;
  }

  if (ast.groupBy?.fields.length !== 1) {
    return undefined;
  }

  if (ast.having !== undefined) {
    return undefined;
  }

  if (
    ast.orderBy?.some((orderSpec) => orderSpec.field.alias !== ast.start.alias)
  ) {
    return undefined;
  }

  const traversal = ast.traversals[0]!;
  if ((traversal.inverseEdgeKinds?.length ?? 0) > 0) {
    return undefined;
  }

  const groupField = ast.groupBy.fields[0]!;
  if (groupField.alias !== ast.start.alias || !isIdFieldRef(groupField)) {
    return undefined;
  }

  let requiresNodeCount = false;
  let requiresNodeCountDistinct = false;
  let requiresEdgeCount = false;
  let requiresEdgeCountDistinct = false;

  for (const projectedField of ast.projection.fields) {
    const source = projectedField.source;

    if (!isAggregateExpr(source)) {
      if (source.alias !== ast.start.alias) {
        return undefined;
      }
      continue;
    }

    if (!isIdFieldRef(source.field)) {
      return undefined;
    }

    const isNodeTarget = source.field.alias === traversal.nodeAlias;
    const isEdgeTarget = source.field.alias === traversal.edgeAlias;
    if (!isNodeTarget && !isEdgeTarget) {
      return undefined;
    }

    if (source.function === "count") {
      if (isNodeTarget) requiresNodeCount = true;
      else requiresEdgeCount = true;
      continue;
    }

    if (source.function === "countDistinct") {
      if (isNodeTarget) requiresNodeCountDistinct = true;
      else requiresEdgeCountDistinct = true;
      continue;
    }

    return undefined;
  }

  if (
    !requiresNodeCount &&
    !requiresNodeCountDistinct &&
    !requiresEdgeCount &&
    !requiresEdgeCountDistinct
  ) {
    return undefined;
  }

  return {
    traversal,
    requiresNodeCount,
    requiresNodeCountDistinct,
    requiresEdgeCount,
    requiresEdgeCountDistinct,
  };
}

function compileCountAggregateFastPath(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
  logicalPlan: LogicalPlan,
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined,
  predicateIndex: PredicateIndex,
  temporalFilterPass: TemporalFilterPass,
): SQL | undefined {
  const plan = resolveCountAggregateFastPath(ast);
  if (!plan) {
    return undefined;
  }

  const {
    traversal,
    requiresNodeCount,
    requiresNodeCountDistinct,
    requiresEdgeCount,
    requiresEdgeCountDistinct,
  } = plan;
  const { dialect } = ctx;
  const startAlias = ast.start.alias;
  const previousAlias = traversal.joinFromAlias;
  const previousAliasIdColumn = `${previousAlias}_id`;
  const previousAliasKindColumn = `${previousAlias}_kind`;
  const countCteAlias = `cte_${traversal.nodeAlias}_counts`;
  const nodeCountColumn = `${traversal.nodeAlias}_count`;
  const nodeCountDistinctColumn = `${traversal.nodeAlias}_count_distinct`;
  const edgeCountColumn = `${traversal.edgeAlias}_count`;
  const edgeCountDistinctColumn = `${traversal.edgeAlias}_count_distinct`;

  const previousNodeKinds = getNodeKindsForAlias(ast, traversal.joinFromAlias);
  const edgeKinds = [...new Set(traversal.edgeKinds)];
  const nodeKinds = traversal.nodeKinds;

  const edgeTemporalFilter = temporalFilterPass.forAlias("e");
  const nodeTemporalFilter = temporalFilterPass.forAlias("n");

  const nodePredicateContext: PredicateCompilerContext = {
    ...ctx,
    cteColumnPrefix: "n",
  };
  const nodePredicateClauses = compilePredicateClauses(
    getPredicatesForAlias(predicateIndex, traversal.nodeAlias, "node"),
    nodePredicateContext,
  );

  const edgePredicateContext: PredicateCompilerContext = {
    ...ctx,
    cteColumnPrefix: "e",
  };
  const edgePredicateClauses = compilePredicateClauses(
    getPredicatesForAlias(predicateIndex, traversal.edgeAlias, "edge"),
    edgePredicateContext,
  );

  const joinField = traversal.direction === "out" ? "from_id" : "to_id";
  const targetField = traversal.direction === "out" ? "to_id" : "from_id";
  const joinKindField = traversal.direction === "out" ? "from_kind" : "to_kind";
  const targetKindField =
    traversal.direction === "out" ? "to_kind" : "from_kind";

  // The target-node join is only needed when an aggregate actually counts
  // live target nodes. For edge-only counts (countEdges / countDistinctEdges)
  // the edge row alone is sufficient: the edge's own deleted_at and valid_*
  // columns already constrain "live edge," and target-kind validation is
  // enforced via the edge's to_kind filter (which the store's write path
  // keeps consistent with the target node's kind at insert time).
  const hasNodePredicates = nodePredicateClauses.length > 0;
  const requiresNodeJoin =
    requiresNodeCount || requiresNodeCountDistinct || hasNodePredicates;

  // Join style depends on how the target-node join interacts with the
  // aggregates:
  //
  // - INNER JOIN when the user applied a predicate to the target alias
  //   (whereNode on the target). Predicates should constrain every
  //   aggregate in the query — including countEdges — so they live in
  //   WHERE and the JOIN filters edges whose targets fail to match.
  //   With INNER JOIN, a group where every edge's target fails the
  //   predicate produces no rows; GROUP BY omits it, and required
  //   traversals correctly drop that start row.
  //
  // - LEFT JOIN when only temporal/deleted filters apply (no caller
  //   predicates). This lets mixed aggregates differ: countEdges
  //   counts all live edges (including edges to expired targets)
  //   while count(target) only counts edges to live targets.
  const useInnerJoin = hasNodePredicates;

  const whereClauses = [
    sql`e.graph_id = ${graphId}`,
    compileKindFilter(sql.raw("e.kind"), edgeKinds),
    compileKindFilter(sql.raw(`e.${joinKindField}`), previousNodeKinds),
    compileKindFilter(sql.raw(`e.${targetKindField}`), nodeKinds),
    edgeTemporalFilter,
    ...edgePredicateClauses,
    // INNER JOIN mode: node-side filters in WHERE constrain every aggregate.
    ...(requiresNodeJoin && useInnerJoin ?
      [
        compileKindFilter(sql.raw("n.kind"), nodeKinds),
        nodeTemporalFilter,
        ...nodePredicateClauses,
      ]
    : []),
  ];

  const nodeJoinOnClauses =
    requiresNodeJoin ?
      useInnerJoin ?
        // INNER JOIN: only the key conditions; filters live in WHERE.
        [
          sql`n.graph_id = e.graph_id`,
          sql`n.id = e.${sql.raw(targetField)}`,
          sql`n.kind = e.${sql.raw(targetKindField)}`,
        ]
        // LEFT JOIN: temporal/kind filters gate the join, so countEdges
        // still sees the full edge set while count(target) excludes edges
        // to expired targets (via COUNT ignoring NULLs).
      : [
          sql`n.graph_id = e.graph_id`,
          sql`n.id = e.${sql.raw(targetField)}`,
          sql`n.kind = e.${sql.raw(targetKindField)}`,
          compileKindFilter(sql.raw("n.kind"), nodeKinds),
          nodeTemporalFilter,
        ]
    : [];

  const aggregateColumns: SQL[] = [];
  if (requiresNodeCount) {
    aggregateColumns.push(sql`COUNT(n.id) AS ${sql.raw(nodeCountColumn)}`);
  }
  if (requiresNodeCountDistinct) {
    aggregateColumns.push(
      sql`COUNT(DISTINCT n.id) AS ${sql.raw(nodeCountDistinctColumn)}`,
    );
  }
  if (requiresEdgeCount) {
    aggregateColumns.push(sql`COUNT(e.id) AS ${sql.raw(edgeCountColumn)}`);
  }
  if (requiresEdgeCountDistinct) {
    aggregateColumns.push(
      sql`COUNT(DISTINCT e.id) AS ${sql.raw(edgeCountDistinctColumn)}`,
    );
  }

  // LIMIT push-down: when the outer SELECT applies LIMIT/OFFSET that do not
  // depend on aggregate results, we can reduce the start CTE to just the
  // required rows before aggregation. This turns an O(|start|) GROUP BY
  // into an O(limit) GROUP BY.
  //
  // Safe when:
  //   - The traversal is optional (LEFT JOIN outer). For INNER JOIN we can't
  //     push down without potentially dropping rows the original query would
  //     have kept.
  //   - No ORDER BY. ORDER BY over the full result requires the full result.
  //     (The fast path already restricts ORDER BY to the start alias, but we
  //     still need every row to sort correctly.)
  //   - LIMIT is defined. OFFSET is carried with it.
  const startCteLimit =
    traversal.optional && ast.orderBy === undefined && ast.limit !== undefined ?
      { limit: ast.limit, offset: ast.offset }
    : undefined;

  const startCte = buildStandardStartCte({
    ast,
    ctx,
    graphId,
    predicateIndex,
    requiredColumnsByAlias,
    temporalFilterPass,
    ...(startCteLimit === undefined ? {} : { limitOffset: startCteLimit }),
  });

  const targetNodeJoinKeyword = useInnerJoin ? "JOIN" : "LEFT JOIN";
  const targetNodeJoin =
    requiresNodeJoin ?
      sql`
        ${sql.raw(targetNodeJoinKeyword)} ${ctx.schema.nodesTable} n ON ${sql.join(nodeJoinOnClauses, sql` AND `)}
      `
    : sql``;

  const countCte = sql`
    ${sql.raw(countCteAlias)} AS (
      SELECT
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasIdColumn)} AS ${sql.raw(previousAliasIdColumn)},
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasKindColumn)} AS ${sql.raw(previousAliasKindColumn)},
        ${sql.join(aggregateColumns, sql`, `)}
      FROM cte_${sql.raw(previousAlias)}
      JOIN ${ctx.schema.edgesTable} e ON cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasIdColumn)} = e.${sql.raw(joinField)}
        AND cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasKindColumn)} = e.${sql.raw(joinKindField)}${targetNodeJoin}
      WHERE ${sql.join(whereClauses, sql` AND `)}
      GROUP BY
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasIdColumn)},
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasKindColumn)}
    )
  `;

  function resolveCountColumn(source: AggregateExpr): string {
    const isEdge = source.field.alias === traversal.edgeAlias;
    if (source.function === "countDistinct") {
      return isEdge ? edgeCountDistinctColumn : nodeCountDistinctColumn;
    }
    return isEdge ? edgeCountColumn : nodeCountColumn;
  }

  const projection = sql.join(
    ast.projection.fields.map((projectedField) => {
      const source = projectedField.source;

      if (!isAggregateExpr(source)) {
        const value = compileFieldValue(
          source,
          dialect,
          source.valueType,
          `cte_${source.alias}`,
        );
        return sql`${value} AS ${quoteIdentifier(projectedField.outputName)}`;
      }

      const projectedCountColumn = resolveCountColumn(source);
      const countValue = sql`${sql.raw(countCteAlias)}.${sql.raw(projectedCountColumn)}`;
      const aggregateValue =
        traversal.optional ? sql`COALESCE(${countValue}, 0)` : countValue;

      return sql`${aggregateValue} AS ${quoteIdentifier(projectedField.outputName)}`;
    }),
    sql`, `,
  );

  const joinType = traversal.optional ? "LEFT JOIN" : "INNER JOIN";
  const fromClause = sql`
    FROM cte_${sql.raw(startAlias)}
    ${sql.raw(joinType)} ${sql.raw(countCteAlias)}
      ON ${sql.raw(countCteAlias)}.${sql.raw(previousAliasIdColumn)} = cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasIdColumn)}
      AND ${sql.raw(countCteAlias)}.${sql.raw(previousAliasKindColumn)} = cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasKindColumn)}
  `;

  const orderBy = buildStandardOrderBy({ ast, dialect });
  // When the LIMIT/OFFSET was pushed into the start CTE, the outer SELECT
  // must not re-apply it — the start CTE already produced exactly the
  // requested page, and the outer LEFT JOIN preserves its cardinality.
  // Re-applying would double-offset and produce an empty page. Rewrite
  // the logical plan to match: the emitter asserts plan shape aligns
  // with emitted SQL, so dropping the clause and leaving the plan's
  // `limit_offset` node behind would trip an invariant.
  const emittedLogicalPlan =
    startCteLimit === undefined ? logicalPlan : (
      stripLimitOffsetFromPlan(logicalPlan)
    );
  const limitOffset =
    startCteLimit === undefined ?
      buildLimitOffsetClause({ limit: ast.limit, offset: ast.offset })
    : undefined;

  return emitStandardQuerySql({
    ctes: [startCte, countCte],
    fromClause,
    ...(orderBy === undefined ? {} : { orderBy }),
    ...(limitOffset === undefined ? {} : { limitOffset }),
    logicalPlan: emittedLogicalPlan,
    projection,
  });
}

/**
 * Returns a copy of the logical plan with every `limit_offset` node
 * elided. Used when the count aggregate fast path pushes LIMIT/OFFSET
 * into the start CTE — the outer SELECT then carries no LIMIT/OFFSET,
 * so the logical plan must not either or the emitter invariant check
 * will disagree with the emitted SQL.
 */
function stripLimitOffsetFromPlan(plan: LogicalPlan): LogicalPlan {
  return { ...plan, root: stripLimitOffsetFromPlanNode(plan.root) };
}

function stripLimitOffsetFromPlanNode(node: LogicalPlanNode): LogicalPlanNode {
  if (node.op === "limit_offset") {
    return stripLimitOffsetFromPlanNode(node.input);
  }
  if ("input" in node) {
    return { ...node, input: stripLimitOffsetFromPlanNode(node.input) };
  }
  return node;
}

/**
 * Compiles a standard (non-recursive) query to SQL using CTEs.
 */
type StandardQueryStrategyHandler = (
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
) => SQL;

const STANDARD_QUERY_STRATEGY_HANDLERS: Record<
  DialectStandardQueryStrategy,
  StandardQueryStrategyHandler
> = {
  cte_project: compileStandardQueryWithCteStrategy,
};

function compileStandardQuery(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const strategy = ctx.dialect.capabilities.standardQueryStrategy;
  const handler = STANDARD_QUERY_STRATEGY_HANDLERS[strategy];
  return handler(ast, graphId, ctx);
}

type SelectStandardOrderByInput = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias: string | undefined;
  dialect: DialectAdapter;
  fulltextPredicate: FulltextMatchPredicate | undefined;
  fusion: HybridFusionOptions | undefined;
  vectorPredicate: VectorSimilarityPredicate | undefined;
}>;

function selectStandardOrderBy(
  input: SelectStandardOrderByInput,
): SQL | undefined {
  const {
    ast,
    collapsedTraversalCteAlias,
    dialect,
    fulltextPredicate,
    fusion,
    vectorPredicate,
  } = input;
  if (vectorPredicate && fulltextPredicate) {
    return buildStandardHybridRrfOrderBy({ ast, dialect, fusion });
  }
  if (vectorPredicate) {
    return buildStandardVectorOrderBy({ ast, dialect });
  }
  if (fulltextPredicate) {
    return buildStandardFulltextOrderBy({ ast, dialect });
  }
  return buildStandardOrderBy({
    ast,
    ...(collapsedTraversalCteAlias === undefined ?
      {}
    : { collapsedTraversalCteAlias }),
    dialect,
  });
}

function compileStandardQueryWithCteStrategy(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const { dialect } = ctx;
  const {
    collapsedTraversalCteAlias,
    effectiveLimit,
    fulltextPredicate,
    fusion,
    logicalPlan,
    predicateIndex,
    requiredColumnsByAlias,
    shouldCollapseSelectiveTraversalRowset,
    temporalFilterPass,
    traversalCteLimit,
    vectorPredicate,
  } = runStandardQueryPassPipeline(ast, graphId, ctx);

  if (temporalFilterPass === undefined) {
    throw new CompilerInvariantError(
      "Temporal filter pass did not initialize temporal state",
      { phase: "standard-pass-pipeline" },
    );
  }
  if (logicalPlan === undefined) {
    throw new CompilerInvariantError(
      "Logical plan pass did not initialize plan state",
      { phase: "standard-pass-pipeline" },
    );
  }

  if (!vectorPredicate && !fulltextPredicate) {
    const fastPathSql = compileCountAggregateFastPath(
      ast,
      graphId,
      ctx,
      logicalPlan,
      requiredColumnsByAlias,
      predicateIndex,
      temporalFilterPass,
    );
    if (fastPathSql) {
      return fastPathSql;
    }
  }

  // Build CTEs
  const ctes: SQL[] = [
    buildStandardStartCte({
      ast,
      ctx,
      graphId,
      predicateIndex,
      requiredColumnsByAlias,
      temporalFilterPass,
    }),
  ];

  // Traversal CTEs
  for (let index = 0; index < ast.traversals.length; index++) {
    const materializeTraversalCte = shouldMaterializeTraversalCte(
      dialect,
      ast.traversals.length,
      index,
    );
    ctes.push(
      buildStandardTraversalCte({
        ast,
        carryForwardPreviousColumns: shouldCollapseSelectiveTraversalRowset,
        ctx,
        graphId,
        materializeCte: materializeTraversalCte,
        predicateIndex,
        requiredColumnsByAlias,
        temporalFilterPass,
        traversalIndex: index,
        traversalLimit: traversalCteLimit,
      }),
    );
  }

  // Add embeddings CTE if vector similarity is used
  if (vectorPredicate) {
    const nodeKinds = getNodeKindsForAlias(ast, vectorPredicate.field.alias);
    ctes.push(
      buildStandardEmbeddingsCte({
        ctx,
        graphId,
        nodeKinds,
        vectorPredicate,
      }),
    );
  }

  // Add fulltext CTE if a matches() predicate is used
  if (fulltextPredicate) {
    const nodeKinds = getNodeKindsForAlias(ast, fulltextPredicate.field.alias);
    ctes.push(
      buildStandardFulltextCte({
        ctx,
        fulltextPredicate,
        graphId,
        nodeKinds,
      }),
    );
  }

  if (getHybridTargetAlias(vectorPredicate, fulltextPredicate) !== undefined) {
    ctes.push(buildStandardHybridCandidateCte());
  }

  // Build main SELECT
  const projection = buildStandardProjection({
    ast,
    ...(collapsedTraversalCteAlias === undefined ?
      {}
    : { collapsedTraversalCteAlias }),
    dialect,
  });
  const fromClause = buildStandardFromClause({
    ast,
    ...(collapsedTraversalCteAlias === undefined ?
      {}
    : { collapsedTraversalCteAlias }),
    ...(vectorPredicate === undefined ? {} : { vectorPredicate }),
    ...(fulltextPredicate === undefined ? {} : { fulltextPredicate }),
  });
  const groupBy = buildStandardGroupBy({ ast, dialect });
  const having = buildStandardHaving({ ast, ctx });

  const orderBy = selectStandardOrderBy({
    ast,
    collapsedTraversalCteAlias,
    dialect,
    fulltextPredicate,
    fusion,
    vectorPredicate,
  });

  const limitOffset = buildLimitOffsetClause({
    limit: effectiveLimit,
    offset: ast.offset,
  });

  return emitStandardQuerySql({
    ctes,
    fromClause,
    ...(groupBy === undefined ? {} : { groupBy }),
    ...(having === undefined ? {} : { having }),
    ...(orderBy === undefined ? {} : { orderBy }),
    ...(limitOffset === undefined ? {} : { limitOffset }),
    logicalPlan,
    projection,
  });
}
