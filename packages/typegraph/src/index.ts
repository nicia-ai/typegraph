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
  // Recorded-time instant brand (the typed anchor for store.asOfRecorded)
  asRecordedInstant,
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
  type RecordedInstant,
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
  BackendIdentity,
  BackendLifecycle,
  BackendMaintenance,
  BackendTransactions,
  CommitSchemaVersionExpected,
  CommitSchemaVersionParams,
  ContributionMaterializationBackend,
  DeleteFulltextBatchParams,
  EdgeEntityReadBackend,
  EdgeEntityWriteBackend,
  FulltextBatchRow,
  FulltextCapabilities,
  FulltextOperationBackend,
  FulltextQueryMode,
  FulltextSearchParams,
  FulltextSearchResult,
  GraphBackend,
  GraphEntityReadBackend,
  GraphEntityWriteBackend,
  GraphLifecycleBackend,
  IndexMaterializationBackend,
  NodeEntityReadBackend,
  NodeEntityWriteBackend,
  QueryExecutionBackend,
  RawQueryExecutionBackend,
  RawStatementExecutionBackend,
  RemovalMaterializationBackend,
  SchemaCommitBackend,
  SchemaReadBackend,
  SchemaVersionRow,
  SetActiveVersionParams,
  TransactionBackend,
  UniqueConstraintBackend,
  UpsertFulltextBatchParams,
  VectorCapabilities,
  VectorOperationBackend,
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

export {
  type ExternalRecordedReadSource,
  recordedRelation,
  type RecordedRelationOptions,
} from "./query/compiler/schema";
export type {
  EdgeIntrospection,
  FulltextSearchHit,
  FulltextSearchOptions,
  HistorySafeBackend,
  HistorySafeTransactionBackend,
  HistoryStore,
  HistoryTransactionContext,
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
  RecordedReadStore,
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
export type {
  EdgeBatchReads,
  EdgeTemporalReads,
  EdgeWrites,
  NodeCurrentReads,
  NodeTemporalReads,
  NodeWrites,
  RecordedStoreViewEdgeCollection,
  RecordedStoreViewEdgeCollections,
  RecordedStoreViewNodeCollection,
  RecordedStoreViewNodeCollections,
  StoreViewCanReachOptions,
  StoreViewCoordinate,
  StoreViewDegreeOptions,
  StoreViewEdgeCollection,
  StoreViewEdgeCollections,
  StoreViewNeighborsOptions,
  StoreViewNodeCollection,
  StoreViewNodeCollections,
  StoreViewReachableOptions,
  StoreViewShortestPathOptions,
  StoreViewSubgraphOptions,
  TypedRecordedStoreViewEdgeCollection,
  TypedStoreViewEdgeCollection,
} from "./store";
export {
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
  RecordedStoreView,
  StoreSearch,
  StoreView,
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
  GetOrCreateAction,
  GraphEdgeCollections,
  GraphNodeCollections,
  HistoryStoreOptions,
  HookContext,
  IfExistsMode,
  LiveStoreOptions,
  Node,
  NodeBulkFindByIndexOptions,
  NodeCollection,
  NodeGetOrCreateByConstraintOptions,
  NodeGetOrCreateByConstraintResult,
  NodeRef,
  NoRecordedCoordinate,
  OperationHookContext,
  QueryHookContext,
  QueryOptions,
  StoreHooks,
  StoreOptions,
  StoreProjection,
  StoreRef,
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
  CompiledRowsSql,
  CompiledSelectSql,
  CompiledStatementSql,
  DynamicEdgeAccessor,
  DynamicEdgeType,
  DynamicFieldBuilder,
  DynamicNodeAccessor,
  DynamicNodeType,
  DynamicSelectableEdge,
  DynamicSelectableNode,
  EdgeAccessor,
  EmptyAliasMap,
  EmptyEdgeAliasMap,
  EmptyRecursiveAliasMap,
  FieldAccessor,
  FieldRef,
  InitialQueryBuilder,
  IntentSql,
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
  QueryCoordinateState,
  RecursiveTraversalOptions,
  ResolvedSqlTableNames,
  ResolveJsonPointer,
  ResolveJsonPointerSegments,
  SelectableEdge,
  SelectableNode,
  SelectContext,
  SortDirection,
  SqlDialect,
  SqlIntent,
  SqlSchema,
  SqlTableNames,
  StreamOptions,
  TraversalExpansion,
} from "./query";
export type { ParameterRef } from "./query/ast";

// Functions and classes
export {
  asCompiledRowsSql,
  asCompiledSelectSql,
  asCompiledStatementSql,
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
