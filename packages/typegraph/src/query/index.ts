/**
 * Query module for TypeGraph.
 *
 * Provides a type-safe, fluent API for building and executing queries.
 */

// ============================================================
// Public Types
// ============================================================

export type { FieldRef, OrderSpec, SortDirection } from "./ast";

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
  EdgeAccessor,
  FieldAccessor,
  NodeAccessor,
  NodeAlias,
  PaginatedResult,
  PaginateOptions,
  PropsAccessor,
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
export { PreparedQuery } from "./builder/prepared-query";
export { UnionableQuery } from "./builder/unionable-query";

// Aggregate functions
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
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
  type SqlSchema,
  type SqlTableNames,
} from "./compiler/schema";
