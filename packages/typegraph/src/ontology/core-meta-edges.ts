import { type AnyEdgeType, type NodeType } from "../core/types";
import { type CompositionPartSide } from "../registry/composition-relation";
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
  type MetaEdgeName,
} from "./constants";
import {
  type EquivalentToCheck,
  META_EDGE_BRAND,
  type MetaEdge,
  type OntologyRelation,
  type SubClassOfCheck,
  type TypedOntologyRelation,
} from "./types";

// ============================================================
// Helper to Create Meta-Edge
// ============================================================

function createMetaEdge<K extends string>(
  name: K,
  description: string,
): MetaEdge<K> {
  return Object.freeze({
    [META_EDGE_BRAND]: true as const,
    name,
    properties: { description },
  });
}

// ============================================================
// Subsumption & Classification
// ============================================================

/**
 * Type inheritance relationship.
 * A subClassOf B means instances of A are also instances of B.
 */
const subClassOfMetaEdge = createMetaEdge(
  META_EDGE_SUB_CLASS_OF,
  "Type inheritance (Podcast subClassOf Media)",
);

/**
 * Creates a subClassOf ontology relation.
 *
 * Compile-time structural contract (C.1, roadmap D2): `child`'s schema
 * output must structurally extend `parent`'s — every property `parent`
 * requires, `child` has with a compatible type; `child` may add properties
 * or narrow an optional-in-parent property. A pair that fails this is
 * refused at compile time with a {@link SubClassOfCheck} mismatch naming
 * the incompatible fields, and — for pairs the type checker cannot see
 * through (refinements, transforms, value-level constraints) — at registry
 * build time by the authoritative runtime check
 * (`src/registry/validate-structural-subsumption.ts`). C.1 is a filter, not
 * the authority: it accepts strictly more than the registry does, never
 * less.
 *
 * A hierarchy that is a taxonomy rather than a subtype relationship — the
 * child does not extend the parent's schema — should use `broader(child,
 * parent)` instead; see `includeNarrower` for kind-level taxonomy queries.
 */
export function subClassOf<C extends NodeType, P extends NodeType>(
  child: C,
  parent: P & SubClassOfCheck<C, P>,
): TypedOntologyRelation<typeof META_EDGE_SUB_CLASS_OF, C, P> {
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
const broaderMetaEdge = createMetaEdge(
  META_EDGE_BROADER,
  "Broader concept (ML broader AI)",
);

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
const narrowerMetaEdge = createMetaEdge(
  META_EDGE_NARROWER,
  "Narrower concept (AI narrower ML)",
);

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
const relatedToMetaEdge = createMetaEdge(
  META_EDGE_RELATED_TO,
  "Non-hierarchical association",
);

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
const equivalentToMetaEdge = createMetaEdge(
  META_EDGE_EQUIVALENT_TO,
  "Same class, different representation",
);

/**
 * Creates an equivalentTo ontology relation.
 *
 * Between two registered kinds, `equivalentTo` is MUTUAL SUBSUMPTION (D1):
 * `KindRegistry` folds the class into `subClassAncestors`/`subClassDescendants`
 * before the transitive closure, so `isAssignableTo`, `expandSubClasses`,
 * disjointness propagation and the `kindWithSubClasses` claim axis all agree
 * that the two kinds are substitutable. Subsumption is a node-kind relation,
 * so the left parameter widens to `NodeType | AnyEdgeType` only so an edge
 * kind can be mapped to an external IRI for cross-system mapping — an edge
 * kind equivalenced to a registered node or edge kind is refused at registry
 * build (`ONTOLOGY_EQUIVALENCE_INVALID_CLASS`).
 *
 * Between two node kinds this carries the same compile-time structural
 * contract as `subClassOf` (C.1), checked in BOTH directions -- mutual
 * subsumption means each kind's schema must extend the other's. The IRI
 * form (`equivalentTo(kind, iri)`) and the edge-to-node form carry no
 * check: an external IRI, and an edge kind paired with a node kind (always
 * refused at registry build), have no comparable schema pair.
 *
 * `sameAs` (removed, roadmap F) was a type-level alias of this relation: a
 * document persisted before the removal that still names a `sameAs`
 * relation continues to load and fold into the same equivalence bucket as
 * `equivalentTo` — `collectOntologyRelations`
 * (`src/registry/kind-registry.ts`) switches on the meta-edge name, not on
 * whether the deleted factory produced it.
 */
export function equivalentTo<A extends NodeType, B extends NodeType>(
  kindA: A,
  kindB: B & EquivalentToCheck<A, B>,
): TypedOntologyRelation<typeof META_EDGE_EQUIVALENT_TO, A, B>;
export function equivalentTo(
  kindA: NodeType | AnyEdgeType,
  kindBOrIri: string,
): OntologyRelation;
export function equivalentTo(
  kindA: AnyEdgeType,
  kindB: NodeType,
): OntologyRelation;
export function equivalentTo(
  kindA: NodeType | AnyEdgeType,
  kindBOrIri: NodeType | string,
): OntologyRelation {
  return {
    metaEdge: equivalentToMetaEdge,
    from: kindA,
    to: kindBOrIri,
  };
}

/**
 * `sameAs`'s meta-edge object. The public `sameAs()`/`differentFrom()`
 * factories were removed (roadmap F, R1), and neither this object nor
 * {@link differentFromMetaEdge} is a member of the public `core` export: a
 * new graph definition cannot construct a relation carrying either name any
 * more, whether through a factory or by reaching into `core` directly.
 * `buildRegistryFromSerializedSchema` needs neither object — a persisted
 * document's relations carry the meta-edge as a plain string name, and
 * `collectOntologyRelations` (`src/registry/kind-registry.ts`) switches on
 * that string. The one reader that still resolves a meta-edge NAME to its
 * object is `compileOntologyRelation` (`src/graph-extension/compiler.ts`,
 * compiling a declarative graph extension into the same `OntologyRelation`
 * shape a compile-time factory produces): it looks every
 * `ALL_META_EDGE_NAMES` member up by `${name}MetaEdge` through
 * {@link metaEdgesByName} below, the one internal record both deprecated
 * meta-edges are exported for.
 */
const sameAsMetaEdge = createMetaEdge(
  META_EDGE_SAME_AS,
  "Deprecated type-level equivalence alias",
);

/** See {@link sameAsMetaEdge} — the `differentFrom` counterpart. */
const differentFromMetaEdge = createMetaEdge(
  META_EDGE_DIFFERENT_FROM,
  "Deprecated decorative type-level non-identity relation",
);

/**
 * Disjoint types relationship.
 * A disjointWith B means nothing can be both an A and a B.
 */
const disjointWithMetaEdge = createMetaEdge(
  META_EDGE_DISJOINT_WITH,
  "Mutually exclusive types",
);

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
const partOfMetaEdge = createMetaEdge(META_EDGE_PART_OF, "X is part of Y");

/**
 * The options every composition relation (`partOf`/`hasPart`) requires.
 */
export type CompositionOptions = Readonly<{
  /** The edge kind that realizes the composition instance-level. */
  via: AnyEdgeType;
  /** R5: required only when the edge admits both orientations (e.g. same-kind containment). */
  partSide?: CompositionPartSide;
}>;

/**
 * Creates a partOf ontology relation.
 *
 * `via` names the edge kind whose live rows realize this composition; a
 * typo is a compile error because it is the edge's TYPE, not its name.
 */
export function partOf(
  part: NodeType,
  whole: NodeType,
  options: CompositionOptions,
): OntologyRelation {
  return {
    metaEdge: partOfMetaEdge,
    from: part,
    to: whole,
    via: options.via.kind,
    ...(options.partSide === undefined ? {} : { partSide: options.partSide }),
  };
}

/**
 * Has-part relationship.
 * A hasPart B means A contains B as a component.
 */
const hasPartMetaEdge = createMetaEdge(META_EDGE_HAS_PART, "Y has part X");

/**
 * Creates a hasPart ontology relation.
 *
 * `via` names the edge kind whose live rows realize this composition; a
 * typo is a compile error because it is the edge's TYPE, not its name.
 */
export function hasPart(
  whole: NodeType,
  part: NodeType,
  options: CompositionOptions,
): OntologyRelation {
  return {
    metaEdge: hasPartMetaEdge,
    from: whole,
    to: part,
    via: options.via.kind,
    ...(options.partSide === undefined ? {} : { partSide: options.partSide }),
  };
}

// ============================================================
// Property Relationships
// ============================================================

/**
 * Inverse edge relationship.
 * Edge A inverseOf edge B means traversing A is equivalent to traversing B backwards.
 */
const inverseOfMetaEdge = createMetaEdge(
  META_EDGE_INVERSE_OF,
  "Edge A is inverse of edge B",
);

/**
 * Implication relationship.
 * Edge A implies edge B means if A exists, B should also exist.
 */
const impliesMetaEdge = createMetaEdge(
  META_EDGE_IMPLIES,
  "Edge A implies edge B exists",
);

/**
 * Creates an inverseOf ontology relation.
 * Edge A inverseOf edge B means traversing A is equivalent to traversing B backwards.
 */
export function inverseOf(
  edgeA: AnyEdgeType,
  edgeB: AnyEdgeType,
): OntologyRelation {
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
export function implies(
  edgeA: AnyEdgeType,
  edgeB: AnyEdgeType,
): OntologyRelation {
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
 * The core ontology module containing all built-in meta-edges and their
 * relation factory functions. Deliberately excludes `sameAsMetaEdge` and
 * `differentFromMetaEdge` (roadmap F, R1 fix): a package consumer with
 * `core` in hand cannot construct a `sameAs`/`differentFrom` relation by
 * reaching into it any more than by calling the deleted factories — see
 * {@link metaEdgesByName} below for the internal-only record that still
 * carries them.
 */
export const core = {
  // Meta-edges
  subClassOfMetaEdge,
  broaderMetaEdge,
  narrowerMetaEdge,
  relatedToMetaEdge,
  equivalentToMetaEdge,
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
  disjointWith,
  partOf,
  hasPart,
  inverseOf,
  implies,
} as const;

// ============================================================
// Internal by-name lookup (NOT part of the public `core` export)
// ============================================================

/**
 * Every built-in meta-edge by name, including `sameAs`/`differentFrom` —
 * which have no public factory and are absent from the public `core`
 * export above. This record is kept, per roadmap F ruling F-2, for exactly
 * as long as PERSISTED-DOCUMENT interpretation needs it: a `schema_doc`
 * committed before this removal can carry a `sameAs`/`differentFrom`
 * relation by name (`SerializedOntology.relations`,
 * `src/schema/types.ts`), and `collectOntologyRelations`
 * (`src/registry/kind-registry.ts`) must still fold that name into the same
 * `KindRegistry` state the pre-removal code produced when the document
 * loads.
 *
 * `compileOntologyRelation` (`src/graph-extension/compiler.ts`) is the one
 * reader that resolves an `ALL_META_EDGE_NAMES` member to its `MetaEdge`
 * object this way, by name, rather than through a factory. That path
 * compiles a DECLARATIVE graph extension, not only a persisted document —
 * and `ALL_META_EDGE_NAMES` stays closed, not narrowed, so a new extension
 * naming `sameAs`/`differentFrom` still compiles today. That is by design:
 * the closed name set is what graph extensions validate against
 * (`src/graph-extension/validation.ts`), and narrowing it to exclude these
 * two names — rather than merely declining to ship a public factory or
 * relation-declaration sugar for them — was never part of this removal.
 *
 * Not re-exported from `../ontology` or the package root — reach it only by
 * importing `./core-meta-edges` directly from inside this package.
 */
export const metaEdgesByName: Readonly<Record<MetaEdgeName, MetaEdge>> = {
  [META_EDGE_SUB_CLASS_OF]: subClassOfMetaEdge,
  [META_EDGE_BROADER]: broaderMetaEdge,
  [META_EDGE_NARROWER]: narrowerMetaEdge,
  [META_EDGE_RELATED_TO]: relatedToMetaEdge,
  [META_EDGE_EQUIVALENT_TO]: equivalentToMetaEdge,
  [META_EDGE_SAME_AS]: sameAsMetaEdge,
  [META_EDGE_DIFFERENT_FROM]: differentFromMetaEdge,
  [META_EDGE_DISJOINT_WITH]: disjointWithMetaEdge,
  [META_EDGE_PART_OF]: partOfMetaEdge,
  [META_EDGE_HAS_PART]: hasPartMetaEdge,
  [META_EDGE_INVERSE_OF]: inverseOfMetaEdge,
  [META_EDGE_IMPLIES]: impliesMetaEdge,
};
