// Node factory
export { defineNode, type DefineNodeOptions } from "./node";

// Edge factory
export { defineEdge, type DefineEdgeOptions } from "./edge";

// Meta-edge factory
export { metaEdge, type MetaEdgeOptions } from "./meta-edge";

// Embedding type for vector search
export {
  embedding,
  type EmbeddingSchema,
  type EmbeddingValue,
  getEmbeddingDimensions,
  isEmbeddingSchema,
} from "./embedding";

// External reference type for hybrid overlay patterns
export {
  createExternalRef,
  externalRef,
  type ExternalRefSchema,
  type ExternalRefValue,
  getExternalRefTable,
  isExternalRefSchema,
} from "./external-ref";

// Graph definition
export {
  type AllEdgeTypes,
  type AllNodeTypes,
  defineGraph,
  type EdgeTypeNames,
  type GetEdgeType,
  getEdgeTypeNames,
  type GetNodeType,
  getNodeTypeNames,
  type GraphDef,
  isGraphDef,
  type NodeTypeNames,
} from "./define-graph";

// Core types
export {
  type AnyEdgeType,
  type Cardinality,
  type Collation,
  type DeleteBehavior,
  type EdgeProps,
  type EdgeRegistration,
  type EdgeType,
  type EdgeTypeWithEndpoints,
  type EndpointExistence,
  type GraphDefaults,
  isEdgeType,
  isEdgeTypeWithEndpoints,
  isNodeType,
  type NodeId,
  type NodeProps,
  type NodeRegistration,
  type NodeType,
  type TemporalMode,
  type UniqueConstraint,
  type UniquenessScope,
} from "./types";
