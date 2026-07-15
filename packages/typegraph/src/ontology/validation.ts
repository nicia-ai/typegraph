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
  detectDisjointHierarchyContradictions(ontology, issues);
  detectMultipleInversePartners(ontology, issues);
  return issues;
}

function validateSelfLoopsAndDuplicates(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const seenKeys = new Set<string>();
  for (const [index, relation] of ontology.entries()) {
    if (
      relation.from === relation.to &&
      STRICTLY_HIERARCHICAL.has(relation.metaEdge)
    ) {
      issues.push({
        relationIndex: index,
        message: `Hierarchical meta-edge "${relation.metaEdge}" cannot be a self-loop ("${relation.from}" → "${relation.to}").`,
        code: "ONTOLOGY_SELF_LOOP",
        details: { metaEdge: relation.metaEdge, kind: relation.from },
      });
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
  options: Readonly<{ skipSelfLoops: boolean }>,
): Map<MetaEdgeName, NormalizedHierarchicalEdge[]> {
  const groups = new Map<MetaEdgeName, NormalizedHierarchicalEdge[]>();
  for (const [index, relation] of ontology.entries()) {
    const normalization = HIERARCHICAL_NORMALIZATION.get(relation.metaEdge);
    if (normalization === undefined) continue;
    if (options.skipSelfLoops && relation.from === relation.to) continue;

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
  const groups = buildHierarchicalGroups(ontology, { skipSelfLoops: true });
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

function detectDisjointHierarchyContradictions(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const disjointPairs = new Map<string, number>();
  for (const [index, relation] of ontology.entries()) {
    if (relation.metaEdge !== META_EDGE_DISJOINT_WITH) continue;
    disjointPairs.set(`${relation.from}|${relation.to}`, index);
    disjointPairs.set(`${relation.to}|${relation.from}`, index);
  }
  if (disjointPairs.size === 0) return;

  const groups = buildHierarchicalGroups(ontology, { skipSelfLoops: false });
  const reportedPairs = new Set<string>();
  for (const [name, edges] of groups) {
    const closure = computeTransitiveClosure(
      edges.map((edge) => [edge.from, edge.to] as const),
    );
    for (const [from, reachable] of closure) {
      for (const to of reachable) {
        const pairKey = `${from}|${to}`;
        const relationIndex = disjointPairs.get(pairKey);
        if (relationIndex === undefined || reportedPairs.has(pairKey)) continue;
        reportedPairs.add(pairKey);
        issues.push({
          relationIndex,
          message: `Contradiction: "${from}" and "${to}" are declared disjointWith but also related by "${name}" (directly or transitively).`,
          code: "ONTOLOGY_DISJOINT_CONFLICT",
          details: { from, to, hierarchicalMetaEdge: name },
        });
      }
    }
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
