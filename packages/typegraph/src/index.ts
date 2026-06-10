/**
 * TypeGraph: Type-Driven Embedded Knowledge Graph for TypeScript
 *
 * @example
 * ```typescript
 * import * as tg from "@nicia-ai/typegraph";
 * import { z } from "zod";
 *
 * const Person = tg.defineNode("Person", {
 *   schema: z.object({
 *     fullName: z.string(),
 *     email: z.string().email().optional(),
 *   }),
 * });
 *
 * const Company = tg.defineNode("Company", {
 *   schema: z.object({
 *     name: z.string(),
 *     industry: z.string(),
 *   }),
 * });
 *
 * const worksAt = tg.defineEdge("worksAt", {
 *   schema: z.object({
 *     role: z.string(),
 *   }),
 * });
 *
 * const graph = tg.defineGraph({
 *   id: "my_graph",
 *   nodes: {
 *     Person: { type: Person },
 *     Company: { type: Company },
 *   },
 *   edges: {
 *     worksAt: {
 *       type: worksAt,
 *       from: [Person],
 *       to: [Company],
 *     },
 *   },
 *   ontology: [
 *     tg.core.disjointWith(Person, Company),
 *   ],
 * });
 * ```
 */

// ============================================================
// Core DSL
// ============================================================

export {
  // Type utilities
  type AllEdgeTypes,
  type AllNodeTypes,
  // External reference type for hybrid overlay patterns
  createExternalRef,
  DEFAULT_SEARCHABLE_LANGUAGE,
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeKinds,
  // Embedding type for vector search
  embedding,
  type EmbeddingSchema,
  type EmbeddingValue,
  externalRef,
  type ExternalRefSchema,
  type ExternalRefValue,
  getEdgeKinds,
  type GetEdgeType,
  getEmbeddingDimensions,
  getExternalRefTable,
  getNodeKinds,
  type GetNodeType,
  getSearchableMetadata,
  type GraphDef,
  // Type guards
  isEdgeType,
  isEdgeTypeWithEndpoints,
  isEmbeddingSchema,
  isExternalRefSchema,
  isGraphDef,
  isNodeType,
  isSearchableSchema,
  metaEdge,
  type NodeKinds,
  // Searchable type for fulltext search
  searchable,
  type SearchableMetadata,
  type SearchableOptions,
  type SearchableSchema,
} from "./core";

// ============================================================
// Backend Types
// ============================================================

export type {
  StrategyTableContribution,
  TableContribution,
} from "./backend/table-contribution";
export type {
  AdoptedTransaction,
  BackendCapabilities,
  CommitSchemaVersionExpected,
  CommitSchemaVersionParams,
  DeleteFulltextBatchParams,
  EdgeHistoryRow,
  FulltextBatchRow,
  FulltextCapabilities,
  FulltextQueryMode,
  FulltextSearchParams,
  FulltextSearchResult,
  GraphBackend,
  HistoryBackend,
  HistoryMeta,
  HistoryOp,
  NodeHistoryRow,
  PruneHistoryParams,
  SchemaVersionRow,
  SetActiveVersionParams,
  TransactionBackend,
  TransactionOptions,
  UpsertFulltextBatchParams,
  VectorCapabilities,
} from "./backend/types";
export type { FulltextStrategy } from "./query/dialect/fulltext-strategy";
export {
  fts5Strategy,
  tsvectorStrategy,
} from "./query/dialect/fulltext-strategy";

// ============================================================
// Vector Strategy (pluggable per-(kind, field) vector storage)
// ============================================================

export { libsqlVectorStrategy } from "./query/dialect/vector/libsql-strategy";
export { pgvectorStrategy } from "./query/dialect/vector/pgvector-strategy";
export { sqliteVecStrategy } from "./query/dialect/vector/sqlite-vec-strategy";
export {
  buildVectorCapabilities,
  type VectorSlot,
  type VectorStrategy,
} from "./query/dialect/vector-strategy";

// ============================================================
// Vector Storage Migration (one-time shared-table → per-field cutover)
// ============================================================

export {
  type LegacyEmbeddingSlotConfig,
  migrateLegacyEmbeddings,
  type MigrateLegacyEmbeddingsOptions,
  type MigrateLegacyEmbeddingsResult,
} from "./backend/migrate-vectors";

// ============================================================
// Core Types
// ============================================================

export type {
  AnyEdgeType,
  Cardinality,
  Collation,
  DefineEdgeOptions,
  DefineNodeOptions,
  DeleteBehavior,
  EdgeId,
  EdgeProps,
  EdgeRegistration,
  EdgeType,
  EdgeTypeWithEndpoints,
  EndpointExistence,
  GraphDefaults,
  JsonValue,
  KindAnnotations,
  MetaEdgeOptions,
  NodeId,
  NodeProps,
  NodeRegistration,
  NodeType,
  TemporalMode,
  UniqueConstraint,
  UniquenessScope,
} from "./core";

// ============================================================
// Ontology
// ============================================================

export type {
  InferenceType,
  MetaEdge,
  MetaEdgeProperties,
  OntologyRelation,
} from "./ontology";
export {
  // Individual relation factories (for convenience)
  broader,
  // Transitive-closure utilities (reason over subClassOf/equivalentTo hierarchies)
  computeTransitiveClosure,
  // Core ontology module
  core,
  differentFrom,
  disjointWith,
  equivalentTo,
  hasPart,
  implies,
  inverseOf,
  invertClosure,
  // Type guards
  isMetaEdge,
  isReachable,
  narrower,
  partOf,
  relatedTo,
  sameAs,
  subClassOf,
} from "./ontology";

// ============================================================
// Errors
// ============================================================

export type {
  ErrorCategory,
  StoreNotInitializedReason,
  TypeGraphErrorOptions,
  ValidationErrorDetails,
  ValidationIssue,
} from "./errors";
export {
  // Error classes
  BackendDisposedError,
  CardinalityError,
  CompilerInvariantError,
  ConfigurationError,
  DatabaseOperationError,
  DisjointError,
  EagerMaterializationError,
  EdgeNotFoundError,
  EmbeddingDimensionChangedError,
  EndpointError,
  EndpointNotFoundError,
  // Error utility functions
  getErrorSuggestion,
  isConstraintError,
  isSystemError,
  isTypeGraphError,
  isUserRecoverable,
  KindNotFoundError,
  MigrationError,
  NodeConstraintNotFoundError,
  NodeIndexNotFoundError,
  NodeNotFoundError,
  RestrictedDeleteError,
  SchemaContentConflictError,
  SchemaMismatchError,
  StaleVersionError,
  StoreNotInitializedError,
  TypeGraphError,
  UniquenessError,
  UnsupportedPredicateError,
  ValidationError,
  VersionConflictError,
} from "./errors";

// ============================================================
// Store
// ============================================================

export type {
  EdgeIntrospection,
  FulltextSearchHit,
  FulltextSearchOptions,
  HybridFulltextOptions,
  HybridFusionOptions,
  HybridSearchHit,
  HybridSearchOptions,
  HybridVectorOptions,
  KindIntrospection,
  MaterializeIndexesEntry,
  MaterializeIndexesOptions,
  MaterializeIndexesResult,
  MaterializeRemovalsEntry,
  MaterializeRemovalsOptions,
  MaterializeRemovalsResult,
  OntologyIntrospection,
  RebuildFulltextOptions,
  RebuildFulltextResult,
  ReclaimedVectorFieldEntry,
  ReembedFunction,
  ReembedVectorFieldOptions,
  ReembedVectorFieldResult,
  SchemaIntrospection,
  SchemaManagerOptions,
  SchemaValidationResult,
  Store,
  UniqueIntrospection,
  VectorSearchHit,
  VectorSearchOptions,
} from "./store";
export {
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
  StoreSearch,
} from "./store";
export type {
  AlgorithmCyclePolicy,
  BaseTraversalOptions,
  DegreeOptions,
  GraphAlgorithms,
  NeighborsOptions,
  NodeIdentifier,
  PathNode,
  ReachableNode,
  ReachableOptions,
  ShortestPathOptions,
  ShortestPathResult,
  TemporalAlgorithmOptions,
  TraversalDirection,
} from "./store/algorithms";
export type {
  AnyEdge,
  AnyNode,
  SubgraphEdgeResult,
  SubgraphNodeResult,
  SubgraphOptions,
  SubgraphResult,
  SubsetEdge,
  SubsetNode,
} from "./store/subgraph";
export { defineSubgraphProject } from "./store/subgraph";
export type {
  ConstraintNames,
  CreateEdgeInput,
  CreateNodeInput,
  DynamicEdgeCollection,
  DynamicNodeCollection,
  Edge,
  EdgeCollection,
  EdgeFindByEndpointsOptions,
  EdgeGetOrCreateByEndpointsOptions,
  EdgeGetOrCreateByEndpointsResult,
  EdgeHistoryEntry,
  GetOrCreateAction,
  GraphEdgeCollections,
  GraphNodeCollections,
  HookContext,
  IfExistsMode,
  Node,
  NodeBulkFindByIndexOptions,
  NodeCollection,
  NodeGetOrCreateByConstraintOptions,
  NodeGetOrCreateByConstraintResult,
  NodeHistoryEntry,
  NodeRef,
  OperationHookContext,
  QueryHookContext,
  QueryOptions,
  StoreHistory,
  StoreHooks,
  StoreOptions,
  StoreProjection,
  StoreRef,
  StoreTransactionOptions,
  TransactionContext,
  TypedEdgeCollection,
  UpdateEdgeInput,
  UpdateNodeInput,
} from "./store/types";

// ============================================================
// Query
// ============================================================

// Types
export type {
  AggregateResult,
  AliasMap,
  BatchableQuery,
  BatchResults,
  DynamicEdgeAccessor,
  DynamicEdgeType,
  DynamicFieldBuilder,
  DynamicNodeAccessor,
  DynamicNodeType,
  DynamicSelectableEdge,
  DynamicSelectableNode,
  EdgeAccessor,
  FieldAccessor,
  FieldRef,
  JsonPointer,
  JsonPointerFor,
  JsonPointerInput,
  JsonPointerSegment,
  JsonPointerSegments,
  JsonPointerSegmentsFor,
  NodeAccessor,
  NodeAlias,
  OrderSpec,
  PaginatedResult,
  PaginateOptions,
  Predicate,
  PropsAccessor,
  RecursiveTraversalOptions,
  ResolveJsonPointer,
  ResolveJsonPointerSegments,
  SelectableEdge,
  SelectableNode,
  SelectContext,
  SortDirection,
  SqlDialect,
  SqlSchema,
  SqlTableNames,
  StreamOptions,
  TraversalExpansion,
} from "./query";
export type { ParameterRef } from "./query/ast";

// Functions and classes
export {
  // Aggregate functions
  avg,
  // Fragment composition
  composeFragments,
  count,
  countDistinct,
  countDistinctEdges,
  countEdges,
  createFragment,
  createQueryBuilder,
  // SQL schema configuration
  createSqlSchema,
  DEFAULT_SQL_SCHEMA,
  ExecutableAggregateQuery,
  ExecutableQuery,
  // Subquery predicates
  exists,
  field,
  fieldRef,
  // HAVING helpers
  having,
  havingEq,
  havingGt,
  havingGte,
  havingLt,
  havingLte,
  inSubquery,
  isParameterRef,
  joinJsonPointers,
  jsonPointer,
  limitFragment,
  max,
  MAX_EXPLICIT_RECURSIVE_DEPTH,
  MAX_JSON_POINTER_DEPTH,
  MAX_RECURSIVE_DEPTH,
  min,
  normalizeJsonPointer,
  notExists,
  notInSubquery,
  offsetFragment,
  orderByFragment,
  // Parameterized queries
  param,
  parseJsonPointer,
  PreparedQuery,
  QueryBuilder,
  sum,
  UnionableQuery,
} from "./query";

// Fragment composition types
export type {
  FlexibleQueryFragment,
  QueryFragment,
  TraversalFragment,
} from "./query";

// ============================================================
// Indexes
// ============================================================

export {
  andWhere,
  defineEdgeIndex,
  defineNodeIndex,
  type EdgeIndexConfig,
  type EdgeIndexDeclaration,
  type EdgeIndexDirection,
  type EdgeIndexWhereBuilder,
  type IndexDeclaration,
  type IndexOrigin,
  type IndexScope,
  type IndexWhereExpression,
  type IndexWhereFieldBuilder,
  type IndexWhereInput,
  type NodeIndexConfig,
  type NodeIndexDeclaration,
  type NodeIndexWhereBuilder,
  notWhere,
  orWhere,
} from "./indexes";

// ============================================================
// Graph Extension
// ============================================================
//
// The root surface intentionally keeps only the entry points, the
// top-level document type, version constants, error classes, and the
// types you need to inspect a validation/incompatibility error. The
// per-property / per-shape document types
// (`Extension*Property`, `ExtensionNodeDef`, `ExtensionEdgeDef`,
// `Extension*Index`, etc.) live behind
// `@nicia-ai/typegraph/graph-extension` — agent-prompt builders and
// codegen tools reach for them explicitly so the root surface stays
// small. Adding to this list later is a non-breaking change; removing
// from it is not.

export type {
  GraphExtension,
  GraphExtensionIssue,
  GraphExtensionIssueCode,
  GraphExtensionVersion,
  IncompatibleChange,
  KindReferent,
} from "./graph-extension";
export {
  CURRENT_GRAPH_EXTENSION_VERSION,
  defineGraphExtension,
  GraphExtensionError,
  GraphExtensionUnresolvedEndpointError,
  GraphExtensionValidationError,
  GraphExtensionVersionUnsupportedError,
  IncompatibleChangeError,
  KindCollisionError,
  KindHasReferentsError,
  LEGACY_GRAPH_EXTENSION_VERSION,
  RemoveCompileTimeKindError,
  validateGraphExtension,
} from "./graph-extension";

// ============================================================
// Utilities
// ============================================================

export {
  // ID utilities
  generateId,
  type IdConfig,
  type IdGenerator,
} from "./utils";
