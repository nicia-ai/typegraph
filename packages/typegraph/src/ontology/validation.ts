import {
  computeDisjointExpansionClosures,
  computeEquivalenceClasses,
  expandDisjointSide,
} from "../registry/kind-registry";
import { computeTransitiveClosure } from "./closures";
import {
  META_EDGE_BROADER,
  META_EDGE_DISJOINT_WITH,
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_HAS_PART,
  META_EDGE_INVERSE_OF,
  META_EDGE_NARROWER,
  META_EDGE_PART_OF,
  META_EDGE_SAME_AS,
  META_EDGE_SUB_CLASS_OF,
  type MetaEdgeName,
} from "./constants";

export type NamedOntologyRelation = Readonly<{
  metaEdge: string;
  from: string;
  to: string;
}>;

type OntologyValidationIssueCode =
  | "ONTOLOGY_CYCLE"
  | "ONTOLOGY_SELF_LOOP"
  | "ONTOLOGY_DISJOINT_CONFLICT"
  | "ONTOLOGY_INVERSE_MULTIPLE_PARTNERS"
  | "ONTOLOGY_EQUIVALENCE_INVALID_CLASS"
  | "DUPLICATE_ONTOLOGY_RELATION";

export type OntologyValidationIssue = Readonly<{
  relationIndex?: number;
  message: string;
  code: OntologyValidationIssueCode;
  details: Readonly<Record<string, unknown>>;
}>;

const STRICTLY_HIERARCHICAL: ReadonlySet<string> = new Set([
  META_EDGE_SUB_CLASS_OF,
  META_EDGE_BROADER,
  META_EDGE_NARROWER,
  META_EDGE_PART_OF,
  META_EDGE_HAS_PART,
]);

const HIERARCHICAL_NORMALIZATION: ReadonlyMap<
  string,
  Readonly<{ canonical: MetaEdgeName; flip: boolean }>
> = new Map([
  [META_EDGE_SUB_CLASS_OF, { canonical: META_EDGE_SUB_CLASS_OF, flip: false }],
  [META_EDGE_BROADER, { canonical: META_EDGE_BROADER, flip: false }],
  [META_EDGE_NARROWER, { canonical: META_EDGE_BROADER, flip: true }],
  [META_EDGE_PART_OF, { canonical: META_EDGE_PART_OF, flip: false }],
  [META_EDGE_HAS_PART, { canonical: META_EDGE_PART_OF, flip: true }],
]);

type NormalizedHierarchicalEdge = Readonly<{
  from: string;
  to: string;
  originalIndex: number;
}>;

/**
 * Whether a name in an ontology relation is a REGISTERED node kind, a
 * REGISTERED edge kind, or neither (an external IRI, or a kind this document
 * only references). Supplied by whoever knows the kinds — the registry
 * builder from its own maps, the deserializer from the serialized document's
 * `nodes` and `edges` records. Absent when no classification is available, in
 * which case the equivalence-class kind check is skipped and the
 * merged-graph registry build is the gate.
 */
export type OntologyKindClassification = Readonly<{
  isNodeKind: (name: string) => boolean;
  isEdgeKind: (name: string) => boolean;
}>;

/**
 * Validates the semantic coherence shared by authored extensions, live graph
 * registries, and serialized-schema registries.
 */
export function validateOntologyRelations(
  ontology: readonly NamedOntologyRelation[],
  kinds?: OntologyKindClassification,
): readonly OntologyValidationIssue[] {
  const issues: OntologyValidationIssue[] = [];
  validateSelfLoopsAndDuplicates(ontology, issues);
  detectHierarchicalCycles(ontology, issues);
  detectDisjointExpansionConflicts(ontology, issues);
  detectMultipleInversePartners(ontology, issues);
  detectInvalidEquivalenceClasses(ontology, kinds, issues);
  return issues;
}

function validateSelfLoopsAndDuplicates(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const seenKeys = new Set<string>();
  for (const [index, relation] of ontology.entries()) {
    if (relation.from === relation.to) {
      if (STRICTLY_HIERARCHICAL.has(relation.metaEdge)) {
        issues.push({
          relationIndex: index,
          message: `Hierarchical meta-edge "${relation.metaEdge}" cannot be a self-loop ("${relation.from}" → "${relation.to}").`,
          code: "ONTOLOGY_SELF_LOOP",
          details: { metaEdge: relation.metaEdge, kind: relation.from },
        });
      } else if (relation.metaEdge === META_EDGE_DISJOINT_WITH) {
        // A self disjointWith makes areSame(ref, ref) and areDifferent(ref,
        // ref) both true and every same-kind identity fold fail at runtime.
        // Reject it as a coherence contradiction at construction/load time.
        issues.push({
          relationIndex: index,
          message: `Contradiction: kind "${relation.from}" cannot be declared disjointWith itself.`,
          code: "ONTOLOGY_DISJOINT_CONFLICT",
          details: { from: relation.from, to: relation.to },
        });
      }
    }

    const key = `${relation.metaEdge}::${relation.from}->${relation.to}`;
    if (seenKeys.has(key)) {
      issues.push({
        relationIndex: index,
        message: `Duplicate ontology relation "${relation.metaEdge}" (${relation.from} → ${relation.to}).`,
        code: "DUPLICATE_ONTOLOGY_RELATION",
        details: { ...relation },
      });
      continue;
    }
    seenKeys.add(key);
  }
}

function buildHierarchicalGroups(
  ontology: readonly NamedOntologyRelation[],
): Map<MetaEdgeName, NormalizedHierarchicalEdge[]> {
  const groups = new Map<MetaEdgeName, NormalizedHierarchicalEdge[]>();
  for (const [index, relation] of ontology.entries()) {
    const normalization = HIERARCHICAL_NORMALIZATION.get(relation.metaEdge);
    if (normalization === undefined) continue;
    // Self-loops are reported elsewhere; skip them for cycle detection.
    if (relation.from === relation.to) continue;

    const from = normalization.flip ? relation.to : relation.from;
    const to = normalization.flip ? relation.from : relation.to;
    const edges = groups.get(normalization.canonical) ?? [];
    edges.push({ from, to, originalIndex: index });
    groups.set(normalization.canonical, edges);
  }
  return groups;
}

function detectHierarchicalCycles(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const groups = buildHierarchicalGroups(ontology);
  for (const [name, edges] of groups) {
    const closure = computeTransitiveClosure(
      edges.map((edge) => [edge.from, edge.to] as const),
    );
    const reportedNodes = new Set<string>();
    for (const [from, reachable] of closure) {
      if (!reachable.has(from) || reportedNodes.has(from)) continue;
      reportedNodes.add(from);
      const offendingEdge = edges.find((edge) => edge.from === from);
      issues.push({
        ...(offendingEdge === undefined ?
          {}
        : { relationIndex: offendingEdge.originalIndex }),
        message: `Cycle detected in "${name}" relations involving "${from}".`,
        code: "ONTOLOGY_CYCLE",
        details: { metaEdge: name, kind: from },
      });
    }
  }
}

type DisjointDeclaration = Readonly<{ a: string; b: string; index: number }>;

function collectDisjointDeclarations(
  ontology: readonly NamedOntologyRelation[],
): readonly DisjointDeclaration[] {
  const declarations: DisjointDeclaration[] = [];
  for (const [index, relation] of ontology.entries()) {
    if (relation.metaEdge !== META_EDGE_DISJOINT_WITH) continue;
    // Self disjointWith is reported by validateSelfLoopsAndDuplicates; skip
    // it here so the disjoint-expansion pass never double-reports the same
    // relation.
    if (relation.from === relation.to) continue;
    declarations.push({ a: relation.from, b: relation.to, index });
  }
  return declarations;
}

/**
 * Rejects any disjoint declaration whose fully propagated sides overlap.
 *
 * The expansion runs over the registry's own closures through the registry's
 * own `expandDisjointSide`, so an accepted ontology cannot produce a runtime
 * state where two kinds are simultaneously equivalent and disjoint. A
 * validation-local re-implementation is what previously let an equivalence
 * chain routed through an external IRI load clean.
 *
 * Cyclic and self-looping ontologies reach this pass too, since the cycle
 * check only records issues rather than aborting. That is safe: closure
 * computation is Warshall over a fixed node set and expansion is a worklist
 * guarded by a visited set, so neither diverges on a cycle.
 */
function detectDisjointExpansionConflicts(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const declarations = collectDisjointDeclarations(ontology);
  if (declarations.length === 0) return;

  const closures = computeDisjointExpansionClosures(ontology);
  for (const { a, b, index } of declarations) {
    const left = expandDisjointSide(a, closures);
    const right = new Set(expandDisjointSide(b, closures));
    const overlappingKind = [...left]
      .filter((kind) => right.has(kind))
      .toSorted()[0];
    if (overlappingKind === undefined) continue;
    issues.push({
      relationIndex: index,
      message: `Contradiction: the propagated disjointWith sides "${a}" and "${b}" both contain kind "${overlappingKind}".`,
      code: "ONTOLOGY_DISJOINT_CONFLICT",
      details: { kind: overlappingKind, from: a, to: b },
    });
  }
}

function detectMultipleInversePartners(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const partners = new Map<string, string>();
  for (const [index, relation] of ontology.entries()) {
    if (relation.metaEdge !== META_EDGE_INVERSE_OF) continue;
    recordInversePartner(relation.from, relation.to, index, partners, issues);
    if (relation.from !== relation.to) {
      recordInversePartner(relation.to, relation.from, index, partners, issues);
    }
  }
}

/**
 * Refuses an equivalence class that is not a set of node kinds.
 *
 * D1 makes `equivalentTo` MUTUAL SUBSUMPTION between registered kinds, and
 * subsumption is a node-kind relation: a node kind and an edge kind cannot
 * subsume each other, and two edge kinds have no defined substitution
 * semantics yet. The left parameter is widened only so an EDGE kind can be
 * mapped to an external IRI, so a class is legal when it contains at most one
 * registered edge kind and, if it contains one, no registered node kind.
 *
 * Transitivity is why this is a runtime check and not only a signature:
 * `equivalentTo(edgeA, iri)` plus `equivalentTo(edgeB, iri)` puts two edge
 * kinds in one class without either call spelling the pair.
 */
function detectInvalidEquivalenceClasses(
  ontology: readonly NamedOntologyRelation[],
  kinds: OntologyKindClassification | undefined,
  issues: OntologyValidationIssue[],
): void {
  if (kinds === undefined) return;
  for (const members of computeEquivalenceClasses(ontology)) {
    const edgeMembers = members.filter((member) => kinds.isEdgeKind(member));
    if (edgeMembers.length === 0) continue;
    const nodeMembers = members.filter((member) => kinds.isNodeKind(member));
    const reason =
      nodeMembers.length > 0 ? "mixed-node-and-edge"
      : edgeMembers.length > 1 ? "multiple-edge-kinds"
      : undefined;
    if (reason === undefined) continue;
    const relationIndex = findEquivalenceRelationIndex(ontology, members);
    issues.push({
      ...(relationIndex === undefined ? {} : { relationIndex }),
      message:
        reason === "mixed-node-and-edge" ?
          `Equivalence class {${members.join(", ")}} mixes node kinds (${nodeMembers.join(", ")}) and edge kinds (${edgeMembers.join(", ")}); equivalentTo between registered kinds is mutual subsumption, which relates node kinds only.`
        : `Equivalence class {${members.join(", ")}} contains more than one registered edge kind (${edgeMembers.join(", ")}); equivalentTo may map an edge kind to an external IRI, but two edge kinds have no substitution semantics.`,
      code: "ONTOLOGY_EQUIVALENCE_INVALID_CLASS",
      details: {
        reason,
        members,
        nodeKinds: nodeMembers,
        edgeKinds: edgeMembers,
      },
    });
  }
}

/** The first declared equivalence relation whose endpoints are in `members`. */
function findEquivalenceRelationIndex(
  ontology: readonly NamedOntologyRelation[],
  members: readonly string[],
): number | undefined {
  const memberSet = new Set(members);
  for (const [index, relation] of ontology.entries()) {
    if (
      (relation.metaEdge === META_EDGE_EQUIVALENT_TO ||
        relation.metaEdge === META_EDGE_SAME_AS) &&
      memberSet.has(relation.from) &&
      memberSet.has(relation.to)
    ) {
      return index;
    }
  }
  return undefined;
}

function recordInversePartner(
  edgeKind: string,
  partnerKind: string,
  relationIndex: number,
  partners: Map<string, string>,
  issues: OntologyValidationIssue[],
): void {
  const existingPartner = partners.get(edgeKind);
  if (existingPartner === undefined) {
    partners.set(edgeKind, partnerKind);
    return;
  }
  if (existingPartner === partnerKind) return;

  issues.push({
    relationIndex,
    message: `Edge kind "${edgeKind}" has multiple distinct inverseOf partners ("${existingPartner}" and "${partnerKind}").`,
    code: "ONTOLOGY_INVERSE_MULTIPLE_PARTNERS",
    details: { edgeKind, existingPartner, conflictingPartner: partnerKind },
  });
}
