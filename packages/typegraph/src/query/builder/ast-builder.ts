/**
 * AST Builder utilities for query construction.
 *
 * Provides shared functions for building QueryAst objects from builder state.
 */
import {
  type GroupBySpec,
  type OrderSpec,
  type PredicateExpression,
  type QueryAst,
} from "../ast";
import type { QueryBuilderConfig, QueryBuilderState } from "./types";

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
  const temporalMode: { mode: typeof state.temporalMode; asOf?: string } = {
    mode: state.temporalMode,
  };
  if (state.asOf !== undefined) {
    temporalMode.asOf = state.asOf;
  }

  const ast: QueryAst = {
    graphId: config.graphId,
    start: {
      alias: state.startAlias,
      kinds: state.startKinds,
      includeSubClasses: state.includeSubClasses,
    },
    traversals: state.traversals,
    predicates: state.predicates,
    projection: {
      fields: state.projection,
    },
    temporalMode,
  };

  // Add optional fields conditionally
  if (state.orderBy.length > 0) {
    (ast as { orderBy?: readonly OrderSpec[] }).orderBy = state.orderBy;
  }
  if (state.limit !== undefined) {
    (ast as { limit?: number }).limit = state.limit;
  }
  if (state.offset !== undefined) {
    (ast as { offset?: number }).offset = state.offset;
  }
  if (state.groupBy !== undefined) {
    (ast as { groupBy?: GroupBySpec }).groupBy = state.groupBy;
  }
  if (state.having !== undefined) {
    (ast as { having?: PredicateExpression }).having = state.having;
  }

  return ast;
}
