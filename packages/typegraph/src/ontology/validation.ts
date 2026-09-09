import {
  type CompositionExistence,
  type CompositionPartSide,
  isCompositionMetaEdge,
  normalizePartWhole,
} from "../registry/composition-relation";
import {
  computeDisjointExpansionClosures,
  computeEquivalenceClasses,
  expandDisjointSide,
} from "../registry/kind-registry";
import { encodeTupleKey } from "../utils/tuple-key";
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
  /** The realizing edge kind name. Required for `partOf`/`hasPart`, absent otherwise. */
  via?: string;
  /** R5's orientation. Meaningful only alongside `via`. */
  partSide?: CompositionPartSide;
  /** Item E.2. Meaningful only alongside `via`. */
  existence?: CompositionExistence;
}>;

type OntologyValidationIssueCode =
  | "ONTOLOGY_CYCLE"
  | "ONTOLOGY_SELF_LOOP"
  | "ONTOLOGY_DISJOINT_CONFLICT"
  | "ONTOLOGY_INVERSE_MULTIPLE_PARTNERS"
  | "ONTOLOGY_EQUIVALENCE_INVALID_CLASS"
  | "DUPLICATE_ONTOLOGY_RELATION"
  | "ONTOLOGY_COMPOSITION_VIA_REQUIRED"
  | "ONTOLOGY_COMPOSITION_VIA_FORBIDDEN"
  | "ONTOLOGY_COMPOSITION_PART_SIDE_FORBIDDEN"
  | "ONTOLOGY_COMPOSITION_EXISTENCE_FORBIDDEN";

export type OntologyValidationIssue = Readonly<{
  relationIndex?: number;
  message: string;
  code: OntologyValidationIssueCode;
  details: Readonly<Record<string, unknown>>;
}>;

/**
 * `validateOntologyRelations`'s issue shape when called WITHOUT a `kinds`
 * classifier: `detectInvalidEquivalenceClasses` returns immediately in that
 * case (see its docstring), so `"ONTOLOGY_EQUIVALENCE_INVALID_CLASS"` is
 * PROVABLY absent from the result, not merely unlikely. The no-`kinds`
 * overload below encodes that as a type, which is what lets
 * `graph-extension/validation.ts` assign an issue's `code` straight into a
 * `GraphExtensionIssue` — a union that deliberately does not list this code
 * (see `GRAPH_EXTENSION_ISSUE_CODES`) — without a cast.
 */
export type OntologyValidationIssueWithoutEquivalenceClass = Readonly<{
  relationIndex?: number;
  message: string;
  code: Exclude<
    OntologyValidationIssueCode,
    "ONTOLOGY_EQUIVALENCE_INVALID_CLASS"
  >;
  details: Readonly<Record<string, unknown>>;
}>;

const STRICTLY_HIERARCHICAL: ReadonlySet<string> = new Set([
  META_EDGE_SUB_CLASS_OF,
  META_EDGE_BROADER,
  META_EDGE_NARROWER,
  META_EDGE_PART_OF,
  META_EDGE_HAS_PART,
]);

// `partOf`/`hasPart` are deliberately absent here: which endpoint is the
// part is `normalizePartWhole`'s decision (`../registry/composition-relation`),
// not a second copy of it. `buildHierarchicalGroups` below routes composition
// relations through that one owner and consults this table only for the
// non-composition narrower/broader flip, which really is a different
// decision (a generic "narrower canonicalizes to broader" convention, not
// "which side is the part").
const HIERARCHICAL_NORMALIZATION: ReadonlyMap<
  string,
  Readonly<{ canonical: MetaEdgeName; flip: boolean }>
> = new Map([
  [META_EDGE_SUB_CLASS_OF, { canonical: META_EDGE_SUB_CLASS_OF, flip: false }],
  [META_EDGE_BROADER, { canonical: META_EDGE_BROADER, flip: false }],
  [META_EDGE_NARROWER, { canonical: META_EDGE_BROADER, flip: true }],
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
 *
 * Overloaded on whether `kinds` is supplied: without it, the equivalence-
 * class check cannot run (see `detectInvalidEquivalenceClasses`), so the
 * result is typed as never carrying `"ONTOLOGY_EQUIVALENCE_INVALID_CLASS"`.
 */
export function validateOntologyRelations(
  ontology: readonly NamedOntologyRelation[],
): readonly OntologyValidationIssueWithoutEquivalenceClass[];
export function validateOntologyRelations(
  ontology: readonly NamedOntologyRelation[],
  kinds: OntologyKindClassification,
): readonly OntologyValidationIssue[];
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
  validateCompositionShape(ontology, issues);
  return issues;
}

/**
 * A reflexive `partOf`/`hasPart` pair naming its realizing edge is a
 * meaningful declaration ("a Section may be part of another Section"): its
 * soundness is an instance-level property (the union acyclicity check, item
 * E-b), not a kind-level one. A same-kind pair with no `via` is still refused
 * below by `ONTOLOGY_COMPOSITION_VIA_REQUIRED`, so this only widens the
 * self-loop exemption for a relation that is otherwise well-formed.
 */
function isReflexiveCompositionAllowed(
  relation: NamedOntologyRelation,
): boolean {
  return isCompositionMetaEdge(relation.metaEdge) && relation.via !== undefined;
}

function validateSelfLoopsAndDuplicates(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  const seenKeys = new Set<string>();
  for (const [index, relation] of ontology.entries()) {
    if (relation.from === relation.to) {
      if (
        STRICTLY_HIERARCHICAL.has(relation.metaEdge) &&
        !isReflexiveCompositionAllowed(relation)
      ) {
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

    // `via`/`partSide` join the key so two realizing edges can hold the
    // same (part, whole) pair — the heterogeneous-edge shape
    // `compositionEdgeKindsUnder` exists to serve — without colliding as
    // duplicates.
    const key = encodeTupleKey([
      relation.metaEdge,
      relation.from,
      relation.to,
      relation.via ?? "",
      relation.partSide ?? "",
    ]);
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
    // Self-loops are reported elsewhere; skip them for cycle detection.
    if (relation.from === relation.to) continue;

    let canonical: MetaEdgeName;
    let from: string;
    let to: string;
    if (isCompositionMetaEdge(relation.metaEdge)) {
      const { partKind, wholeKind } = normalizePartWhole(relation);
      canonical = META_EDGE_PART_OF;
      from = partKind;
      to = wholeKind;
    } else {
      const normalization = HIERARCHICAL_NORMALIZATION.get(relation.metaEdge);
      if (normalization === undefined) continue;
      canonical = normalization.canonical;
      from = normalization.flip ? relation.to : relation.from;
      to = normalization.flip ? relation.from : relation.to;
    }
    const edges = groups.get(canonical) ?? [];
    edges.push({ from, to, originalIndex: index });
    groups.set(canonical, edges);
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
 *
 * Only fires with a `kinds` classifier supplied — `buildValidatedKindRegistry`
 * always supplies one (defaulting to the caller's own node/edge maps), so a
 * graph's own ontology is always checked. `validateGraphExtension`'s
 * document-scoped call omits `kinds` (an extension's ontology may name
 * base-graph kinds it cannot classify on its own) and so never reaches this
 * check; the graph-extension issue codes deliberately do NOT list
 * `"ONTOLOGY_EQUIVALENCE_INVALID_CLASS"` for that reason. It only ever
 * reaches a caller as a `ConfigurationError` thrown when the MERGED graph's
 * `KindRegistry` is built (`buildKindRegistry`).
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

/**
 * The two composition shape checks that need nothing but the relation
 * itself, run for every ontology relation regardless of meta-edge: `via` is
 * required exactly on `partOf`/`hasPart` and forbidden everywhere else, and
 * `partSide` is meaningful only alongside `via`.
 *
 * This is what delivers R3: a persisted `partOf`/`hasPart` relation missing
 * `via` is refused on load, through the same `validateOntologyRelations`
 * path the compile-time builder and the extension builder already share.
 * The registration-dependent checks (orientation, cardinality, exactness,
 * population) run later, in `buildCompositionRelation`
 * (`src/registry/composition-relation.ts`), once a `KindRegistry` exists.
 */
function validateCompositionShape(
  ontology: readonly NamedOntologyRelation[],
  issues: OntologyValidationIssue[],
): void {
  for (const [index, relation] of ontology.entries()) {
    if (isCompositionMetaEdge(relation.metaEdge)) {
      if (relation.via === undefined) {
        issues.push({
          relationIndex: index,
          message: `${relation.metaEdge}(${relation.from}, ${relation.to}) is missing the required \`via\` edge kind.`,
          code: "ONTOLOGY_COMPOSITION_VIA_REQUIRED",
          details: { ...relation },
        });
      }
      continue;
    }

    if (relation.via !== undefined) {
      issues.push({
        relationIndex: index,
        message: `Meta-edge "${relation.metaEdge}" cannot carry a \`via\` edge kind; only partOf/hasPart may.`,
        code: "ONTOLOGY_COMPOSITION_VIA_FORBIDDEN",
        details: { metaEdge: relation.metaEdge, via: relation.via },
      });
    }
    if (relation.partSide !== undefined) {
      issues.push({
        relationIndex: index,
        message: `Meta-edge "${relation.metaEdge}" cannot carry a \`partSide\`; only partOf/hasPart may.`,
        code: "ONTOLOGY_COMPOSITION_PART_SIDE_FORBIDDEN",
        details: { metaEdge: relation.metaEdge, partSide: relation.partSide },
      });
    }
    if (relation.existence !== undefined) {
      issues.push({
        relationIndex: index,
        message: `Meta-edge "${relation.metaEdge}" cannot carry an \`existence\`; only partOf/hasPart may.`,
        code: "ONTOLOGY_COMPOSITION_EXISTENCE_FORBIDDEN",
        details: { metaEdge: relation.metaEdge, existence: relation.existence },
      });
    }
  }
}
