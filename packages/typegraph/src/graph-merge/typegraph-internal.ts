export type { GraphBackend } from "../backend/types";
export {
  defineGraph,
  getEdgeKinds,
  getNodeKinds,
  type GraphDef,
} from "../core/define-graph";
export { defineNode } from "../core/node";
export type {
  EdgeId,
  JsonValue,
  NodeId,
  NodeType,
} from "../core/types";
export { TypeGraphError, type TypeGraphErrorOptions } from "../errors";
export { exportGraph } from "../interchange/export";
export { importGraph } from "../interchange/import";
export {
  computeTransitiveClosure,
  isReachable,
} from "../ontology/closures";
export { computeSchemaHash, serializeSchema } from "../schema/serializer";
export {
  type OntologyIntrospection,
  type UniqueIntrospection,
} from "../store/introspect";
export type { Store } from "../store/store";
export { createStoreWithSchema } from "../store/store";
export type { Edge, Node } from "../store/types";
export { generateId } from "../utils/id";
