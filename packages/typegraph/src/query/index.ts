/**
 * Query module for TypeGraph.
 *
 * Provides a type-safe, fluent API for building and executing queries.
 */

// ============================================================
// Public Types
// ============================================================

export type { FieldRef, OrderSpec, SortDirection } from "./ast";
export {
  isSqlFragment,
  Placeholder,
  type RenderedSql,
  renderPostgres,
  renderSql,
  renderSqlInline,
  renderSqlite,
  sql,
  type SqlChunk,
  type SqlFragment,
  type SqlIdentifierChunk,
  type SqlParameterChunk,
  type SqlPlaceholderChunk,
  type SqlTag,
  type SqlTextChunk,
} from "./sql-fragment";
export {
  type CompiledRowsSql,
  type CompiledSelectSql,
  type CompiledStatementSql,
  type IntentSql,
  type SqlIntent,
} from "./sql-intent";

// JSON Pointer types (part of nested object API)
export type {
  JsonPointer,
  JsonPointerFor,
  JsonPointerInput,
  JsonPointerSegment,
  JsonPointerSegments,
  JsonPointerSegmentsFor,
  ResolveJsonPointer,
  ResolveJsonPointerSegments,
} from "./json-pointer";

// Builder types users need
export type {
  AliasMap,
  BatchableQuery,
  BatchResults,
  CommonPropertyKeys,
  CompiledOneStatementRead,
  DynamicEdgeAccessor,
  DynamicEdgeType,
  DynamicFieldBuilder,
  DynamicNodeAccessor,
  DynamicNodeKind,
  DynamicNodeType,
  DynamicSelectableEdge,
  DynamicSelectableNode,
  EdgeAccessor,
  EmbeddableOneStatementRead,
  EmptyAliasMap,
  EmptyEdgeAliasMap,
  EmptyRecursiveAliasMap,
  ExecutableOneStatementRead,
  FieldAccessor,
  IdentityTraversalOption,
  InitialQueryBuilder,
  NodeAccessor,
  NodeAlias,
  NodePropsFor,
  OneStatementBatchableQuery,
  OneStatementBatchResults,
  PaginatedResult,
  PaginateOptions,
  PropsAccessor,
  QualifiedRecursivePath,
  QualifiedRecursivePathEdge,
  QualifiedRecursivePathElement,
  QualifiedRecursivePathNode,
  QualifiedRecursivePathOption,
  QueryCoordinateState,
  RecursiveTraversalOptions,
  SelectableEdge,
  SelectableNode,
  SelectContext,
  StreamOptions,
  TraversalExpansion,
} from "./builder";

// ============================================================
// Public Functions
// ============================================================

// Predicate helpers for subqueries and parameterized queries
export {
  exists,
  fieldRef,
  inSubquery,
  isParameterRef,
  notExists,
  notInSubquery,
  param,
  type Predicate,
} from "./predicates";

// JSON Pointer utilities
export {
  joinJsonPointers,
  jsonPointer,
  MAX_JSON_POINTER_DEPTH,
  normalizeJsonPointer,
  parseJsonPointer,
} from "./json-pointer";

// Query Builder (main entry point)
export { createQueryBuilder } from "./builder";

// Query classes
export { type AggregateResult, ExecutableAggregateQuery } from "./builder";
export { ExecutableQuery } from "./builder";
export { QueryBuilder } from "./builder";
export type {
  PreparedBindings,
  PreparedParameterDeclaration,
} from "./builder/prepared-bindings";
export { PreparedQuery } from "./builder/prepared-query";
export {
  ExecutableRelationQuery,
  type RelationColumnContext,
  type RelationProjection,
  type RelationProjectionResult,
} from "./builder/relation";
export { UnionableQuery } from "./builder/unionable-query";

// Aggregate functions
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
} from "./builder";

// Fragment composition
// NOTE: Exported directly from fragment.ts to avoid circular dependency issues
// with the builder/index.ts wiring
export {
  composeFragments,
  createFragment,
  type FlexibleQueryFragment,
  limitFragment,
  offsetFragment,
  orderByFragment,
  type QueryFragment,
  type TraversalFragment,
} from "./builder/fragment";

// SQL dialect type
export type { SqlDialect } from "./dialect";

// Compiler constants
export {
  MAX_EXPLICIT_RECURSIVE_DEPTH,
  MAX_RECURSIVE_DEPTH,
} from "./compiler/index";

// SQL schema configuration
export {
  type DatabaseProjection,
  ExecutableProjectionQuery,
  type ProjectionResult,
} from "./builder/executable-projection-query";
export type {
  ExpressionAliasContext,
  ExpressionValue,
  QueryExpressionContext,
} from "./builder/expression-context";
export type { BatchOnceOptions } from "./builder/one-statement-batch";
export {
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
  type ResolvedSqlTableNames,
  type SqlSchema,
  type SqlTableNames,
} from "./compiler/schema";
export {
  type CollectedRecord,
  type CollectOptions,
  type CollectOrder,
  type CollectRecordFields,
  type CollectRecordOperand,
  type DatabaseExpression,
  expr,
} from "./expressions";
