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
  type GetOrCreateAction,
  type HookContext,
  type IfExistsMode,
  type Node,
  type NodeCollection,
  type NodeGetOrCreateByConstraintOptions,
  type NodeGetOrCreateByConstraintResult,
  type NodeRef,
  type OperationHookContext,
  type QueryHookContext,
  type QueryOptions,
  type StoreHooks,
  type StoreOptions,
  type StoreRef,
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
export type { SchemaManagerOptions, SchemaValidationResult } from "./store";
export type { Store } from "./store";
export { createStore, createStoreWithSchema } from "./store";

// Search facade and option / result types
export type {
  FulltextSearchHit,
  FulltextSearchOptions,
  HybridFulltextOptions,
  HybridFusionOptions,
  HybridSearchHit,
  HybridSearchOptions,
  HybridVectorOptions,
  VectorSearchHit,
} from "./search";
export { StoreSearch } from "./search-facade";

// Fulltext rebuild
export type {
  RebuildFulltextOptions,
  RebuildFulltextResult,
} from "./fulltext-rebuild";
