import { type EdgeType, type NodeType } from "../core/types";
import {
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
} from "./constants";
import { META_EDGE_BRAND, type MetaEdge, type OntologyRelation } from "./types";

// ============================================================
// Helper to Create Meta-Edge
// ============================================================

function createMetaEdge<K extends string>(
  name: K,
  properties: {
    transitive?: boolean;
    symmetric?: boolean;
    reflexive?: boolean;
    inverse?: string;
    inference:
      | "subsumption"
      | "hierarchy"
      | "substitution"
      | "constraint"
      | "composition"
      | "association"
      | "none";
    description: string;
  },
): MetaEdge<K> {
  return Object.freeze({
    [META_EDGE_BRAND]: true as const,
    name,
    properties: {
      transitive: properties.transitive ?? false,
      symmetric: properties.symmetric ?? false,
      reflexive: properties.reflexive ?? false,
      inverse: properties.inverse,
      inference: properties.inference,
      description: properties.description,
    },
  }) as MetaEdge<K>;
}

// ============================================================
// Subsumption & Classification
// ============================================================

/**
 * Type inheritance relationship.
 * A subClassOf B means instances of A are also instances of B.
 */
const subClassOfMetaEdge = createMetaEdge(META_EDGE_SUB_CLASS_OF, {
  transitive: true,
  inference: "subsumption",
  description: "Type inheritance (Podcast subClassOf Media)",
});

/**
 * Creates a subClassOf ontology relation.
 */
export function subClassOf(
  child: NodeType,
  parent: NodeType,
): OntologyRelation {
  return {
    metaEdge: subClassOfMetaEdge,
    from: child,
    to: parent,
  };
}

// ============================================================
// Hierarchical (SKOS-inspired)
// ============================================================

/**
 * Broader concept relationship.
 * A broader B means A is a more specific concept than B.
 */
const broaderMetaEdge = createMetaEdge(META_EDGE_BROADER, {
  transitive: true,
  inverse: META_EDGE_NARROWER,
  inference: "hierarchy",
  description: "Broader concept (ML broader AI)",
});

/**
 * Creates a broader ontology relation.
 */
export function broader(
  narrowerConcept: NodeType,
  broaderConcept: NodeType,
): OntologyRelation {
  return {
    metaEdge: broaderMetaEdge,
    from: narrowerConcept,
    to: broaderConcept,
  };
}

/**
 * Narrower concept relationship.
 * A narrower B means A is a more general concept than B.
 */
const narrowerMetaEdge = createMetaEdge(META_EDGE_NARROWER, {
  transitive: true,
  inverse: META_EDGE_BROADER,
  inference: "hierarchy",
  description: "Narrower concept (AI narrower ML)",
});

/**
 * Creates a narrower ontology relation.
 */
export function narrower(
  broaderConcept: NodeType,
  narrowerConcept: NodeType,
): OntologyRelation {
  return {
    metaEdge: narrowerMetaEdge,
    from: broaderConcept,
    to: narrowerConcept,
  };
}

/**
 * Related concept relationship.
 * Non-hierarchical association between concepts.
 */
const relatedToMetaEdge = createMetaEdge(META_EDGE_RELATED_TO, {
  symmetric: true,
  inference: "association",
  description: "Non-hierarchical association",
});

/**
 * Creates a relatedTo ontology relation.
 */
export function relatedTo(
  conceptA: NodeType,
  conceptB: NodeType,
): OntologyRelation {
  return {
    metaEdge: relatedToMetaEdge,
    from: conceptA,
    to: conceptB,
  };
}

// ============================================================
// Equivalence & Identity (OWL-inspired)
// ============================================================

/**
 * Type equivalence relationship.
 * A equivalentTo B means they represent the same class.
 */
const equivalentToMetaEdge = createMetaEdge(META_EDGE_EQUIVALENT_TO, {
  symmetric: true,
  transitive: true,
  inference: "substitution",
  description: "Same class, different representation",
});

/**
 * Creates an equivalentTo ontology relation.
 * Can be used with external IRIs for cross-system mapping.
 */
export function equivalentTo(
  kindA: NodeType,
  kindBOrIri: NodeType | string,
): OntologyRelation {
  return {
    metaEdge: equivalentToMetaEdge,
    from: kindA,
    to: kindBOrIri,
  };
}

/**
 * Instance identity relationship.
 * A sameAs B means they refer to the same individual.
 */
const sameAsMetaEdge = createMetaEdge(META_EDGE_SAME_AS, {
  symmetric: true,
  transitive: true,
  inference: "substitution",
  description: "Same individual (for deduplication)",
});

/**
 * Creates a sameAs ontology relation.
 */
export function sameAs(
  kindA: NodeType,
  kindBOrIri: NodeType | string,
): OntologyRelation {
  return {
    metaEdge: sameAsMetaEdge,
    from: kindA,
    to: kindBOrIri,
  };
}

/**
 * Explicit non-identity relationship.
 * A differentFrom B means they are definitely different individuals.
 */
const differentFromMetaEdge = createMetaEdge(META_EDGE_DIFFERENT_FROM, {
  symmetric: true,
  inference: "constraint",
  description: "Explicitly different individuals",
});

/**
 * Creates a differentFrom ontology relation.
 */
export function differentFrom(
  kindA: NodeType,
  kindB: NodeType,
): OntologyRelation {
  return {
    metaEdge: differentFromMetaEdge,
    from: kindA,
    to: kindB,
  };
}

/**
 * Disjoint types relationship.
 * A disjointWith B means nothing can be both an A and a B.
 */
const disjointWithMetaEdge = createMetaEdge(META_EDGE_DISJOINT_WITH, {
  symmetric: true,
  inference: "constraint",
  description: "Mutually exclusive types",
});

/**
 * Creates a disjointWith ontology relation.
 */
export function disjointWith(
  kindA: NodeType,
  kindB: NodeType,
): OntologyRelation {
  return {
    metaEdge: disjointWithMetaEdge,
    from: kindA,
    to: kindB,
  };
}

// ============================================================
// Mereological (Part-Whole)
// ============================================================

/**
 * Part-of relationship.
 * A partOf B means A is a component of B.
 */
const partOfMetaEdge = createMetaEdge(META_EDGE_PART_OF, {
  transitive: true,
  inverse: META_EDGE_HAS_PART,
  inference: "composition",
  description: "X is part of Y",
});

/**
 * Creates a partOf ontology relation.
 */
export function partOf(part: NodeType, whole: NodeType): OntologyRelation {
  return {
    metaEdge: partOfMetaEdge,
    from: part,
    to: whole,
  };
}

/**
 * Has-part relationship.
 * A hasPart B means A contains B as a component.
 */
const hasPartMetaEdge = createMetaEdge(META_EDGE_HAS_PART, {
  transitive: true,
  inverse: META_EDGE_PART_OF,
  inference: "composition",
  description: "Y has part X",
});

/**
 * Creates a hasPart ontology relation.
 */
export function hasPart(whole: NodeType, part: NodeType): OntologyRelation {
  return {
    metaEdge: hasPartMetaEdge,
    from: whole,
    to: part,
  };
}

// ============================================================
// Property Relationships
// ============================================================

/**
 * Inverse edge relationship.
 * Edge A inverseOf edge B means traversing A is equivalent to traversing B backwards.
 */
const inverseOfMetaEdge = createMetaEdge(META_EDGE_INVERSE_OF, {
  symmetric: true,
  inference: "none",
  description: "Edge A is inverse of edge B",
});

/**
 * Implication relationship.
 * Edge A implies edge B means if A exists, B should also exist.
 */
const impliesMetaEdge = createMetaEdge(META_EDGE_IMPLIES, {
  transitive: true,
  inference: "none",
  description: "Edge A implies edge B exists",
});

/**
 * Creates an inverseOf ontology relation.
 * Edge A inverseOf edge B means traversing A is equivalent to traversing B backwards.
 */
export function inverseOf(edgeA: EdgeType, edgeB: EdgeType): OntologyRelation {
  return {
    metaEdge: inverseOfMetaEdge,
    from: edgeA,
    to: edgeB,
  };
}

/**
 * Creates an implies ontology relation.
 * Edge A implies edge B means if A exists between two nodes, B should also exist.
 */
export function implies(edgeA: EdgeType, edgeB: EdgeType): OntologyRelation {
  return {
    metaEdge: impliesMetaEdge,
    from: edgeA,
    to: edgeB,
  };
}

// ============================================================
// Core Ontology Export
// ============================================================

/**
 * The core ontology module containing all built-in meta-edges
 * and their relation factory functions.
 */
export const core = {
  // Meta-edges
  subClassOfMetaEdge,
  broaderMetaEdge,
  narrowerMetaEdge,
  relatedToMetaEdge,
  equivalentToMetaEdge,
  sameAsMetaEdge,
  differentFromMetaEdge,
  disjointWithMetaEdge,
  partOfMetaEdge,
  hasPartMetaEdge,
  inverseOfMetaEdge,
  impliesMetaEdge,

  // Relation factories
  subClassOf,
  broader,
  narrower,
  relatedTo,
  equivalentTo,
  sameAs,
  differentFrom,
  disjointWith,
  partOf,
  hasPart,
  inverseOf,
  implies,
} as const;
