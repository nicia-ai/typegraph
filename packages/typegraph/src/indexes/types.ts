import { type z } from "zod";

import { type AnyEdgeType, type EdgeType, type NodeType } from "../core/types";
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
// Partial Index WHERE DSL (portable AST)
// ============================================================

export type IndexWhereOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "notIn";

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
      op: "isNull" | "isNotNull";
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
  | IndexWhereExpression
  | ((where: Builder) => IndexWhereExpression);

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
  fields: readonly IndexFieldInput<z.infer<N["schema"]>>[];
  coveringFields?: readonly IndexFieldInput<z.infer<N["schema"]>>[] | undefined;
  unique?: boolean | undefined;
  name?: string | undefined;
  scope?: IndexScope | undefined;
  where?: IndexWhereInput<NodeIndexWhereBuilder<N>> | undefined;
}>;

export type EdgeIndexDirection = "out" | "in" | "none";

export type EdgeIndexConfig<E extends AnyEdgeType> = Readonly<{
  fields: readonly IndexFieldInput<z.infer<E["schema"]>>[];
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
}>;

export type NodeIndex<N extends NodeType = NodeType> = Readonly<{
  __type: "typegraph_node_index";
  node: N;
  nodeKind: N["name"];
  fields: readonly JsonPointer[];
  fieldValueTypes: readonly (ValueType | undefined)[];
  coveringFields: readonly JsonPointer[];
  coveringFieldValueTypes: readonly (ValueType | undefined)[];
  unique: boolean;
  scope: IndexScope;
  where: IndexWhereExpression | undefined;
  name: string;
}>;

export type EdgeIndex<E extends AnyEdgeType = EdgeType> = Readonly<{
  __type: "typegraph_edge_index";
  edge: E;
  edgeKind: E["name"];
  fields: readonly JsonPointer[];
  fieldValueTypes: readonly (ValueType | undefined)[];
  coveringFields: readonly JsonPointer[];
  coveringFieldValueTypes: readonly (ValueType | undefined)[];
  unique: boolean;
  scope: IndexScope;
  direction: EdgeIndexDirection;
  where: IndexWhereExpression | undefined;
  name: string;
}>;

export type TypeGraphIndex = NodeIndex | EdgeIndex;

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
