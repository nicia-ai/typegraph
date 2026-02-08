// Core meta-edges and relation factories
export {
  broader,
  core,
  differentFrom,
  disjointWith,
  equivalentTo,
  hasPart,
  implies,
  inverseOf,
  narrower,
  partOf,
  relatedTo,
  sameAs,
  subClassOf,
} from "./core-meta-edges";

// Named constants for meta-edge names
export {
  ALL_META_EDGE_NAMES,
  META_EDGE_BROADER,
  META_EDGE_DIFFERENT_FROM,
  META_EDGE_DISJOINT_WITH,
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_HAS_PART,
  META_EDGE_IMPLIES,
  META_EDGE_INVERSE_OF,
  META_EDGE_NARROWER,
  META_EDGE_PART_OF,
  META_EDGE_RELATED_TO,
  META_EDGE_SAME_AS,
  META_EDGE_SUB_CLASS_OF,
  type MetaEdgeName,
} from "./constants";

// Closure computation
export {
  computeTransitiveClosure,
  invertClosure,
  isReachable,
} from "./closures";

// Types
export {
  getTypeName,
  type InferenceType,
  isMetaEdge,
  META_EDGE_BRAND,
  type MetaEdge,
  type MetaEdgeProperties,
  type OntologyRelation,
} from "./types";
