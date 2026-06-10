// Types
export {
  type ConstraintNames,
  type CreateEdgeInput,
  type CreateNodeInput,
  type DynamicEdgeCollection,
  type DynamicNodeCollection,
  type Edge,
  type EdgeCollection,
  type EdgeFindByEndpointsOptions,
  type EdgeGetOrCreateByEndpointsOptions,
  type EdgeGetOrCreateByEndpointsResult,
  type EdgeHistoryEntry,
  type GetOrCreateAction,
  type HookContext,
  type IfExistsMode,
  type Node,
  type NodeBulkFindByIndexOptions,
  type NodeCollection,
  type NodeGetOrCreateByConstraintOptions,
  type NodeGetOrCreateByConstraintResult,
  type NodeHistoryEntry,
  type NodeRef,
  type OperationHookContext,
  type QueryHookContext,
  type QueryOptions,
  type StoreHistory,
  type StoreHooks,
  type StoreOptions,
  type StoreRef,
  type StoreTransactionOptions,
  type TransactionContext,
  type TypedEdgeCollection,
  type UpdateEdgeInput,
  type UpdateNodeInput,
} from "./types";

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
  VectorSearchHit,
  VectorSearchOptions,
} from "./search";
export { StoreSearch } from "./search-facade";

// Fulltext rebuild
export type {
  RebuildFulltextOptions,
  RebuildFulltextResult,
} from "./fulltext-rebuild";
