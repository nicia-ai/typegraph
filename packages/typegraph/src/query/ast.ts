/**
 * Query AST types.
 *
 * Defines the abstract syntax tree for TypeGraph queries.
 * This portable representation can be compiled to SQL (today)
 * or other query languages (Cypher, SPARQL) in the future.
 */
import { type TemporalMode } from "../core/types";
import { type JsonPointer } from "./json-pointer";

// ============================================================
// Predicate Expressions
// ============================================================

/**
 * A field reference in a predicate.
 */
export type FieldRef = Readonly<{
  __type: "field_ref";
  alias: string;
  path: readonly string[]; // ["props", "name"] or ["id"]
  jsonPointer?: JsonPointer | undefined; // JSON Pointer into props
  valueType?: ValueType | undefined;
  elementType?: ValueType | undefined;
}>;

/**
 * A literal value in a predicate.
 */
export type LiteralValue = Readonly<{
  __type: "literal";
  value: string | number | boolean;
  valueType?: ValueType | undefined;
}>;

/**
 * A parameter reference for prepared queries.
 *
 * Used in place of a literal value to create parameterized queries
 * that can be executed multiple times with different bindings.
 */
export type ParameterRef = Readonly<{
  __type: "parameter";
  name: string;
  valueType?: ValueType | undefined;
}>;

/**
 * Supported value types for predicates.
 */
export type ValueType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "array"
  | "object"
  | "embedding"
  | "unknown";

/**
 * Comparison operators.
 */
export type ComparisonOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "notIn";

/**
 * String operators.
 */
export type StringOp =
  | "contains"
  | "startsWith"
  | "endsWith"
  | "like"
  | "ilike";

/**
 * A comparison predicate.
 */
export type ComparisonPredicate = Readonly<{
  __type: "comparison";
  op: ComparisonOp;
  left: FieldRef;
  right: LiteralValue | LiteralValue[] | ParameterRef;
}>;

/**
 * A string predicate.
 */
export type StringPredicate = Readonly<{
  __type: "string_op";
  op: StringOp;
  field: FieldRef;
  pattern: string | ParameterRef;
}>;

/**
 * A null check predicate.
 */
export type NullPredicate = Readonly<{
  __type: "null_check";
  op: "isNull" | "isNotNull";
  field: FieldRef;
}>;

/**
 * A between predicate.
 */
export type BetweenPredicate = Readonly<{
  __type: "between";
  field: FieldRef;
  lower: LiteralValue | ParameterRef;
  upper: LiteralValue | ParameterRef;
}>;

// ============================================================
// Array Predicates
// ============================================================

/**
 * Array operators.
 */
export type ArrayOp =
  | "contains" // Array contains a single value
  | "containsAll" // Array contains all specified values
  | "containsAny" // Array contains any of the specified values (overlaps)
  | "isEmpty" // Array is empty
  | "isNotEmpty" // Array is not empty
  | "lengthEq" // Array length equals
  | "lengthGt" // Array length greater than
  | "lengthGte" // Array length greater than or equal
  | "lengthLt" // Array length less than
  | "lengthLte"; // Array length less than or equal

/**
 * An array predicate.
 */
export type ArrayPredicate = Readonly<{
  __type: "array_op";
  op: ArrayOp;
  field: FieldRef;
  values?: readonly LiteralValue[]; // For contains/containsAll/containsAny
  length?: number; // For length comparisons
}>;

// ============================================================
// Object/JSON Predicates
// ============================================================

/**
 * Object operators.
 */
export type ObjectOp =
  | "hasKey" // Object has a specific key at root level
  | "hasPath" // Object has a nested path
  | "pathEquals" // Value at path equals
  | "pathContains" // Value at path contains (for nested arrays)
  | "pathIsNull" // Value at path is null
  | "pathIsNotNull"; // Value at path is not null

/**
 * An object/JSON predicate.
 */
export type ObjectPredicate = Readonly<{
  __type: "object_op";
  op: ObjectOp;
  field: FieldRef;
  pointer: JsonPointer; // Relative JSON Pointer
  value?: LiteralValue; // For pathEquals, pathContains
  valueType?: ValueType;
  elementType?: ValueType;
}>;

/**
 * Logical AND predicate.
 */
type AndPredicate = Readonly<{
  __type: "and";
  predicates: readonly PredicateExpression[];
}>;

/**
 * Logical OR predicate.
 */
type OrPredicate = Readonly<{
  __type: "or";
  predicates: readonly PredicateExpression[];
}>;

/**
 * Logical NOT predicate.
 */
type NotPredicate = Readonly<{
  __type: "not";
  predicate: PredicateExpression;
}>;

/**
 * An aggregate comparison predicate (for HAVING clauses).
 */
export type AggregateComparisonPredicate = Readonly<{
  __type: "aggregate_comparison";
  op: ComparisonOp;
  aggregate: AggregateExpr;
  value: LiteralValue;
}>;

// ============================================================
// Subquery Predicates
// ============================================================

/**
 * An EXISTS subquery predicate.
 * Tests whether the subquery returns any rows.
 */
export type ExistsSubquery = Readonly<{
  __type: "exists";
  subquery: QueryAst;
  negated: boolean; // for NOT EXISTS
}>;

/**
 * An IN subquery predicate.
 * Tests whether a field value is in the subquery results.
 */
export type InSubquery = Readonly<{
  __type: "in_subquery";
  field: FieldRef;
  subquery: QueryAst;
  negated: boolean; // for NOT IN
}>;

// ============================================================
// Vector Predicates
// ============================================================

/**
 * Vector similarity metric types.
 */
export type VectorMetricType = "cosine" | "l2" | "inner_product";

/**
 * A vector similarity predicate.
 * Finds nodes with embeddings similar to the query embedding.
 *
 * This predicate affects query execution by:
 * - Joining with the embeddings table
 * - Adding ORDER BY distance (ascending)
 * - Applying LIMIT (top k results)
 * - Optionally filtering by minimum score
 */
export type VectorSimilarityPredicate = Readonly<{
  __type: "vector_similarity";
  /** The embedding field reference */
  field: FieldRef;
  /** The query embedding to compare against */
  queryEmbedding: readonly number[];
  /** Similarity metric to use */
  metric: VectorMetricType;
  /** Maximum number of results to return */
  limit: number;
  /** Optional minimum similarity score (0-1 for cosine) */
  minScore?: number;
}>;

// ============================================================
// Fulltext Predicates
// ============================================================

import type { FulltextQueryMode } from "../backend/types";

/**
 * A fulltext MATCH predicate.
 *
 * Finds nodes whose combined searchable content matches the query. Affects
 * query execution by joining with the fulltext table, adding an ORDER BY
 * on relevance rank (descending), and applying a LIMIT (top k).
 */
export type FulltextMatchPredicate = Readonly<{
  __type: "fulltext_match";
  /**
   * Reserved for forward compatibility with per-field fulltext dispatch.
   * Today only `field.alias` is consumed: the MATCH always targets the
   * combined `content` column, so `field.path` is a synthetic
   * `["$fulltext"]` marker rather than a real props path. Future
   * strategies (per-field indexes, `setweight()`-style boosts) can use
   * the full `FieldRef` without breaking the AST shape.
   */
  field: FieldRef;
  /** The user-supplied query string. */
  query: string;
  /** Parse mode for the query string. Default: "websearch". */
  mode: FulltextQueryMode;
  /** Language override for query parsing. */
  language?: string;
  /** Maximum number of results to return. */
  limit: number;
  /** Minimum relevance to include (backend-native units). */
  minScore?: number;
}>;

/**
 * Fusion options for hybrid (vector + fulltext) queries.
 *
 * Shared between:
 * - Query-builder path: `QueryBuilder.fuseWith()` stores this on `QueryAst`.
 * - Store path: `store.search.hybrid(kind, { fusion })` accepts the same shape.
 *
 * Only applied when the query contains both a vector and a fulltext
 * predicate. Defaults (when omitted): RRF with k=60 and equal weights.
 */
export type HybridFusionOptions = Readonly<{
  /** RRF is the only currently supported fusion method. */
  method?: "rrf";
  /** RRF constant. The classic value is 60. */
  k?: number;
  /** Per-source weights. Default: { vector: 1, fulltext: 1 }. */
  weights?: Readonly<{
    vector?: number;
    fulltext?: number;
  }>;
}>;

/**
 * Classic RRF constant. Shared by the store-level JS fusion in
 * `store.search.hybrid` and the SQL emitter — keep both paths reading
 * the same number so their top-k never drifts on ties.
 */
export const DEFAULT_RRF_K = 60;

/** Default per-source RRF weight when none is supplied. */
export const DEFAULT_RRF_WEIGHT = 1;

/**
 * All predicate expression types.
 */
export type PredicateExpression =
  | ComparisonPredicate
  | StringPredicate
  | NullPredicate
  | BetweenPredicate
  | ArrayPredicate
  | ObjectPredicate
  | AndPredicate
  | OrPredicate
  | NotPredicate
  | AggregateComparisonPredicate
  | ExistsSubquery
  | InSubquery
  | VectorSimilarityPredicate
  | FulltextMatchPredicate;

// ============================================================
// Query Start
// ============================================================

/**
 * The starting point of a query (the FROM clause).
 */
type QueryStart = Readonly<{
  alias: string;
  kinds: readonly string[]; // Expanded via ontology if includeSubClasses
  includeSubClasses: boolean;
}>;

// ============================================================
// Traversals
// ============================================================

/**
 * Direction of edge traversal.
 */
export type TraversalDirection = "out" | "in";

/**
 * Traversal ontology expansion behavior.
 *
 * - `"none"` — follow only the exact edge kind specified
 * - `"implying"` — also follow edge kinds that imply the specified kind (subClassOf)
 * - `"inverse"` — also follow the ontological inverse edge kind (inverseOf)
 * - `"all"` — follow both implying and inverse expansions
 */
export type TraversalExpansion = "none" | "implying" | "inverse" | "all";

/**
 * Cycle handling policy for recursive traversals.
 */
export type RecursiveCyclePolicy = "prevent" | "allow";

/**
 * Variable-length traversal specification for recursive graph traversals.
 */
export type VariableLengthSpec = Readonly<{
  /** Minimum number of hops before including results (default: 1) */
  minDepth: number;
  /** Maximum number of hops (-1 = unlimited, default: -1) */
  maxDepth: number;
  /**
   * Cycle handling mode.
   *
   * - "prevent": Track visited nodes per path and reject revisits
   * - "allow": Skip cycle checks (faster, may revisit nodes)
   */
  cyclePolicy: RecursiveCyclePolicy;
  /** Optional column alias for projected traversal path array */
  pathAlias?: string;
  /** Optional column alias for projected traversal depth */
  depthAlias?: string;
}>;

/**
 * A traversal step in the query.
 */
export type Traversal = Readonly<{
  edgeAlias: string;
  edgeKinds: readonly string[]; // Expanded via ontology based on traversal expand mode
  /**
   * Edge kinds traversed in the opposite direction.
   *
   * Populated when query options request inverse/symmetric expansion.
   */
  inverseEdgeKinds?: readonly string[];
  direction: TraversalDirection;
  nodeAlias: string;
  nodeKinds: readonly string[];
  joinFromAlias: string;
  joinEdgeField: "from_id" | "to_id";
  /** If true, use LEFT JOIN instead of INNER JOIN (optional match) */
  optional: boolean;
  /** Variable-length traversal configuration (for recursive CTEs) */
  variableLength?: VariableLengthSpec;
}>;

/**
 * Returns the full set of edge kind names for a traversal, merging
 * forward and inverse kinds with deduplication.
 */
export function mergeEdgeKinds(traversal: Traversal): readonly string[] {
  const inverse = traversal.inverseEdgeKinds;
  if (inverse === undefined || inverse.length === 0) return traversal.edgeKinds;

  return [
    ...traversal.edgeKinds,
    ...inverse.filter((kind) => !traversal.edgeKinds.includes(kind)),
  ];
}

// ============================================================
// Aggregations
// ============================================================

/**
 * Supported aggregate functions.
 */
type AggregateFunction =
  | "count"
  | "countDistinct"
  | "sum"
  | "avg"
  | "min"
  | "max";

/**
 * An aggregate expression.
 */
export type AggregateExpr = Readonly<{
  __type: "aggregate";
  function: AggregateFunction;
  field: FieldRef;
}>;

/**
 * A GROUP BY specification.
 */
export type GroupBySpec = Readonly<{
  fields: readonly FieldRef[];
}>;

// ============================================================
// Projections
// ============================================================

/**
 * A projected field in the SELECT clause.
 * Can be either a direct field reference or an aggregate expression.
 */
export type ProjectedField = Readonly<{
  outputName: string;
  source: FieldRef | AggregateExpr;
  /** Override the CTE alias for this field (used for edge fields in node CTEs) */
  cteAlias?: string;
}>;

/**
 * The projection (SELECT) clause.
 */
export type Projection = Readonly<{
  fields: readonly ProjectedField[];
}>;

/**
 * A selectively projected field for optimized queries.
 *
 * Used when the select callback only accesses specific fields,
 * allowing the compiler to generate optimized SQL that fetches
 * only those fields instead of the full props blob.
 */
export type SelectiveField = Readonly<{
  /** The alias (node or edge) this field belongs to */
  alias: string;
  /** The field name (e.g., "email", "name", "id") */
  field: string;
  /** The output column name in the result (e.g., "p_email") */
  outputName: string;
  /** True if this is a system field (id, kind, etc.), false for props */
  isSystemField: boolean;
  /**
   * Optional value type for props fields.
   *
   * When present, the compiler can use type-aware JSON extraction
   * (e.g. numeric/date casts) to better match predicate compilation
   * and enable expression index coverage.
   */
  valueType?: ValueType | undefined;
}>;

// ============================================================
// Ordering
// ============================================================

/**
 * Null ordering preference.
 */
type NullOrdering = "first" | "last";

/**
 * Sort direction.
 */
export type SortDirection = "asc" | "desc";

/**
 * An ordering specification.
 */
export type OrderSpec = Readonly<{
  field: FieldRef;
  direction: SortDirection;
  nulls?: NullOrdering;
}>;

// ============================================================
// Node Predicate
// ============================================================

/**
 * A predicate applied to a specific node or edge alias.
 */
export type NodePredicate = Readonly<{
  targetAlias: string;
  /** Whether this predicate targets a node or edge. Defaults to "node". */
  targetType?: "node" | "edge";
  expression: PredicateExpression;
}>;

// ============================================================
// Temporal Options
// ============================================================

/**
 * Temporal query options.
 */
type TemporalOptions = Readonly<{
  mode: TemporalMode;
  asOf?: string;
}>;

// ============================================================
// Query AST
// ============================================================

/**
 * The complete query AST.
 */
export type QueryAst = Readonly<{
  /** The graph ID this query is for (used for subqueries) */
  graphId?: string;
  start: QueryStart;
  traversals: readonly Traversal[];
  predicates: readonly NodePredicate[];
  projection: Projection;
  temporalMode: TemporalOptions;
  orderBy?: readonly OrderSpec[];
  limit?: number;
  offset?: number;
  /** GROUP BY specification for aggregate queries */
  groupBy?: GroupBySpec;
  /** HAVING clause - predicates applied after GROUP BY */
  having?: PredicateExpression;
  /**
   * Selective fields for optimized queries.
   * When present, the compiler generates SQL that only fetches these specific
   * fields instead of the full props blob, enabling covered index usage.
   */
  selectiveFields?: readonly SelectiveField[];
  /** Fusion options for hybrid queries. Ignored unless both predicates present. */
  fusion?: HybridFusionOptions;
}>;

// ============================================================
// Set Operations
// ============================================================

/**
 * Set operation types for combining queries.
 */
export type SetOperationType = "union" | "unionAll" | "intersect" | "except";

/**
 * A set operation combining two queries.
 */
export type SetOperation = Readonly<{
  __type: "set_operation";
  operator: SetOperationType;
  left: ComposableQuery;
  right: ComposableQuery;
  orderBy?: readonly OrderSpec[];
  limit?: number;
  offset?: number;
}>;

/**
 * A composable query - either a base query or a set operation.
 */
export type ComposableQuery = QueryAst | SetOperation;
