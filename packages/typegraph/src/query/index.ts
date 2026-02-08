/**
 * Query module for TypeGraph.
 *
 * Provides a type-safe, fluent API for building and executing queries.
 */

// ============================================================
// Public Types
// ============================================================

// Core query types users need
export type {
  FieldRef,
  OrderSpec,
  QueryAst,
  SetOperation,
  SortDirection,
  ValueType,
  VariableLengthSpec,
} from "./ast";

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
  SelectableEdge,
  SelectableNode,
  SelectContext,
  StreamOptions,
} from "./builder";

// ============================================================
// Public Functions
// ============================================================

// Predicate helpers for subqueries
export {
  exists,
  fieldRef,
  inSubquery,
  notExists,
  notInSubquery,
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

// Dialect adapters (for advanced users)
export { type DialectAdapter, getDialect, type SqlDialect } from "./dialect";

// Compiler constants
export { MAX_RECURSIVE_DEPTH } from "./compiler/index";
