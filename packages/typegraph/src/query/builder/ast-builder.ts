/**
 * AST Builder utilities for query construction.
 *
 * Provides shared functions for building QueryAst objects from builder state.
 */
import { type QueryAst } from "../ast";
import { getExpressionScope } from "./expression-scope";
import type { QueryBuilderConfig, QueryBuilderState } from "./types";
import {
  validateFulltextPredicatePlacement,
  validateQuerySource,
  validateQueryState,
  validateVectorPredicatePlacement,
} from "./validation";

/**
 * Builds a QueryAst from builder config and state.
 *
 * This is shared by ExecutableQuery and ExecutableAggregateQuery to avoid
 * duplicating the AST construction logic.
 */
export function buildQueryAst(
  config: QueryBuilderConfig,
  state: QueryBuilderState,
): QueryAst {
  validateQuerySource(state, false);
  validateQueryState(state);
  validateVectorPredicatePlacement(state.predicates);
  validateFulltextPredicatePlacement(state.predicates);

  const temporalMode: { mode: typeof state.temporalMode; asOf?: string } = {
    mode: state.temporalMode,
  };
  if (state.asOf !== undefined) {
    temporalMode.asOf = state.asOf;
  }

  return {
    graphId: config.graphId,
    expressionScope: getExpressionScope(config),
    start: {
      alias: state.startAlias,
      kinds: state.startKinds,
      expansion: state.startExpansion,
    },
    traversals: state.traversals,
    predicates: state.predicates,
    ...(state.resultPredicate === undefined ?
      {}
    : { resultPredicate: state.resultPredicate }),
    projection: {
      fields: state.projection,
    },
    temporalMode,
    ...(state.recordedAsOf !== undefined && {
      recordedAsOf: state.recordedAsOf,
    }),
    ...(state.orderBy.length > 0 && { orderBy: state.orderBy }),
    ...(state.limit !== undefined && { limit: state.limit }),
    ...(state.offset !== undefined && { offset: state.offset }),
    ...(state.groupBy !== undefined && { groupBy: state.groupBy }),
    ...(state.having !== undefined && { having: state.having }),
    ...(state.aggregateOrderBy.length > 0 && {
      aggregateOrderBy: state.aggregateOrderBy,
    }),
    ...(state.fusion !== undefined && { fusion: state.fusion }),
  };
}
