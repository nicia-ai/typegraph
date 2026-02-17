import { type EdgeType, type NodeType } from "../core/types";

// ============================================================
// Brand Key
// ============================================================

/** Brand key for MetaEdge */
export const META_EDGE_BRAND = "__metaEdge" as const;

// ============================================================
// Inference Types
// ============================================================

/**
 * How a meta-edge affects queries and validation.
 */
export type InferenceType =
  | "subsumption" // Query for X includes instances of subclasses
  | "hierarchy" // Enables broader/narrower traversal
  | "substitution" // Can substitute equivalent types
  | "constraint" // Validation rules
  | "composition" // Part-whole navigation
  | "association" // Discovery/recommendation
  | "none"; // No automatic inference

// ============================================================
// Meta-Edge Properties
// ============================================================

/**
 * Properties of a meta-edge.
 */
export type MetaEdgeProperties = Readonly<{
  transitive: boolean; // A→B, B→C implies A→C
  symmetric: boolean; // A→B implies B→A
  reflexive: boolean; // A→A is always true
  inverse: string | undefined; // Name of inverse meta-edge
  inference: InferenceType; // How this affects queries
  description: string | undefined;
}>;

// ============================================================
// Meta-Edge Type
// ============================================================

/**
 * A meta-edge definition.
 *
 * Meta-edges represent type-level relationships (between kinds),
 * not instance-level relationships (between nodes).
 */
export type MetaEdge<K extends string = string> = Readonly<{
  [META_EDGE_BRAND]: true;
  name: K;
  properties: MetaEdgeProperties;
}>;

// ============================================================
// Ontology Relation
// ============================================================

/**
 * A relation in the ontology (instance of meta-edge between types).
 *
 * @example
 * ```typescript
 * // Podcast subClassOf Media
 * subClassOf(Podcast, Media)
 *
 * // Person equivalentTo schema:Person
 * equivalentTo(Person, "https://schema.org/Person")
 * ```
 */
export type OntologyRelation = Readonly<{
  metaEdge: MetaEdge;
  from: NodeType | EdgeType | string; // string for external IRIs
  to: NodeType | EdgeType | string;
}>;

// ============================================================
// Type Guards
// ============================================================

/**
 * Checks if a value is a MetaEdge.
 */
export function isMetaEdge(value: unknown): value is MetaEdge {
  return (
    typeof value === "object" &&
    value !== null &&
    META_EDGE_BRAND in value &&
    (value as Record<string, unknown>)[META_EDGE_BRAND] === true
  );
}

/**
 * Gets the type name from a NodeType, EdgeType, or IRI string.
 */
export function getTypeName(typeOrIri: NodeType | EdgeType | string): string {
  if (typeof typeOrIri === "string") {
    return typeOrIri;
  }
  return typeOrIri.kind;
}
