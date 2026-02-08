/**
 * Fluent query builder for TypeGraph.
 *
 * Provides a type-safe, chainable API for building queries.
 * Each method returns a new builder instance with expanded type information.
 *
 * This module re-exports from the builder submodules and provides the
 * createQueryBuilder factory function.
 */
import { type GraphDef } from "../core/define-graph";
import { type KindRegistry } from "../registry/kind-registry";
import {
  type CreateQueryBuilderOptions,
  QueryBuilder,
  type QueryBuilderConfig,
  type QueryBuilderState,
} from "./builder/index";
import { createSchemaIntrospector } from "./schema-introspector";

// Re-export all classes
export {
  ExecutableAggregateQuery,
  ExecutableQuery,
  QueryBuilder,
} from "./builder/index";

// Re-export aggregate helpers
export {
  avg,
  count,
  countDistinct,
  field,
  having,
  havingEq,
  havingGt,
  havingGte,
  havingLt,
  havingLte,
  max,
  min,
  sum,
} from "./builder/index";

// Re-export types
export type {
  AggregateResult,
  AliasMap,
  EdgeAccessor,
  FieldAccessor,
  NodeAccessor,
  NodeAlias,
  PaginatedResult,
  PaginateOptions,
  PropsAccessor,
  SelectableEdge,
  SelectableNode,
  SelectContext,
  StreamOptions,
} from "./builder/index";

// ============================================================
// Factory Function
// ============================================================

/**
 * Creates a new query builder for a graph.
 *
 * @param graphId - The graph identifier
 * @param registry - The kind registry for ontology lookups
 * @param options - Optional backend and dialect configuration
 * @returns A new QueryBuilder instance
 *
 * @example
 * ```typescript
 * // Without execution capability (compile only)
 * const builder = createQueryBuilder<MyGraph>("my_graph", registry);
 *
 * // With execution capability
 * const builder = createQueryBuilder<MyGraph>("my_graph", registry, {
 *   backend: myBackend,
 *   dialect: "sqlite",
 * });
 * ```
 */
export function createQueryBuilder<G extends GraphDef>(
  graphId: string,
  registry: KindRegistry,
  options?: CreateQueryBuilderOptions,
): QueryBuilder<G> {
  const schemaIntrospector = createSchemaIntrospector(
    registry.nodeKinds,
    registry.edgeKinds,
  );

  // Build config, only including optional properties if defined
  const config: QueryBuilderConfig = {
    graphId,
    registry,
    schemaIntrospector,
    ...(options?.backend !== undefined && { backend: options.backend }),
    ...(options?.dialect !== undefined && { dialect: options.dialect }),
    ...(options?.schema !== undefined && { schema: options.schema }),
  };

  const initialState: QueryBuilderState = {
    startAlias: "",
    currentAlias: "",
    startKinds: [],
    includeSubClasses: false,
    traversals: [],
    predicates: [],
    projection: [],
    orderBy: [],
    limit: undefined,
    offset: undefined,
    temporalMode: "current",
    asOf: undefined,
    groupBy: undefined,
    having: undefined,
  };

  return new QueryBuilder(config, initialState);
}
