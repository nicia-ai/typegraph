/**
 * Named constants for ontology meta-edge names.
 *
 * Use these constants instead of string literals for type safety
 * and IDE support.
 */

// ============================================================
// Meta-Edge Names
// ============================================================

/** Type inheritance (Podcast subClassOf Media) */
export const META_EDGE_SUB_CLASS_OF = "subClassOf" as const;

/** Broader concept (ML broader AI) */
export const META_EDGE_BROADER = "broader" as const;

/** Narrower concept (AI narrower ML) */
export const META_EDGE_NARROWER = "narrower" as const;

/** Non-hierarchical association */
export const META_EDGE_RELATED_TO = "relatedTo" as const;

/** Same class, different representation */
export const META_EDGE_EQUIVALENT_TO = "equivalentTo" as const;

/** Same individual (for deduplication) */
export const META_EDGE_SAME_AS = "sameAs" as const;

/** Explicitly different individuals */
export const META_EDGE_DIFFERENT_FROM = "differentFrom" as const;

/** Mutually exclusive types */
export const META_EDGE_DISJOINT_WITH = "disjointWith" as const;

/** X is part of Y */
export const META_EDGE_PART_OF = "partOf" as const;

/** Y has part X */
export const META_EDGE_HAS_PART = "hasPart" as const;

/** Edge A is inverse of edge B */
export const META_EDGE_INVERSE_OF = "inverseOf" as const;

/** Edge A implies edge B exists */
export const META_EDGE_IMPLIES = "implies" as const;

// ============================================================
// All Meta-Edge Names (for validation)
// ============================================================

export const ALL_META_EDGE_NAMES = [
  META_EDGE_SUB_CLASS_OF,
  META_EDGE_BROADER,
  META_EDGE_NARROWER,
  META_EDGE_RELATED_TO,
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_SAME_AS,
  META_EDGE_DIFFERENT_FROM,
  META_EDGE_DISJOINT_WITH,
  META_EDGE_PART_OF,
  META_EDGE_HAS_PART,
  META_EDGE_INVERSE_OF,
  META_EDGE_IMPLIES,
] as const;

export type MetaEdgeName = (typeof ALL_META_EDGE_NAMES)[number];
