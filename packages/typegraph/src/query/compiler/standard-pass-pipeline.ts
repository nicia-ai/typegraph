import type {
  PredicateExpression,
  QueryAst,
  VectorSimilarityPredicate,
} from "../ast";
import { type DialectAdapter } from "../dialect";
import {
  createTemporalFilterPass,
  resolveVectorAwareLimit,
  runCompilerPass,
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
import {
  addRequiredColumn,
  isIdFieldRef,
  markFieldRefAsRequired,
  markSelectiveFieldAsRequired,
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
    (field) => field.source.__type === "aggregate",
  );
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

  addRequiredColumn(requiredColumnsByAlias, ast.start.alias, "id");
  for (const traversal of ast.traversals) {
    addRequiredColumn(requiredColumnsByAlias, traversal.nodeAlias, "id");
  }

  if (ast.selectiveFields && ast.selectiveFields.length > 0) {
    for (const field of ast.selectiveFields) {
      markSelectiveFieldAsRequired(requiredColumnsByAlias, field);
    }
  } else {
    for (const projectedField of ast.projection.fields) {
      const source = projectedField.source;
      if (source.__type === "field_ref") {
        markFieldRefAsRequired(requiredColumnsByAlias, source);
      } else {
        addRequiredColumn(requiredColumnsByAlias, source.field.alias, "id");
        if (
          source.function !== "count" &&
          source.function !== "countDistinct"
        ) {
          markFieldRefAsRequired(requiredColumnsByAlias, source.field);
        }
      }
    }
  }

  if (ast.groupBy) {
    for (const field of ast.groupBy.fields) {
      markFieldRefAsRequired(requiredColumnsByAlias, field);
    }
  }

  if (ast.orderBy) {
    for (const orderSpec of ast.orderBy) {
      markFieldRefAsRequired(requiredColumnsByAlias, orderSpec.field);
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

  if (
    ast.projection.fields.some((field) => field.source.__type === "aggregate")
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
  logicalPlan: LogicalPlan | undefined;
  predicateIndex: PredicateIndex;
  requiredColumnsByAlias: RequiredColumnsByAlias | undefined;
  shouldCollapseSelectiveTraversalRowset: boolean;
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
      return runVectorPredicatePass(currentState.ast, currentState.ctx.dialect)
        .vectorPredicate;
    },
    update(currentState, vectorPredicate): StandardQueryPassState {
      return {
        ...currentState,
        vectorPredicate,
      };
    },
  });
  state = vectorPass.state;

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
      const lastTraversal = currentState.ast.traversals.at(-1);
      const collapsedTraversalCteAlias =
        shouldCollapseSelectiveTraversalRowset && lastTraversal !== undefined ?
          `cte_${lastTraversal.nodeAlias}`
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

  // Compute effectiveLimit once — used by both logical plan lowering and SQL LIMIT/OFFSET.
  state = {
    ...state,
    effectiveLimit: resolveVectorAwareLimit(
      state.ast.limit,
      state.vectorPredicate,
    ),
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
