import { requireDefined } from "../utils/presence";
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
  detectEquivalenceDisjointConflicts(ontology, issues);
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

type DisjointDeclaration = Readonly<{ a: string; b: string; index: number }>;

function collectDisjointDeclarations(
  ontology: readonly NamedOntologyRelation[],
): readonly DisjointDeclaration[] {
  const declarations: DisjointDeclaration[] = [];
  for (const [index, relation] of ontology.entries()) {
    if (relation.metaEdge !== META_EDGE_DISJOINT_WITH) continue;
    // Self disjointWith is reported by validateSelfLoopsAndDuplicates; skip
    // it here so the hierarchy pass never double-reports the same relation.
    if (relation.from === relation.to) continue;
    declarations.push({ a: relation.from, b: relation.to, index });
  }
  return declarations;
}

/**
 * Rejects a disjoint pair whose two sides are joined by a hierarchical
 * closure. Two shapes both collapse a runtime identity fold into a
 * baffling self-disjoint error, so both are refused at load time:
 *
 * 1. One side subsumes the other (`disjointWith(A, B)` + `subClassOf(A,
 *    B)`): `A` is both distinct from and a `B`.
 * 2. A third kind is a common descendant of both sides
 *    (`disjointWith(A, B)` + `subClassOf(C, A)` + `subClassOf(C, B)`):
 *    `C` inherits disjointness from both parents and becomes disjoint
 *    with itself.
 *
 * Both reduce to "some kind's hierarchical ancestor set (itself plus the
 * kinds that subsume it) contains both sides of a disjoint pair".
 */
function detectDisjointHierarchyContradictions(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const declarations = collectDisjointDeclarations(ontology);
  if (declarations.length === 0) return;

  const groups = buildHierarchicalGroups(ontology, { skipSelfLoops: false });
  const reported = new Set<string>();
  for (const [name, edges] of groups) {
    const closure = computeTransitiveClosure(
      edges.map((edge) => [edge.from, edge.to] as const),
    );
    for (const [kind, ancestors] of closure) {
      for (const { a, b, index } of declarations) {
        if (kind === a || kind === b) {
          if (!ancestors.has(kind === a ? b : a)) continue;
        } else if (!ancestors.has(a) || !ancestors.has(b)) {
          continue;
        }
        const reportKey = `${name}::${kind}::${a}|${b}`;
        if (reported.has(reportKey)) continue;
        reported.add(reportKey);
        issues.push(
          kind === a || kind === b ?
            {
              relationIndex: index,
              message: `Contradiction: "${a}" and "${b}" are declared disjointWith but also related by "${name}" (directly or transitively).`,
              code: "ONTOLOGY_DISJOINT_CONFLICT",
              details: { from: a, to: b, hierarchicalMetaEdge: name },
            }
          : {
              relationIndex: index,
              message: `Contradiction: kind "${kind}" is subsumed via "${name}" by both "${a}" and "${b}", which are declared disjointWith.`,
              code: "ONTOLOGY_DISJOINT_CONFLICT",
              details: { kind, from: a, to: b, hierarchicalMetaEdge: name },
            },
        );
      }
    }
  }
}

/**
 * Rejects a kind declared both `equivalentTo` and `disjointWith` another
 * — a kind cannot be identical to and mutually exclusive with the same
 * peer. Equivalence is symmetric and transitive, so the check runs over
 * union-find groups: `disjointWith(A, C)` combined with `equivalentTo(A,
 * B)` + `equivalentTo(B, C)` is caught even though `A` and `C` were never
 * declared equivalent directly.
 */
function detectEquivalenceDisjointConflicts(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const declarations = collectDisjointDeclarations(ontology);
  if (declarations.length === 0) return;

  const equivalenceRoot = buildEquivalenceRoots(ontology);
  if (equivalenceRoot.size === 0) return;

  const reported = new Set<string>();
  for (const { a, b, index } of declarations) {
    const rootA = equivalenceRoot.get(a);
    const rootB = equivalenceRoot.get(b);
    if (rootA === undefined || rootB === undefined || rootA !== rootB) continue;
    const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (reported.has(pairKey)) continue;
    reported.add(pairKey);
    issues.push({
      relationIndex: index,
      message: `Contradiction: "${a}" and "${b}" are declared both equivalentTo (directly or transitively) and disjointWith.`,
      code: "ONTOLOGY_DISJOINT_CONFLICT",
      details: { from: a, to: b },
    });
  }
}

/**
 * Union-find over `equivalentTo` / `sameAs` relations, returning a map
 * from each participating kind to its equivalence-class representative.
 * Kinds sharing a representative are equivalent (directly or via a chain).
 */
function buildEquivalenceRoots(
  ontology: readonly NamedOntologyRelation[],
): ReadonlyMap<string, string> {
  const parent = new Map<string, string>();
  const size = new Map<string, number>();

  function find(node: string): string {
    if (!parent.has(node)) {
      parent.set(node, node);
      size.set(node, 1);
      return node;
    }

    let root = node;
    for (;;) {
      const next = requireDefined(parent.get(root));
      if (next === root) break;
      root = next;
    }

    let cursor = node;
    while (cursor !== root) {
      const next = requireDefined(parent.get(cursor));
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  function union(left: string, right: string): void {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft === rootRight) return;
    const leftSize = requireDefined(size.get(rootLeft));
    const rightSize = requireDefined(size.get(rootRight));
    const [root, child] =
      leftSize >= rightSize ? [rootLeft, rootRight] : [rootRight, rootLeft];
    parent.set(child, root);
    size.set(root, leftSize + rightSize);
  }

  for (const relation of ontology) {
    if (
      relation.metaEdge === META_EDGE_EQUIVALENT_TO ||
      relation.metaEdge === META_EDGE_SAME_AS
    ) {
      union(relation.from, relation.to);
    }
  }

  const roots = new Map<string, string>();
  for (const node of parent.keys()) {
    roots.set(node, find(node));
  }
  return roots;
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
