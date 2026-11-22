import type {
  FieldRef,
  FulltextMatchPredicate,
  HybridFusionOptions,
  PredicateExpression,
  QueryAst,
  VectorSimilarityPredicate,
} from "../ast";
import { type DialectAdapter } from "../dialect/types";
import { type DatabaseExpression } from "../expressions";
import {
  expressionContainsAggregate,
  visitExpressionChildren,
} from "./expression-inspection";
import { visitCorrelatedExpressionFields } from "./expression-subquery-scope";
import {
  createTemporalFilterPass,
  runCompilerPass,
  runFulltextPredicatePass,
  runFusionConfigPass,
  runVectorPredicatePass,
  type TemporalFilterPass,
} from "./passes";
import { type LogicalPlan, lowerStandardQueryToLogicalPlan } from "./plan";
import {
  buildPredicateIndex,
  getPredicatesForAlias,
  type PredicateIndex,
} from "./predicate-utils";
import { type PredicateCompilerContext } from "./predicates";
import { assertRecordedQueryDoesNotUseCurrentIndexes } from "./recorded-current-index-guard";
import {
  addRequiredColumn,
  findSelectivePropsFieldForFieldRef,
  isIdFieldRef,
  mapSelectiveSystemFieldToColumn,
  markFieldRefAsRequired,
  type RequiredColumnsByAlias,
} from "./utils";

/**
 * Heuristics for pushing LIMIT into traversal CTEs to cap intermediate row counts.
 * - 8x multiplier accounts for edge fan-out (each node may connect to multiple edges).
 * - 10K cap prevents runaway memory allocation for large intermediate result sets.
 */
const TRAVERSAL_LIMIT_PUSHDOWN_MULTIPLIER = 8;
const TRAVERSAL_LIMIT_PUSHDOWN_MAX = 10_000;

function isColumnPruningEnabled(ast: QueryAst): boolean {
  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    return true;
  }
  if (ast.groupBy || ast.having) {
    return true;
  }
  return ast.projection.fields.some(
    (field) =>
      field.source.__type === "aggregate" ||
      (field.source.__type === "database_expression" &&
        expressionContainsAggregate(field.source)),
  );
}

export function visitExpressionFields(
  expression: DatabaseExpression,
  visit: (field: FieldRef) => void,
): void {
  const node = expression.node;
  if (node.kind === "field") {
    visit(node.field);
    return;
  }
  if (node.kind === "exists_subquery" || node.kind === "scalar_subquery") {
    visitCorrelatedExpressionFields(
      node.subquery,
      expression.scopeIdentity,
      visit,
    );
    return;
  }
  visitExpressionChildren(expression, (operand) => {
    visitExpressionFields(operand, visit);
  });
}

/**
 * Visits every field a predicate reads, on every operand: both sides of a
 * comparison (the right may be a field), every field of a tuple, every
 * member of AND/OR, and every operand of a database expression. EXISTS and
 * IN subqueries are compiled as independent statements and read nothing of
 * the enclosing query besides the IN field.
 */
export function visitPredicateFields(
  expression: PredicateExpression,
  visit: (field: FieldRef) => void,
): void {
  switch (expression.__type) {
    case "comparison": {
      visit(expression.left);
      if (
        !Array.isArray(expression.right) &&
        expression.right.__type === "field_ref"
      )
        visit(expression.right);
      return;
    }
    case "tuple_comparison": {
      for (const field of expression.fields) visit(field);
      return;
    }
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op":
    case "in_subquery":
    case "vector_similarity":
    case "fulltext_match": {
      visit(expression.field);
      return;
    }
    case "and":
    case "or": {
      for (const predicate of expression.predicates) {
        visitPredicateFields(predicate, visit);
      }
      return;
    }
    case "not": {
      visitPredicateFields(expression.predicate, visit);
      return;
    }
    case "aggregate_comparison": {
      visit(expression.aggregate.field);
      return;
    }
    case "exists": {
      return;
    }
    case "database_expression_predicate": {
      visitExpressionFields(expression.expression, visit);
      return;
    }
  }
}

export function markPredicateFieldsAsRequired(
  requiredColumnsByAlias: Map<string, Set<string>>,
  expression: PredicateExpression,
): void {
  visitPredicateFields(expression, (field) => {
    markFieldRefAsRequired(requiredColumnsByAlias, field);
  });
}

/**
 * Where the outer statement reads a field: the projection (when it is not a
 * selective one), the id an aggregate counts, grouping, an ordering term that
 * is a plain field or one inside an expression, the result predicate, or
 * HAVING.
 */
type OuterClauseFieldUse =
  | "projection"
  | "aggregate-id"
  | "group-by"
  | "order-by-field"
  | "order-by-expression"
  | "result-predicate"
  | "having";

/**
 * Visits every field the outer SELECT of a standard statement may read from
 * its candidate CTEs, with the clause that reads it, so column pruning keeps
 * those columns. Selective fields are not visited; pruning reads them from
 * `ast.selectiveFields`.
 *
 * This answers "which columns must a CTE carry", where keeping a column the
 * SQL never reads is harmless. It is not the read set the SQL-name check
 * uses: that is recorded by the function that writes each reference
 * (`column-reads.ts`), and the two are allowed to differ.
 */
function visitOuterClauseFields(
  ast: QueryAst,
  options: Readonly<{ includeProjection: boolean }>,
  visit: (field: FieldRef, use: OuterClauseFieldUse) => void,
): void {
  const hasSelectiveFields = (ast.selectiveFields?.length ?? 0) > 0;
  if (options.includeProjection && !hasSelectiveFields) {
    for (const projectedField of ast.projection.fields) {
      const source = projectedField.source;
      if (source.__type === "field_ref") {
        visit(source, "projection");
      } else if (source.__type === "aggregate") {
        visit(
          { __type: "field_ref", alias: source.field.alias, path: ["id"] },
          "aggregate-id",
        );
        visit(source.field, "projection");
      } else {
        visitExpressionFields(source, (field) => {
          visit(field, "projection");
        });
      }
    }
  }

  if (ast.groupBy) {
    for (const field of ast.groupBy.fields) {
      if (field.__type === "field_ref") {
        visit(field, "group-by");
      } else {
        visitExpressionFields(field, (referencedField) => {
          visit(referencedField, "group-by");
        });
      }
    }
  }

  for (const orderSpec of ast.orderBy ?? []) {
    if (orderSpec.field.__type === "database_expression") {
      visitExpressionFields(orderSpec.field, (field) => {
        visit(field, "order-by-expression");
      });
      continue;
    }
    visit(orderSpec.field, "order-by-field");
  }

  if (ast.resultPredicate !== undefined) {
    visitPredicateFields(ast.resultPredicate, (field) => {
      visit(field, "result-predicate");
    });
  }

  if (ast.having) {
    visitPredicateFields(ast.having, (field) => {
      visit(field, "having");
    });
  }
}

/**
 * Collects the columns each alias must carry out of its CTE.
 *
 * `includeProjection` (default true) folds in the SELECT-list fields. The late
 * materialization path passes `false` to build a *lean* candidate CTE that
 * carries only identity, ordering, and predicate columns — the projection-only
 * columns (e.g. a large `content` prop) are deferred and re-fetched by identity
 * for the surviving rows, not materialized for every candidate.
 */
export function collectRequiredColumnsByAlias(
  ast: QueryAst,
  options?: Readonly<{ includeProjection?: boolean }>,
): RequiredColumnsByAlias {
  const includeProjection = options?.includeProjection ?? true;
  const requiredColumnsByAlias = new Map<string, Set<string>>();

  addRequiredColumn(requiredColumnsByAlias, ast.start.alias, "id");
  for (const traversal of ast.traversals) {
    addRequiredColumn(requiredColumnsByAlias, traversal.nodeAlias, "id");
  }

  const hasSelectiveFields = (ast.selectiveFields?.length ?? 0) > 0;

  if (includeProjection && hasSelectiveFields) {
    for (const field of ast.selectiveFields ?? []) {
      if (field.isSystemField) {
        addRequiredColumn(
          requiredColumnsByAlias,
          field.alias,
          mapSelectiveSystemFieldToColumn(field.field),
        );
      }
    }
  }

  visitOuterClauseFields(ast, { includeProjection }, (field, use) => {
    // An ordering term the selective projection already extracts is read
    // from that extracted column, so it needs nothing else carried.
    if (
      use === "order-by-field" &&
      findSelectivePropsFieldForFieldRef(ast.selectiveFields, field) !==
        undefined
    )
      return;
    markFieldRefAsRequired(requiredColumnsByAlias, field);
  });

  if (!hasSelectiveFields) {
    for (const predicate of ast.predicates) {
      markPredicateFieldsAsRequired(
        requiredColumnsByAlias,
        predicate.expression,
      );
    }
  }

  return requiredColumnsByAlias;
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
    case "tuple_comparison": {
      return false;
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
    case "vector_similarity":
    case "fulltext_match": {
      return false;
    }
    case "database_expression_predicate": {
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

  if (ast.groupBy || ast.having || ast.resultPredicate !== undefined) {
    return undefined;
  }

  if (ast.orderBy && ast.orderBy.length > 0) {
    return undefined;
  }

  if (ast.traversals.length < 2) {
    return undefined;
  }

  if (ast.traversals.some((traversal) => traversal.optional)) {
    return undefined;
  }

  if (!isStartAliasBoundToSingleId(ast, predicateIndex)) {
    return undefined;
  }

  const pushdownLimit = Math.min(
    ast.limit * TRAVERSAL_LIMIT_PUSHDOWN_MULTIPLIER,
    TRAVERSAL_LIMIT_PUSHDOWN_MAX,
  );

  return Math.max(ast.limit, pushdownLimit);
}

/** The last CTE carries each whole path only when every traversal extends the prior row. */
function canCollapseLinearTraversalRowset(
  ast: QueryAst,
  vectorPredicate: VectorSimilarityPredicate | undefined,
  fulltextPredicate: FulltextMatchPredicate | undefined,
): boolean {
  if (vectorPredicate !== undefined) {
    return false;
  }

  if (fulltextPredicate !== undefined) {
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

  if (ast.groupBy || ast.having || ast.resultPredicate !== undefined) {
    return false;
  }

  if (
    ast.projection.fields.some(
      (field) =>
        field.source.__type === "aggregate" ||
        (field.source.__type === "database_expression" &&
          expressionContainsAggregate(field.source)),
    )
  ) {
    return false;
  }

  return true;
}

export function shouldMaterializeTraversalCte(
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

type StandardQueryPassState = Readonly<{
  ast: QueryAst;
  collapsedTraversalCteAlias: string | undefined;
  ctx: PredicateCompilerContext;
  effectiveLimit: number | undefined;
  fulltextPredicate: FulltextMatchPredicate | undefined;
  fusion: HybridFusionOptions | undefined;
  logicalPlan: LogicalPlan | undefined;
  predicateIndex: PredicateIndex;
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined;
  shouldCollapseLinearTraversalRowset: boolean;
  temporalFilterPass: TemporalFilterPass | undefined;
  traversalCteLimit: number | undefined;
  vectorPredicate: VectorSimilarityPredicate | undefined;
}>;

export function runStandardQueryPassPipeline(
  ast: QueryAst,
  graphId: string,
  ctx: PredicateCompilerContext,
): StandardQueryPassState {
  let state: StandardQueryPassState = {
    ast,
    collapsedTraversalCteAlias: undefined,
    ctx,
    effectiveLimit: undefined,
    fulltextPredicate: undefined,
    fusion: undefined,
    logicalPlan: undefined,
    predicateIndex: buildPredicateIndex(ast),
    requiredColumnsByAlias: undefined,
    shouldCollapseLinearTraversalRowset: false,
    temporalFilterPass: undefined,
    traversalCteLimit: undefined,
    vectorPredicate: undefined,
  };

  const vectorPass = runCompilerPass(state, {
    name: "vector_predicate",
    execute(currentState): VectorSimilarityPredicate | undefined {
      return runVectorPredicatePass(
        currentState.ast,
        currentState.ctx.dialect,
        currentState.ctx.vectorStrategy,
      ).vectorPredicate;
    },
    update(currentState, vectorPredicate): StandardQueryPassState {
      return {
        ...currentState,
        vectorPredicate,
      };
    },
  });
  state = vectorPass.state;

  const fulltextPass = runCompilerPass(state, {
    name: "fulltext_predicate",
    execute(currentState): FulltextMatchPredicate | undefined {
      return runFulltextPredicatePass(
        currentState.ast,
        currentState.ctx.dialect,
      ).fulltextPredicate;
    },
    update(currentState, fulltextPredicate): StandardQueryPassState {
      return {
        ...currentState,
        fulltextPredicate,
      };
    },
  });
  state = fulltextPass.state;

  assertRecordedQueryDoesNotUseCurrentIndexes(
    state.ast,
    state.vectorPredicate,
    state.fulltextPredicate,
  );

  const fusionPass = runCompilerPass(state, {
    name: "fusion_config",
    execute(currentState): HybridFusionOptions | undefined {
      return runFusionConfigPass(
        currentState.ast,
        currentState.vectorPredicate,
        currentState.fulltextPredicate,
      ).fusion;
    },
    update(currentState, fusion): StandardQueryPassState {
      return {
        ...currentState,
        fusion,
      };
    },
  });
  state = fusionPass.state;

  const temporalPass = runCompilerPass(state, {
    name: "temporal_filters",
    execute(currentState): TemporalFilterPass {
      return createTemporalFilterPass(
        currentState.ast,
        ctx.readInstant,
        ctx.recordedReadBinding,
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

  const selectiveTraversalRowsetPass = runCompilerPass(state, {
    name: "linear_traversal_rowset",
    execute(currentState): Readonly<{
      collapsedTraversalCteAlias: string | undefined;
      shouldCollapseLinearTraversalRowset: boolean;
    }> {
      const shouldCollapseLinearTraversalRowset =
        canCollapseLinearTraversalRowset(
          currentState.ast,
          currentState.vectorPredicate,
          currentState.fulltextPredicate,
        );
      const lastTraversal = currentState.ast.traversals.at(-1);
      const collapsedTraversalCteAlias =
        shouldCollapseLinearTraversalRowset && lastTraversal !== undefined ?
          `cte_${lastTraversal.nodeAlias}`
        : undefined;

      return {
        collapsedTraversalCteAlias,
        shouldCollapseLinearTraversalRowset,
      };
    },
    update(
      currentState,
      { collapsedTraversalCteAlias, shouldCollapseLinearTraversalRowset },
    ): StandardQueryPassState {
      return {
        ...currentState,
        collapsedTraversalCteAlias,
        shouldCollapseLinearTraversalRowset,
      };
    },
  });
  state = selectiveTraversalRowsetPass.state;

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

  // Ranked predicates bound their candidate CTEs independently. The query limit
  // applies to completed match rows after traversal fanout and result filtering.
  state = {
    ...state,
    effectiveLimit: state.ast.limit,
  };

  const logicalPlanPass = runCompilerPass(state, {
    name: "logical_plan",
    execute(currentState): LogicalPlan {
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
        ...(currentState.effectiveLimit === undefined ?
          {}
        : { effectiveLimit: currentState.effectiveLimit }),
        ...(currentState.vectorPredicate === undefined ?
          {}
        : { vectorPredicate: currentState.vectorPredicate }),
        ...(currentState.fulltextPredicate === undefined ?
          {}
        : { fulltextPredicate: currentState.fulltextPredicate }),
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

  return state;
}
