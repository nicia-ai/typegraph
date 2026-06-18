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
  type EmptyAliasMap,
  type EmptyEdgeAliasMap,
  type EmptyRecursiveAliasMap,
  QueryBuilder,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type QueryCoordinateState,
} from "./builder/index";
import {
  type QueryBuilderInternalContext,
  registerQueryBuilderInternalContext,
} from "./builder/internal-context";
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
  countDistinctEdges,
  countEdges,
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
  BatchableQuery,
  BatchResults,
  DynamicEdgeAccessor,
  DynamicEdgeType,
  DynamicFieldBuilder,
  DynamicNodeAccessor,
  DynamicNodeType,
  DynamicSelectableEdge,
  DynamicSelectableNode,
  EdgeAccessor,
  EmptyAliasMap,
  EmptyEdgeAliasMap,
  EmptyRecursiveAliasMap,
  FieldAccessor,
  NodeAccessor,
  NodeAlias,
  PaginatedResult,
  PaginateOptions,
  PropsAccessor,
  QueryCoordinateState,
  RecursiveTraversalOptions,
  SelectableEdge,
  SelectableNode,
  SelectContext,
  StreamOptions,
  TraversalExpansion,
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
type InternalCreateQueryBuilderOptions = CreateQueryBuilderOptions &
  QueryBuilderInternalContext;

export type InitialQueryBuilder<
  G extends GraphDef,
  CoordinateState extends QueryCoordinateState = "open",
> = QueryBuilder<
  G,
  EmptyAliasMap,
  EmptyEdgeAliasMap,
  EmptyRecursiveAliasMap,
  CoordinateState
>;

export function createQueryBuilder<G extends GraphDef>(
  graphId: string,
  registry: KindRegistry,
  options?: CreateQueryBuilderOptions,
): InitialQueryBuilder<G>;
export function createQueryBuilder<G extends GraphDef>(
  graphId: string,
  registry: KindRegistry,
  options?: CreateQueryBuilderOptions,
): InitialQueryBuilder<G> {
  return createQueryBuilderWithContext<G>(graphId, registry, options);
}

export function createInternalQueryBuilder<
  G extends GraphDef,
  CoordinateState extends QueryCoordinateState = "open",
>(
  graphId: string,
  registry: KindRegistry,
  options?: InternalCreateQueryBuilderOptions,
): InitialQueryBuilder<G, CoordinateState> {
  return createQueryBuilderWithContext<G, CoordinateState>(
    graphId,
    registry,
    options,
  );
}

function createQueryBuilderWithContext<
  G extends GraphDef,
  CoordinateState extends QueryCoordinateState = "open",
>(
  graphId: string,
  registry: KindRegistry,
  options?: InternalCreateQueryBuilderOptions,
): InitialQueryBuilder<G, CoordinateState> {
  const schemaIntrospector = createSchemaIntrospector(
    registry.nodeKinds,
    registry.edgeKinds,
  );

  // Build config, only including optional properties if defined
  const config: QueryBuilderConfig = {
    graphId,
    registry,
    schemaIntrospector,
    defaultTraversalExpansion: options?.defaultTraversalExpansion ?? "inverse",
    ...(options?.backend !== undefined && { backend: options.backend }),
    ...(options?.dialect !== undefined && { dialect: options.dialect }),
    ...(options?.schema !== undefined && { schema: options.schema }),
  };
  registerQueryBuilderInternalContext(config, {
    ...(options?.recordedReadBinding !== undefined && {
      recordedReadBinding: options.recordedReadBinding,
    }),
    ...(options?.sealedCoordinate !== undefined && {
      sealedCoordinate: options.sealedCoordinate,
    }),
  });

  // A sealed coordinate (StoreView pin) seeds the temporal axis; `.temporal()`
  // then refuses to override it.
  const sealed = options?.sealedCoordinate?.valid;
  const recorded = options?.sealedCoordinate?.recorded;

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
    temporalMode: sealed?.mode ?? "current",
    asOf: sealed?.asOf,
    recordedAsOf: recorded?.asOf,
    groupBy: undefined,
    having: undefined,
    fusion: undefined,
    dynamicNodeAliases: new Set(),
    dynamicEdgeAliases: new Set(),
  };

  return new QueryBuilder(config, initialState) as InitialQueryBuilder<
    G,
    CoordinateState
  >;
}
