// Node factory
export { defineNode, type DefineNodeOptions } from "./node";

// Edge factory
export { defineEdge, type DefineEdgeOptions } from "./edge";

// Embedding type for vector search
export {
  embedding,
  type EmbeddingBrand,
  type EmbeddingSchema,
  type EmbeddingValue,
  getEmbeddingDimensions,
  isEmbeddingSchema,
  resolveGraphVectorSlots,
} from "./embedding";

// Searchable type for fulltext search
export {
  DEFAULT_SEARCHABLE_LANGUAGE,
  getSearchableMetadata,
  isSearchableSchema,
  searchable,
  type SearchableMetadata,
  type SearchableOptions,
  type SearchableSchema,
} from "./searchable";

// External reference type for hybrid overlay patterns
export {
  createExternalRef,
  externalRef,
  type ExternalRefSchema,
  type ExternalRefValue,
  getExternalRefTable,
  isExternalRefSchema,
} from "./external-ref";

// Recorded-time instant brand (the typed anchor for store.asOfRecorded)
export {
  asRecordedInstant,
  compareRecordedInstants,
  type RecordedInstant,
  recordedInstant,
  recordedInstantOwner,
  recordedInstantRevision,
  recordedInstantWallTime,
  type RestoredRecordedInstant,
} from "./temporal";

// Graph definition
export {
  type AllEdgeTypes,
  type AllNodeTypes,
  defineGraph,
  type EdgeKinds,
  getEdgeKinds,
  type GetEdgeType,
  getNodeKinds,
  type GetNodeType,
  type GraphDef,
  type GraphIdentityConfig,
  isGraphDef,
  type NodeKinds,
} from "./define-graph";

// Edge endpoint utilities
export {
  type EndpointPair,
  formatEndpointPairs,
  getEdgeEndpointPairs,
  isEdgeTargetMap,
  normalizeTargetMap,
  projectTargetKinds,
  projectTargetNodes,
  validateTargetMapEntries,
} from "./edge-endpoints";

// Core types
export type { GraphAllocationOwner } from "./allocation-owner";
export {
  type AnyEdgeRegistration,
  type AnyEdgeType,
  asEdgeId,
  asNodeId,
  type Cardinality,
  type Collation,
  type DeleteBehavior,
  type EdgeId,
  type EdgeMatchIdentity,
  type EdgeProps,
  type EdgeRegistration,
  type EdgeTargetMap,
  type EdgeTargets,
  type EdgeType,
  type EdgeTypeWithEndpoints,
  type EndpointExistence,
  type GraphAnnotations,
  type GraphDefaults,
  type IndexEntity,
  isEdgeType,
  isEdgeTypeWithEndpoints,
  isNodeType,
  type JsonScalar,
  type JsonValue,
  type KindAnnotations,
  type KindEntity,
  type NodeId,
  type NodeProps,
  type NodeRegistration,
  type NodeType,
  type NullCheckOp,
  type TargetCardinality,
  type TemporalMode,
  type UniqueConstraint,
  type UniquenessScope,
} from "./types";

// Ontology declaration and custom meta-edge vocabulary
export {
  type CompositionExistence,
  type CompositionOptions,
  type CompositionPartSide,
  type CompositionViaRef,
  core,
  type EquivalentToCheck,
  isMetaEdge,
  type MetaEdge,
  type MetaEdgeName,
  type MetaEdgeProperties,
  type OntologyRelation,
  type PolymorphicNodeType,
  type StructuralSubtypeMismatch,
  type SubClassOfCheck,
  type TypedOntologyRelation,
} from "../ontology";
// Type-only: `MetaEdgeName` is spelled `(typeof ALL_META_EDGE_NAMES)[number]`,
// so naming it needs the constant's type, not a runtime export.
export type { ALL_META_EDGE_NAMES } from "../ontology/constants";

// ID generation
export { generateId } from "../utils/id";

/**
 * Types the public declarations name without being everyday API: exported so
 * a consumer's declaration emit can spell an inferred type through a public
 * specifier. Entrypoints whose declarations name them load this entrypoint's
 * declarations (contract 3 in `tests/public-type-reachability.test.ts`).
 */
export type { UniquePredicate } from "../constraints";
export type {
  IncompatibleKeys,
  LiteralKeysOf,
  OpaqueTypeLevelValue,
  RuntimeInvisibleTags,
  StructuralSubtypeMismatchWording,
  TypeLevelChild,
  TypeLevelElement,
} from "../ontology/types";
export type {
  CompositionPair,
  CompositionRealization,
  CompositionRelation,
} from "../registry/composition-relation";
export type { EdgeKindFacts } from "../registry/edge-kind-facts";
export type { KindRegistry, RegistryClosures } from "../registry/kind-registry";
export type {
  EdgeEntry,
  GraphDefConfig,
  NormalizedEdges,
} from "./define-graph";
export type { EmptySchema } from "./edge";
export type {
  EmbeddingIndexOptions,
  EmbeddingIndexType,
  EmbeddingMetric,
} from "./embedding";
export type {
  EngineRecordedInstantParts,
  ReadCoordinate,
  RecordedInstantParts,
  TypeGraphRecordedInstantParts,
} from "./temporal";
export type {
  UniqueConstraintField,
  UniqueConstraintPredicate,
  UniqueConstraintPredicateBuilder,
} from "./types";
