/**
 * Query Compiler Module
 *
 * Main entry point for compiling query ASTs to SQL.
 * Re-exports individual compiler modules and provides the main compile functions.
 */

// Re-export sub-modules
export {
  compileAggregateExpr,
  compileFieldColumn,
  compileFieldValue,
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";
export {
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
  type SqlSchema,
  type SqlTableNames,
} from "./schema";
// Note: compileSetOperation is defined below as a wrapper
export {
  type LogicalPlan,
  type LogicalPlanNode,
  lowerRecursiveQueryToLogicalPlan,
  lowerSetOperationToLogicalPlan,
  lowerStandardQueryToLogicalPlan,
} from "./plan";
export {
  compileVariableLengthQuery,
  hasVariableLengthTraversal,
  MAX_EXPLICIT_RECURSIVE_DEPTH,
  MAX_RECURSIVE_DEPTH,
} from "./recursive";
export {
  compileTemporalFilter,
  extractTemporalOptions,
  type TemporalFilterOptions,
} from "./temporal";

// Re-export dialect types
export { type DialectAdapter, getDialect, type SqlDialect } from "../dialect";

import { type SQL, sql } from "drizzle-orm";

import { UnsupportedPredicateError } from "../../errors";
import {
  type AggregateExpr,
  type FieldRef,
  type NodePredicate,
  type PredicateExpression,
  type QueryAst,
  type SetOperation,
  type VectorSimilarityPredicate,
} from "../ast";
import { type DialectAdapter, getDialect, type SqlDialect } from "../dialect";
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
import {
  createTemporalFilterPass,
  type PassSnapshot,
  resolveVectorAwareLimit,
  runCompilerPass,
  runVectorPredicatePass,
  type TemporalFilterPass,
} from "./passes";
import { type LogicalPlan, lowerStandardQueryToLogicalPlan } from "./plan";
import {
  compileFieldValue,
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";
import {
  compileVariableLengthQuery,
  hasVariableLengthTraversal,
} from "./recursive";
import { DEFAULT_SQL_SCHEMA, type SqlSchema } from "./schema";
import { compileSetOperation as compileSetOp } from "./set-operations";
import {
  addRequiredColumn,
  markFieldRefAsRequired,
  markSelectiveFieldAsRequired,
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
      compileQuery(subAst as QueryAst, subGraphId, { dialect, schema }),
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

  const { variableLength: _variableLength, ...nonRecursiveTraversal } =
    traversal;
  void _variableLength;

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

const EMPTY_PREDICATES: readonly NodePredicate[] = [];
const TRAVERSAL_LIMIT_PUSHDOWN_MULTIPLIER = 8;
const TRAVERSAL_LIMIT_PUSHDOWN_MAX = 10_000;

type PredicateIndex = Readonly<{
  byAliasAndType: ReadonlyMap<string, readonly NodePredicate[]>;
}>;

function buildPredicateIndexKey(
  alias: string,
  targetType: "node" | "edge",
): string {
  return `${alias}\u0000${targetType}`;
}

function resolvePredicateTargetType(predicate: NodePredicate): "node" | "edge" {
  return predicate.targetType === "edge" ? "edge" : "node";
}

function buildPredicateIndex(ast: QueryAst): PredicateIndex {
  const byAliasAndType = new Map<string, NodePredicate[]>();
  for (const predicate of ast.predicates) {
    const key = buildPredicateIndexKey(
      predicate.targetAlias,
      resolvePredicateTargetType(predicate),
    );
    const existing = byAliasAndType.get(key);
    if (existing === undefined) {
      byAliasAndType.set(key, [predicate]);
    } else {
      existing.push(predicate);
    }
  }
  return { byAliasAndType };
}

function getPredicatesForAlias(
  predicateIndex: PredicateIndex,
  alias: string,
  targetType: "node" | "edge",
): readonly NodePredicate[] {
  return (
    predicateIndex.byAliasAndType.get(
      buildPredicateIndexKey(alias, targetType),
    ) ?? EMPTY_PREDICATES
  );
}

function compilePredicateClauses(
  predicates: readonly NodePredicate[],
  predicateContext: PredicateCompilerContext,
): SQL[] {
  return predicates.map((predicate) =>
    compilePredicateExpression(predicate.expression, predicateContext),
  );
}

function isColumnPruningEnabled(ast: QueryAst): boolean {
  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    return true;
  }
  if (ast.groupBy || ast.having) {
    return true;
  }
  return ast.projection.fields.some((field) => isAggregateExpr(field.source));
}

function markPredicateFieldsAsRequired(
  requiredColumnsByAlias: Map<string, Set<string>>,
  expression: PredicateExpression,
): void {
  switch (expression.__type) {
    case "comparison": {
      markFieldRefAsRequired(requiredColumnsByAlias, expression.left);
      return;
    }
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op": {
      markFieldRefAsRequired(requiredColumnsByAlias, expression.field);
      return;
    }
    case "and":
    case "or": {
      for (const predicate of expression.predicates) {
        markPredicateFieldsAsRequired(requiredColumnsByAlias, predicate);
      }
      return;
    }
    case "not": {
      markPredicateFieldsAsRequired(
        requiredColumnsByAlias,
        expression.predicate,
      );
      return;
    }
    case "aggregate_comparison": {
      markFieldRefAsRequired(
        requiredColumnsByAlias,
        expression.aggregate.field,
      );
      return;
    }
    case "in_subquery": {
      markFieldRefAsRequired(requiredColumnsByAlias, expression.field);
      return;
    }
    case "vector_similarity": {
      markFieldRefAsRequired(requiredColumnsByAlias, expression.field);
      return;
    }
    case "exists": {
      return;
    }
  }
}

function collectRequiredColumnsByAlias(ast: QueryAst): RequiredColumnsByAlias {
  const requiredColumnsByAlias = new Map<string, Set<string>>();

  // Join keys are always required.
  addRequiredColumn(requiredColumnsByAlias, ast.start.alias, "id");
  for (const traversal of ast.traversals) {
    addRequiredColumn(requiredColumnsByAlias, traversal.nodeAlias, "id");
  }

  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    for (const field of ast.selectiveFields) {
      markSelectiveFieldAsRequired(requiredColumnsByAlias, field);
    }
  } else {
    for (const field of ast.projection.fields) {
      if (isAggregateExpr(field.source)) {
        markFieldRefAsRequired(requiredColumnsByAlias, field.source.field);
      } else {
        markFieldRefAsRequired(requiredColumnsByAlias, field.source);
      }
    }
  }

  if (ast.groupBy) {
    for (const field of ast.groupBy.fields) {
      markFieldRefAsRequired(requiredColumnsByAlias, field);
    }
  }

  if (ast.orderBy) {
    for (const field of ast.orderBy) {
      markFieldRefAsRequired(requiredColumnsByAlias, field.field);
    }
  }

  if (ast.having) {
    markPredicateFieldsAsRequired(requiredColumnsByAlias, ast.having);
  }

  for (const predicate of ast.predicates) {
    markPredicateFieldsAsRequired(requiredColumnsByAlias, predicate.expression);
  }

  return requiredColumnsByAlias;
}

function compileKindFilter(column: SQL, kinds: readonly string[]): SQL {
  if (kinds.length === 0) {
    return sql`1 = 0`;
  }
  if (kinds.length === 1) {
    return sql`${column} = ${kinds[0]}`;
  }
  return sql`${column} IN (${sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

function getNodeKindsForAlias(ast: QueryAst, alias: string): readonly string[] {
  if (alias === ast.start.alias) {
    return ast.start.kinds;
  }

  for (const traversal of ast.traversals) {
    if (traversal.nodeAlias === alias) {
      return traversal.nodeKinds;
    }
  }

  throw new UnsupportedPredicateError(
    `Unknown traversal source alias: ${alias}`,
  );
}

function isIdFieldRef(field: FieldRef): boolean {
  return (
    field.path.length === 1 &&
    field.path[0] === "id" &&
    field.jsonPointer === undefined
  );
}

function hasIdEqualityPredicate(
  expression: PredicateExpression,
  alias: string,
): boolean {
  switch (expression.__type) {
    case "comparison": {
      return (
        expression.op === "eq" &&
        expression.left.alias === alias &&
        isIdFieldRef(expression.left)
      );
    }
    case "and": {
      return expression.predicates.some((predicate) =>
        hasIdEqualityPredicate(predicate, alias),
      );
    }
    case "or":
    case "not":
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "exists":
    case "in_subquery":
    case "vector_similarity": {
      return false;
    }
  }
}

function isStartAliasBoundToSingleId(
  ast: QueryAst,
  predicateIndex: PredicateIndex,
): boolean {
  return getPredicatesForAlias(predicateIndex, ast.start.alias, "node").some(
    (predicate) =>
      hasIdEqualityPredicate(predicate.expression, ast.start.alias),
  );
}

function resolveTraversalCteLimit(
  ast: QueryAst,
  predicateIndex: PredicateIndex,
): number | undefined {
  if (ast.limit === undefined) {
    return undefined;
  }

  if (ast.offset !== undefined) {
    return undefined;
  }

  if (ast.limit <= 0) {
    return 0;
  }

  if (ast.groupBy || ast.having) {
    return undefined;
  }

  if (ast.orderBy && ast.orderBy.length > 0) {
    return undefined;
  }

  if (ast.traversals.length < 2) {
    return undefined;
  }

  // Optional traversals require LEFT JOIN semantics. Limiting traversal CTE rows
  // can incorrectly turn matched rows into unmatched (NULL) rows.
  if (ast.traversals.some((traversal) => traversal.optional)) {
    return undefined;
  }

  if (!isStartAliasBoundToSingleId(ast, predicateIndex)) {
    return undefined;
  }

  const scaledLimit = ast.limit * TRAVERSAL_LIMIT_PUSHDOWN_MULTIPLIER;
  return Math.min(
    Math.max(ast.limit, scaledLimit),
    TRAVERSAL_LIMIT_PUSHDOWN_MAX,
  );
}

type CountAggregateFastPathPlan = Readonly<{
  traversal: QueryAst["traversals"][number];
  requiresCount: boolean;
  requiresCountDistinct: boolean;
}>;

function canCollapseSelectiveTraversalRowset(
  ast: QueryAst,
  vectorPredicate: VectorSimilarityPredicate | undefined,
): boolean {
  if (vectorPredicate !== undefined) {
    return false;
  }

  if (ast.traversals.length === 0) {
    return false;
  }

  if (ast.traversals.some((traversal) => traversal.optional)) {
    return false;
  }

  let expectedJoinFromAlias = ast.start.alias;
  for (const traversal of ast.traversals) {
    if (traversal.joinFromAlias !== expectedJoinFromAlias) {
      return false;
    }
    expectedJoinFromAlias = traversal.nodeAlias;
  }

  if (!ast.selectiveFields || ast.selectiveFields.length === 0) {
    return false;
  }

  if (ast.groupBy || ast.having) {
    return false;
  }

  if (ast.projection.fields.some((field) => isAggregateExpr(field.source))) {
    return false;
  }

  return true;
}

function shouldMaterializeTraversalCte(
  dialect: DialectAdapter,
  traversalCount: number,
  traversalIndex: number,
): boolean {
  if (!dialect.capabilities.materializeIntermediateTraversalCtes) {
    return false;
  }

  if (traversalCount <= 1) {
    return false;
  }

  return traversalIndex < traversalCount - 1;
}

type StandardQueryPassName =
  | "vector_predicate"
  | "temporal_filters"
  | "column_pruning"
  | "selective_traversal_rowset"
  | "traversal_limit"
  | "logical_plan";

type StandardQueryPassSnapshot = PassSnapshot<StandardQueryPassName, unknown>;

type StandardQueryPassState = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias: string | undefined;
  ctx: PredicateCompilerContext;
  logicalPlan: LogicalPlan | undefined;
  predicateIndex: PredicateIndex;
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined;
  shouldCollapseSelectiveTraversalRowset: boolean;
  temporalFilterPass: TemporalFilterPass | undefined;
  traversalCteLimit: number | undefined;
  vectorPredicate: VectorSimilarityPredicate | undefined;
}>;

type StandardQueryPassPipelineResult = Readonly<{
  state: StandardQueryPassState;
  snapshots: readonly StandardQueryPassSnapshot[];
}>;

function runStandardQueryPassPipeline(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): StandardQueryPassPipelineResult {
  const snapshots: StandardQueryPassSnapshot[] = [];

  let state: StandardQueryPassState = {
    ast,
    collapsedTraversalCteAlias: undefined,
    ctx,
    logicalPlan: undefined,
    predicateIndex: buildPredicateIndex(ast),
    requiredColumnsByAlias: undefined,
    shouldCollapseSelectiveTraversalRowset: false,
    temporalFilterPass: undefined,
    traversalCteLimit: undefined,
    vectorPredicate: undefined,
  };

  const vectorPass = runCompilerPass(state, {
    name: "vector_predicate",
    execute(currentState): VectorSimilarityPredicate | undefined {
      return runVectorPredicatePass(currentState.ast).vectorPredicate;
    },
    update(currentState, vectorPredicate): StandardQueryPassState {
      return {
        ...currentState,
        vectorPredicate,
      };
    },
  });
  state = vectorPass.state;
  snapshots.push(vectorPass.snapshot);

  const temporalPass = runCompilerPass(state, {
    name: "temporal_filters",
    execute(currentState): TemporalFilterPass {
      return createTemporalFilterPass(
        currentState.ast,
        currentState.ctx.dialect.currentTimestamp(),
      );
    },
    update(currentState, temporalFilterPass): StandardQueryPassState {
      return {
        ...currentState,
        temporalFilterPass,
      };
    },
  });
  state = temporalPass.state;
  snapshots.push(temporalPass.snapshot);

  const columnPruningPass = runCompilerPass(state, {
    name: "column_pruning",
    execute(currentState): RequiredColumnsByAlias | undefined {
      return isColumnPruningEnabled(currentState.ast) ?
          collectRequiredColumnsByAlias(currentState.ast)
        : undefined;
    },
    update(currentState, requiredColumnsByAlias): StandardQueryPassState {
      return {
        ...currentState,
        requiredColumnsByAlias,
      };
    },
  });
  state = columnPruningPass.state;
  snapshots.push(columnPruningPass.snapshot);

  const selectiveTraversalRowsetPass = runCompilerPass(state, {
    name: "selective_traversal_rowset",
    execute(currentState): Readonly<{
      collapsedTraversalCteAlias: string | undefined;
      shouldCollapseSelectiveTraversalRowset: boolean;
    }> {
      const shouldCollapseSelectiveTraversalRowset =
        canCollapseSelectiveTraversalRowset(
          currentState.ast,
          currentState.vectorPredicate,
        );
      const collapsedTraversalCteAlias =
        shouldCollapseSelectiveTraversalRowset ?
          `cte_${currentState.ast.traversals.at(-1)!.nodeAlias}`
        : undefined;

      return {
        collapsedTraversalCteAlias,
        shouldCollapseSelectiveTraversalRowset,
      };
    },
    update(
      currentState,
      { collapsedTraversalCteAlias, shouldCollapseSelectiveTraversalRowset },
    ): StandardQueryPassState {
      return {
        ...currentState,
        collapsedTraversalCteAlias,
        shouldCollapseSelectiveTraversalRowset,
      };
    },
  });
  state = selectiveTraversalRowsetPass.state;
  snapshots.push(selectiveTraversalRowsetPass.snapshot);

  const traversalLimitPass = runCompilerPass(state, {
    name: "traversal_limit",
    execute(currentState): number | undefined {
      return resolveTraversalCteLimit(
        currentState.ast,
        currentState.predicateIndex,
      );
    },
    update(currentState, traversalCteLimit): StandardQueryPassState {
      return {
        ...currentState,
        traversalCteLimit,
      };
    },
  });
  state = traversalLimitPass.state;
  snapshots.push(traversalLimitPass.snapshot);

  const logicalPlanPass = runCompilerPass(state, {
    name: "logical_plan",
    execute(currentState): LogicalPlan {
      const effectiveLimit = resolveVectorAwareLimit(
        currentState.ast.limit,
        currentState.vectorPredicate,
      );
      const loweringInput = {
        ast: currentState.ast,
        dialect: currentState.ctx.dialect.name,
        graphId,
      };

      return lowerStandardQueryToLogicalPlan({
        ...loweringInput,
        ...(currentState.collapsedTraversalCteAlias === undefined ?
          {}
        : {
            collapsedTraversalCteAlias: currentState.collapsedTraversalCteAlias,
          }),
        ...(effectiveLimit === undefined ? {} : { effectiveLimit }),
        ...(currentState.vectorPredicate === undefined ?
          {}
        : { vectorPredicate: currentState.vectorPredicate }),
      });
    },
    update(currentState, logicalPlan): StandardQueryPassState {
      return {
        ...currentState,
        logicalPlan,
      };
    },
  });
  state = logicalPlanPass.state;
  snapshots.push(logicalPlanPass.snapshot);

  return {
    state,
    snapshots,
  };
}

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

  const startCte = compileStartCte(
    ast,
    graphId,
    ctx,
    requiredColumnsByAlias,
    predicateIndex,
    temporalFilterPass,
  );
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

  const orderBy = compileOrderBy(ast, dialect);
  const limitOffset = compileLimitOffsetWithOverride(ast.limit, ast.offset);

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
function compileStandardQuery(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  const { dialect } = ctx;
  const passPipeline = runStandardQueryPassPipeline(ast, graphId, ctx);
  const passSnapshots = passPipeline.snapshots;
  void passSnapshots;

  const {
    collapsedTraversalCteAlias,
    logicalPlan,
    predicateIndex,
    requiredColumnsByAlias,
    shouldCollapseSelectiveTraversalRowset,
    temporalFilterPass,
    traversalCteLimit,
    vectorPredicate,
  } = passPipeline.state;

  if (temporalFilterPass === undefined) {
    throw new Error("Temporal filter pass did not initialize temporal state");
  }
  if (logicalPlan === undefined) {
    throw new Error("Logical plan pass did not initialize plan state");
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
    compileStartCte(
      ast,
      graphId,
      ctx,
      requiredColumnsByAlias,
      predicateIndex,
      temporalFilterPass,
    ),
  ];

  // Traversal CTEs
  for (let index = 0; index < ast.traversals.length; index++) {
    const materializeTraversalCte = shouldMaterializeTraversalCte(
      dialect,
      ast.traversals.length,
      index,
    );
    ctes.push(
      compileTraversalCte(
        ast,
        index,
        graphId,
        ctx,
        requiredColumnsByAlias,
        traversalCteLimit,
        predicateIndex,
        shouldCollapseSelectiveTraversalRowset,
        materializeTraversalCte,
        temporalFilterPass,
      ),
    );
  }

  // Add embeddings CTE if vector similarity is used
  if (vectorPredicate) {
    ctes.push(compileEmbeddingsCte(vectorPredicate, graphId, ctx));
  }

  // Build main SELECT
  const projection = compileProjection(
    ast,
    dialect,
    collapsedTraversalCteAlias,
  );
  const fromClause = compileFromClause(
    ast,
    vectorPredicate,
    collapsedTraversalCteAlias,
  );
  const groupBy = compileGroupBy(ast, dialect);
  const having = compileHaving(ast, ctx);

  // Order by distance if vector similarity, otherwise use AST order
  const orderBy =
    vectorPredicate ?
      compileVectorOrderBy(vectorPredicate, ast, dialect)
    : compileOrderBy(ast, dialect, collapsedTraversalCteAlias);

  const effectiveLimit = resolveVectorAwareLimit(ast.limit, vectorPredicate);
  const limitOffset = compileLimitOffsetWithOverride(
    effectiveLimit,
    ast.offset,
  );

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

// ============================================================
// CTE Compilation
// ============================================================

/**
 * Compiles the start CTE for the initial node selection.
 */
function compileStartCte(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined,
  predicateIndex: PredicateIndex,
  temporalFilterPass: TemporalFilterPass,
): SQL {
  return buildStandardStartCte({
    ast,
    ctx,
    graphId,
    predicateIndex,
    requiredColumnsByAlias,
    temporalFilterPass,
  });
}

/**
 * Compiles a traversal CTE for edge+node joins.
 */
function compileTraversalCte(
  ast: QueryAst,
  traversalIndex: number,
  graphId: string,
  ctx: PredicateCompilerContext,
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined,
  traversalLimit: number | undefined,
  predicateIndex: PredicateIndex,
  carryForwardPreviousColumns: boolean,
  materializeCte: boolean,
  temporalFilterPass: TemporalFilterPass,
): SQL {
  return buildStandardTraversalCte({
    ast,
    carryForwardPreviousColumns,
    ctx,
    graphId,
    materializeCte,
    predicateIndex,
    requiredColumnsByAlias,
    temporalFilterPass,
    traversalIndex,
    traversalLimit,
  });
}

// ============================================================
// Query Part Compilation
// ============================================================

/**
 * Checks if a source is an aggregate expression.
 */
function isAggregateExpr(
  source: FieldRef | AggregateExpr,
): source is AggregateExpr {
  return "__type" in source && source.__type === "aggregate";
}

/**
 * Compiles the SELECT projection.
 *
 * If selectiveFields are present, generates optimized SQL that only
 * extracts the specific fields needed, enabling covered index usage.
 */
function compileProjection(
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
  collapsedTraversalCteAlias?: string,
): SQL {
  return buildStandardProjection({
    ast,
    ...(collapsedTraversalCteAlias === undefined ?
      {}
    : { collapsedTraversalCteAlias }),
    dialect,
  });
}

/**
 * Compiles the FROM clause with JOINs.
 *
 * The FROM clause starts from the start CTE and joins each traversal CTE.
 * Each traversal CTE contains a column for its join source's ID.
 * If a vector predicate is present, also joins the embeddings CTE.
 */
function compileFromClause(
  ast: QueryAst,
  vectorPredicate?: VectorSimilarityPredicate,
  collapsedTraversalCteAlias?: string,
): SQL {
  return buildStandardFromClause({
    ast,
    ...(collapsedTraversalCteAlias === undefined ?
      {}
    : { collapsedTraversalCteAlias }),
    ...(vectorPredicate === undefined ? {} : { vectorPredicate }),
  });
}

/**
 * Compiles ORDER BY clause.
 */
function compileOrderBy(
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
  collapsedTraversalCteAlias?: string,
): SQL | undefined {
  return buildStandardOrderBy({
    ast,
    ...(collapsedTraversalCteAlias === undefined ?
      {}
    : { collapsedTraversalCteAlias }),
    dialect,
  });
}

/**
 * Compiles GROUP BY clause.
 *
 * PostgreSQL requires all non-aggregated SELECT columns to appear in GROUP BY.
 * This function automatically includes:
 * 1. All non-aggregate projected fields from ast.projection (added first to ensure
 *    GROUP BY expressions match SELECT expressions exactly)
 * 2. Any explicit GROUP BY fields from ast.groupBy not already in projection
 *
 * IMPORTANT: Projected fields are added first because:
 * - SELECT uses field refs from aggregate which may not have valueType set
 * - Explicit .groupBy() fields have valueType from schema introspection
 * - If GROUP BY uses different valueType than SELECT, PostgreSQL sees different expressions
 * - By preferring projected fields' valueType, GROUP BY matches SELECT exactly
 *
 * Uses compileFieldValue to properly extract JSON fields with json_extract,
 * ensuring GROUP BY operates on the same values as SELECT.
 */
function compileGroupBy(
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
): SQL | undefined {
  return buildStandardGroupBy({ ast, dialect });
}

/**
 * Compiles HAVING clause.
 */
function compileHaving(
  ast: QueryAst,
  ctx: PredicateCompilerContext,
): SQL | undefined {
  return buildStandardHaving({ ast, ctx });
}

// compileLimitOffset removed - replaced by compileLimitOffsetWithOverride

// ============================================================
// Vector Similarity Compilation
// ============================================================

/**
 * Compiles a CTE for embedding similarity search.
 * This CTE selects from the embeddings table with distance calculation.
 */
function compileEmbeddingsCte(
  vectorPredicate: VectorSimilarityPredicate,
  graphId: string,
  ctx: PredicateCompilerContext,
): SQL {
  return buildStandardEmbeddingsCte({
    ctx,
    graphId,
    vectorPredicate,
  });
}

/**
 * Compiles ORDER BY clause for vector similarity queries.
 * Orders by distance first, then any additional ordering from the AST.
 */
function compileVectorOrderBy(
  vectorPredicate: VectorSimilarityPredicate,
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
): SQL {
  return buildStandardVectorOrderBy({
    ast,
    dialect,
    vectorPredicate,
  });
}

/**
 * Compiles LIMIT and OFFSET with optional limit override.
 */
function compileLimitOffsetWithOverride(
  limit: number | undefined,
  offset: number | undefined,
): SQL | undefined {
  return buildLimitOffsetClause({
    limit,
    offset,
  });
}
