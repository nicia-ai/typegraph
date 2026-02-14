import { type AnyEdgeType, type NodeType } from "../core/types";
import {
  computeTransitiveClosure,
  invertClosure,
  isReachable,
} from "../ontology/closures";
import {
  META_EDGE_BROADER,
  META_EDGE_DISJOINT_WITH,
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_HAS_PART,
  META_EDGE_IMPLIES,
  META_EDGE_INVERSE_OF,
  META_EDGE_NARROWER,
  META_EDGE_PART_OF,
  META_EDGE_SAME_AS,
  META_EDGE_SUB_CLASS_OF,
} from "../ontology/constants";
import { type OntologyRelation } from "../ontology/types";

/**
 * KindRegistry holds precomputed closures for ontological reasoning.
 *
 * Computed at store initialization and cached for fast query-time lookups.
 */
export class KindRegistry {
  // === Node & Edge Kinds ===
  readonly nodeKinds: ReadonlyMap<string, NodeType>;
  readonly edgeKinds: ReadonlyMap<string, AnyEdgeType>;

  // === Subsumption (subClassOf) ===
  // Transitive closure for inheritance
  readonly subClassAncestors: ReadonlyMap<string, ReadonlySet<string>>;
  readonly subClassDescendants: ReadonlyMap<string, ReadonlySet<string>>;

  // === Hierarchy (broader/narrower) ===
  // Transitive closure for concept hierarchy (separate from subClassOf!)
  readonly broaderClosure: ReadonlyMap<string, ReadonlySet<string>>;
  readonly narrowerClosure: ReadonlyMap<string, ReadonlySet<string>>;

  // === Equivalence ===
  readonly equivalenceSets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly iriToKind: ReadonlyMap<string, string>;

  // === Constraints ===
  readonly disjointPairs: ReadonlySet<string>; // Normalized pairs: "Organization|Person"

  // === Composition ===
  readonly partOfClosure: ReadonlyMap<string, ReadonlySet<string>>;
  readonly hasPartClosure: ReadonlyMap<string, ReadonlySet<string>>;

  // === Edge Relationships ===
  readonly edgeInverses: ReadonlyMap<string, string>;
  readonly edgeImplicationsClosure: ReadonlyMap<string, ReadonlySet<string>>;
  readonly edgeImplyingClosure: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(
    nodeKinds: ReadonlyMap<string, NodeType>,
    edgeKinds: ReadonlyMap<string, AnyEdgeType>,
    closures: {
      subClassAncestors: ReadonlyMap<string, ReadonlySet<string>>;
      subClassDescendants: ReadonlyMap<string, ReadonlySet<string>>;
      broaderClosure: ReadonlyMap<string, ReadonlySet<string>>;
      narrowerClosure: ReadonlyMap<string, ReadonlySet<string>>;
      equivalenceSets: ReadonlyMap<string, ReadonlySet<string>>;
      iriToKind: ReadonlyMap<string, string>;
      disjointPairs: ReadonlySet<string>;
      partOfClosure: ReadonlyMap<string, ReadonlySet<string>>;
      hasPartClosure: ReadonlyMap<string, ReadonlySet<string>>;
      edgeInverses: ReadonlyMap<string, string>;
      edgeImplicationsClosure: ReadonlyMap<string, ReadonlySet<string>>;
      edgeImplyingClosure: ReadonlyMap<string, ReadonlySet<string>>;
    },
  ) {
    this.nodeKinds = nodeKinds;
    this.edgeKinds = edgeKinds;
    this.subClassAncestors = closures.subClassAncestors;
    this.subClassDescendants = closures.subClassDescendants;
    this.broaderClosure = closures.broaderClosure;
    this.narrowerClosure = closures.narrowerClosure;
    this.equivalenceSets = closures.equivalenceSets;
    this.iriToKind = closures.iriToKind;
    this.disjointPairs = closures.disjointPairs;
    this.partOfClosure = closures.partOfClosure;
    this.hasPartClosure = closures.hasPartClosure;
    this.edgeInverses = closures.edgeInverses;
    this.edgeImplicationsClosure = closures.edgeImplicationsClosure;
    this.edgeImplyingClosure = closures.edgeImplyingClosure;
  }

  // === Subsumption Methods ===

  /**
   * Checks if child is a subclass of parent (directly or transitively).
   */
  isSubClassOf(child: string, parent: string): boolean {
    return isReachable(this.subClassAncestors, child, parent);
  }

  /**
   * Expands a kind to include all its subclasses.
   * Returns [kind, ...subclasses].
   */
  expandSubClasses(kind: string): readonly string[] {
    const descendants = this.subClassDescendants.get(kind) ?? new Set();
    return [kind, ...descendants];
  }

  /**
   * Gets all ancestors of a kind (via subClassOf).
   */
  getAncestors(kind: string): ReadonlySet<string> {
    return this.subClassAncestors.get(kind) ?? new Set();
  }

  /**
   * Gets all descendants of a kind (via subClassOf).
   */
  getDescendants(kind: string): ReadonlySet<string> {
    return this.subClassDescendants.get(kind) ?? new Set();
  }

  // === Hierarchy Methods ===

  /**
   * Checks if narrowerConcept is narrower than broaderConcept.
   */
  isNarrowerThan(narrowerConcept: string, broaderConcept: string): boolean {
    return isReachable(this.broaderClosure, narrowerConcept, broaderConcept);
  }

  /**
   * Checks if broaderConcept is broader than narrowerConcept.
   */
  isBroaderThan(broaderConcept: string, narrowerConcept: string): boolean {
    return isReachable(this.narrowerClosure, broaderConcept, narrowerConcept);
  }

  /**
   * Expands to include all narrower concepts.
   */
  expandNarrower(kind: string): readonly string[] {
    const narrower = this.narrowerClosure.get(kind) ?? new Set();
    return [kind, ...narrower];
  }

  /**
   * Expands to include all broader concepts.
   */
  expandBroader(kind: string): readonly string[] {
    const broader = this.broaderClosure.get(kind) ?? new Set();
    return [kind, ...broader];
  }

  // === Equivalence Methods ===

  /**
   * Checks if two kinds are equivalent.
   */
  areEquivalent(a: string, b: string): boolean {
    const equivalents = this.equivalenceSets.get(a);
    return equivalents?.has(b) ?? false;
  }

  /**
   * Gets all equivalents of a kind (including external IRIs).
   */
  getEquivalents(kind: string): readonly string[] {
    const equivalents = this.equivalenceSets.get(kind);
    return equivalents ? [...equivalents] : [];
  }

  /**
   * Resolves an external IRI to an internal kind name.
   */
  resolveIri(iri: string): string | undefined {
    return this.iriToKind.get(iri);
  }

  // === Constraint Methods ===

  /**
   * Checks if two kinds are disjoint.
   */
  areDisjoint(a: string, b: string): boolean {
    const normalizedPair = a < b ? `${a}|${b}` : `${b}|${a}`;
    return this.disjointPairs.has(normalizedPair);
  }

  /**
   * Gets all kinds that are disjoint with the given kind.
   */
  getDisjointKinds(kind: string): readonly string[] {
    const result: string[] = [];
    for (const pair of this.disjointPairs) {
      const parts = pair.split("|");
      const a = parts[0]!;
      const b = parts[1]!;
      if (a === kind) result.push(b);
      else if (b === kind) result.push(a);
    }
    return result;
  }

  // === Composition Methods ===

  /**
   * Checks if part is part of whole (directly or transitively).
   */
  isPartOf(part: string, whole: string): boolean {
    return isReachable(this.partOfClosure, part, whole);
  }

  /**
   * Gets all wholes that contain this part.
   */
  getWholes(part: string): readonly string[] {
    const wholes = this.partOfClosure.get(part);
    return wholes ? [...wholes] : [];
  }

  /**
   * Gets all parts of this whole.
   */
  getParts(whole: string): readonly string[] {
    const parts = this.hasPartClosure.get(whole);
    return parts ? [...parts] : [];
  }

  // === Edge Relationship Methods ===

  /**
   * Gets the inverse edge kind for a given edge kind.
   * If edgeA inverseOf edgeB, then getInverseEdge("edgeA") returns "edgeB".
   */
  getInverseEdge(edgeKind: string): string | undefined {
    return this.edgeInverses.get(edgeKind);
  }

  /**
   * Gets all edges implied by a given edge (transitively).
   * If A implies B and B implies C, then getImpliedEdges("A") returns ["B", "C"].
   */
  getImpliedEdges(edgeKind: string): readonly string[] {
    const implied = this.edgeImplicationsClosure.get(edgeKind);
    return implied ? [...implied] : [];
  }

  /**
   * Gets all edges that imply a given edge (transitively).
   * If A implies B and B implies C, then getImplyingEdges("C") returns ["A", "B"].
   * Used for query-time expansion: when querying for C, also include A and B edges.
   */
  getImplyingEdges(edgeKind: string): readonly string[] {
    const implying = this.edgeImplyingClosure.get(edgeKind);
    return implying ? [...implying] : [];
  }

  /**
   * Expands an edge kind to include all edges that imply it.
   * Returns [edgeKind, ...implyingEdges].
   */
  expandImplyingEdges(edgeKind: string): readonly string[] {
    const implying = this.edgeImplyingClosure.get(edgeKind) ?? new Set();
    return [edgeKind, ...implying];
  }

  // === Edge Endpoint Validation ===

  /**
   * Checks if a concrete kind is assignable to a target kind.
   * Uses subsumption: Company is assignable to Organization if Company subClassOf Organization.
   */
  isAssignableTo(concreteKind: string, targetKind: string): boolean {
    if (concreteKind === targetKind) return true;
    return this.isSubClassOf(concreteKind, targetKind);
  }

  /**
   * Validates that a kind exists in the registry.
   */
  hasNodeType(name: string): boolean {
    return this.nodeKinds.has(name);
  }

  /**
   * Validates that an edge kind exists in the registry.
   */
  hasEdgeType(name: string): boolean {
    return this.edgeKinds.has(name);
  }

  /**
   * Gets a node kind by name.
   */
  getNodeType(name: string): NodeType | undefined {
    return this.nodeKinds.get(name);
  }

  /**
   * Gets an edge kind by name.
   */
  getEdgeType(name: string): AnyEdgeType | undefined {
    return this.edgeKinds.get(name);
  }
}

/**
 * Builder function to create empty closures.
 */
export function createEmptyClosures(): {
  subClassAncestors: ReadonlyMap<string, ReadonlySet<string>>;
  subClassDescendants: ReadonlyMap<string, ReadonlySet<string>>;
  broaderClosure: ReadonlyMap<string, ReadonlySet<string>>;
  narrowerClosure: ReadonlyMap<string, ReadonlySet<string>>;
  equivalenceSets: ReadonlyMap<string, ReadonlySet<string>>;
  iriToKind: ReadonlyMap<string, string>;
  disjointPairs: ReadonlySet<string>;
  partOfClosure: ReadonlyMap<string, ReadonlySet<string>>;
  hasPartClosure: ReadonlyMap<string, ReadonlySet<string>>;
  edgeInverses: ReadonlyMap<string, string>;
  edgeImplicationsClosure: ReadonlyMap<string, ReadonlySet<string>>;
  edgeImplyingClosure: ReadonlyMap<string, ReadonlySet<string>>;
} {
  return {
    subClassAncestors: new Map(),
    subClassDescendants: new Map(),
    broaderClosure: new Map(),
    narrowerClosure: new Map(),
    equivalenceSets: new Map(),
    iriToKind: new Map(),
    disjointPairs: new Set(),
    partOfClosure: new Map(),
    hasPartClosure: new Map(),
    edgeInverses: new Map(),
    edgeImplicationsClosure: new Map(),
    edgeImplyingClosure: new Map(),
  };
}

/**
 * Computes all closures from an ontology.
 */
export function computeClosuresFromOntology(
  ontology: readonly OntologyRelation[],
): {
  subClassAncestors: ReadonlyMap<string, ReadonlySet<string>>;
  subClassDescendants: ReadonlyMap<string, ReadonlySet<string>>;
  broaderClosure: ReadonlyMap<string, ReadonlySet<string>>;
  narrowerClosure: ReadonlyMap<string, ReadonlySet<string>>;
  equivalenceSets: ReadonlyMap<string, ReadonlySet<string>>;
  iriToKind: ReadonlyMap<string, string>;
  disjointPairs: ReadonlySet<string>;
  partOfClosure: ReadonlyMap<string, ReadonlySet<string>>;
  hasPartClosure: ReadonlyMap<string, ReadonlySet<string>>;
  edgeInverses: ReadonlyMap<string, string>;
  edgeImplicationsClosure: ReadonlyMap<string, ReadonlySet<string>>;
  edgeImplyingClosure: ReadonlyMap<string, ReadonlySet<string>>;
} {
  // Collect relations by type
  const subClassRelations: [string, string][] = [];
  const broaderRelations: [string, string][] = [];
  const equivalentRelations: [string, string][] = [];
  const disjointRelations: [string, string][] = [];
  const partOfRelations: [string, string][] = [];
  const inverseOfRelations: [string, string][] = [];
  const impliesRelations: [string, string][] = [];

  for (const relation of ontology) {
    const fromName = getKindName(relation.from);
    const toName = getKindName(relation.to);

    switch (relation.metaEdge.name) {
      case META_EDGE_SUB_CLASS_OF: {
        subClassRelations.push([fromName, toName]);
        break;
      }
      case META_EDGE_BROADER: {
        broaderRelations.push([fromName, toName]);
        break;
      }
      case META_EDGE_NARROWER: {
        // narrower is inverse of broader
        broaderRelations.push([toName, fromName]);
        break;
      }
      case META_EDGE_EQUIVALENT_TO:
      case META_EDGE_SAME_AS: {
        equivalentRelations.push([fromName, toName]);
        break;
      }
      case META_EDGE_DISJOINT_WITH: {
        disjointRelations.push([fromName, toName]);
        break;
      }
      case META_EDGE_PART_OF: {
        partOfRelations.push([fromName, toName]);
        break;
      }
      case META_EDGE_HAS_PART: {
        // hasPart is inverse of partOf
        partOfRelations.push([toName, fromName]);
        break;
      }
      case META_EDGE_INVERSE_OF: {
        // inverseOf is symmetric: if A inverseOf B, then B inverseOf A
        inverseOfRelations.push([fromName, toName]);
        break;
      }
      case META_EDGE_IMPLIES: {
        impliesRelations.push([fromName, toName]);
        break;
      }
    }
  }

  // Compute subClassOf closures
  const subClassAncestors = computeTransitiveClosure(subClassRelations);
  const subClassDescendants = invertClosure(subClassAncestors);

  // Compute broader/narrower closures
  const broaderClosure = computeTransitiveClosure(broaderRelations);
  const narrowerClosure = invertClosure(broaderClosure);

  // Compute equivalence sets and IRI mappings
  const equivalenceSets = computeEquivalenceSets(equivalentRelations);
  const iriToKind = computeIriMapping(equivalentRelations);

  // Compute disjoint pairs (normalize for symmetric lookup)
  const disjointPairs = computeDisjointPairs(disjointRelations);

  // Compute partOf closures
  const partOfClosure = computeTransitiveClosure(partOfRelations);
  const hasPartClosure = invertClosure(partOfClosure);

  // Compute edge inverses (symmetric: store both directions)
  const edgeInverses = computeEdgeInverses(inverseOfRelations);

  // Compute edge implications closure (transitive)
  // edgeImplicationsClosure: A -> [B, C] means A implies B and C
  // edgeImplyingClosure: C -> [A, B] means A and B imply C (inverse direction)
  const edgeImplicationsClosure = computeTransitiveClosure(impliesRelations);
  const edgeImplyingClosure = invertClosure(edgeImplicationsClosure);

  return {
    subClassAncestors,
    subClassDescendants,
    broaderClosure,
    narrowerClosure,
    equivalenceSets,
    iriToKind,
    disjointPairs,
    partOfClosure,
    hasPartClosure,
    edgeInverses,
    edgeImplicationsClosure,
    edgeImplyingClosure,
  };
}

/**
 * Gets the name from a NodeType, EdgeType, or string.
 */
function getKindName(kindOrIri: NodeType | AnyEdgeType | string): string {
  if (typeof kindOrIri === "string") {
    return kindOrIri;
  }
  return kindOrIri.kind;
}

/**
 * Checks if a string is an external IRI (not a local kind name).
 */
function isExternalIri(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * Computes equivalence sets (symmetric + transitive closure).
 */
function computeEquivalenceSets(
  relations: readonly (readonly [string, string])[],
): ReadonlyMap<string, ReadonlySet<string>> {
  // Use union-find to compute equivalence classes
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) {
      parent.set(x, x);
      return x;
    }
    // Safe: has() check above guarantees key exists
    const p = parent.get(x)!;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root); // Path compression
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootA, rootB);
    }
  }

  // Build equivalence classes
  for (const [a, b] of relations) {
    union(a, b);
  }

  // Collect all members of each equivalence class
  const classes = new Map<string, Set<string>>();
  for (const key of parent.keys()) {
    const root = find(key);
    const existing = classes.get(root) ?? new Set();
    existing.add(key);
    classes.set(root, existing);
  }

  // Build result: each node maps to its equivalence set
  const result = new Map<string, ReadonlySet<string>>();
  for (const members of classes.values()) {
    for (const member of members) {
      // Exclude self from equivalence set
      const others = new Set(members);
      others.delete(member);
      result.set(member, others);
    }
  }

  return result;
}

/**
 * Computes mapping from external IRIs to internal kind names.
 */
function computeIriMapping(
  relations: readonly (readonly [string, string])[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();

  for (const [a, b] of relations) {
    // If one is an IRI and other is a kind name, map IRI → kind
    if (isExternalIri(a) && !isExternalIri(b)) {
      result.set(a, b);
    } else if (isExternalIri(b) && !isExternalIri(a)) {
      result.set(b, a);
    }
  }

  return result;
}

/**
 * Computes normalized disjoint pairs.
 */
function computeDisjointPairs(
  relations: readonly (readonly [string, string])[],
): ReadonlySet<string> {
  const result = new Set<string>();

  for (const [a, b] of relations) {
    // Normalize pair for consistent lookup
    const normalized = a < b ? `${a}|${b}` : `${b}|${a}`;
    result.add(normalized);
  }

  return result;
}

/**
 * Computes edge inverse mapping (symmetric: stores both directions).
 */
function computeEdgeInverses(
  relations: readonly (readonly [string, string])[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();

  for (const [a, b] of relations) {
    // inverseOf is symmetric: A inverseOf B means B inverseOf A too
    result.set(a, b);
    result.set(b, a);
  }

  return result;
}
