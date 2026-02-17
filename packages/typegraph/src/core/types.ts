import { type z } from "zod";

// ============================================================
// Brand Keys for Nominal Typing
// ============================================================

/** Brand key for NodeType */
export const NODE_TYPE_BRAND = "__nodeType" as const;

/** Brand key for EdgeType */
export const EDGE_TYPE_BRAND = "__edgeType" as const;

/** Brand symbol for NodeId */
declare const __nodeId: unique symbol;

// ============================================================
// Node Type
// ============================================================

/**
 * A node type definition.
 *
 * Created via `defineNode()`. Represents a type of node in the graph
 * with an associated Zod schema for properties.
 */
export type NodeType<
  K extends string = string,
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> = Readonly<{
  [NODE_TYPE_BRAND]: true;
  kind: K;
  schema: S;
  description: string | undefined;
}>;

/**
 * Branded node ID type.
 *
 * Prevents mixing IDs from different node types at compile time.
 */
export type NodeId<N extends NodeType> = string &
  Readonly<{
    [__nodeId]: N;
  }>;

/**
 * Infer the props type from a NodeType.
 */
export type NodeProps<N extends NodeType> = z.infer<N["schema"]>;

// ============================================================
// Edge Type
// ============================================================

/**
 * An edge type definition.
 *
 * Created via `defineEdge()`. Represents a type of edge in the graph
 * with an optional Zod schema for properties.
 *
 * Optionally includes `from` and `to` arrays that define the allowed
 * source and target node types (domain and range constraints).
 */
export type EdgeType<
  K extends string = string,
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
  From extends readonly NodeType[] | undefined = undefined,
  To extends readonly NodeType[] | undefined = undefined,
> = Readonly<{
  [EDGE_TYPE_BRAND]: true;
  kind: K;
  schema: S;
  description: string | undefined;
  from: From;
  to: To;
}>;

/**
 * Base edge type for use in constraints - accepts any from/to configuration.
 */
export type AnyEdgeType = EdgeType<
  string,
  z.ZodObject<z.ZodRawShape>,
  readonly NodeType[] | undefined,
  readonly NodeType[] | undefined
>;

/**
 * An edge type that has both from and to constraints defined.
 * Can be used directly in defineGraph without an EdgeRegistration wrapper.
 */
export type EdgeTypeWithEndpoints = EdgeType<
  string,
  z.ZodObject<z.ZodRawShape>,
  readonly NodeType[],
  readonly NodeType[]
>;

/**
 * Infer the props type from an EdgeType.
 */
export type EdgeProps<E extends AnyEdgeType> = z.infer<E["schema"]>;

// ============================================================
// Configuration Types
// ============================================================

/**
 * Delete behaviors for nodes.
 */
export type DeleteBehavior = "restrict" | "cascade" | "disconnect";

/**
 * Edge cardinality constraints.
 */
export type Cardinality =
  | "many" // No constraint (default)
  | "one" // At most one edge of this kind from any source node
  | "unique" // At most one edge of this kind between any (source, target) pair
  | "oneActive"; // At most one edge with valid_to IS NULL from any source

/**
 * Endpoint existence modes for edge validation.
 */
export type EndpointExistence =
  | "notDeleted" // Endpoint deleted_at IS NULL (default)
  | "currentlyValid" // Endpoint not deleted AND temporally valid
  | "ever"; // Endpoint exists in any state

/**
 * Temporal query modes.
 */
export type TemporalMode =
  | "current" // Valid now AND not deleted
  | "asOf" // Valid at specific date AND not deleted
  | "includeEnded" // All validity periods AND not deleted
  | "includeTombstones"; // Everything including soft-deleted

/**
 * Uniqueness constraint scope.
 */
export type UniquenessScope =
  | "kind" // Unique within this exact kind only
  | "kindWithSubClasses"; // Unique across this kind and all subclasses

/**
 * Collation for uniqueness constraints.
 */
export type Collation = "binary" | "caseInsensitive";

// ============================================================
// Uniqueness Constraint
// ============================================================

/**
 * Uniqueness constraint definition.
 */
export type UniqueConstraint<
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> = Readonly<{
  name: string;
  fields: readonly (keyof z.infer<S> & string)[];
  where?: (
    props: UniqueConstraintPredicateBuilder<S>,
  ) => UniqueConstraintPredicate;
  scope: UniquenessScope;
  collation: Collation;
}>;

/**
 * Predicate builder for uniqueness constraint where clause.
 * Uses -? to make all fields required in the builder, even if optional in the schema.
 */
export type UniqueConstraintPredicateBuilder<
  S extends z.ZodObject<z.ZodRawShape>,
> = Readonly<{
  [K in keyof z.infer<S>]-?: UniqueConstraintField;
}>;

/**
 * Field operations for uniqueness constraint predicates.
 */
type UniqueConstraintField = Readonly<{
  isNull: () => UniqueConstraintPredicate;
  isNotNull: () => UniqueConstraintPredicate;
}>;

/**
 * A uniqueness constraint predicate (internal representation).
 */
export type UniqueConstraintPredicate = Readonly<{
  __type: "unique_predicate";
  field: string;
  op: "isNull" | "isNotNull";
}>;

// ============================================================
// Node Registration
// ============================================================

/**
 * Node registration in a graph definition.
 */
export type NodeRegistration<N extends NodeType = NodeType> = Readonly<{
  type: N;
  unique?: readonly UniqueConstraint<N["schema"]>[];
  onDelete?: DeleteBehavior;
}>;

// ============================================================
// Edge Registration
// ============================================================

/**
 * Edge registration in a graph definition.
 */
export type EdgeRegistration<
  E extends AnyEdgeType = AnyEdgeType,
  FromTypes extends NodeType = NodeType,
  ToTypes extends NodeType = NodeType,
> = Readonly<{
  type: E;
  from: readonly FromTypes[];
  to: readonly ToTypes[];
  cardinality?: Cardinality;
  endpointExistence?: EndpointExistence;
}>;

// ============================================================
// Graph Defaults
// ============================================================

/**
 * Default settings for a graph.
 */
export type GraphDefaults = Readonly<{
  onNodeDelete?: DeleteBehavior;
  temporalMode?: TemporalMode;
}>;

// ============================================================
// Type Helpers
// ============================================================

/**
 * Checks if a value is a NodeType.
 */
export function isNodeType(value: unknown): value is NodeType {
  return (
    typeof value === "object" &&
    value !== null &&
    NODE_TYPE_BRAND in value &&
    (value as Record<string, unknown>)[NODE_TYPE_BRAND] === true
  );
}

/**
 * Checks if a value is an EdgeType.
 */
export function isEdgeType(value: unknown): value is AnyEdgeType {
  return (
    typeof value === "object" &&
    value !== null &&
    EDGE_TYPE_BRAND in value &&
    (value as Record<string, unknown>)[EDGE_TYPE_BRAND] === true
  );
}

/**
 * Checks if a value is an EdgeType with both from and to constraints defined.
 * Such edges can be used directly in defineGraph without an EdgeRegistration wrapper.
 */
export function isEdgeTypeWithEndpoints(
  value: unknown,
): value is EdgeTypeWithEndpoints {
  return (
    isEdgeType(value) &&
    Array.isArray(value.from) &&
    value.from.length > 0 &&
    Array.isArray(value.to) &&
    value.to.length > 0
  );
}
