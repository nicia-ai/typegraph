/**
 * Shared type definitions for the query builder.
 *
 * Contains type definitions used across QueryBuilder, TraversalBuilder,
 * and ExecutableQuery classes.
 */
import { type z } from "zod";

import { type GraphBackend } from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { type EmbeddingValue } from "../../core/embedding";
import {
  type AnyEdgeType,
  type EdgeRegistration,
  type EdgeType,
  type NodeType,
  type TemporalMode,
} from "../../core/types";
import { type KindRegistry } from "../../registry/kind-registry";
import {
  type GroupBySpec,
  type NodePredicate,
  type OrderSpec,
  type ParameterRef,
  type PredicateExpression,
  type ProjectedField,
  type RecursiveCyclePolicy,
  type Traversal,
  type TraversalDirection,
  type TraversalExpansion,
} from "../ast";
import { type SqlDialect, type SqlSchema } from "../compiler/index";
import { type JsonPointerInput } from "../json-pointer";
import type { Predicate, SimilarToOptions } from "../predicates";
import { type SchemaIntrospector } from "../schema-introspector";

export type { TraversalExpansion } from "../ast";

// ============================================================
// Edge Target Type Helpers
// ============================================================

/**
 * Extracts the names of valid target node kinds for an edge traversal.
 *
 * For "out" direction: returns the names of node kinds in the edge's "to" array.
 * For "in" direction: returns the names of node kinds in the edge's "from" array.
 *
 * @example
 * // Given: worksAt: { from: [Person], to: [Company, Organization] }
 * // ValidEdgeTargets<G, "worksAt", "out"> = "Company" | "Organization"
 * // ValidEdgeTargets<G, "worksAt", "in"> = "Person"
 */
export type ValidEdgeTargets<
  G extends GraphDef,
  EK extends keyof G["edges"] & string,
  Dir extends TraversalDirection,
> =
  G["edges"][EK] extends EdgeRegistration ?
    Dir extends "out" ?
      G["edges"][EK]["to"][number]["kind"]
    : G["edges"][EK]["from"][number]["kind"]
  : never;

// ============================================================
// Alias Types
// ============================================================

/**
 * A node alias with its associated type.
 */
export type NodeAlias<
  K extends NodeType = NodeType,
  Optional extends boolean = false,
> = Readonly<{
  type: K;
  alias: string;
  optional: Optional;
}>;

/**
 * A map of alias names to their node aliases.
 */
export type AliasMap = Readonly<Record<string, NodeAlias<NodeType, boolean>>>;

/**
 * An edge alias with its associated type and optional flag.
 */
export type EdgeAlias<
  E extends AnyEdgeType = EdgeType,
  Optional extends boolean = false,
> = Readonly<{
  type: E;
  alias: string;
  optional: Optional;
}>;

/**
 * A map of alias names to their edge aliases.
 */
export type EdgeAliasMap = Readonly<
  Record<string, EdgeAlias<EdgeType, boolean>>
>;

// ============================================================
// Recursive Alias Types
// ============================================================

/**
 * A recursive alias marker with its associated type (depth or path).
 */
export type RecursiveAlias<T extends "depth" | "path"> = Readonly<{ type: T }>;

/**
 * A map of recursive alias names to their types.
 */
export type RecursiveAliasMap = Readonly<
  Record<string, RecursiveAlias<"depth" | "path">>
>;

/**
 * Resolves a recursive alias marker to its runtime value type.
 */
export type RecursiveAliasValue<RA> =
  RA extends RecursiveAlias<"depth"> ? number
  : RA extends RecursiveAlias<"path"> ? readonly string[]
  : never;

/**
 * Resolves the depth alias name from the recursive config.
 * If a string is provided, uses it directly. If `true`, defaults to `${A}_depth`.
 */
type ResolveDepthAlias<DC, A extends string> =
  DC extends string ? DC
  : DC extends true ? `${A}_depth`
  : never;

/**
 * Resolves the path alias name from the recursive config.
 * If a string is provided, uses it directly. If `true`, defaults to `${A}_path`.
 */
type ResolvePathAlias<PC, A extends string> =
  PC extends string ? PC
  : PC extends true ? `${A}_path`
  : never;

/**
 * Builds the recursive alias map from depth/path config and target node alias.
 */
/* eslint-disable @typescript-eslint/no-empty-object-type -- Empty when depth/path config is false */
export type BuildRecursiveAliases<DC, PC, A extends string> = ([DC] extends (
  [false]
) ?
  {}
: Record<ResolveDepthAlias<DC, A>, RecursiveAlias<"depth">>) &
  ([PC] extends [false] ? {}
  : Record<ResolvePathAlias<PC, A>, RecursiveAlias<"path">>);
/* eslint-enable @typescript-eslint/no-empty-object-type */

/**
 * Type utility for compile-time alias collision detection.
 *
 * When A already exists in Aliases, this resolves to an error message type
 * that will cause a type error with a descriptive message.
 */
export type UniqueAlias<A extends string, Aliases extends AliasMap> =
  A extends keyof Aliases ? `Error: Alias '${A}' is already in use` : A;

// ============================================================
// Field Accessor Types
// ============================================================

/**
 * Creates typed field accessors for a node kind's properties.
 */
export type PropsAccessor<N extends NodeType> = Readonly<{
  // Remove optional modifier so optional fields still have accessor methods.
  [K in keyof z.infer<N["schema"]>]-?: FieldAccessor<z.infer<N["schema"]>[K]>;
}>;

/**
 * A field accessor with type-appropriate predicate methods.
 * Uses NonNullable to handle optional fields correctly.
 */
export type FieldAccessor<T> = FieldAccessorForType<NonNullable<T>>;

type FieldAccessorForType<T> =
  [T] extends [EmbeddingValue] ? EmbeddingFieldAccessor
  : [T] extends [string] ? StringFieldAccessor
  : [T] extends [number] ? NumberFieldAccessor
  : [T] extends [boolean] ? BooleanFieldAccessor
  : [T] extends [Date] ? DateFieldAccessor
  : [T] extends [readonly (infer U)[]] ? ArrayFieldAccessor<U>
  : [T] extends [Record<string, unknown>] ? ObjectFieldAccessor<T>
  : BaseFieldAccessor;

export type BaseFieldAccessor = Readonly<{
  eq: (value: unknown) => Predicate;
  neq: (value: unknown) => Predicate;
  isNull: () => Predicate;
  isNotNull: () => Predicate;
  in: (values: readonly unknown[]) => Predicate;
  notIn: (values: readonly unknown[]) => Predicate;
}>;

export type StringFieldAccessor = BaseFieldAccessor &
  Readonly<{
    contains: (pattern: string | ParameterRef) => Predicate;
    startsWith: (pattern: string | ParameterRef) => Predicate;
    endsWith: (pattern: string | ParameterRef) => Predicate;
    like: (pattern: string | ParameterRef) => Predicate;
    ilike: (pattern: string | ParameterRef) => Predicate;
  }>;

export type NumberFieldAccessor = BaseFieldAccessor &
  Readonly<{
    gt: (value: number | ParameterRef) => Predicate;
    gte: (value: number | ParameterRef) => Predicate;
    lt: (value: number | ParameterRef) => Predicate;
    lte: (value: number | ParameterRef) => Predicate;
    between: (
      lower: number | ParameterRef,
      upper: number | ParameterRef,
    ) => Predicate;
  }>;

export type BooleanFieldAccessor = BaseFieldAccessor;

export type DateFieldAccessor = BaseFieldAccessor &
  Readonly<{
    gt: (value: Date | string | ParameterRef) => Predicate;
    gte: (value: Date | string | ParameterRef) => Predicate;
    lt: (value: Date | string | ParameterRef) => Predicate;
    lte: (value: Date | string | ParameterRef) => Predicate;
    between: (
      lower: Date | string | ParameterRef,
      upper: Date | string | ParameterRef,
    ) => Predicate;
  }>;

export type ArrayFieldAccessor<U> = BaseFieldAccessor &
  Readonly<{
    contains: (value: U) => Predicate;
    containsAny: (values: readonly U[]) => Predicate;
    containsAll: (values: readonly U[]) => Predicate;
    length: NumberFieldAccessor;
    isEmpty: () => Predicate;
    isNotEmpty: () => Predicate;
    lengthEq: (length: number) => Predicate;
    lengthGt: (length: number) => Predicate;
    lengthGte: (length: number) => Predicate;
    lengthLt: (length: number) => Predicate;
    lengthLte: (length: number) => Predicate;
  }>;

export type EmbeddingFieldAccessor = BaseFieldAccessor &
  Readonly<{
    /**
     * Finds the k most similar items using vector similarity.
     *
     * @param queryEmbedding - The query vector to compare against
     * @param k - Maximum number of results to return
     * @param options - Optional metric and minimum score filter
     */
    similarTo: (
      queryEmbedding: readonly number[],
      k: number,
      options?: SimilarToOptions,
    ) => Predicate;
  }>;

export type ObjectFieldAccessor<T> = BaseFieldAccessor &
  Readonly<{
    get: <K extends keyof T & string>(
      key: K,
    ) => T[K] extends Record<string, unknown> ? ObjectFieldAccessor<T[K]>
    : FieldAccessor<T[K]>;
    hasKey: (key: string) => Predicate;
    hasPath: <P extends JsonPointerInput<T>>(pointer: P) => Predicate;
    pathEquals: <P extends JsonPointerInput<T>>(
      pointer: P,
      value: string | number | boolean | Date,
    ) => Predicate;
    pathContains: <P extends JsonPointerInput<T>>(
      pointer: P,
      value: string | number | boolean | Date,
    ) => Predicate;
    pathIsNull: <P extends JsonPointerInput<T>>(pointer: P) => Predicate;
    pathIsNotNull: <P extends JsonPointerInput<T>>(pointer: P) => Predicate;
  }>;

/**
 * Node accessor for predicate building.
 *
 * Properties are available at the top level for ergonomic access:
 * - `n.name` instead of `n.props.name`
 * - System fields: `n.id`, `n.kind`
 */
export type NodeAccessor<N extends NodeType> = Readonly<{
  id: StringFieldAccessor;
  kind: StringFieldAccessor;
}> &
  PropsAccessor<N>;

/**
 * Creates typed field accessors for an edge kind's properties.
 */
type EdgePropsAccessor<E extends AnyEdgeType> = Readonly<{
  // Remove optional modifier so optional fields still have accessor methods.
  [K in keyof z.infer<E["schema"]>]-?: FieldAccessor<z.infer<E["schema"]>[K]>;
}>;

/**
 * Edge accessor for predicate building.
 *
 * Properties are available at the top level for ergonomic access:
 * - `e.role` instead of `e.props.role`
 * - System fields: `e.id`, `e.kind`, `e.fromId`, `e.toId`
 */
export type EdgeAccessor<E extends AnyEdgeType> = Readonly<{
  id: StringFieldAccessor;
  kind: StringFieldAccessor;
  fromId: StringFieldAccessor;
  toId: StringFieldAccessor;
}> &
  EdgePropsAccessor<E>;

// ============================================================
// Selection Types
// ============================================================

/**
 * Metadata for a selectable node result.
 */
export type SelectableNodeMeta = Readonly<{
  version: number;
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}>;

/**
 * A selectable node result.
 *
 * Properties from the schema are spread at the top level for ergonomic access:
 * - `node.name` instead of `node.props.name`
 * - System metadata is under `node.meta.*`
 */
export type SelectableNode<N extends NodeType> = Readonly<{
  id: string;
  kind: N["kind"];
  meta: SelectableNodeMeta;
}> &
  Readonly<z.infer<N["schema"]>>;

/**
 * Metadata for a selectable edge result.
 */
export type SelectableEdgeMeta = Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | undefined;
}>;

/**
 * A selectable edge result.
 *
 * Properties from the schema are spread at the top level for ergonomic access:
 * - `edge.role` instead of `edge.props.role`
 * - System metadata is under `edge.meta.*`
 */
export type SelectableEdge<E extends AnyEdgeType = EdgeType> = Readonly<{
  id: string;
  kind: E["kind"];
  fromId: string;
  toId: string;
  meta: SelectableEdgeMeta;
}> &
  Readonly<z.infer<E["schema"]>>;

/**
 * Selection context passed to select callback.
 *
 * Includes node aliases, edge aliases, and recursive metadata aliases
 * (depth/path from variable-length traversals). Edge aliases from optional
 * traversals are nullable.
 */
export type SelectContext<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap = Record<string, never>,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty when no recursive aliases
  RecursiveAliases extends RecursiveAliasMap = {},
> = Readonly<{
  [A in keyof Aliases]: Aliases[A]["optional"] extends true ?
    SelectableNode<Aliases[A]["type"]> | undefined
  : SelectableNode<Aliases[A]["type"]>;
}> &
  Readonly<{
    [EA in keyof EdgeAliases]: EdgeAliases[EA]["optional"] extends true ?
      SelectableEdge<EdgeAliases[EA]["type"]> | undefined
    : SelectableEdge<EdgeAliases[EA]["type"]>;
  }> &
  Readonly<{
    [RA in keyof RecursiveAliases]: RecursiveAliasValue<RecursiveAliases[RA]>;
  }>;

// ============================================================
// Pagination Types
// ============================================================

/**
 * Result of a paginated query.
 */
export type PaginatedResult<R> = Readonly<{
  /** The data items for this page */
  data: readonly R[];
  /** Cursor to fetch the next page (undefined if no more pages) */
  nextCursor: string | undefined;
  /** Cursor to fetch the previous page (undefined if on first page) */
  prevCursor: string | undefined;
  /** Whether there are more items after this page */
  hasNextPage: boolean;
  /** Whether there are items before this page */
  hasPrevPage: boolean;
}>;

/**
 * Options for cursor-based pagination.
 *
 * Use `first`/`after` for forward pagination, `last`/`before` for backward.
 */
export type PaginateOptions = Readonly<{
  /** Number of items to fetch (forward pagination) */
  first?: number;
  /** Cursor to start after (forward pagination) */
  after?: string;
  /** Number of items to fetch (backward pagination) */
  last?: number;
  /** Cursor to start before (backward pagination) */
  before?: string;
}>;

/**
 * Options for streaming results.
 */
export type StreamOptions = Readonly<{
  /** Number of items to fetch per batch (default: 1000) */
  batchSize?: number;
}>;

/**
 * Options for recursive traversals.
 */
export type RecursiveTraversalOptions = Readonly<{
  /** Minimum number of hops before including results (default: 1) */
  minHops?: number;
  /** Maximum number of hops (-1 means unlimited) */
  maxHops?: number;
  /** Cycle handling policy (default: "prevent") */
  cyclePolicy?: RecursiveCyclePolicy;
  /** Include path in output. Pass a string to customize alias. */
  path?: boolean | string;
  /** Include depth in output. Pass a string to customize alias. */
  depth?: boolean | string;
}>;

// ============================================================
// Configuration Types
// ============================================================

/**
 * Configuration for the query builder.
 */
export type QueryBuilderConfig = Readonly<{
  graphId: string;
  registry: KindRegistry;
  schemaIntrospector: SchemaIntrospector;
  /** Default traversal ontology expansion mode. */
  defaultTraversalExpansion: TraversalExpansion;
  backend?: GraphBackend;
  dialect?: SqlDialect;
  /** SQL schema configuration for custom table names. */
  schema?: SqlSchema;
}>;

/**
 * Internal state of the query builder.
 */
export type QueryBuilderState = Readonly<{
  startAlias: string;
  startKinds: readonly string[];
  /** The current alias (last traversal target, or startAlias if no traversals) */
  currentAlias: string;
  includeSubClasses: boolean;
  traversals: readonly Traversal[];
  predicates: readonly NodePredicate[];
  projection: readonly ProjectedField[];
  orderBy: readonly OrderSpec[];
  limit: number | undefined;
  offset: number | undefined;
  temporalMode: TemporalMode;
  asOf: string | undefined;
  groupBy: GroupBySpec | undefined;
  having: PredicateExpression | undefined;
}>;

/**
 * Options for creating a query builder.
 */
export type CreateQueryBuilderOptions = Readonly<{
  /** Backend for query execution */
  backend?: GraphBackend;
  /** SQL dialect for compilation */
  dialect?: SqlDialect;
  /** SQL schema configuration for custom table names */
  schema?: SqlSchema;
  /** Default traversal ontology expansion mode (default: "inverse"). */
  defaultTraversalExpansion?: TraversalExpansion;
}>;
