/**
 * AST Builder utilities for query construction.
 *
 * Provides shared functions for building QueryAst objects from builder state.
 */
import { type QueryAst } from "../ast";
import type { QueryBuilderConfig, QueryBuilderState } from "./types";
import { validateVectorPredicatePlacement } from "./validation";

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
  validateVectorPredicatePlacement(state.predicates);

  const temporalMode: { mode: typeof state.temporalMode; asOf?: string } = {
    mode: state.temporalMode,
  };
  if (state.asOf !== undefined) {
    temporalMode.asOf = state.asOf;
  }

  return {
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
    ...(state.orderBy.length > 0 && { orderBy: state.orderBy }),
    ...(state.limit !== undefined && { limit: state.limit }),
    ...(state.offset !== undefined && { offset: state.offset }),
    ...(state.groupBy !== undefined && { groupBy: state.groupBy }),
    ...(state.having !== undefined && { having: state.having }),
  };
}
