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
  asEdgeId,
  asNodeId,
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
  // Vector-slot enumeration for manual provisioning (the boot step
  // createStoreWithSchema performs via backend.ensureVectorSlotContribution)
  resolveGraphVectorSlots,
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
  AdapterBackend,
  AdapterBackendTransactions,
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
  FilteredApproximateSearch,
  FilteredApproximateSearchMode,
  FulltextBatchRow,
  FulltextCapabilities,
  FulltextOperationBackend,
  FulltextQueryMode,
  FulltextSearchParams,
  FulltextSearchResult,
  GraphAnalyticsCapabilities,
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
  TransactionOptions,
  TransactionReadBackend,
  TrustedImportSession,
  UniqueConstraintBackend,
  UpsertFulltextBatchParams,
  VectorCapabilities,
  VectorOperationBackend,
} from "./backend/types";
export {
  type RowProps,
  rowPropsToJsonText,
  rowPropsToObject,
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
  CardinalityErrorDetails,
  DatabaseOperationErrorDetails,
  DisjointErrorDetails,
  EagerMaterializationErrorDetails,
  EdgeNotFoundErrorDetails,
  EmbeddingDimensionChangedErrorDetails,
  EndpointErrorDetails,
  EndpointNotFoundErrorDetails,
  ErrorCategory,
  InvalidEdgeWeightErrorDetails,
  InvalidEdgeWeightReason,
  KindNotFoundErrorDetails,
  MigrationErrorDetails,
  NodeConstraintNotFoundErrorDetails,
  NodeIndexNotFoundErrorDetails,
  NodeNotFoundErrorDetails,
  RecordedCaptureGuardCode,
  RecordedCaptureGuardError,
  RestrictedDeleteErrorDetails,
  SchemaContentConflictErrorDetails,
  SchemaMismatchErrorDetails,
  StaleVersionErrorDetails,
  StoreNotInitializedErrorDetails,
  StoreNotInitializedReason,
  TrustedImportErrorReason,
  TypeGraphErrorOptions,
  UniquenessErrorDetails,
  ValidationErrorDetails,
  ValidationIssue,
  VersionConflictErrorDetails,
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
  GraphAlgorithmConvergenceError,
  InvalidEdgeWeightError,
  isConstraintError,
  isRecordedCaptureGuardError,
  isSystemError,
  isTypeGraphError,
  isUserRecoverable,
  KindNotFoundError,
  MigrationError,
  NodeConstraintNotFoundError,
  NodeIndexNotFoundError,
  NodeNotFoundError,
  RECORDED_CAPTURE_GUARD_CODES,
  RestrictedDeleteError,
  SchemaContentConflictError,
  SchemaMismatchError,
  StaleVersionError,
  StoreNotInitializedError,
  TransactionClosedError,
  TrustedImportError,
  TypeGraphError,
  UniquenessError,
  UnsupportedBackendCapabilityError,
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
  AdapterHistoryStore,
  AdapterHistoryTransactionContext,
  AdapterRecordedReadStore,
  AdapterStore,
  EdgeIntrospection,
  FulltextSearchHit,
  FulltextSearchOptions,
  HistoryStore,
  HistoryStoreBackend,
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
  MaterializeSystemIndexesOptions,
  MeasurableAdapterHistoryTransactionContext,
  OntologyIntrospection,
  RebuildFulltextOptions,
  RebuildFulltextResult,
  ReclaimedVectorFieldEntry,
  RecordedReadStore,
  RecordedScanOptions,
  RecordedScanPage,
  ReembedFunction,
  ReembedVectorFieldOptions,
  ReembedVectorFieldResult,
  SchemaIntrospection,
  SchemaManagerOptions,
  SchemaValidationResult,
  SearchScopeOptions,
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
  StoreViewGraphAlgorithms,
  StoreViewLabelPropagationOptions,
  StoreViewNeighborsOptions,
  StoreViewNodeCollection,
  StoreViewNodeCollections,
  StoreViewPageRankOptions,
  StoreViewPersonalizedPageRankOptions,
  StoreViewReachableOptions,
  StoreViewShortestPathOptions,
  StoreViewSubgraphOptions,
  StoreViewWeaklyConnectedComponentsOptions,
  StoreViewWeightedShortestPathOptions,
  TypedRecordedStoreViewEdgeCollection,
  TypedStoreViewEdgeCollection,
} from "./store";
export {
  createAdapterStore,
  createAdapterStoreWithSchema,
  createStore,
  createStoreWithSchema,
  createVerifiedAdapterStore,
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
  LabelPropagationMembership,
  LabelPropagationOptions,
  NeighborsOptions,
  NodeIdentifier,
  PageRankOptions,
  PageRankScore,
  PathNode,
  PersonalizedPageRankOptions,
  PersonalizedPageRankSeed,
  ReachableNode,
  ReachableOptions,
  ShortestPathOptions,
  ShortestPathResult,
  TemporalAlgorithmOptions,
  TraversalDirection,
  WeaklyConnectedComponentMembership,
  WeaklyConnectedComponentsOptions,
  WeightedShortestPathOptions,
  WeightedShortestPathResult,
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
  AdapterTransactionContext,
  BaseStoreOptions,
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
  MeasurableAdapterTransactionContext,
  MeasurableTransactionContext,
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
  RecordedReadStoreOptions,
  ScopedMeasure,
  SqlAvailability,
  StoreHooks,
  StoreOptions,
  StoreProjection,
  StoreRef,
  TransactionContext,
  TransactionOutcome,
  TransactionReceipt,
  TypedEdgeCollection,
  UnboundLiveStoreOptions,
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
export {
  isSqlFragment,
  Placeholder,
  type RenderedSql,
  renderPostgres,
  renderSql,
  renderSqlInline,
  renderSqlite,
  sql,
  type SqlChunk,
  type SqlFragment,
  type SqlIdentifierChunk,
  type SqlParameterChunk,
  type SqlPlaceholderChunk,
  type SqlTag,
  type SqlTextChunk,
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
  SYSTEM_INDEX_DECLARATIONS,
  type SystemIndexDeclaration,
  type SystemIndexTable,
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
