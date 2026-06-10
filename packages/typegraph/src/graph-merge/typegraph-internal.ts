export type {
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../backend/types";
export { computeUniqueKey } from "../constraints";
export {
  defineGraph,
  getEdgeKinds,
  getNodeKinds,
  type GetNodeType,
  type GraphDef,
  type NodeKinds,
} from "../core/define-graph";
export { defineNode } from "../core/node";
export type { EdgeId, JsonValue, NodeId, NodeType } from "../core/types";
export { TypeGraphError, type TypeGraphErrorOptions } from "../errors";
export { exportGraph } from "../interchange/export";
export { importGraph } from "../interchange/import";
export { computeTransitiveClosure, isReachable } from "../ontology/closures";
export { sortedReplacer } from "../schema/canonical";
export { computeSchemaHash, serializeSchema } from "../schema/serializer";
export {
  type OntologyIntrospection,
  type UniqueIntrospection,
} from "../store/introspect";
export type { Store } from "../store/store";
export { createStoreWithSchema } from "../store/store";
export type { Edge, Node } from "../store/types";
export { sha256Hex } from "../utils/hash";
export { generateId } from "../utils/id";
