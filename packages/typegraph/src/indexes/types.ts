import { type z } from "zod";

import {
  type AnyEdgeType,
  type NodeType,
  type NullCheckOp,
} from "../core/types";
import { type ValueType } from "../query/ast";
import {
  type JsonPointer,
  type JsonPointerFor,
  type JsonPointerSegmentsFor,
} from "../query/json-pointer";

// ============================================================
// Scoping
// ============================================================

export type IndexScope =
  /**
   * Prefix index keys with `(graph_id, kind)` (nodes) or `(graph_id, kind)` (edges).
   *
   * This matches TypeGraph queries which always filter on `graph_id` and `kind`
   * (often as `IN (...)` due to ontology expansion).
   */
  | "graphAndKind"
  /**
   * Prefix index keys with `graph_id` only.
   */
  | "graph"
  /**
   * Do not prefix index keys with TypeGraph system columns.
   */
  | "none";

// ============================================================
// Index Access Method
// ============================================================

/**
 * Index access method for relational (node/edge) index declarations.
 *
 * - `"btree"` — the default ordered index over the compiled extraction
 *   expressions; serves equality/range predicates and `orderBy`.
 * - `"gin"` — a PostgreSQL expression GIN over the field's jsonb value
 *   (`jsonb_path_ops`); serves the array containment predicates
 *   (`contains` / `containsAll` / `containsAny` on array fields), which a
 *   btree can never serve. Skipped on SQLite.
 * - `"trigram"` — a PostgreSQL expression GIN over the field's text value
 *   (`gin_trgm_ops`, requires the `pg_trgm` extension); serves substring
 *   and case-insensitive matches (`contains` / `startsWith` / `endsWith` /
 *   `like` / `ilike` on string fields). Skipped on SQLite, whose substring
 *   search story is FTS5 fulltext.
 *
 * `"gin"` and `"trigram"` take exactly one field and reject `unique`,
 * `coveringFields`, and `where`; `scope` (and edge `direction`) prefix
 * columns do not apply — the query's `graph_id` / `kind` equality filters
 * are applied as residual conditions over the index's candidate rows.
 */
export type RelationalIndexMethod = "btree" | "gin" | "trigram";

// ============================================================
// Partial Index WHERE DSL (portable AST)
// ============================================================

export type IndexWhereOp =
  "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn";

export type IndexWhereExpression =
  | Readonly<{
      __type: "index_where_and";
      predicates: readonly IndexWhereExpression[];
    }>
  | Readonly<{
      __type: "index_where_or";
      predicates: readonly IndexWhereExpression[];
    }>
  | Readonly<{
      __type: "index_where_not";
      predicate: IndexWhereExpression;
    }>
  | Readonly<{
      __type: "index_where_comparison";
      left: IndexWhereOperand;
      op: IndexWhereOp;
      right: IndexWhereLiteral | readonly IndexWhereLiteral[];
    }>
  | Readonly<{
      __type: "index_where_null_check";
      operand: IndexWhereOperand;
      op: NullCheckOp;
    }>;

export type IndexWhereOperand =
  | Readonly<{
      __type: "index_operand_system";
      column: SystemColumnName;
      valueType: ValueType | undefined;
    }>
  | Readonly<{
      __type: "index_operand_prop";
      field: string;
      valueType: ValueType | undefined;
    }>;

export type IndexWhereLiteral = Readonly<{
  __type: "index_where_literal";
  value: string | number | boolean;
  valueType: ValueType;
}>;

type IndexWhereComparableValue<T> =
  NonNullable<T> extends string ? string
  : NonNullable<T> extends number ? number
  : NonNullable<T> extends boolean ? boolean
  : NonNullable<T> extends Date ? Date | string
  : never;

export type IndexWhereFieldBuilder<T> = Readonly<{
  eq: (value: IndexWhereComparableValue<T>) => IndexWhereExpression;
  neq: (value: IndexWhereComparableValue<T>) => IndexWhereExpression;
  gt: (value: IndexWhereComparableValue<T>) => IndexWhereExpression;
  gte: (value: IndexWhereComparableValue<T>) => IndexWhereExpression;
  lt: (value: IndexWhereComparableValue<T>) => IndexWhereExpression;
  lte: (value: IndexWhereComparableValue<T>) => IndexWhereExpression;
  in: (values: readonly IndexWhereComparableValue<T>[]) => IndexWhereExpression;
  notIn: (
    values: readonly IndexWhereComparableValue<T>[],
  ) => IndexWhereExpression;
  isNull: () => IndexWhereExpression;
  isNotNull: () => IndexWhereExpression;
}>;

export type NodeIndexWhereBuilder<N extends NodeType> = Readonly<
  {
    graphId: IndexWhereFieldBuilder<string>;
    kind: IndexWhereFieldBuilder<string>;
    id: IndexWhereFieldBuilder<string>;
    deletedAt: IndexWhereFieldBuilder<string | undefined>;
    validFrom: IndexWhereFieldBuilder<string | undefined>;
    validTo: IndexWhereFieldBuilder<string | undefined>;
    createdAt: IndexWhereFieldBuilder<string>;
    updatedAt: IndexWhereFieldBuilder<string>;
    version: IndexWhereFieldBuilder<number>;
  } & {
    [K in keyof z.infer<N["schema"]>]-?: IndexWhereFieldBuilder<
      z.infer<N["schema"]>[K]
    >;
  }
>;

export type EdgeIndexWhereBuilder<E extends AnyEdgeType> = Readonly<
  {
    graphId: IndexWhereFieldBuilder<string>;
    kind: IndexWhereFieldBuilder<string>;
    id: IndexWhereFieldBuilder<string>;
    fromKind: IndexWhereFieldBuilder<string>;
    fromId: IndexWhereFieldBuilder<string>;
    toKind: IndexWhereFieldBuilder<string>;
    toId: IndexWhereFieldBuilder<string>;
    deletedAt: IndexWhereFieldBuilder<string | undefined>;
    validFrom: IndexWhereFieldBuilder<string | undefined>;
    validTo: IndexWhereFieldBuilder<string | undefined>;
    createdAt: IndexWhereFieldBuilder<string>;
    updatedAt: IndexWhereFieldBuilder<string>;
  } & {
    [K in keyof z.infer<E["schema"]>]-?: IndexWhereFieldBuilder<
      z.infer<E["schema"]>[K]
    >;
  }
>;

export type IndexWhereInput<Builder> =
  IndexWhereExpression | ((where: Builder) => IndexWhereExpression);

// ============================================================
// Index Definitions
// ============================================================

type NonEmptyJsonPointerFor<T> = Exclude<JsonPointerFor<T>, "">;

type NonEmptyJsonPointerSegmentsFor<T> = Exclude<
  JsonPointerSegmentsFor<T>,
  readonly []
>;

export type IndexFieldInput<T> =
  | (keyof T & string)
  | NonEmptyJsonPointerFor<T>
  | NonEmptyJsonPointerSegmentsFor<T>
  | JsonPointer;

export type NodeIndexConfig<N extends NodeType> = Readonly<{
  /**
   * Prop-based key fields. May be empty (or omitted) only if
   * `keySystemColumns` supplies at least one key column instead — an
   * index needs at least one of `fields`, `coveringFields`, or
   * `keySystemColumns` to be non-empty.
   */
  fields?: readonly IndexFieldInput<z.infer<N["schema"]>>[] | undefined;
  coveringFields?: readonly IndexFieldInput<z.infer<N["schema"]>>[] | undefined;
  /**
   * System columns (e.g. `"id"`) to include in the index key, positioned
   * after the `scope` prefix and before `fields`/`coveringFields`.
   *
   * Needed when an index must serve a join predicate on a system column
   * TypeGraph's compiled queries filter on directly — e.g. `n.id =
   * e.from_id` — so the index can be used for an index-only scan instead
   * of falling back to a heap fetch per candidate row. Must not repeat a
   * column already implied by `scope`, and must only reference node
   * system columns (`"from_kind"` / `"from_id"` / `"to_kind"` / `"to_id"`
   * are edge-only and are rejected).
   */
  keySystemColumns?: readonly SystemColumnName[] | undefined;
  unique?: boolean | undefined;
  name?: string | undefined;
  scope?: IndexScope | undefined;
  where?: IndexWhereInput<NodeIndexWhereBuilder<N>> | undefined;
  /** Index access method. Default: `"btree"`. See {@link RelationalIndexMethod}. */
  method?: RelationalIndexMethod | undefined;
}>;

export type EdgeIndexDirection = "out" | "in" | "none";

export type EdgeIndexConfig<E extends AnyEdgeType> = Readonly<{
  fields: readonly [
    IndexFieldInput<z.infer<E["schema"]>>,
    ...IndexFieldInput<z.infer<E["schema"]>>[],
  ];
  coveringFields?: readonly IndexFieldInput<z.infer<E["schema"]>>[] | undefined;
  unique?: boolean | undefined;
  name?: string | undefined;
  scope?: IndexScope | undefined;
  /**
   * Optional direction hint to prefix edge indexes with the join key that
   * TypeGraph traversal queries use (`from_id` for out, `to_id` for in).
   */
  direction?: EdgeIndexDirection | undefined;
  where?: IndexWhereInput<EdgeIndexWhereBuilder<E>> | undefined;
  /** Index access method. Default: `"btree"`. See {@link RelationalIndexMethod}. */
  method?: RelationalIndexMethod | undefined;
}>;

// ============================================================
// Index Origin
// ============================================================

/**
 * Where an index declaration originated.
 *
 * - `compile-time`: declared via `defineNodeIndex` / `defineEdgeIndex` and
 *   threaded through `defineGraph({ indexes })`. This is the default and is
 *   omitted from the canonical schema document so legacy graphs hash
 *   byte-identically.
 * - `runtime`: produced by a graph extension. Always emitted explicitly
 *   so the loader can re-route the declaration through the extension
 *   compiler on restart.
 */
export type IndexOrigin = "compile-time" | "runtime";

// ============================================================
// Serializable Index Declaration
// ============================================================

/**
 * Common shape shared by node and edge index declarations.
 *
 * `IndexDeclaration` is the canonical, JSON-serializable representation of
 * an index that flows through `GraphDef.indexes` and
 * `SerializedSchema.indexes`. It carries everything the DDL compiler and
 * the Drizzle schema factories need to generate index SQL — the same
 * value can come from a typed builder (`defineNodeIndex` /
 * `defineEdgeIndex`) or be reconstructed from a graph extension on
 * restart.
 */
type IndexDeclarationBase = Readonly<{
  /** Unique index name (used in DDL and as the diffing identity key). */
  name: string;
  /**
   * Where this declaration originated.
   *
   * `undefined` is the canonical representation of `"compile-time"` —
   * the default origin is omitted from the serialized form so legacy
   * graphs (no `indexes` slice) hash byte-identically with new graphs
   * that declare only compile-time indexes.
   */
  origin?: IndexOrigin;
  fields: readonly JsonPointer[];
  fieldValueTypes: readonly (ValueType | undefined)[];
  coveringFields: readonly JsonPointer[];
  coveringFieldValueTypes: readonly (ValueType | undefined)[];
  unique: boolean;
  scope: IndexScope;
  where: IndexWhereExpression | undefined;
  /**
   * Index access method. Absent means `"btree"` — canonicalized by
   * absence (like `origin`) so serialized declarations and
   * materialization signatures from before this field existed stay
   * byte-identical.
   */
  method?: Exclude<RelationalIndexMethod, "btree">;
}>;

export type NodeIndexDeclaration = IndexDeclarationBase &
  Readonly<{
    entity: "node";
    kind: string;
    /**
     * System columns included in the index key (see
     * {@link NodeIndexConfig.keySystemColumns}). Absent means none —
     * canonicalized by absence like `origin`/`method` so declarations
     * that don't use this stay byte-identical to before it existed.
     */
    keySystemColumns?: readonly SystemColumnName[];
  }>;

export type EdgeIndexDeclaration = IndexDeclarationBase &
  Readonly<{
    entity: "edge";
    kind: string;
    direction: EdgeIndexDirection;
  }>;

/**
 * Distance metric for vector similarity. Mirrors `EmbeddingMetric` from
 * `core/embedding.ts` (re-exported here as part of the index surface).
 */
export type VectorIndexMetric = "cosine" | "l2" | "inner_product";

/**
 * Vector index implementation. `none` is a declarative opt-out: the
 * declaration carries shape metadata for tooling but `materializeIndexes`
 * skips the DDL.
 */
export type VectorIndexImplementation = "hnsw" | "ivfflat" | "none";

/**
 * Vector-index parameters. Concrete defaults are applied at the
 * `embedding(...)` brand boundary; this carries them onto the
 * declaration so the materializer / signature / drift detection have
 * everything they need without re-resolving from the brand.
 */
export type VectorIndexParams = Readonly<{
  /** HNSW: max connections per layer. */
  m: number;
  /** HNSW: build-time search depth. */
  efConstruction: number;
  /** IVFFlat: number of inverted lists. `undefined` when not IVFFlat. */
  lists: number | undefined;
}>;

/**
 * Vector index declaration. Auto-derived from `embedding()` brands at
 * `defineGraph()` time and explicitly buildable via `defineVectorIndex`.
 *
 * Identity key is `(kind, fieldPath)` — v1 allows at most one vector
 * index per (kind, field) pair. The `name` field is generated
 * deterministically from this tuple plus the metric so consumers don't
 * accidentally collide vector index names with relational indexes.
 *
 * `unique` / `scope` / `where` from the relational base are NOT
 * supported on vector — pgvector / sqlite-vec don't implement them.
 */
export type VectorIndexDeclaration = Readonly<{
  entity: "vector";
  /** Index name (also the physical identity key in the materialization status table). */
  name: string;
  origin?: IndexOrigin;
  /** Node kind the embedding lives on. */
  kind: string;
  /** JSON-pointer-style field path for the embedding inside the node's props. */
  fieldPath: string;
  /** Embedding dimensionality. */
  dimensions: number;
  /** Distance metric. */
  metric: VectorIndexMetric;
  /** Index implementation. */
  indexType: VectorIndexImplementation;
  /** Concrete index parameters. */
  indexParams: VectorIndexParams;
}>;

/**
 * Relational subset of `IndexDeclaration` — the variants that emit
 * `CREATE INDEX` DDL via `generateIndexDDL`. Used to narrow input
 * types in the relational DDL / serializer / migration code paths
 * that don't apply to vector indexes (which use a different
 * materialization primitive on the backend).
 */
export type RelationalIndexDeclaration =
  NodeIndexDeclaration | EdgeIndexDeclaration;

/**
 * A serializable index declaration that flows through `GraphDef.indexes`
 * and `SerializedSchema.indexes`.
 *
 * Discriminated by `entity`. Everything is JSON round-trippable so a
 * declaration produced by `defineNodeIndex` and a declaration
 * reconstructed from a stored schema document compile to byte-identical
 * SQL.
 */
export type IndexDeclaration =
  RelationalIndexDeclaration | VectorIndexDeclaration;

// ============================================================
// System Columns
// ============================================================

export type SystemColumnName =
  | "graph_id"
  | "kind"
  | "id"
  | "from_kind"
  | "from_id"
  | "to_kind"
  | "to_id"
  | "deleted_at"
  | "valid_from"
  | "valid_to"
  | "created_at"
  | "updated_at"
  | "version";
