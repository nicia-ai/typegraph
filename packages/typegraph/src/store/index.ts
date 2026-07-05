// Types
export {
  type ConstraintNames,
  type CreateEdgeInput,
  type CreateNodeInput,
  type DynamicEdgeCollection,
  type DynamicNodeCollection,
  type Edge,
  type EdgeBatchReads,
  type EdgeCollection,
  type EdgeFindByEndpointsOptions,
  type EdgeGetOrCreateByEndpointsOptions,
  type EdgeGetOrCreateByEndpointsResult,
  type EdgeTemporalReads,
  type EdgeWrites,
  type GetOrCreateAction,
  type HistoryStoreOptions,
  type HookContext,
  type IfExistsMode,
  type LiveStoreOptions,
  type Node,
  type NodeBulkFindByIndexOptions,
  type NodeCollection,
  type NodeCurrentReads,
  type NodeGetOrCreateByConstraintOptions,
  type NodeGetOrCreateByConstraintResult,
  type NodeRef,
  type NodeTemporalReads,
  type NodeWrites,
  type NoRecordedCoordinate,
  type OperationHookContext,
  type QueryHookContext,
  type QueryOptions,
  type RecordedStoreViewEdgeCollection,
  type RecordedStoreViewEdgeCollections,
  type RecordedStoreViewNodeCollection,
  type RecordedStoreViewNodeCollections,
  type StoreHooks,
  type StoreOptions,
  type StoreRef,
  type StoreViewEdgeCollection,
  type StoreViewEdgeCollections,
  type StoreViewNodeCollection,
  type StoreViewNodeCollections,
  type TransactionContext,
  type TransactionOutcome,
  type TransactionReceipt,
  type TypedEdgeCollection,
  type TypedRecordedStoreViewEdgeCollection,
  type TypedStoreViewEdgeCollection,
  type UpdateEdgeInput,
  type UpdateNodeInput,
} from "./types";

// StoreView (read-only as-of lens)
export type {
  StoreViewCanReachOptions,
  StoreViewCoordinate,
  StoreViewDegreeOptions,
  StoreViewNeighborsOptions,
  StoreViewReachableOptions,
  StoreViewShortestPathOptions,
  StoreViewSubgraphOptions,
} from "./store-view";
export { RecordedStoreView, StoreView } from "./store-view";

// Subgraph extraction
export type {
  AnyEdge,
  AnyNode,
  SubgraphOptions,
  SubgraphResult,
  SubsetEdge,
  SubsetNode,
} from "./subgraph";
export { defineSubgraphProject } from "./subgraph";

// Store
export type {
  MaterializeIndexesEntry,
  MaterializeIndexesOptions,
  MaterializeIndexesResult,
} from "./materialize-indexes";
export type {
  MaterializeRemovalsEntry,
  MaterializeRemovalsOptions,
  MaterializeRemovalsResult,
  ReclaimedVectorFieldEntry,
} from "./materialize-removals";
export type {
  HistorySafeBackend,
  HistorySafeTransactionBackend,
  HistoryStore,
  HistoryTransactionContext,
  RecordedReadStore,
  ReembedFunction,
  ReembedVectorFieldOptions,
  ReembedVectorFieldResult,
  SchemaManagerOptions,
  SchemaValidationResult,
} from "./store";
export type { Store } from "./store";
export {
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
} from "./store";

// Search facade and option / result types
export type {
  EdgeIntrospection,
  KindIntrospection,
  OntologyIntrospection,
  SchemaIntrospection,
  UniqueIntrospection,
} from "./introspect";
export type {
  FulltextSearchHit,
  FulltextSearchOptions,
  HybridFulltextOptions,
  HybridFusionOptions,
  HybridSearchHit,
  HybridSearchOptions,
  HybridVectorOptions,
  SearchScopeOptions,
  VectorSearchHit,
  VectorSearchOptions,
} from "./search";
export { StoreSearch } from "./search-facade";

// Fulltext rebuild
export type {
  RebuildFulltextOptions,
  RebuildFulltextResult,
} from "./fulltext-rebuild";
