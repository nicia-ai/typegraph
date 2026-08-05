import {
  computeDisjointExpansionClosures,
  expandDisjointSide,
} from "../registry/kind-registry";
import { computeTransitiveClosure } from "./closures";
import {
  META_EDGE_BROADER,
  META_EDGE_DISJOINT_WITH,
  META_EDGE_HAS_PART,
  META_EDGE_INVERSE_OF,
  META_EDGE_NARROWER,
  META_EDGE_PART_OF,
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
 * Validates the semantic coherence shared by authored extensions, live graph
 * registries, and serialized-schema registries.
 */
export function validateOntologyRelations(
  ontology: readonly NamedOntologyRelation[],
): readonly OntologyValidationIssue[] {
  const issues: OntologyValidationIssue[] = [];
  validateSelfLoopsAndDuplicates(ontology, issues);
  detectHierarchicalCycles(ontology, issues);
  detectDisjointExpansionConflicts(ontology, issues);
  detectMultipleInversePartners(ontology, issues);
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
