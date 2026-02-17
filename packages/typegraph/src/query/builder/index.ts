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
setQueryBuilderClass(
  QueryBuilder as unknown as Parameters<typeof setQueryBuilderClass>[0],
);
setUnionableQueryClass(
  UnionableQuery as unknown as Parameters<typeof setUnionableQueryClass>[0],
);

// Classes
export {
  type AggregateResult,
  ExecutableAggregateQuery,
} from "./executable-aggregate-query";
export { ExecutableQuery } from "./executable-query";
export { PreparedQuery } from "./prepared-query";
export { QueryBuilder } from "./query-builder";
export { TraversalBuilder } from "./traversal-builder";
export { UnionableQuery } from "./unionable-query";

// Aggregate helpers
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
  type BooleanFieldAccessor,
  type CreateQueryBuilderOptions,
  type DateFieldAccessor,
  type EdgeAccessor,
  type EmbeddingFieldAccessor,
  type FieldAccessor,
  type NodeAccessor,
  type NodeAlias,
  type NumberFieldAccessor,
  type ObjectFieldAccessor,
  type PaginatedResult,
  type PaginateOptions,
  type PropsAccessor,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type RecursiveAlias,
  type RecursiveAliasMap,
  type RecursiveAliasValue,
  type RecursiveTraversalOptions,
  type SelectableEdge,
  type SelectableNode,
  type SelectContext,
  type StreamOptions,
  type StringFieldAccessor,
  type TraversalExpansion,
  type UniqueAlias,
  type ValidEdgeTargets,
} from "./types";

// Validation utilities
export { validateSqlIdentifier } from "./validation";
