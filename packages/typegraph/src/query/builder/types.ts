/**
 * Shared type definitions for the query builder.
 *
 * Contains type definitions used across QueryBuilder, TraversalBuilder,
 * and ExecutableQuery classes.
 */
import { type z } from "zod";

import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { type EmbeddingValue } from "../../core/embedding";
import { type RecordedInstant } from "../../core/temporal";
import {
  type AnyEdgeType,
  type EdgeRegistration,
  type EdgeType,
  type NodeId,
  type NodeType,
  type TemporalMode,
} from "../../core/types";
import { type PolymorphicNodeType } from "../../ontology/types";
import { type KindRegistry } from "../../registry/kind-registry";
import {
  type AggregateOrderSpec,
  type GroupBySpec,
  type HybridFusionOptions,
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
import { type SqlSchema } from "../compiler/schema";
import { type SqlDialect } from "../dialect/types";
import { type JsonPointerInput } from "../json-pointer";
import type {
  FulltextAccessor,
  Predicate,
  SimilarToOptions,
} from "../predicates";
import { type SchemaIntrospector } from "../schema-introspector";
import { type AliasExpansionAxis } from "./alias-expansion";
import {
  type DynamicEdgeAccessor,
  type DynamicNodeAccessor,
  type DynamicSelectableEdge,
  type DynamicSelectableNode,
  type IsDynamicEdgeType,
  type IsDynamicNodeType,
} from "./dynamic";
import type { ArrayNodeKinds, EdgeTargetKinds } from "./edge-target-kinds";

export type { TraversalExpansion } from "../ast";

export type QueryCoordinateState = "open" | "sealed";

// ============================================================
// Batch Query Interface
// ============================================================

/**
 * A query deferred for execution inside a `store.batch()` call.
 *
 * Both `ExecutableQuery` and `UnionableQuery` satisfy this interface.
 * The result type `R` is preserved per-query in the batch return tuple.
 *
 * Deferring costs nothing and saves nothing on its own: `store.batch()` runs
 * each query as its own statement (sometimes two — see `ExecutableQuery`'s
 * `executeOn`), so it does not fold these into a single round trip. Whether
 * they share one connection is up to the adapter, not to
 * `backend.capabilities.execution.interactiveTransactions` — see `store.batch()` for the full cost
 * model.
 */
export type BatchableQuery<R = unknown> = Readonly<{
  executeOn: (
    backend: GraphBackend | TransactionBackend,
  ) => Promise<readonly R[]>;
}>;

/**
 * Maps a tuple of BatchableQuery types to their result types.
 *
 * Given `[BatchableQuery<A>, BatchableQuery<B>]`, produces
 * `[readonly A[], readonly B[]]`.
 */
export type BatchResults<Queries extends readonly BatchableQuery<unknown>[]> = {
  -readonly [K in keyof Queries]: Queries[K] extends BatchableQuery<infer R> ?
    readonly R[]
  : never;
};

// ============================================================
// Edge Target Type Helpers
// ============================================================

/**
 * Extracts the declared target kinds for an edge traversal.
 * Outgoing traversals use the full range of an array or source-dependent map;
 * incoming traversals use the source array.
 */
export type ValidEdgeTargets<
  G extends GraphDef,
  EK extends keyof G["edges"] & string,
  Dir extends TraversalDirection,
> =
  G["edges"][EK] extends EdgeRegistration ?
    // Keep the direct array projection: a generic node schema must not wait
    // for the distributive helper to resolve before its known kind is usable.
    Dir extends "out" ?
      | ArrayNodeKinds<G["edges"][EK]["to"]>
      | EdgeTargetKinds<G["edges"][EK]["to"]>
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
 * True when `G["ontology"]` has lost its `const`-inferred tuple shape — its
 * `length` is the general `number` rather than a tuple's fixed literal
 * count. `defineGraph`'s `const TOntology` normally keeps the array a tuple
 * of positionally typed relations (so {@link SubsumptionAffected} can
 * `Extract` a `to: { kind: K }` literal out of it), but a caller can lose
 * that shape — most commonly by building the relations in a variable
 * annotated `readonly OntologyRelation[]` before passing it to
 * `defineGraph({ ontology })`, the exact pattern the changeset blesses
 * ("code that annotates a relation's result as `OntologyRelation` still
 * compiles unchanged"). `defineGraph`'s own omitted-`ontology` default is
 * the literal empty tuple `readonly []` (`length: 0`), which is NOT erased
 * by this test — only a genuinely unbounded array is.
 */
type OntologyTypeErased<G extends GraphDef> =
  number extends G["ontology"]["length"] ? true : false;

/**
 * Whether kind `K` in graph `G` participates in a `subClassOf`/`equivalentTo`
 * relation that could hand a polymorphic-default query a row of a DIFFERENT
 * concrete kind: `K` is a `subClassOf` target, or `K` is either side of an
 * `equivalentTo`/`sameAs` pair. Direct participation is enough — a kind with
 * a transitive descendant necessarily has a direct one — so this is a single
 * non-recursive `Extract` over `G["ontology"]`, computable with no
 * transitive-closure type engine. `false` (a graph with `ontology: []`, or a
 * kind no relation touches) costs zero type churn.
 *
 * **An {@link OntologyTypeErased} ontology widens conservatively.** Once the
 * tuple has lost its fixed length, every element has necessarily widened to
 * the untyped `OntologyRelation` shape too (a tuple can only lose its length
 * by losing the literal types that made each position distinct), so no
 * per-element `Extract` can rule out a `subClassOf` targeting `K` — without
 * this arm the check would silently answer `false`, an unsound
 * under-widening. This is deliberately scored on the WHOLE array's
 * tuple-ness, not on whether any individual union member happens to be a
 * bare `OntologyRelation`: `broader`, `disjointWith`, `inverseOf` and every
 * other non-C.1 meta-edge helper are typed to return plain `OntologyRelation`
 * by design, so a real tuple that legitimately mixes a typed `subClassOf`
 * with one of those untouched relations (`ontology: [subClassOf(Child,
 * Parent), inverseOf(knows, knows)]`) must NOT trip this arm — the tuple's
 * length is still the literal `2`, and the precise `Extract` test below
 * still finds `subClassOf`'s `to: { kind: K }` literal on its own element.
 */
type SubsumptionAffected<G extends GraphDef, K extends string> =
  OntologyTypeErased<G> extends true ? true
  : [
    Extract<
      G["ontology"][number],
      | { metaEdge: { name: "subClassOf" }; to: { kind: K } }
      | { metaEdge: { name: "equivalentTo" | "sameAs" }; from: { kind: K } }
      | { metaEdge: { name: "equivalentTo" | "sameAs" }; to: { kind: K } }
    >,
  ] extends [never] ?
    false
  : true;

/**
 * The alias type a `from(kind, alias)` call with NO explicit
 * `includeSubClasses` resolves to, under the Q3 polymorphic-by-default
 * axis. `PolymorphicNodeType` only when `K` is actually
 * {@link SubsumptionAffected} — a compile-time subtype guarantee (C.1/C.2)
 * covers the kind's PROPERTIES, never its `kind` discriminant or `NodeId`
 * brand, so a row may come back as a narrower concrete kind whenever the
 * axis can expand at all.
 *
 * **Documented limitation: a `subClassOf` (or registered-kind
 * `equivalentTo`/`sameAs`) added at runtime through `store.evolve()` is
 * invisible to this type.** `evolve()` merges the extension into the LIVE
 * registry but returns `Store<G>` with the compile-time `G` unchanged, so
 * `SubsumptionAffected<G, K>` still evaluates against the graph as it was
 * declared, not as it now runs. A kind that only becomes polymorphic
 * through a runtime extension therefore keeps its narrow, exact-kind alias
 * type here — `from(kind, alias)` types the row as the single compile-time
 * kind even though it may come back as the extension's subclass at
 * runtime, which would let a subtype id round-trip through
 * `store.nodes.<K>.update()` typechecked and silently match nothing. Use
 * `fromDynamic()` (always `PolymorphicNodeType`-typed, §1.4 of the typed-
 * subsumption plan) or `{ includeSubClasses: false }` for a kind a runtime
 * extension subclasses.
 */
export type AliasNodeType<G extends GraphDef, K extends string> =
  SubsumptionAffected<G, K> extends true ?
    PolymorphicNodeType<G["nodes"][K]["type"]>
  : G["nodes"][K]["type"];

/**
 * A map of alias names to their node aliases.
 */
export type AliasMap = Readonly<Record<string, NodeAlias<NodeType, boolean>>>;
export type EmptyAliasMap = Readonly<Record<never, never>>;

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
export type EmptyEdgeAliasMap = Readonly<Record<never, never>>;

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
export type EmptyRecursiveAliasMap = Readonly<Record<never, never>>;

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
export type PropsAccessor<N extends NodeType> = Readonly<
  {
    // Remove optional modifier so optional fields still have accessor methods.
    [K in keyof z.infer<N["schema"]>]-?: FieldAccessor<z.infer<N["schema"]>[K]>;
  }
>;

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
  in: (values: readonly unknown[] | ParameterRef) => Predicate;
  notIn: (values: readonly unknown[] | ParameterRef) => Predicate;
}>;

export type StringFieldAccessor = BaseFieldAccessor &
  Readonly<{
    gt: (value: string | ParameterRef) => Predicate;
    gte: (value: string | ParameterRef) => Predicate;
    lt: (value: string | ParameterRef) => Predicate;
    lte: (value: string | ParameterRef) => Predicate;
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
 * - Fulltext: `n.$fulltext.matches(...)` — throws at query build time if
 *   the node kind has no `searchable()` fields. Exposed at the type
 *   level on every accessor so refinements like
 *   `searchable().min(1)` do not make it disappear.
 *
 * For aliases declared via `fromDynamic` / `toDynamic`, `N` carries the
 * dynamic brand and this resolves to `DynamicNodeAccessor` — schema
 * properties go through a `.field(name)` discriminator.
 */
export type NodeAccessor<N extends NodeType> =
  IsDynamicNodeType<N> extends true ? DynamicNodeAccessor
  : Readonly<{
      id: StringFieldAccessor;
      kind: StringFieldAccessor;
      $fulltext: FulltextAccessor;
    }> &
      PropsAccessor<N>;

/**
 * Creates typed field accessors for an edge kind's properties.
 */
type EdgePropsAccessor<E extends AnyEdgeType> = Readonly<
  {
    // Remove optional modifier so optional fields still have accessor methods.
    [K in keyof z.infer<E["schema"]>]-?: FieldAccessor<z.infer<E["schema"]>[K]>;
  }
>;

/**
 * Edge accessor for predicate building.
 *
 * Properties are available at the top level for ergonomic access:
 * - `e.role` instead of `e.props.role`
 * - System fields: `e.id`, `e.kind`, `e.fromId`, `e.toId`
 *
 * Dynamic-mode counterpart: see `NodeAccessor` for the brand-detection
 * pattern.
 */
export type EdgeAccessor<E extends AnyEdgeType> =
  IsDynamicEdgeType<E> extends true ? DynamicEdgeAccessor
  : Readonly<{
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
 *
 * For aliases declared via `fromDynamic` / `toDynamic` this resolves to
 * `DynamicSelectableNode` — same wire shape, schema properties typed
 * `unknown` for narrowing at the call site.
 *
 * `id` carries the same `NodeId<N>` brand as `Node<N>` (see `store/types.ts`)
 * so a projected id can be passed straight back into `getById`/`getByIds`
 * without a cast.
 */
export type SelectableNode<N extends NodeType> =
  IsDynamicNodeType<N> extends true ? DynamicSelectableNode
  : Readonly<{
      id: NodeId<N>;
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
 *
 * Dynamic-mode counterpart: see `SelectableNode`.
 *
 * `traverse(edgeKind, alias)` defaults to `expand: "inverse"` (see
 * `GraphAlgorithms`/`QueryBuilder.traverse`'s `defaultTraversalExpansion`),
 * which UNIONs in rows for the *registered inverse* edge kind alongside the
 * requested one — `EdgeAlias<E>`'s `E` stays pinned to the single requested
 * kind regardless, so under the default expansion mode the row backing
 * `alias` can genuinely be a different edge kind (with different endpoint
 * kinds and a different props schema — `inverseOf(edgeA, edgeB)` doesn't
 * require `edgeA`/`edgeB` to share a schema) than `E` says. Three distinct
 * consequences follow:
 *
 * - `kind: E["kind"]` is a **literal type that can already be wrong today**
 *   — not a branding gap, a plain type-accuracy gap. It's typed as the
 *   requested kind (e.g. `"manages"`) but the runtime value can be the
 *   inverse kind (e.g. `"managedBy"`); see the `"proves why edge
 *   id/kind/schema props can't be trusted"` test in
 *   `tests/query-execution.test.ts` for a concrete repro. This predates
 *   and is independent of the id/endpoint branding question below.
 * - The flattened `z.infer<E["schema"]>` properties have the same
 *   type-accuracy gap as `kind`, for the same reason: `ctx.e.role` is typed
 *   against the requested kind's schema, but an inverse-branch row's real
 *   props came from a different schema and may not have a `role` field at
 *   all (reading it returns `undefined`, not a type error).
 * - `id`/`fromId`/`toId` stay plain `string`, unlike `SelectableNode`'s
 *   `id: NodeId<N>` — a real ergonomics gap, but not an accuracy one: `string`
 *   never overclaims. Branding them would compile but be actively wrong:
 *   e.g. `store.edges.<E>.getById()` filters on `row.kind !== kind` and
 *   silently returns `undefined` for a mismatched-kind id — worse than the
 *   unsafe cast it would have replaced.
 *
 * Proving any of these safe requires tracking `expand` mode (`"none"` vs
 * not) at the type level through `TraversalBuilder`/`EdgeAlias` — evaluated
 * for #235 and deliberately not built: the machinery would touch every
 * traversal-entry overload for a benefit that only applies when a caller
 * opts out of the default expansion. When you know a traversal is
 * single-kind (e.g. via `expand: "none"`), re-brand `id`/`fromId`/`toId`
 * explicitly with `asNodeId`/`asEdgeId` (see #223) — e.g.
 * `asNodeId<typeof Person>(edge.fromId)` for a `Person -> Company` edge —
 * and don't trust `kind` or schema properties without independently
 * verifying the traversal can't have expanded.
 */
export type SelectableEdge<E extends AnyEdgeType = EdgeType> =
  IsDynamicEdgeType<E> extends true ? DynamicSelectableEdge
  : Readonly<{
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
  /**
   * Store-level default for the `from`/`to`/`fromDynamic`/`toDynamic`
   * subclass-expansion axis when an alias states no `includeSubClasses`
   * (roadmap Q3). `true` (the default everywhere a store doesn't override
   * it) makes a supertype query polymorphic.
   */
  defaultIncludeSubClasses: boolean;
  /** Whether this builder's graph enables Operational Identity. */
  identityEnabled: boolean;
  /** Equal-id behavior used by historical identity traversal compilation. */
  identitySameIdAcrossKinds: "fold" | "ignore";
  backend?: GraphBackend;
  dialect?: SqlDialect;
  /** SQL schema configuration from createSqlSchema(...) for custom table names. */
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
  /** The start alias's resolved expansion axis — see `alias-expansion.ts`. */
  startExpansion: AliasExpansionAxis;
  traversals: readonly Traversal[];
  predicates: readonly NodePredicate[];
  projection: readonly ProjectedField[];
  orderBy: readonly OrderSpec[];
  /** ORDER BY entries added via `ExecutableAggregateQuery.orderBy()`. */
  aggregateOrderBy: readonly AggregateOrderSpec[];
  limit: number | undefined;
  offset: number | undefined;
  temporalMode: TemporalMode;
  asOf: string | undefined;
  recordedAsOf?: RecordedInstant | undefined;
  groupBy: GroupBySpec | undefined;
  having: PredicateExpression | undefined;
  fusion: HybridFusionOptions | undefined;
  /**
   * Aliases declared via `fromDynamic` / `toDynamic`. The accessor
   * factories check membership to decide between typed and dynamic
   * predicate surfaces.
   */
  dynamicNodeAliases: ReadonlySet<string>;
  /** Edge aliases declared via `traverseDynamic` / `optionalTraverseDynamic`. */
  dynamicEdgeAliases: ReadonlySet<string>;
}>;

/**
 * Options for creating a query builder.
 */
export type CreateQueryBuilderOptions = Readonly<{
  /** Backend for query execution */
  backend?: GraphBackend;
  /** SQL dialect for compilation */
  dialect?: SqlDialect;
  /** SQL schema configuration from createSqlSchema(...) for custom table names */
  schema?: SqlSchema;
  /** Default traversal ontology expansion mode (default: "inverse"). */
  defaultTraversalExpansion?: TraversalExpansion;
  /**
   * Default subclass-expansion axis for `from`/`to`/`fromDynamic`/
   * `toDynamic` when an alias states no `includeSubClasses` (default:
   * `true`, roadmap Q3). A store-issued builder threads its own
   * `queryDefaults.includeSubClasses`; a standalone `createQueryBuilder`
   * defaults to `true` too, so a store-less builder and a store-issued one
   * agree.
   */
  defaultIncludeSubClasses?: boolean;
  /**
   * Overrides whether a builder may compile identity-aware traversals
   * (`traverse(..., { includeIdentityMembers: true })`).
   *
   * Defaults to the graph capability carried by `buildKindRegistry(graph)`.
   * Passing `true` with a registry from a graph that does not enable identity
   * throws a `ConfigurationError` instead of producing invalid SQL.
   */
  identityEnabled?: boolean;
  /** Overrides the graph registry's same-id behavior. */
  identitySameIdAcrossKinds?: "fold" | "ignore";
}>;
