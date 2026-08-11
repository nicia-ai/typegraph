import { type GraphIdentityConfig } from "../core/define-graph";
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
  META_EDGE_RELATED_TO,
  META_EDGE_SAME_AS,
  META_EDGE_SUB_CLASS_OF,
} from "../ontology/constants";
import { isExternalIri } from "../ontology/external-iri";
import { type OntologyRelation } from "../ontology/types";
import { type NamedOntologyRelation } from "../ontology/validation";
import { compareStrings } from "../utils/compare";
import { requireDefined } from "../utils/presence";

const DISJOINT_PAIR_SEPARATOR = "|";
const ENCODED_DISJOINT_PAIR_PREFIX = "\u001Epair\u001E";

/**
 * Encodes one string with its UTF-16 length, so adjacent values retain their
 * boundary even when either value contains punctuation used by older labels.
 */
function encodeLengthPrefixed(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * Builds the canonical label of an unordered pair of kinds: the two names in
 * code-point order. Existing unambiguous pairs retain their historical
 * separator-joined form; pairs containing that separator use length prefixes.
 *
 * Order-independence is the whole point — `A⊥B` and `B⊥A` are one fact, so
 * they must be one string. {@link KindRegistry.disjointPairLabel} exposes it,
 * {@link computeDisjointPairs} writes the set with it, and the disjointness
 * claim axis folds it.
 */
function disjointPairLabel(leftKind: string, rightKind: string): string {
  const [first, second] =
    leftKind < rightKind ? [leftKind, rightKind] : [rightKind, leftKind];
  if (
    !first.includes(DISJOINT_PAIR_SEPARATOR) &&
    !second.includes(DISJOINT_PAIR_SEPARATOR)
  ) {
    // Preserve the historical form — and therefore existing serialized
    // closure documents and schema hashes — wherever it is already injective.
    return `${first}${DISJOINT_PAIR_SEPARATOR}${second}`;
  }
  return `${ENCODED_DISJOINT_PAIR_PREFIX}${encodeLengthPrefixed(first)}${encodeLengthPrefixed(second)}`;
}

/** Reads one value produced by {@link encodeLengthPrefixed}. */
function readLengthPrefixed(
  label: string,
  offset: number,
): Readonly<{ value: string; nextOffset: number }> {
  const lengthSeparator = label.indexOf(":", offset);
  const lengthText = label.slice(offset, lengthSeparator);
  if (lengthSeparator === -1 || !/^\d+$/u.test(lengthText)) {
    throw new Error(`Invalid disjoint-pair label ${JSON.stringify(label)}.`);
  }
  const start = lengthSeparator + 1;
  const end = start + Number(lengthText);
  if (end > label.length) {
    throw new Error(`Invalid disjoint-pair label ${JSON.stringify(label)}.`);
  }
  return { value: label.slice(start, end), nextOffset: end };
}

/** The inverse of {@link disjointPairLabel}, so only one place knows the form. */
function disjointPairMembers(label: string): readonly [string, string] {
  if (!label.startsWith(ENCODED_DISJOINT_PAIR_PREFIX)) {
    const [first, second] = label.split(DISJOINT_PAIR_SEPARATOR);
    return [requireDefined(first), requireDefined(second)];
  }
  const first = readLengthPrefixed(label, ENCODED_DISJOINT_PAIR_PREFIX.length);
  const second = readLengthPrefixed(label, first.nextOffset);
  if (second.nextOffset !== label.length) {
    throw new Error(`Invalid disjoint-pair label ${JSON.stringify(label)}.`);
  }
  return [first.value, second.value];
}

/**
 * Precomputes each undirected `subClassOf` component once per registry.
 *
 * The transitive closures are a sound adjacency: every direct edge is present,
 * and every closure edge joins members of the same component. Assigning the
 * same frozen array to every member makes later axis/probe resolution O(1) and
 * guarantees every member observes byte-identical ordering.
 */
function computeSubClassComponents(
  nodeKinds: ReadonlyMap<string, NodeType>,
  ancestors: ReadonlyMap<string, ReadonlySet<string>>,
  descendants: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, readonly string[]> {
  const components = new Map<string, readonly string[]>();
  const knownKinds = new Set([
    ...nodeKinds.keys(),
    ...ancestors.keys(),
    ...descendants.keys(),
  ]);
  for (const kind of knownKinds) {
    if (components.has(kind)) continue;
    const members = new Set<string>([kind]);
    const pending = [kind];
    while (pending.length > 0) {
      const current = requireDefined(pending.pop());
      const neighbors = [
        ...(ancestors.get(current) ?? []),
        ...(descendants.get(current) ?? []),
      ];
      for (const neighbor of neighbors) {
        if (members.has(neighbor)) continue;
        members.add(neighbor);
        pending.push(neighbor);
      }
    }
    const component = Object.freeze(
      [...members].toSorted((left, right) => compareStrings(left, right)),
    );
    for (const member of members) components.set(member, component);
  }
  return components;
}

/**
 * KindRegistry holds precomputed closures for ontological reasoning.
 *
 * Computed at store initialization and cached for fast query-time lookups.
 */
export class KindRegistry {
  // === Node & Edge Kinds ===
  readonly nodeKinds: ReadonlyMap<string, NodeType>;
  readonly edgeKinds: ReadonlyMap<string, AnyEdgeType>;
  /**
   * Durable graph identity capability; supplies the identity defaults for
   * every query builder built from this registry (compile-only and
   * store-bound).
   */
  readonly identity: GraphIdentityConfig | undefined;

  // === Subsumption (subClassOf) ===
  // Transitive closure for inheritance
  readonly subClassAncestors: ReadonlyMap<string, ReadonlySet<string>>;
  readonly subClassDescendants: ReadonlyMap<string, ReadonlySet<string>>;
  readonly #subClassComponents: ReadonlyMap<string, readonly string[]>;

  // === Hierarchy (broader/narrower) ===
  // Transitive closure for concept hierarchy (separate from subClassOf!)
  readonly broaderClosure: ReadonlyMap<string, ReadonlySet<string>>;
  readonly narrowerClosure: ReadonlyMap<string, ReadonlySet<string>>;

  // === Equivalence ===
  readonly equivalenceSets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly iriToKind: ReadonlyMap<string, string>;
  readonly relatedKinds: ReadonlyMap<string, ReadonlySet<string>>;

  // === Constraints ===
  readonly disjointPairs: ReadonlySet<string>; // Injectively encoded unordered pairs

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
      relatedKinds: ReadonlyMap<string, ReadonlySet<string>>;
      disjointPairs: ReadonlySet<string>;
      partOfClosure: ReadonlyMap<string, ReadonlySet<string>>;
      hasPartClosure: ReadonlyMap<string, ReadonlySet<string>>;
      edgeInverses: ReadonlyMap<string, string>;
      edgeImplicationsClosure: ReadonlyMap<string, ReadonlySet<string>>;
      edgeImplyingClosure: ReadonlyMap<string, ReadonlySet<string>>;
    },
    identity?: GraphIdentityConfig,
  ) {
    this.nodeKinds = nodeKinds;
    this.edgeKinds = edgeKinds;
    this.identity = identity;
    this.subClassAncestors = closures.subClassAncestors;
    this.subClassDescendants = closures.subClassDescendants;
    this.#subClassComponents = computeSubClassComponents(
      nodeKinds,
      closures.subClassAncestors,
      closures.subClassDescendants,
    );
    this.broaderClosure = closures.broaderClosure;
    this.narrowerClosure = closures.narrowerClosure;
    this.equivalenceSets = closures.equivalenceSets;
    this.iriToKind = closures.iriToKind;
    this.relatedKinds = closures.relatedKinds;
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

  /**
   * Returns the precomputed undirected `subClassOf` component containing kind,
   * in code-point order. Every member of one component returns the same array.
   */
  getSubClassComponent(kind: string): readonly string[] {
    return this.#subClassComponents.get(kind) ?? [kind];
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

  /** Gets directly associated kinds declared through symmetric `relatedTo`. */
  getRelatedKinds(kind: string): readonly string[] {
    const related = this.relatedKinds.get(kind);
    return related === undefined ? [] : [...related];
  }

  // === Constraint Methods ===

  /**
   * THE canonical label of an unordered pair of kinds — the form
   * {@link disjointPairs} stores, and the form a disjointness CLAIM AXIS is
   * folded from.
   *
   * Exposed on the registry because the claim axis needs it: a fence keyed on
   * a second spelling of this normalization would put the two kinds of one
   * disjoint pair on two rows that can never collide, which is exactly the
   * failure the fence exists to prevent. One expression, called by the
   * membership test, by the pair computation, and by the axis.
   */
  disjointPairLabel(a: string, b: string): string {
    return disjointPairLabel(a, b);
  }

  /**
   * Checks if two kinds are disjoint.
   */
  areDisjoint(a: string, b: string): boolean {
    return this.disjointPairs.has(disjointPairLabel(a, b));
  }

  /**
   * Every declared disjoint pair, once each, as the two kinds it names.
   *
   * The inverse of {@link disjointPairLabel} lives in this module alone, so a
   * caller enumerating the pairs — the fence audit is the one that needs them —
   * never has to know how a label is spelled. Iterating the kinds and folding
   * {@link getDisjointKinds} would be a second, order-dependent spelling of
   * exactly this set.
   */
  disjointKindPairs(): readonly (readonly [string, string])[] {
    return [...this.disjointPairs].map((pair) => disjointPairMembers(pair));
  }

  /**
   * Gets all kinds that are disjoint with the given kind.
   */
  getDisjointKinds(kind: string): readonly string[] {
    const result: string[] = [];
    for (const pair of this.disjointPairs) {
      const [firstKind, secondKind] = disjointPairMembers(pair);
      if (firstKind === kind) result.push(secondKind);
      else if (secondKind === kind) result.push(firstKind);
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
   * Checks if a concrete kind is assignable to at least one of the given
   * target kinds. Shared by every "is this kind usable where one of these
   * kinds is expected" check (edge endpoint validation, ontology relation
   * endpoint compatibility) so they can't independently drift.
   */
  isAssignableToAny(
    concreteKind: string,
    targetKinds: readonly string[],
  ): boolean {
    return targetKinds.some((targetKind) =>
      this.isAssignableTo(concreteKind, targetKind),
    );
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
  relatedKinds: ReadonlyMap<string, ReadonlySet<string>>;
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
    relatedKinds: new Map(),
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
): ReturnType<typeof computeClosuresFromNamedOntology> {
  return computeClosuresFromNamedOntology(
    ontology.map((relation) => ({
      metaEdge: relation.metaEdge.name,
      from: getKindName(relation.from),
      to: getKindName(relation.to),
    })),
  );
}

type NamedRelationPair = readonly [string, string];

/**
 * The per-meta-edge relation lists every closure is derived from. Collecting
 * them once keeps the mapping from meta-edge to closure input single-sourced:
 * `narrower` and `hasPart` are normalized into their canonical direction here
 * and nowhere else.
 */
type CollectedOntologyRelations = Readonly<{
  subClass: readonly NamedRelationPair[];
  broader: readonly NamedRelationPair[];
  equivalent: readonly NamedRelationPair[];
  related: readonly NamedRelationPair[];
  disjoint: readonly NamedRelationPair[];
  partOf: readonly NamedRelationPair[];
  inverseOf: readonly NamedRelationPair[];
  implies: readonly NamedRelationPair[];
}>;

/**
 * The closures disjointness expansion consumes. `validateOntologyRelations`
 * and the registry share this exact input so a declaration validation accepts
 * can never expand differently at runtime.
 */
export type DisjointExpansionClosures = Readonly<{
  subClassDescendants: ReadonlyMap<string, ReadonlySet<string>>;
  equivalenceSets: ReadonlyMap<string, ReadonlySet<string>>;
}>;

function collectOntologyRelations(
  ontology: readonly NamedOntologyRelation[],
): CollectedOntologyRelations {
  const subClass: NamedRelationPair[] = [];
  const broader: NamedRelationPair[] = [];
  const equivalent: NamedRelationPair[] = [];
  const related: NamedRelationPair[] = [];
  const disjoint: NamedRelationPair[] = [];
  const partOf: NamedRelationPair[] = [];
  const inverseOf: NamedRelationPair[] = [];
  const implies: NamedRelationPair[] = [];

  for (const relation of ontology) {
    const fromName = relation.from;
    const toName = relation.to;

    switch (relation.metaEdge) {
      case META_EDGE_SUB_CLASS_OF: {
        subClass.push([fromName, toName]);
        break;
      }
      case META_EDGE_BROADER: {
        broader.push([fromName, toName]);
        break;
      }
      case META_EDGE_NARROWER: {
        // narrower is inverse of broader
        broader.push([toName, fromName]);
        break;
      }
      case META_EDGE_EQUIVALENT_TO:
      case META_EDGE_SAME_AS: {
        equivalent.push([fromName, toName]);
        break;
      }
      case META_EDGE_RELATED_TO: {
        related.push([fromName, toName]);
        break;
      }
      case META_EDGE_DISJOINT_WITH: {
        disjoint.push([fromName, toName]);
        break;
      }
      case META_EDGE_PART_OF: {
        partOf.push([fromName, toName]);
        break;
      }
      case META_EDGE_HAS_PART: {
        // hasPart is inverse of partOf
        partOf.push([toName, fromName]);
        break;
      }
      case META_EDGE_INVERSE_OF: {
        // inverseOf is symmetric: if A inverseOf B, then B inverseOf A
        inverseOf.push([fromName, toName]);
        break;
      }
      case META_EDGE_IMPLIES: {
        implies.push([fromName, toName]);
        break;
      }
    }
  }

  return {
    subClass,
    broader,
    equivalent,
    related,
    disjoint,
    partOf,
    inverseOf,
    implies,
  };
}

function computeSubsumptionAndEquivalenceClosures(
  collected: CollectedOntologyRelations,
): DisjointExpansionClosures &
  Readonly<{ subClassAncestors: ReadonlyMap<string, ReadonlySet<string>> }> {
  const subClassAncestors = computeTransitiveClosure(collected.subClass);
  return {
    subClassAncestors,
    subClassDescendants: invertClosure(subClassAncestors),
    equivalenceSets: computeEquivalenceSets(collected.equivalent),
  };
}

/**
 * Computes only the closures disjointness expansion needs.
 *
 * Load-time validation calls this instead of {@link
 * computeClosuresFromNamedOntology} so it never pays for the quadratic
 * disjoint-pair materialization it is trying to prove unnecessary, while still
 * expanding over byte-identical closures.
 */
export function computeDisjointExpansionClosures(
  ontology: readonly NamedOntologyRelation[],
): DisjointExpansionClosures {
  return computeSubsumptionAndEquivalenceClosures(
    collectOntologyRelations(ontology),
  );
}

/** Computes all registry closures from already-normalized relation names. */
export function computeClosuresFromNamedOntology(
  ontology: readonly NamedOntologyRelation[],
): {
  subClassAncestors: ReadonlyMap<string, ReadonlySet<string>>;
  subClassDescendants: ReadonlyMap<string, ReadonlySet<string>>;
  broaderClosure: ReadonlyMap<string, ReadonlySet<string>>;
  narrowerClosure: ReadonlyMap<string, ReadonlySet<string>>;
  equivalenceSets: ReadonlyMap<string, ReadonlySet<string>>;
  iriToKind: ReadonlyMap<string, string>;
  relatedKinds: ReadonlyMap<string, ReadonlySet<string>>;
  disjointPairs: ReadonlySet<string>;
  partOfClosure: ReadonlyMap<string, ReadonlySet<string>>;
  hasPartClosure: ReadonlyMap<string, ReadonlySet<string>>;
  edgeInverses: ReadonlyMap<string, string>;
  edgeImplicationsClosure: ReadonlyMap<string, ReadonlySet<string>>;
  edgeImplyingClosure: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const collected = collectOntologyRelations(ontology);

  const { subClassAncestors, subClassDescendants, equivalenceSets } =
    computeSubsumptionAndEquivalenceClosures(collected);

  // Compute broader/narrower closures
  const broaderClosure = computeTransitiveClosure(collected.broader);
  const narrowerClosure = invertClosure(broaderClosure);

  const iriToKind = computeIriMapping(collected.equivalent);
  const relatedKinds = computeSymmetricRelations(collected.related);

  // Compute disjoint pairs (normalize for symmetric lookup)
  const disjointPairs = computeDisjointPairs(collected.disjoint, {
    subClassDescendants,
    equivalenceSets,
  });

  // Compute partOf closures
  const partOfClosure = computeTransitiveClosure(collected.partOf);
  const hasPartClosure = invertClosure(partOfClosure);

  // Compute edge inverses (symmetric: store both directions)
  const edgeInverses = computeEdgeInverses(collected.inverseOf);

  // Compute edge implications closure (transitive)
  // edgeImplicationsClosure: A -> [B, C] means A implies B and C
  // edgeImplyingClosure: C -> [A, B] means A and B imply C (inverse direction)
  const edgeImplicationsClosure = computeTransitiveClosure(collected.implies);
  const edgeImplyingClosure = invertClosure(edgeImplicationsClosure);

  return {
    subClassAncestors,
    subClassDescendants,
    broaderClosure,
    narrowerClosure,
    equivalenceSets,
    iriToKind,
    relatedKinds,
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
 * Computes equivalence sets (symmetric + transitive closure).
 */
function computeEquivalenceSets(
  relations: readonly (readonly [string, string])[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const parent = new Map<string, string>();
  const size = new Map<string, number>();

  function find(x: string): string {
    if (!parent.has(x)) {
      parent.set(x, x);
      size.set(x, 1);
      return x;
    }

    let root = x;
    while (requireDefined(parent.get(root)) !== root) {
      root = requireDefined(parent.get(root));
    }
    let cursor = x;
    while (cursor !== root) {
      const next = requireDefined(parent.get(cursor));
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const sizeA = requireDefined(size.get(rootA));
    const sizeB = requireDefined(size.get(rootB));
    const [root, child] = sizeA >= sizeB ? [rootA, rootB] : [rootB, rootA];
    parent.set(child, root);
    size.set(root, sizeA + sizeB);
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
      result.set(member, new ExcludingReadonlySet(members, member));
    }
  }

  return result;
}

type SetLike<T> = Readonly<{
  size: number;
  has(value: T): boolean;
  keys(): Iterator<T>;
}>;

type SetComposition<T> = Readonly<{
  union<U>(other: SetLike<U>): Set<T | U>;
  intersection<U>(other: SetLike<U>): Set<T & U>;
  difference<U>(other: SetLike<U>): Set<T>;
  symmetricDifference<U>(other: SetLike<U>): Set<T | U>;
  isSubsetOf(other: SetLike<unknown>): boolean;
  isSupersetOf(other: SetLike<unknown>): boolean;
  isDisjointFrom(other: SetLike<unknown>): boolean;
}>;

type ComposableSet<T> = Set<T> & SetComposition<T>;

/**
 * Presents one shared equivalence class as an immutable set that excludes the
 * member being queried. Copying the class once per member makes an N-member
 * class consume O(N²) storage even though every view differs by one value.
 *
 * The ES2024 set-composition methods materialize only the selected view. This
 * preserves the public `ReadonlySet` behavior without restoring quadratic
 * eager storage for callers that only iterate or perform membership checks.
 */
class ExcludingReadonlySet
  implements ReadonlySet<string>, SetComposition<string>
{
  readonly #members: ReadonlySet<string>;
  readonly #excludedMember: string;
  readonly [Symbol.toStringTag] = "Set";

  constructor(members: ReadonlySet<string>, excludedMember: string) {
    this.#members = members;
    this.#excludedMember = excludedMember;
  }

  get size(): number {
    return (
      this.#members.size - (this.#members.has(this.#excludedMember) ? 1 : 0)
    );
  }

  has(value: string): boolean {
    return value !== this.#excludedMember && this.#members.has(value);
  }

  *entries(): SetIterator<[string, string]> {
    for (const value of this) yield [value, value];
  }

  keys(): SetIterator<string> {
    return this.values();
  }

  *values(): SetIterator<string> {
    for (const value of this.#members) {
      if (value !== this.#excludedMember) yield value;
    }
  }

  forEach(
    callbackFunction: (
      value: string,
      value2: string,
      set: ReadonlySet<string>,
    ) => void,
    thisArgument?: unknown,
  ): void {
    for (const value of this) {
      callbackFunction.call(thisArgument, value, value, this);
    }
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.values();
  }

  union<U>(other: SetLike<U>): Set<string | U> {
    return this.materialize().union(other);
  }

  intersection<U>(other: SetLike<U>): Set<string & U> {
    return this.materialize().intersection(other);
  }

  difference<U>(other: SetLike<U>): Set<string> {
    return this.materialize().difference(other);
  }

  symmetricDifference<U>(other: SetLike<U>): Set<string | U> {
    return this.materialize().symmetricDifference(other);
  }

  isSubsetOf(other: SetLike<unknown>): boolean {
    return this.materialize().isSubsetOf(other);
  }

  isSupersetOf(other: SetLike<unknown>): boolean {
    return this.materialize().isSupersetOf(other);
  }

  isDisjointFrom(other: SetLike<unknown>): boolean {
    return this.materialize().isDisjointFrom(other);
  }

  private materialize(): ComposableSet<string> {
    return new Set(this) as ComposableSet<string>;
  }
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
 *
 * Disjointness lifts onto both subclass descendants and equivalence-set
 * members: if `A disjointWith B` and `A' equivalentTo A`, then `A'` is
 * disjoint with `B` too (a kind is disjoint with whatever its equivalent
 * is disjoint with). Equivalence sets can carry external IRIs, which are
 * inert references rather than local kinds — those are dropped so only
 * real kind names enter the pair set.
 *
 * The `left === right` guard is defense-in-depth: a coherent ontology
 * (one that passed `validateOntologyRelations`) never expands two disjoint
 * sides to a shared kind, but skipping self-pairs guarantees the load-
 * bearing `areDisjoint(kind, kind) === false` invariant regardless.
 */
function computeDisjointPairs(
  relations: readonly (readonly [string, string])[],
  closures: DisjointExpansionClosures,
): ReadonlySet<string> {
  const result = new Set<string>();

  for (const [a, b] of relations) {
    const leftKinds = expandDisjointSide(a, closures);
    const rightKinds = expandDisjointSide(b, closures);
    for (const left of leftKinds) {
      for (const right of rightKinds) {
        if (left === right) continue;
        result.add(disjointPairLabel(left, right));
      }
    }
  }

  return result;
}

/**
 * Expands one side of a disjoint pair to every kind that inherits its
 * disjointness: the kind itself, its subclass descendants, and its
 * equivalence-set members. External IRIs are excluded — they are inert
 * references, not local kinds that participate in identity folding.
 *
 * The IRI exclusion stops descent, so a subclass reached only *through* an
 * IRI does not inherit disjointness. Equivalence, by contrast, still crosses
 * IRIs because `computeEquivalenceSets` unions over them: a class containing
 * an IRI is already closed, and every member is one hop away.
 *
 * Both the registry and `validateOntologyRelations` expand through this
 * function. Re-implementing it against the declared relations instead of the
 * precomputed closures reintroduces exactly that IRI asymmetry as a
 * validation blind spot.
 */
export function expandDisjointSide(
  kind: string,
  closures: DisjointExpansionClosures,
): readonly string[] {
  const expanded = new Set<string>();
  // Equivalence sets partition the kinds, so every member of a class sees the
  // same class. Consuming a class once keeps expansion linear in the class
  // size instead of quadratic.
  const consumedEquivalenceClasses = new Set<string>();
  const pending = [kind];
  while (pending.length > 0) {
    const current = requireDefined(pending.pop());
    if (expanded.has(current) || isExternalIri(current)) continue;
    expanded.add(current);
    if (!consumedEquivalenceClasses.has(current)) {
      consumedEquivalenceClasses.add(current);
      for (const equivalent of closures.equivalenceSets.get(current) ?? []) {
        consumedEquivalenceClasses.add(equivalent);
        pending.push(equivalent);
      }
    }
    for (const descendant of closures.subClassDescendants.get(current) ?? []) {
      pending.push(descendant);
    }
  }
  return [...expanded];
}

function computeSymmetricRelations(
  relations: readonly (readonly [string, string])[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const [a, b] of relations) {
    const relatedToA = result.get(a) ?? new Set<string>();
    relatedToA.add(b);
    result.set(a, relatedToA);
    const relatedToB = result.get(b) ?? new Set<string>();
    relatedToB.add(a);
    result.set(b, relatedToB);
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
