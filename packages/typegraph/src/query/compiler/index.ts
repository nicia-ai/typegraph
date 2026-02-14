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
import { type QueryAst, type SetOperation } from "../ast";
import {
  type DialectStandardQueryStrategy,
  getDialect,
  type SqlDialect,
} from "../dialect";
import { emitStandardQuerySql } from "./emitter";
import {
  buildLimitOffsetClause,
  buildStandardEmbeddingsCte,
  buildStandardFromClause,
  buildStandardGroupBy,
  buildStandardHaving,
  buildStandardOrderBy,
  buildStandardProjection,
  buildStandardStartCte,
  buildStandardTraversalCte,
  buildStandardVectorOrderBy,
} from "./emitter";
import { type TemporalFilterPass } from "./passes";
import { type LogicalPlan } from "./plan";
import {
  compileKindFilter,
  compilePredicateClauses,
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

  const adapter = getDialect(dialect);
  const ctx: PredicateCompilerContext = {
    dialect: adapter,
    schema,
    compileQuery: (subAst, subGraphId) =>
      compileQuery(subAst, subGraphId, { dialect, schema }),
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

  const adapter = getDialect(dialect);
  return compileSetOp(op, graphId, adapter, schema, (ast, gid) =>
    compileQuery(ast, gid, { dialect, schema }),
  );
}

// ============================================================
// Standard Query Compilation
// ============================================================

type CountAggregateFastPathPlan = Readonly<{
  traversal: QueryAst["traversals"][number];
  requiresCount: boolean;
  requiresCountDistinct: boolean;
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

  let requiresCount = false;
  let requiresCountDistinct = false;

  for (const projectedField of ast.projection.fields) {
    const source = projectedField.source;

    if (!isAggregateExpr(source)) {
      if (source.alias !== ast.start.alias) {
        return undefined;
      }
      continue;
    }

    if (
      source.field.alias !== traversal.nodeAlias ||
      !isIdFieldRef(source.field)
    ) {
      return undefined;
    }

    if (source.function === "count") {
      requiresCount = true;
      continue;
    }

    if (source.function === "countDistinct") {
      requiresCountDistinct = true;
      continue;
    }

    return undefined;
  }

  if (!requiresCount && !requiresCountDistinct) {
    return undefined;
  }

  return {
    traversal,
    requiresCount,
    requiresCountDistinct,
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

  const { traversal, requiresCount, requiresCountDistinct } = plan;
  const { dialect } = ctx;
  const startAlias = ast.start.alias;
  const previousAlias = traversal.joinFromAlias;
  const previousAliasIdColumn = `${previousAlias}_id`;
  const previousAliasKindColumn = `${previousAlias}_kind`;
  const countCteAlias = `cte_${traversal.nodeAlias}_counts`;
  const countColumn = `${traversal.nodeAlias}_count`;
  const countDistinctColumn = `${traversal.nodeAlias}_count_distinct`;

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

  const whereClauses = [
    sql`e.graph_id = ${graphId}`,
    compileKindFilter(sql.raw("e.kind"), edgeKinds),
    compileKindFilter(sql.raw(`e.${joinKindField}`), previousNodeKinds),
    compileKindFilter(sql.raw(`e.${targetKindField}`), nodeKinds),
    compileKindFilter(sql.raw("n.kind"), nodeKinds),
    edgeTemporalFilter,
    nodeTemporalFilter,
    ...nodePredicateClauses,
    ...edgePredicateClauses,
  ];

  const aggregateColumns: SQL[] = [];
  if (requiresCount) {
    aggregateColumns.push(sql`COUNT(n.id) AS ${sql.raw(countColumn)}`);
  }
  if (requiresCountDistinct) {
    aggregateColumns.push(
      sql`COUNT(DISTINCT n.id) AS ${sql.raw(countDistinctColumn)}`,
    );
  }

  const startCte = buildStandardStartCte({
    ast,
    ctx,
    graphId,
    predicateIndex,
    requiredColumnsByAlias,
    temporalFilterPass,
  });
  const countCte = sql`
    ${sql.raw(countCteAlias)} AS (
      SELECT
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasIdColumn)} AS ${sql.raw(previousAliasIdColumn)},
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasKindColumn)} AS ${sql.raw(previousAliasKindColumn)},
        ${sql.join(aggregateColumns, sql`, `)}
      FROM cte_${sql.raw(previousAlias)}
      JOIN ${ctx.schema.edgesTable} e ON cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasIdColumn)} = e.${sql.raw(joinField)}
        AND cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasKindColumn)} = e.${sql.raw(joinKindField)}
      JOIN ${ctx.schema.nodesTable} n ON n.graph_id = e.graph_id
        AND n.id = e.${sql.raw(targetField)}
        AND n.kind = e.${sql.raw(targetKindField)}
      WHERE ${sql.join(whereClauses, sql` AND `)}
      GROUP BY
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasIdColumn)},
        cte_${sql.raw(previousAlias)}.${sql.raw(previousAliasKindColumn)}
    )
  `;

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

      const projectedCountColumn =
        source.function === "countDistinct" ? countDistinctColumn : countColumn;
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
  const limitOffset = buildLimitOffsetClause({
    limit: ast.limit,
    offset: ast.offset,
  });

  return emitStandardQuerySql({
    ctes: [startCte, countCte],
    fromClause,
    ...(orderBy === undefined ? {} : { orderBy }),
    ...(limitOffset === undefined ? {} : { limitOffset }),
    logicalPlan,
    projection,
  });
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

function compileStandardQueryWithCteStrategy(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const { dialect } = ctx;
  const {
    collapsedTraversalCteAlias,
    effectiveLimit,
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

  if (!vectorPredicate) {
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
    ctes.push(buildStandardEmbeddingsCte({ ctx, graphId, vectorPredicate }));
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
  });
  const groupBy = buildStandardGroupBy({ ast, dialect });
  const having = buildStandardHaving({ ast, ctx });

  // Order by distance if vector similarity, otherwise use AST order
  const orderBy =
    vectorPredicate ?
      buildStandardVectorOrderBy({ ast, dialect })
    : buildStandardOrderBy({
        ast,
        ...(collapsedTraversalCteAlias === undefined ?
          {}
        : { collapsedTraversalCteAlias }),
        dialect,
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
