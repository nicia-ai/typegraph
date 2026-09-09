/**
 * Query Builder Module
 *
 * Re-exports from the builder submodules for clean imports.
 * Also wires up circular dependencies between classes.
 */

// Import classes for circular dependency wiring
import { setUnionableQueryClass } from "./executable-query";
import { QueryBuilder } from "./query-builder";
import { setQueryBuilderClass } from "./traversal-builder";
import { UnionableQuery } from "./unionable-query";

// Wire up circular dependencies.
// Type assertions are needed because the circular dependency resolution
// requires passing classes that TypeScript can't verify at module init time.
setQueryBuilderClass(QueryBuilder);
setUnionableQueryClass(UnionableQuery);

// Classes
export {
  type AggregateResult,
  ExecutableAggregateQuery,
} from "./executable-aggregate-query";
export { ExecutableQuery } from "./executable-query";
export { executeOneStatementBatch } from "./one-statement-batch";
export { PreparedQuery } from "./prepared-query";
export {
  type CompositionNavigationOptions,
  type IdentityTraversalOption,
  QueryBuilder,
} from "./query-builder";
export {
  createExecutableRelation,
  createProjectionRelation,
  ExecutableRelationQuery,
  type RelationColumnContext,
  type RelationDefinition,
  type RelationProjection,
  type RelationProjectionResult,
  type RelationProvenance,
  type TopPerPartitionOptions,
  type TopPerPartitionOrder,
} from "./relation";
export { TraversalBuilder } from "./traversal-builder";
export { UnionableQuery } from "./unionable-query";

// Aggregate helpers
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
} from "./aggregates";

// Fragment composition
export {
  composeFragments,
  createFragment,
  type FlexibleQueryFragment,
  limitFragment,
  offsetFragment,
  orderByFragment,
  type QueryFragment,
  type TraversalFragment,
} from "./fragment";

// AST building utilities
export { buildQueryAst } from "./ast-builder";

// Types
export {
  type AliasMap,
  type ArrayFieldAccessor,
  type BaseFieldAccessor,
  type BatchableQuery,
  type BatchResults,
  type BooleanFieldAccessor,
  type CommonPropertyKeys,
  type CompiledOneStatementRead,
  type CreateQueryBuilderOptions,
  type DateFieldAccessor,
  type EdgeAccessor,
  type EmbeddableOneStatementRead,
  type EmbeddingFieldAccessor,
  type EmptyAliasMap,
  type EmptyEdgeAliasMap,
  type EmptyRecursiveAliasMap,
  type ExecutableOneStatementRead,
  type FieldAccessor,
  type NodeAccessor,
  type NodeAlias,
  type NodeCandidateQuery,
  type NodeCandidateSelection,
  type NodePropsFor,
  type NumberFieldAccessor,
  type ObjectFieldAccessor,
  type OneStatementBatchableQuery,
  type OneStatementBatchReads,
  type OneStatementBatchResults,
  type PaginatedResult,
  type PaginateOptions,
  type PropsAccessor,
  type QualifiedRecursivePath,
  type QualifiedRecursivePathEdge,
  type QualifiedRecursivePathElement,
  type QualifiedRecursivePathNode,
  type QualifiedRecursivePathOption,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type QueryCoordinateState,
  type RecursiveAlias,
  type RecursiveAliasMap,
  type RecursiveAliasValue,
  type RecursiveTraversalOptions,
  type SelectableEdge,
  type SelectableEdgeMeta,
  type SelectableNode,
  type SelectableNodeMeta,
  type SelectContext,
  type StreamOptions,
  type StringFieldAccessor,
  type TraversalExpansion,
  type UniqueAlias,
  type ValidEdgeTargets,
} from "./types";

// Dynamic (string-keyed) builder types
export {
  type DynamicEdgeAccessor,
  type DynamicEdgeType,
  type DynamicFieldBuilder,
  type DynamicNodeAccessor,
  type DynamicNodeKind,
  type DynamicNodeType,
  type DynamicSelectableEdge,
  type DynamicSelectableNode,
} from "./dynamic";

// Validation utilities
export type { BatchOnceOptions } from "./one-statement-batch";
export { validateSqlIdentifier } from "./validation";
