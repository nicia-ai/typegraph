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
export { getDialect, type SqlDialect } from "../dialect";

import { type SQL, sql } from "drizzle-orm";

import { UnsupportedPredicateError } from "../../errors";
import {
  type AggregateExpr,
  type FieldRef,
  type NodePredicate,
  type PredicateExpression,
  type QueryAst,
  type SelectiveField,
  type SetOperation,
  type VectorSimilarityPredicate,
} from "../ast";
import { getDialect, type SqlDialect } from "../dialect";
import { jsonPointer } from "../json-pointer";
import {
  compileFieldValue,
  compilePredicateExpression,
  extractVectorSimilarityPredicates,
  type PredicateCompilerContext,
} from "./predicates";
import {
  compileVariableLengthQuery,
  hasVariableLengthTraversal,
} from "./recursive";
import { DEFAULT_SQL_SCHEMA, type SqlSchema } from "./schema";
import { compileSetOperation as compileSetOp } from "./set-operations";
import { compileTemporalFilter, extractTemporalOptions } from "./temporal";
import {
  addRequiredColumn,
  EMPTY_REQUIRED_COLUMNS,
  markFieldRefAsRequired,
  markSelectiveFieldAsRequired,
  NODE_COLUMNS,
  quoteIdentifier,
  type RequiredColumnsByAlias,
  shouldProjectColumn,
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

const EDGE_COLUMNS = [
  "id",
  "kind",
  "from_id",
  "to_id",
  "props",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

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

function compileColumnReference(
  tableAlias: string | undefined,
  column: string,
): SQL {
  if (tableAlias === undefined) {
    return sql.raw(column);
  }
  return sql`${sql.raw(tableAlias)}.${sql.raw(column)}`;
}

function compileNodeSelectColumns(
  tableAlias: string | undefined,
  alias: string,
  requiredColumns: ReadonlySet<string> | undefined,
): SQL[] {
  return NODE_COLUMNS.filter(
    (column) =>
      column === "id" ||
      column === "kind" ||
      shouldProjectColumn(requiredColumns, column),
  ).map(
    (column) =>
      sql`${compileColumnReference(tableAlias, column)} AS ${sql.raw(`${alias}_${column}`)}`,
  );
}

function compileEdgeSelectColumns(
  tableAlias: string | undefined,
  alias: string,
  requiredColumns: ReadonlySet<string> | undefined,
): SQL[] {
  return EDGE_COLUMNS.filter((column) =>
    shouldProjectColumn(requiredColumns, column),
  ).map(
    (column) =>
      sql`${compileColumnReference(tableAlias, column)} AS ${sql.raw(`${alias}_${column}`)}`,
  );
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
  dialect: SqlDialect,
  traversalCount: number,
  traversalIndex: number,
): boolean {
  if (dialect !== "sqlite") {
    return false;
  }

  if (traversalCount <= 1) {
    return false;
  }

  return traversalIndex < traversalCount - 1;
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
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined,
  predicateIndex: PredicateIndex,
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

  const edgeTemporalFilter = compileTemporalFilter({
    ...extractTemporalOptions(ast, "e"),
    currentTimestamp: ctx.dialect.currentTimestamp(),
  });
  const nodeTemporalFilter = compileTemporalFilter({
    ...extractTemporalOptions(ast, "n"),
    currentTimestamp: ctx.dialect.currentTimestamp(),
  });

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

  const parts: SQL[] = [
    sql`WITH ${startCte}, ${countCte}`,
    sql`SELECT ${projection}`,
    fromClause,
  ];

  if (orderBy) parts.push(orderBy);
  if (limitOffset) parts.push(limitOffset);

  return sql.join(parts, sql` `);
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
  const predicateIndex = buildPredicateIndex(ast);

  // Check for vector similarity predicates - they require special handling
  const vectorPredicates = extractVectorSimilarityPredicates(ast.predicates);
  const vectorPredicate = vectorPredicates[0]; // Only support single vector predicate

  if (vectorPredicates.length > 1) {
    throw new UnsupportedPredicateError(
      "Multiple vector similarity predicates in a single query are not supported",
    );
  }

  const requiredColumnsByAlias =
    isColumnPruningEnabled(ast) ?
      collectRequiredColumnsByAlias(ast)
    : undefined;

  const shouldCollapseSelectiveTraversalRowset =
    canCollapseSelectiveTraversalRowset(ast, vectorPredicate);
  const collapsedTraversalCteAlias =
    shouldCollapseSelectiveTraversalRowset ?
      `cte_${ast.traversals.at(-1)!.nodeAlias}`
    : undefined;

  if (!vectorPredicate) {
    const fastPathSql = compileCountAggregateFastPath(
      ast,
      graphId,
      ctx,
      requiredColumnsByAlias,
      predicateIndex,
    );
    if (fastPathSql) {
      return fastPathSql;
    }
  }

  const traversalCteLimit = resolveTraversalCteLimit(ast, predicateIndex);

  // Build CTEs
  const ctes: SQL[] = [
    compileStartCte(ast, graphId, ctx, requiredColumnsByAlias, predicateIndex),
  ];

  // Traversal CTEs
  for (let index = 0; index < ast.traversals.length; index++) {
    const materializeTraversalCte = shouldMaterializeTraversalCte(
      dialect.name,
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

  // Use vector predicate limit if present and no explicit limit in AST
  const effectiveLimit =
    vectorPredicate && ast.limit === undefined ?
      vectorPredicate.limit
    : ast.limit;
  const limitOffset = compileLimitOffsetWithOverride(
    effectiveLimit,
    ast.offset,
  );

  // Assemble query
  const parts: SQL[] = [
    sql`WITH ${sql.join(ctes, sql`, `)}`,
    sql`SELECT ${projection}`,
    fromClause,
  ];

  if (groupBy) parts.push(groupBy);
  if (having) parts.push(having);
  if (orderBy) parts.push(orderBy);
  if (limitOffset) parts.push(limitOffset);

  return sql.join(parts, sql` `);
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
): SQL {
  const alias = ast.start.alias;
  const kinds = ast.start.kinds;

  // Kind filter
  const kindFilter = compileKindFilter(sql.raw("kind"), kinds);

  // Temporal filter
  const temporalFilter = compileTemporalFilter({
    ...extractTemporalOptions(ast),
    currentTimestamp: ctx.dialect.currentTimestamp(),
  });

  // Node predicates for this alias
  // Use cteColumnPrefix: "" to generate raw column names (e.g., "props" not "p_props")
  // because CTE WHERE clauses operate on raw table columns before aliasing
  const cteContext: PredicateCompilerContext = { ...ctx, cteColumnPrefix: "" };
  const predicateClauses = compilePredicateClauses(
    getPredicatesForAlias(predicateIndex, alias, "node"),
    cteContext,
  );

  // Combine all WHERE clauses
  const whereClauses = [
    sql`graph_id = ${graphId}`,
    kindFilter,
    temporalFilter,
    ...predicateClauses,
  ];

  const effectiveRequiredColumns =
    requiredColumnsByAlias ?
      (requiredColumnsByAlias.get(alias) ?? EMPTY_REQUIRED_COLUMNS)
    : undefined;

  return sql`
    cte_${sql.raw(alias)} AS (
      SELECT ${sql.join(
        compileNodeSelectColumns(undefined, alias, effectiveRequiredColumns),
        sql`, `,
      )}
      FROM ${ctx.schema.nodesTable}
      WHERE ${sql.join(whereClauses, sql` AND `)}
    )
  `;
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
): SQL {
  const traversal = ast.traversals[traversalIndex]!;
  const traversalLimitValue =
    traversalIndex === ast.traversals.length - 1 ? traversalLimit : undefined;

  const previousNodeKinds = getNodeKindsForAlias(ast, traversal.joinFromAlias);
  const directEdgeKinds = [...new Set(traversal.edgeKinds)];
  const inverseEdgeKinds =
    traversal.inverseEdgeKinds === undefined ?
      []
    : [...new Set(traversal.inverseEdgeKinds)];

  const nodeKinds = traversal.nodeKinds;
  const nodeKindFilter = compileKindFilter(sql.raw("n.kind"), nodeKinds);

  const edgeTemporalFilter = compileTemporalFilter({
    ...extractTemporalOptions(ast, "e"),
    currentTimestamp: ctx.dialect.currentTimestamp(),
  });
  const nodeTemporalFilter = compileTemporalFilter({
    ...extractTemporalOptions(ast, "n"),
    currentTimestamp: ctx.dialect.currentTimestamp(),
  });

  // Node predicates for this alias
  // Use cteColumnPrefix: "n" to generate table-qualified column names (e.g., "n.props")
  // because traversal CTE WHERE clauses operate on the joined node table
  const nodeCteContext: PredicateCompilerContext = {
    ...ctx,
    cteColumnPrefix: "n",
  };
  const nodePredicateClauses = compilePredicateClauses(
    getPredicatesForAlias(predicateIndex, traversal.nodeAlias, "node"),
    nodeCteContext,
  );

  // Edge predicates for this traversal's edge alias
  // Use cteColumnPrefix: "e" for edge table columns
  const edgeCteContext: PredicateCompilerContext = {
    ...ctx,
    cteColumnPrefix: "e",
  };
  const edgePredicateClauses = compilePredicateClauses(
    getPredicatesForAlias(predicateIndex, traversal.edgeAlias, "edge"),
    edgeCteContext,
  );

  const baseWhereClauses = [
    sql`e.graph_id = ${graphId}`,
    nodeKindFilter,
    edgeTemporalFilter,
    nodeTemporalFilter,
    ...nodePredicateClauses,
    ...edgePredicateClauses,
  ];

  const previousAlias = traversal.joinFromAlias;
  const edgeAlias = traversal.edgeAlias;
  const nodeAlias = traversal.nodeAlias;
  const requiredNodeColumns =
    requiredColumnsByAlias ?
      (requiredColumnsByAlias.get(nodeAlias) ?? EMPTY_REQUIRED_COLUMNS)
    : undefined;
  const requiredEdgeColumns =
    requiredColumnsByAlias ?
      (requiredColumnsByAlias.get(edgeAlias) ?? EMPTY_REQUIRED_COLUMNS)
    : undefined;
  const previousRowColumns =
    carryForwardPreviousColumns ?
      [sql`cte_${sql.raw(previousAlias)}.*`]
    : [
        sql`cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id AS ${sql.raw(previousAlias)}_id`,
        sql`cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_kind AS ${sql.raw(previousAlias)}_kind`,
      ];
  const selectColumns = [
    ...previousRowColumns,
    ...compileEdgeSelectColumns("e", edgeAlias, requiredEdgeColumns),
    ...compileNodeSelectColumns("n", nodeAlias, requiredNodeColumns),
  ];
  const cteMaterialization = materializeCte ? sql`MATERIALIZED ` : sql``;

  function compileTraversalBranch(
    branch: Readonly<{
      joinField: "from_id" | "to_id";
      targetField: "from_id" | "to_id";
      joinKindField: "from_kind" | "to_kind";
      targetKindField: "from_kind" | "to_kind";
      edgeKinds: readonly string[];
      duplicateGuard?: SQL | undefined;
    }>,
  ): SQL {
    const whereClauses = [
      ...baseWhereClauses,
      compileKindFilter(sql.raw("e.kind"), branch.edgeKinds),
      compileKindFilter(
        sql.raw(`e.${branch.joinKindField}`),
        previousNodeKinds,
      ),
      compileKindFilter(sql.raw(`e.${branch.targetKindField}`), nodeKinds),
    ];

    if (branch.duplicateGuard !== undefined) {
      whereClauses.push(branch.duplicateGuard);
    }

    return sql`
      SELECT ${sql.join(selectColumns, sql`, `)}
      FROM cte_${sql.raw(previousAlias)}
      JOIN ${ctx.schema.edgesTable} e ON cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id = e.${sql.raw(branch.joinField)}
        AND cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_kind = e.${sql.raw(branch.joinKindField)}
      JOIN ${ctx.schema.nodesTable} n ON n.graph_id = e.graph_id
        AND n.id = e.${sql.raw(branch.targetField)}
        AND n.kind = e.${sql.raw(branch.targetKindField)}
      WHERE ${sql.join(whereClauses, sql` AND `)}
    `;
  }

  const directJoinField = traversal.direction === "out" ? "from_id" : "to_id";
  const directTargetField = traversal.direction === "out" ? "to_id" : "from_id";
  const directJoinKindField =
    traversal.direction === "out" ? "from_kind" : "to_kind";
  const directTargetKindField =
    traversal.direction === "out" ? "to_kind" : "from_kind";

  const directBranch = compileTraversalBranch({
    joinField: directJoinField,
    targetField: directTargetField,
    joinKindField: directJoinKindField,
    targetKindField: directTargetKindField,
    edgeKinds: directEdgeKinds,
  });

  if (inverseEdgeKinds.length === 0) {
    if (traversalLimitValue !== undefined) {
      return sql`
        cte_${sql.raw(nodeAlias)} AS ${cteMaterialization}(
          SELECT * FROM (
            ${directBranch}
          ) AS traversal_rows
          LIMIT ${traversalLimitValue}
        )
      `;
    }

    return sql`
      cte_${sql.raw(nodeAlias)} AS ${cteMaterialization}(
        ${directBranch}
      )
    `;
  }

  const inverseJoinField = traversal.direction === "out" ? "to_id" : "from_id";
  const inverseTargetField =
    traversal.direction === "out" ? "from_id" : "to_id";
  const inverseJoinKindField =
    traversal.direction === "out" ? "to_kind" : "from_kind";
  const inverseTargetKindField =
    traversal.direction === "out" ? "from_kind" : "to_kind";

  const overlappingKinds = inverseEdgeKinds.filter((kind) =>
    directEdgeKinds.includes(kind),
  );

  const duplicateGuard =
    overlappingKinds.length > 0 ?
      sql`NOT (e.from_id = e.to_id AND ${compileKindFilter(
        sql.raw("e.kind"),
        overlappingKinds,
      )})`
    : undefined;

  const inverseBranch = compileTraversalBranch({
    joinField: inverseJoinField,
    targetField: inverseTargetField,
    joinKindField: inverseJoinKindField,
    targetKindField: inverseTargetKindField,
    edgeKinds: inverseEdgeKinds,
    duplicateGuard,
  });

  if (traversalLimitValue !== undefined) {
    return sql`
      cte_${sql.raw(nodeAlias)} AS ${cteMaterialization}(
        SELECT * FROM (
          ${directBranch}
          UNION ALL
          ${inverseBranch}
        ) AS traversal_rows
        LIMIT ${traversalLimitValue}
      )
    `;
  }

  return sql`
    cte_${sql.raw(nodeAlias)} AS ${cteMaterialization}(
      ${directBranch}
      UNION ALL
      ${inverseBranch}
    )
  `;
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
 * Compiles a projected source (field ref or aggregate).
 */
function compileProjectedSource(
  field: {
    source: FieldRef | AggregateExpr;
    cteAlias?: string;
  },
  dialect: ReturnType<typeof getDialect>,
): SQL {
  if (isAggregateExpr(field.source)) {
    return compileAggregateExprFromSource(field.source, dialect);
  }
  // Use provided cteAlias if available, otherwise derive from field alias
  const cteAlias = field.cteAlias ?? `cte_${field.source.alias}`;
  return compileFieldValue(
    field.source,
    dialect,
    field.source.valueType,
    cteAlias,
  );
}

/**
 * Compiles an aggregate expression from source.
 *
 * Uses compileFieldValue to properly extract JSON fields with json_extract
 * for numeric aggregates like SUM, AVG, MIN, MAX.
 */
function compileAggregateExprFromSource(
  expr: AggregateExpr,
  dialect: ReturnType<typeof getDialect>,
): SQL {
  const { field } = expr;
  const fn = expr.function;

  switch (fn) {
    case "count": {
      const cteAlias = `cte_${field.alias}`;
      return sql`COUNT(${sql.raw(cteAlias)}.${sql.raw(field.alias)}_id)`;
    }
    case "countDistinct": {
      const cteAlias = `cte_${field.alias}`;
      return sql`COUNT(DISTINCT ${sql.raw(cteAlias)}.${sql.raw(field.alias)}_id)`;
    }
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const cteAlias = `cte_${field.alias}`;
      // Use compileFieldValue to properly extract JSON fields
      const column = compileFieldValue(
        field,
        dialect,
        field.valueType,
        cteAlias,
      );
      return sql`${sql.raw(fn.toUpperCase())}(${column})`;
    }
    default: {
      throw new UnsupportedPredicateError(
        `Unknown aggregate function: ${String(fn)}`,
      );
    }
  }
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
  // Check for selective projection first
  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    return compileSelectiveProjection(
      ast.selectiveFields,
      dialect,
      ast,
      collapsedTraversalCteAlias,
    );
  }

  const fields = ast.projection.fields;

  if (fields.length === 0) {
    return sql.raw("*");
  }

  const projectedFields = fields.map((f) => {
    const source = compileProjectedSource(f, dialect);
    // Quote the output name to preserve case in PostgreSQL
    // PostgreSQL converts unquoted identifiers to lowercase
    return sql`${source} AS ${quoteIdentifier(f.outputName)}`;
  });

  return sql.join(projectedFields, sql`, `);
}

/**
 * Compiles selective projection for optimized queries.
 *
 * Generates SQL that only extracts the specific fields needed,
 * rather than fetching the entire props blob. This enables
 * covered index usage when the selected fields are indexed.
 */
function compileSelectiveProjection(
  fields: readonly SelectiveField[],
  dialect: ReturnType<typeof getDialect>,
  ast: QueryAst,
  collapsedTraversalCteAlias?: string,
): SQL {
  // Build a mapping from alias to CTE name
  // Start node: alias maps to cte_{alias}
  // Traversal nodes: nodeAlias maps to cte_{nodeAlias}
  // Traversal edges: edgeAlias maps to cte_{nodeAlias} (edge columns are in the traversal CTE)
  const aliasToCte = new Map<string, string>([
    [ast.start.alias, `cte_${ast.start.alias}`],
  ]);

  // Start node

  // Traversals
  for (const traversal of ast.traversals) {
    // Node alias maps to its own CTE
    aliasToCte.set(traversal.nodeAlias, `cte_${traversal.nodeAlias}`);
    // Edge alias maps to the traversal's CTE (which is named after the node)
    aliasToCte.set(traversal.edgeAlias, `cte_${traversal.nodeAlias}`);
  }

  const columns = fields.map((f) => {
    const cteAlias =
      collapsedTraversalCteAlias ?? aliasToCte.get(f.alias) ?? `cte_${f.alias}`;

    if (f.isSystemField) {
      // System fields: direct column reference from CTE
      // Map API field names to database column names
      const dbColumn =
        f.field === "fromId" ? "from_id"
        : f.field === "toId" ? "to_id"
        : f.field.startsWith("meta.") ?
          // Convert camelCase meta fields to snake_case
          // e.g., "meta.validFrom" → "valid_from"
          f.field
            .slice(5)
            .replaceAll(/([A-Z])/g, "_$1")
            .toLowerCase()
        : f.field;

      return sql`${sql.raw(cteAlias)}.${sql.raw(`${f.alias}_${dbColumn}`)} AS ${quoteIdentifier(f.outputName)}`;
    }

    // Props fields: JSON extraction from the props column.
    // Use the dialect adapter to ensure a stable expression text (important for indexes).
    const propsColumn = `${f.alias}_props`;
    const column = sql`${sql.raw(cteAlias)}.${sql.raw(propsColumn)}`;
    const pointer = jsonPointer([f.field]);
    const extracted = compileSelectiveJsonValue(
      dialect,
      column,
      pointer,
      f.valueType,
    );
    return sql`${extracted} AS ${quoteIdentifier(f.outputName)}`;
  });

  return sql.join(columns, sql`, `);
}

function compileSelectiveJsonValue(
  dialect: ReturnType<typeof getDialect>,
  column: SQL,
  pointer: ReturnType<typeof jsonPointer>,
  valueType: SelectiveField["valueType"],
): SQL {
  switch (valueType) {
    case "string": {
      return dialect.jsonExtractText(column, pointer);
    }
    case "number": {
      return dialect.jsonExtractNumber(column, pointer);
    }
    case "boolean": {
      return dialect.jsonExtractBoolean(column, pointer);
    }
    case "date": {
      return dialect.jsonExtractDate(column, pointer);
    }
    case "array":
    case "object":
    case "embedding":
    case "unknown":
    case undefined: {
      return dialect.jsonExtract(column, pointer);
    }
  }
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
  if (collapsedTraversalCteAlias !== undefined) {
    return sql`FROM ${sql.raw(collapsedTraversalCteAlias)}`;
  }

  const startAlias = ast.start.alias;

  // Start from the first CTE (start alias)
  const fromClause = sql`FROM cte_${sql.raw(startAlias)}`;

  const joins: SQL[] = [];

  // Build JOINs for each traversal
  for (const traversal of ast.traversals) {
    const cteAlias = `cte_${traversal.nodeAlias}`;
    const previousAlias = traversal.joinFromAlias;
    const joinType = traversal.optional ? "LEFT JOIN" : "INNER JOIN";
    // Each traversal CTE has a column for the previous alias's ID
    joins.push(
      sql`${sql.raw(joinType)} ${sql.raw(cteAlias)} ON ${sql.raw(cteAlias)}.${sql.raw(previousAlias)}_id = cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_id AND ${sql.raw(cteAlias)}.${sql.raw(previousAlias)}_kind = cte_${sql.raw(previousAlias)}.${sql.raw(previousAlias)}_kind`,
    );
  }

  // Join embeddings CTE if vector similarity is used
  if (vectorPredicate) {
    const nodeAlias = vectorPredicate.field.alias;
    joins.push(
      sql`INNER JOIN cte_embeddings ON cte_embeddings.node_id = cte_${sql.raw(nodeAlias)}.${sql.raw(nodeAlias)}_id`,
    );
  }

  if (joins.length === 0) {
    return fromClause;
  }

  return sql`${fromClause} ${sql.join(joins, sql` `)}`;
}

/**
 * Compiles ORDER BY clause.
 */
function compileOrderBy(
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
  collapsedTraversalCteAlias?: string,
): SQL | undefined {
  if (!ast.orderBy || ast.orderBy.length === 0) {
    return undefined;
  }

  const parts: SQL[] = [];

  for (const o of ast.orderBy) {
    const valueType = o.field.valueType;
    if (valueType === "array" || valueType === "object") {
      throw new UnsupportedPredicateError(
        "Ordering by JSON arrays or objects is not supported",
      );
    }
    const cteAlias = collapsedTraversalCteAlias ?? `cte_${o.field.alias}`;
    const field = compileFieldValue(o.field, dialect, valueType, cteAlias);
    const dir = sql.raw(o.direction.toUpperCase());
    const nulls = o.nulls ?? (o.direction === "asc" ? "last" : "first");
    const nullsDir = sql.raw(nulls === "first" ? "DESC" : "ASC");

    // Enforce consistent NULL ordering across dialects (SQLite differs from PostgreSQL by default).
    // We emulate NULLS FIRST/LAST using an `IS NULL` ordering prefix to avoid relying on dialect syntax.
    parts.push(sql`(${field} IS NULL) ${nullsDir}`, sql`${field} ${dir}`);
  }

  return sql`ORDER BY ${sql.join(parts, sql`, `)}`;
}

/**
 * Creates a unique key for a FieldRef to enable deduplication.
 * Includes jsonPointer to distinguish fields that share the same base path (e.g., "props").
 */
function fieldRefKey(field: FieldRef): string {
  const pointer = field.jsonPointer ?? "";
  return `${field.alias}:${field.path.join(".")}:${pointer}`;
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
  if (!ast.groupBy || ast.groupBy.fields.length === 0) {
    return undefined;
  }

  // Collect all fields that need to be in GROUP BY, deduplicating by key
  const seenKeys = new Set<string>();
  const allFields: FieldRef[] = [];

  // Add all non-aggregate projected fields FIRST
  // This ensures GROUP BY expressions use the same valueType as SELECT expressions
  // The field() helper used in aggregate doesn't set valueType, while
  // explicit .groupBy() calls set valueType from schema introspection
  for (const projectedField of ast.projection.fields) {
    if (projectedField.source.__type === "field_ref") {
      const key = fieldRefKey(projectedField.source);
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allFields.push(projectedField.source);
      }
    }
  }

  // Add explicit GROUP BY fields that aren't already in projection
  // These might group by fields not in SELECT (unusual but valid SQL)
  for (const field of ast.groupBy.fields) {
    const key = fieldRefKey(field);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      allFields.push(field);
    }
  }

  if (allFields.length === 0) {
    return undefined;
  }

  const parts = allFields.map((f) => {
    const cteAlias = `cte_${f.alias}`;
    // Use compileFieldValue to properly extract JSON fields
    return compileFieldValue(f, dialect, f.valueType, cteAlias);
  });

  return sql`GROUP BY ${sql.join(parts, sql`, `)}`;
}

/**
 * Compiles HAVING clause.
 */
function compileHaving(
  ast: QueryAst,
  ctx: PredicateCompilerContext,
): SQL | undefined {
  if (!ast.having) {
    return undefined;
  }

  const condition = compilePredicateExpression(ast.having, ctx);
  return sql`HAVING ${condition}`;
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
  const { dialect } = ctx;
  const { field, queryEmbedding, metric, minScore } = vectorPredicate;

  // Get the field path from the JSON pointer (e.g., "/embedding")
  // The jsonPointer is already a string like "/embedding"
  const fieldPath =
    field.jsonPointer ? (field.jsonPointer as string)
    : field.path.length > 1 && field.path[0] === "props" ?
      `/${field.path.slice(1).join("/")}`
    : `/${field.path.join("/")}`;

  // Build distance expression
  const distanceExpr = dialect.vectorDistance(
    sql.raw("embedding"),
    queryEmbedding,
    metric,
  );

  // Build WHERE conditions
  const conditions: SQL[] = [
    sql`graph_id = ${graphId}`,
    sql`field_path = ${fieldPath}`,
  ];

  // Add minScore filter if specified
  if (minScore !== undefined) {
    if (!Number.isFinite(minScore)) {
      throw new UnsupportedPredicateError(
        `Vector minScore must be a finite number, got: ${String(minScore)}`,
      );
    }
    conditions.push(
      compileVectorMinScoreCondition(distanceExpr, metric, minScore),
    );
  }

  const scoreExpr = compileVectorScoreExpression(distanceExpr, metric);

  return sql`
    cte_embeddings AS (
      SELECT
        node_id,
        ${distanceExpr} AS distance,
        ${scoreExpr} AS score
      FROM ${ctx.schema.embeddingsTable}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY ${distanceExpr} ASC
    )
  `;
}

function compileVectorScoreExpression(
  distanceExpr: SQL,
  metric: VectorSimilarityPredicate["metric"],
): SQL {
  switch (metric) {
    case "cosine": {
      return sql`(1.0 - ${distanceExpr})`;
    }
    case "l2":
    case "inner_product": {
      // For non-cosine metrics, expose the raw distance value.
      return distanceExpr;
    }
  }
}

function compileVectorMinScoreCondition(
  distanceExpr: SQL,
  metric: VectorSimilarityPredicate["metric"],
  minScore: number,
): SQL {
  switch (metric) {
    case "cosine": {
      const threshold = 1 - minScore;
      return sql`${distanceExpr} <= ${threshold}`;
    }
    case "l2": {
      // For L2, minScore is interpreted as a maximum distance threshold.
      return sql`${distanceExpr} <= ${minScore}`;
    }
    case "inner_product": {
      // pgvector <#> returns negative inner product distance.
      const negativeThreshold = -minScore;
      return sql`${distanceExpr} <= ${negativeThreshold}`;
    }
  }
}

/**
 * Compiles ORDER BY clause for vector similarity queries.
 * Orders by distance first, then any additional ordering from the AST.
 */
function compileVectorOrderBy(
  _vectorPredicate: VectorSimilarityPredicate,
  ast: QueryAst,
  dialect: ReturnType<typeof getDialect>,
): SQL {
  // Primary ordering: distance ascending (closest first)
  const distanceOrder = sql`cte_embeddings.distance ASC`;

  // Secondary ordering from AST
  const additionalOrders: SQL[] = [];
  if (ast.orderBy && ast.orderBy.length > 0) {
    for (const o of ast.orderBy) {
      const valueType = o.field.valueType;
      if (valueType === "array" || valueType === "object") {
        throw new UnsupportedPredicateError(
          "Ordering by JSON arrays or objects is not supported",
        );
      }
      const cteAlias = `cte_${o.field.alias}`;
      const field = compileFieldValue(o.field, dialect, valueType, cteAlias);
      const dir = sql.raw(o.direction.toUpperCase());
      // Use IS NULL emulation for cross-dialect NULL ordering (same as compileOrderBy)
      const nulls = o.nulls ?? (o.direction === "asc" ? "last" : "first");
      const nullsDir = sql.raw(nulls === "first" ? "DESC" : "ASC");
      additionalOrders.push(
        sql`(${field} IS NULL) ${nullsDir}`,
        sql`${field} ${dir}`,
      );
    }
  }

  const allOrders = [distanceOrder, ...additionalOrders];
  return sql`ORDER BY ${sql.join(allOrders, sql`, `)}`;
}

/**
 * Compiles LIMIT and OFFSET with optional limit override.
 */
function compileLimitOffsetWithOverride(
  limit: number | undefined,
  offset: number | undefined,
): SQL | undefined {
  const parts: SQL[] = [];

  if (limit !== undefined) {
    parts.push(sql`LIMIT ${limit}`);
  }
  if (offset !== undefined) {
    parts.push(sql`OFFSET ${offset}`);
  }

  return parts.length > 0 ? sql.join(parts, sql` `) : undefined;
}
