/**
 * Types for serialized schema storage.
 *
 * These types represent the JSON-serializable format used for
 * homoiconic schema storage in the database.
 */
import {
  type Cardinality,
  type Collation,
  type DeleteBehavior,
  type EndpointExistence,
  type TemporalMode,
  type UniquenessScope,
} from "../core/types";
import { type InferenceType } from "../ontology/types";

// ============================================================
// JSON Schema Types (from Zod)
// ============================================================

/**
 * JSON Schema type (subset used by Zod toJSONSchema).
 *
 * This is a simplified version - the actual JSON Schema has many more properties.
 */
export type JsonSchema = Readonly<{
  $schema?: string;
  type?: string | readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  not?: JsonSchema;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  [key: string]: unknown;
}>;

// ============================================================
// Serialized Meta-Edge
// ============================================================

/**
 * Serialized representation of a meta-edge.
 */
export type SerializedMetaEdge = Readonly<{
  name: string;
  transitive: boolean;
  symmetric: boolean;
  reflexive: boolean;
  inverse: string | undefined;
  inference: InferenceType;
  description: string | undefined;
}>;

// ============================================================
// Serialized Ontology Relation
// ============================================================

/**
 * Serialized representation of an ontology relation.
 */
export type SerializedOntologyRelation = Readonly<{
  metaEdge: string; // Meta-edge name
  from: string; // Node kind name or external IRI
  to: string; // Node kind name or external IRI
}>;

// ============================================================
// Serialized Closures
// ============================================================

/**
 * Precomputed closures stored in the schema for fast runtime lookup.
 */
export type SerializedClosures = Readonly<{
  subClassAncestors: Record<string, readonly string[]>;
  subClassDescendants: Record<string, readonly string[]>;
  broaderClosure: Record<string, readonly string[]>;
  narrowerClosure: Record<string, readonly string[]>;
  equivalenceSets: Record<string, readonly string[]>;
  disjointPairs: readonly string[]; // ["Organization|Person", ...]
  partOfClosure: Record<string, readonly string[]>;
  hasPartClosure: Record<string, readonly string[]>;
  iriToKind: Record<string, string>;
  edgeInverses: Record<string, string>; // {"likes": "likedBy", ...}
  edgeImplicationsClosure: Record<string, readonly string[]>;
  edgeImplyingClosure: Record<string, readonly string[]>;
}>;

// ============================================================
// Serialized Ontology
// ============================================================

/**
 * Complete serialized ontology section.
 */
export type SerializedOntology = Readonly<{
  metaEdges: Record<string, SerializedMetaEdge>;
  relations: readonly SerializedOntologyRelation[];
  closures: SerializedClosures;
}>;

// ============================================================
// Serialized Uniqueness Constraint
// ============================================================

/**
 * Serialized representation of a uniqueness constraint.
 */
export type SerializedUniqueConstraint = Readonly<{
  name: string;
  fields: readonly string[];
  where: string | undefined; // Serialized predicate or undefined
  scope: UniquenessScope;
  collation: Collation;
}>;

// ============================================================
// Serialized Node Definition
// ============================================================

/**
 * Serialized representation of a node kind.
 */
export type SerializedNodeDef = Readonly<{
  name: string;
  properties: JsonSchema;
  uniqueConstraints: readonly SerializedUniqueConstraint[];
  onDelete: DeleteBehavior;
  description: string | undefined;
}>;

// ============================================================
// Serialized Edge Definition
// ============================================================

/**
 * Serialized representation of an edge kind.
 */
export type SerializedEdgeDef = Readonly<{
  name: string;
  fromKinds: readonly string[];
  toKinds: readonly string[];
  properties: JsonSchema;
  cardinality: Cardinality;
  endpointExistence: EndpointExistence;
  description: string | undefined;
}>;

// ============================================================
// Serialized Schema
// ============================================================

/**
 * Complete serialized schema document.
 *
 * This is the format stored in the schema_doc column of
 * typegraph_schema_versions.
 */
export type SerializedSchema = Readonly<{
  // Metadata
  graphId: string;
  version: number;
  generatedAt: string; // ISO 8601 timestamp

  // Node definitions
  nodes: Record<string, SerializedNodeDef>;

  // Edge definitions
  edges: Record<string, SerializedEdgeDef>;

  // Ontology
  ontology: SerializedOntology;

  // Graph-wide settings
  defaults: Readonly<{
    onNodeDelete: DeleteBehavior;
    temporalMode: TemporalMode;
  }>;
}>;

// ============================================================
// Schema Hash
// ============================================================

/**
 * A schema hash for detecting changes.
 *
 * We hash the schema content (excluding version and generatedAt)
 * to detect if the schema has actually changed.
 */
export type SchemaHash = string;
