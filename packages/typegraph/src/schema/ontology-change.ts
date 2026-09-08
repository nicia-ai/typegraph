/**
 * Ontology change classification: what an ontology diff means for EXISTING
 * DATA, not just for the schema document.
 *
 * Pure — no backend, no I/O, never throws for a reason of its own: a
 * genuinely incoherent stored or proposed ontology propagates the
 * `ConfigurationError` `buildRegistryFromSerializedSchema` throws, rather
 * than this module adding a second, quieter answer to "can this ontology be
 * interpreted at all".
 *
 * That refusal is NOT already reached elsewhere for the BEFORE (stored)
 * side. `buildKindRegistry` already validates the AFTER side wherever a
 * commit path builds it from the code-level `GraphDef` (`ensureSchema`,
 * `migrateSchema`, `initializeSchema`), but nothing validated the STORED
 * document's registry before this module existed — `deserializeSchema`'s
 * `buildRegistry` accessor is a lazy thunk no `src` caller invoked. A schema
 * persisted under an older, laxer validator and never re-opened through a
 * relation-touching diff can therefore hold an ontology today's hardening
 * would reject, and this module is the first thing that tries to build a
 * `KindRegistry` from it. KNOWN LIMITATION: this can wedge the very
 * fix-forward migration meant to repair it — removing the offending
 * relation is a relation change, so `classifyOntologyChanges` still builds
 * the BEFORE registry and still throws before it ever gets to classify the
 * removal as the fix. There is no workaround inside this module; the
 * document must be repaired through a path that does not diff relations
 * (e.g. a direct schema-row edit) before a relation-touching commit reaches
 * this code again.
 *
 * The severity table below is the ontology half of `computeSchemaDiff`.
 * Three meta-edges can change what data a commit invalidates:
 *
 * - `disjointWith` ADDED can make two already-live nodes of the pair's kinds
 *   mutually exclusive.
 * - `subClassOf` / `equivalentTo` / `sameAs` ADDED can merge two previously
 *   independent `kindWithSubClasses` uniqueness components, or propagate an
 *   existing `disjointWith` down to a kind that was not disjoint before.
 * - `subClassOf` / `equivalentTo` / `sameAs` REMOVED can shrink an edge
 *   kind's admitted endpoint pairs out from under live edges that relied on
 *   the subsumption the relation provided.
 *
 * `sameAs` is folded into the equivalence bucket by `collectOntologyRelations`
 * (`src/registry/kind-registry.ts`), so classifying it differently from
 * `equivalentTo` would make the classifier lie about the closure it produces.
 *
 * `differentFrom` and an unknown/custom meta-edge name reach no arm of
 * `collectOntologyRelations` — they feed no closure and drive no write-path
 * decision, so they are inert and `safe`.
 *
 * `inverseOf` / `implies` change default traversal results (`expand:
 * "inverse"` / `expand: "implying"`), which is a read-semantics change; the
 * identity fold flip (`diffIdentity` in `./migration`) is the precedent for
 * classifying that `breaking` so it cannot auto-migrate.
 *
 * `broader`, `narrower`, `partOf`, `hasPart` and `relatedTo` never gate a
 * write and never change which rows a claim contends for, so they stay
 * `safe` in both directions — `partOf`/`hasPart` until composition
 * constraints exist to make them otherwise.
 *
 * A relation whose `from` or `to` names a kind THIS COMMIT REMOVES is always
 * `safe` with no probe — see {@link classifyOntologyChanges}'s removed-kind
 * rule.
 */
import type { EdgeEndpointAllowance } from "../backend/types";
import {
  ALL_META_EDGE_NAMES,
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
} from "../ontology/constants";
import { expandEdgeEndpointAllowance } from "../registry/edge-endpoint-allowance";
import { type KindRegistry } from "../registry/kind-registry";
import { compareStrings } from "../utils/compare";
import { hasOwnKey } from "../utils/object";
import { encodeTupleKey } from "../utils/tuple-key";
import {
  buildRegistryFromSerializedSchema,
  buildSerializedEdgeKindFacts,
} from "./deserializer";
import { type ChangeSeverity, type ChangeType } from "./migration";
import {
  type SerializedOntologyRelation,
  type SerializedSchema,
} from "./types";

// ============================================================
// Types
// ============================================================

/**
 * One entry in a `nodeUniquenessComponent` probe: a `(constraint name,
 * merged component)` pair the proposal creates — the exact fold
 * `auditConstraintFences` (`src/store/claims/verify.ts`) uses to place a
 * `uniques` row on an axis, minus the precomputed axis itself (the audit
 * derives that from `coveredKinds` through `uniquenessAxisGroupFor`).
 */
export type UniquenessComponentProbeGroup = Readonly<{
  constraintName: string;
  /** Every kind the merged `kindWithSubClasses` axis now covers, code-point order. */
  coveredKinds: readonly string[];
}>;

/** One data check a schema commit owes before it may publish an ontology tightening. */
export type OntologyDataProbe =
  | Readonly<{
      kind: "nodeDisjointness";
      /** Disjoint kind pairs the proposal ADDS, after propagation. Canonical order. */
      pairs: readonly (readonly [string, string])[];
    }>
  | Readonly<{
      kind: "nodeUniquenessComponent";
      /**
       * One entry per `(constraint name, merged component)` the proposal
       * creates.
       */
      groups: readonly UniquenessComponentProbeGroup[];
    }>
  | Readonly<{
      kind: "edgeEndpointAssignability";
      /** Edge kinds whose admitted concrete endpoint pairs SHRANK, with what still remains. */
      allowances: readonly EdgeEndpointAllowance[];
    }>
  | Readonly<{
      kind: "edgeAcyclicity";
      /**
       * Edge kinds whose `acyclic` flag turned on this commit (present on
       * both sides of the diff — a brand-new kind is vacuously safe, per
       * `edgeAcyclicityDelta`).
       */
      edgeKinds: readonly string[];
    }>;

/**
 * A change to the ontology. Moved here from `migration.ts`, which
 * re-exports it so the public path (`src/schema/index.ts`) is unchanged.
 *
 * `entity: "edgeRegistration"` is item D.2's addition: `acyclic` is an
 * edge-registration property, not an ontology meta-edge/relation, but it
 * shares this classifier and the tightening-probe machinery rather than
 * forking a second implementation of "what does a schema change do to
 * existing data".
 */
export type OntologyChange = Readonly<{
  type: ChangeType;
  entity: "metaEdge" | "relation" | "edgeRegistration";
  name: string;
  severity: ChangeSeverity;
  details: string;
  /**
   * The data checks a commit of this change must run. Absent on `safe` and
   * on `breaking` changes (breaking already requires an explicit
   * `migrateSchema()`). Declared per the severity table above regardless of
   * whether the diff-wide payload happens to be empty for this particular
   * relation — `ontologyTighteningProbes` is what decides whether a family
   * has any actual work to fold into a commit preflight.
   */
  probes?: readonly OntologyDataProbe[];
}>;

/** Everything classification reads. Deliberately narrower than `SerializedSchema`. */
export type OntologySnapshot = Pick<
  SerializedSchema,
  "ontology" | "nodes" | "edges"
>;

// ============================================================
// Relation keying
// ============================================================

/** Presentational label for `OntologyChange.name`. Not used as a lookup key. */
function relationKey(relation: SerializedOntologyRelation): string {
  return `${relation.metaEdge}:${relation.from}:${relation.to}`;
}

/**
 * Human-readable description of a relation for `OntologyChange.details`,
 * naming `via` (and `partSide`, when present) so a composition relation
 * re-pointed at a different realizing edge reads as a distinct change
 * instead of two identical-looking "removed"/"added" entries (E-a-8).
 */
function relationDescription(relation: SerializedOntologyRelation): string {
  const base = `${relation.metaEdge}(${relation.from}, ${relation.to})`;
  const viaClause = relation.via === undefined ? "" : ` via "${relation.via}"`;
  const partSideClause =
    relation.partSide === undefined ?
      ""
    : ` (partSide: "${relation.partSide}")`;
  return `${base}${viaClause}${partSideClause}`;
}

/**
 * Injective lookup key for the before/after relation maps below.
 *
 * A delimiter join (`${metaEdge}:${from}:${to}`) collides for a kind name
 * containing the delimiter, and a `via` change (composition's realizing
 * edge) must diff as remove + add rather than disappearing as a no-op, so
 * both `via` and `partSide` are folded into the key alongside the three
 * original fields, through the same injective tuple encoding the claim keys
 * use for exactly this reason (`src/utils/tuple-key.ts`).
 */
function relationMapKey(relation: SerializedOntologyRelation): string {
  return encodeTupleKey([
    relation.metaEdge,
    relation.from,
    relation.to,
    relation.via ?? "",
    relation.partSide ?? "",
  ]);
}

function keyedRelations(
  relations: readonly SerializedOntologyRelation[],
): ReadonlyMap<string, SerializedOntologyRelation> {
  const result = new Map<string, SerializedOntologyRelation>();
  for (const relation of relations) {
    result.set(relationMapKey(relation), relation);
  }
  return result;
}

/**
 * Kind names present on the `before` side (nodes or edges) that are absent
 * on the `after` side — i.e. kinds THIS COMMIT removes.
 */
function computeRemovedKindNames(
  before: OntologySnapshot,
  after: OntologySnapshot,
): ReadonlySet<string> {
  const afterNames = new Set([
    ...Object.keys(after.nodes),
    ...Object.keys(after.edges),
  ]);
  const removed = new Set<string>();
  for (const name of [
    ...Object.keys(before.nodes),
    ...Object.keys(before.edges),
  ]) {
    if (!afterNames.has(name)) removed.add(name);
  }
  return removed;
}

// ============================================================
// Diff-wide probe payloads
// ============================================================

/** Whether `candidate` is a proper subset of `superset` (fewer members, all present in `superset`). */
function isProperSubset(
  candidate: readonly string[],
  superset: readonly string[],
): boolean {
  if (candidate.length >= superset.length) return false;
  const supersetValues = new Set(superset);
  return candidate.every((value) => supersetValues.has(value));
}

/**
 * Whether `after` no longer admits something `before` did. Deliberately NOT
 * `isProperSubset(after, before)`: a proper subset additionally requires
 * `after` to be strictly SHORTER than `before`, which a same-size swap (one
 * allowed pair removed, a different one added in the same commit — e.g.
 * `subClassOf(Company, Organization)` replaced by `subClassOf(Shop,
 * Organization)` on an edge kind `from [Person] to [Organization]`) never
 * satisfies even though it genuinely drops an admitted pair.
 */
function lostAnyMember(
  before: readonly string[],
  after: readonly string[],
): boolean {
  const afterValues = new Set(after);
  return before.some((value) => !afterValues.has(value));
}

/**
 * Disjoint kind pairs the AFTER registry declares that the BEFORE registry
 * did not — after propagation through subsumption and equivalence, so a
 * `subClassOf` addition that propagates an existing `disjointWith` down to a
 * new descendant produces a non-empty delta through the same computation
 * that yields a fresh `disjointWith` addition's own pair.
 */
function nodeDisjointnessDelta(
  beforeRegistry: KindRegistry,
  afterRegistry: KindRegistry,
): readonly (readonly [string, string])[] {
  const beforeLabels = new Set(
    beforeRegistry
      .disjointKindPairs()
      .map(([left, right]) => beforeRegistry.disjointPairLabel(left, right)),
  );
  return afterRegistry
    .disjointKindPairs()
    .filter(
      ([left, right]) =>
        !beforeLabels.has(afterRegistry.disjointPairLabel(left, right)),
    )
    .toSorted((left, right) =>
      compareStrings(
        afterRegistry.disjointPairLabel(left[0], left[1]),
        afterRegistry.disjointPairLabel(right[0], right[1]),
      ),
    );
}

/**
 * Merged `kindWithSubClasses` uniqueness components: every node kind whose
 * `subClassOf` component GREW between the two registries, paired with every
 * `kindWithSubClasses` constraint name declared on any of its members.
 *
 * `equivalentTo` / `sameAs` do not (yet) enter `getSubClassComponent`, so an
 * equivalence addition never grows a component here — see the module
 * docblock for why that is a known, documented no-op rather than a bug.
 *
 * Uses `isProperSubset`, not `lostAnyMember` (contrast
 * `edgeEndpointAssignabilityDelta`): this loop checks every AFTER node kind
 * against its OWN before/after component, not one diff-wide set. A merge
 * always grows the component of every kind newly folded into it — there is
 * no same-size "swap" case here the way there is for a single edge kind's
 * endpoint pairs, so a strict size increase is the correct and sufficient
 * test.
 */
function nodeUniquenessComponentGroups(
  before: OntologySnapshot,
  after: OntologySnapshot,
  beforeRegistry: KindRegistry,
  afterRegistry: KindRegistry,
): readonly UniquenessComponentProbeGroup[] {
  const mergedComponents = new Map<string, readonly string[]>();
  for (const kind of Object.keys(after.nodes)) {
    const afterComponent = afterRegistry.getSubClassComponent(kind);
    const beforeComponent = beforeRegistry.getSubClassComponent(kind);
    if (!isProperSubset(beforeComponent, afterComponent)) continue;
    mergedComponents.set(afterComponent.join(" "), afterComponent);
  }

  const groups: UniquenessComponentProbeGroup[] = [];
  for (const component of mergedComponents.values()) {
    const constraintNames = new Set<string>();
    for (const memberKind of component) {
      const memberDef =
        hasOwnKey(after.nodes, memberKind) ?
          after.nodes[memberKind]
        : undefined;
      if (memberDef === undefined) continue;
      for (const constraint of memberDef.uniqueConstraints) {
        if (constraint.scope === "kindWithSubClasses") {
          constraintNames.add(constraint.name);
        }
      }
    }
    for (const constraintName of [...constraintNames].toSorted(
      compareStrings,
    )) {
      groups.push({ constraintName, coveredKinds: component });
    }
  }
  return groups.toSorted(
    (left, right) =>
      compareStrings(left.constraintName, right.constraintName) ||
      compareStrings(left.coveredKinds.join(" "), right.coveredKinds.join(" ")),
  );
}

/**
 * Edge kinds present on both sides whose admitted concrete endpoint pairs
 * SHRANK, with the (post-shrink) allowance that still remains.
 */
function edgeEndpointAssignabilityDelta(
  before: OntologySnapshot,
  after: OntologySnapshot,
  beforeRegistry: KindRegistry,
  afterRegistry: KindRegistry,
): readonly EdgeEndpointAllowance[] {
  const beforeEndpoints = buildSerializedEdgeKindFacts(before.edges);
  const afterEndpoints = buildSerializedEdgeKindFacts(after.edges);

  const allowances: EdgeEndpointAllowance[] = [];
  for (const edgeKind of Object.keys(after.edges)) {
    if (!hasOwnKey(before.edges, edgeKind)) continue;
    const beforeKinds = beforeEndpoints.get(edgeKind);
    const afterKinds = afterEndpoints.get(edgeKind);
    if (beforeKinds === undefined || afterKinds === undefined) continue;

    const beforeAllowed = expandEdgeEndpointAllowance(
      edgeKind,
      beforeKinds,
      beforeRegistry,
    );
    const afterAllowed = expandEdgeEndpointAllowance(
      edgeKind,
      afterKinds,
      afterRegistry,
    );
    const beforePairKeys = beforeAllowed.allowedPairs.map(
      ([from, to]) => `${from}\0${to}`,
    );
    const afterPairKeys = afterAllowed.allowedPairs.map(
      ([from, to]) => `${from}\0${to}`,
    );
    if (lostAnyMember(beforePairKeys, afterPairKeys)) {
      allowances.push(afterAllowed);
    }
  }
  return allowances.toSorted((left, right) =>
    compareStrings(left.edgeKind, right.edgeKind),
  );
}

/**
 * Edge kinds present on both sides whose `acyclic` flag went from
 * absent/`false` to `true` this commit — item D.2's tightening. A brand-new
 * edge kind (absent from `before`) is excluded: there is no prior data it
 * could have violated, so classifying it would pay for a probe against an
 * empty population every time a schema author declares `acyclic: true` on a
 * kind for the first time.
 */
function edgeAcyclicityAddedDelta(
  before: OntologySnapshot,
  after: OntologySnapshot,
): readonly string[] {
  const edgeKinds: string[] = [];
  for (const edgeKind of Object.keys(after.edges)) {
    if (!hasOwnKey(before.edges, edgeKind)) continue;
    const wasAcyclic = before.edges[edgeKind]?.acyclic === true;
    const isAcyclic = after.edges[edgeKind]?.acyclic === true;
    if (!wasAcyclic && isAcyclic) edgeKinds.push(edgeKind);
  }
  return edgeKinds.toSorted(compareStrings);
}

/**
 * Edge kinds present on both sides whose `acyclic` flag went from `true` to
 * absent/`false` this commit — always `safe`, no probe: dropping the axiom
 * can invalidate nothing already true of the data.
 */
function edgeAcyclicityRemovedDelta(
  before: OntologySnapshot,
  after: OntologySnapshot,
): readonly string[] {
  const edgeKinds: string[] = [];
  for (const edgeKind of Object.keys(before.edges)) {
    if (!hasOwnKey(after.edges, edgeKind)) continue;
    const wasAcyclic = before.edges[edgeKind]?.acyclic === true;
    const isAcyclic = after.edges[edgeKind]?.acyclic === true;
    if (wasAcyclic && !isAcyclic) edgeKinds.push(edgeKind);
  }
  return edgeKinds.toSorted(compareStrings);
}

// ============================================================
// Severity table
// ============================================================

/**
 * The probe kinds a META-EDGE/RELATION change can carry. Excludes
 * `edgeAcyclicity`: that probe belongs to an `entity: "edgeRegistration"`
 * change, classified in a separate arm of `classifyOntologyChanges` that
 * never calls {@link buildProbe} — see `edgeAcyclicityAddedDelta`.
 */
type ProbeKind = Exclude<OntologyDataProbe["kind"], "edgeAcyclicity">;

type RelationSeverity = Readonly<{
  severity: ChangeSeverity;
  probeKinds: readonly ProbeKind[];
}>;

const KNOWN_META_EDGE_NAMES: ReadonlySet<string> = new Set(ALL_META_EDGE_NAMES);

function isKnownMetaEdgeName(name: string): name is MetaEdgeName {
  return KNOWN_META_EDGE_NAMES.has(name);
}

/**
 * The severity table from the module docblock, as one exhaustive `switch`.
 * `MetaEdgeName` is checked exhaustively (a `never` default catches a future
 * addition to `ALL_META_EDGE_NAMES` at compile time); a custom or otherwise
 * unregistered meta-edge name is filtered to `safe` before this runs.
 */
function classifyKnownRelationSeverity(
  direction: "added" | "removed",
  metaEdge: MetaEdgeName,
): RelationSeverity {
  switch (metaEdge) {
    case META_EDGE_DISJOINT_WITH: {
      return direction === "added" ?
          { severity: "warning", probeKinds: ["nodeDisjointness"] }
        : { severity: "safe", probeKinds: [] };
    }
    case META_EDGE_SUB_CLASS_OF:
    case META_EDGE_EQUIVALENT_TO:
    case META_EDGE_SAME_AS: {
      return direction === "added" ?
          {
            severity: "warning",
            probeKinds: ["nodeUniquenessComponent", "nodeDisjointness"],
          }
        : { severity: "warning", probeKinds: ["edgeEndpointAssignability"] };
    }
    case META_EDGE_INVERSE_OF:
    case META_EDGE_IMPLIES: {
      return { severity: "breaking", probeKinds: [] };
    }
    case META_EDGE_BROADER:
    case META_EDGE_NARROWER:
    case META_EDGE_PART_OF:
    case META_EDGE_HAS_PART:
    case META_EDGE_RELATED_TO:
    case META_EDGE_DIFFERENT_FROM: {
      return { severity: "safe", probeKinds: [] };
    }
    default: {
      const exhaustive: never = metaEdge;
      return exhaustive;
    }
  }
}

function classifyRelationSeverity(
  direction: "added" | "removed",
  metaEdge: string,
): RelationSeverity {
  if (!isKnownMetaEdgeName(metaEdge)) {
    // Custom / unregistered meta-edge name: reaches no arm of
    // `collectOntologyRelations`, so it feeds no closure and drives no
    // write-path decision.
    return { severity: "safe", probeKinds: [] };
  }
  return classifyKnownRelationSeverity(direction, metaEdge);
}

// ============================================================
// Classification
// ============================================================

type RelationClassificationContext = Readonly<{
  removedKindNames: ReadonlySet<string>;
  disjointnessPairs: readonly (readonly [string, string])[];
  uniquenessGroups: readonly UniquenessComponentProbeGroup[];
  endpointAllowances: readonly EdgeEndpointAllowance[];
}>;

function buildProbe(
  kind: ProbeKind,
  context: RelationClassificationContext,
): OntologyDataProbe {
  switch (kind) {
    case "nodeDisjointness": {
      return { kind, pairs: context.disjointnessPairs };
    }
    case "nodeUniquenessComponent": {
      return { kind, groups: context.uniquenessGroups };
    }
    case "edgeEndpointAssignability": {
      return { kind, allowances: context.endpointAllowances };
    }
  }
}

function classifyRelation(
  direction: "added" | "removed",
  relation: SerializedOntologyRelation,
  context: RelationClassificationContext,
): OntologyChange {
  const name = relationKey(relation);
  const verb = direction === "added" ? "added" : "removed";

  // The removed-kind rule (load-bearing): a relation naming a kind THIS
  // COMMIT removes is always safe with no probe. Without it,
  // `Store.removeKinds("Company")` would be refused for edges pointing at
  // `Company` rows the removal itself reclaims. Same reasoning as
  // `migrateSchema`'s dropped-kind handling.
  if (
    context.removedKindNames.has(relation.from) ||
    context.removedKindNames.has(relation.to)
  ) {
    return {
      type: direction,
      entity: "relation",
      name,
      severity: "safe",
      details: `Relation ${relationDescription(relation)} was ${verb} alongside a removed kind`,
    };
  }

  const { severity, probeKinds } = classifyRelationSeverity(
    direction,
    relation.metaEdge,
  );
  const probes = probeKinds.map((kind) => buildProbe(kind, context));

  return {
    type: direction,
    entity: "relation",
    name,
    severity,
    details: `Relation ${relationDescription(relation)} was ${verb}`,
    ...(probes.length > 0 ? { probes } : {}),
  };
}

/**
 * Classifies every ontology change between two schema snapshots, with the
 * data probes a commit of a tightening change owes.
 *
 * @throws ConfigurationError when `buildRegistryFromSerializedSchema` cannot
 *   interpret `before` or `after`. Only reached when the diff contains at
 *   least one relation change; a diff that adds or removes no relation never
 *   needs a registry and so can never throw for this reason. See the module
 *   docblock for why the BEFORE side of this throw is new behavior, not an
 *   existing store-open refusal, and for the fix-forward wedge it implies.
 */
export function classifyOntologyChanges(
  before: OntologySnapshot,
  after: OntologySnapshot,
): readonly OntologyChange[] {
  const changes: OntologyChange[] = [];

  const metaEdgesBefore = new Set(Object.keys(before.ontology.metaEdges));
  const metaEdgesAfter = new Set(Object.keys(after.ontology.metaEdges));
  for (const name of metaEdgesBefore) {
    if (!metaEdgesAfter.has(name)) {
      changes.push({
        type: "removed",
        entity: "metaEdge",
        name,
        severity: "breaking",
        details: `Meta-edge "${name}" was removed`,
      });
    }
  }
  for (const name of metaEdgesAfter) {
    if (!metaEdgesBefore.has(name)) {
      changes.push({
        type: "added",
        entity: "metaEdge",
        name,
        severity: "safe",
        details: `Meta-edge "${name}" was added`,
      });
    }
  }

  // Edge-registration `acyclic`, item D.2. Independent of whether any
  // ontology relation changed — an edge kind's acyclicity axiom shares no
  // relation with `disjointWith` / `subClassOf` / `equivalentTo`, so this
  // never needs a `KindRegistry` and runs unconditionally, before the
  // relation-change early return below.
  for (const edgeKind of edgeAcyclicityAddedDelta(before, after)) {
    changes.push({
      type: "modified",
      entity: "edgeRegistration",
      name: edgeKind,
      severity: "warning",
      details: `Edge "${edgeKind}" declared acyclic: true`,
      probes: [{ kind: "edgeAcyclicity", edgeKinds: [edgeKind] }],
    });
  }
  for (const edgeKind of edgeAcyclicityRemovedDelta(before, after)) {
    changes.push({
      type: "modified",
      entity: "edgeRegistration",
      name: edgeKind,
      severity: "safe",
      details: `Edge "${edgeKind}" dropped acyclic: true`,
    });
  }

  const beforeRelations = keyedRelations(before.ontology.relations);
  const afterRelations = keyedRelations(after.ontology.relations);
  const removedRelations = [...beforeRelations.entries()]
    .filter(([key]) => !afterRelations.has(key))
    .map(([, relation]) => relation);
  const addedRelations = [...afterRelations.entries()]
    .filter(([key]) => !beforeRelations.has(key))
    .map(([, relation]) => relation);

  if (removedRelations.length === 0 && addedRelations.length === 0) {
    return changes;
  }

  // Built only when at least one relation changed: a diff that touches no
  // ontology relation (the overwhelming majority of schema commits) never
  // pays for a registry build, and never risks surfacing an incoherent
  // legacy ontology's `ConfigurationError` on a commit that has nothing to
  // do with it.
  // BEFORE is a delta input (disjointness, uniqueness groups, endpoint
  // allowances), never a registry a store reads or writes through —
  // enforcing structural subsumption on it would wedge the fix-forward
  // migration that repairs an already-incoherent persisted document (see
  // `StructuralSubsumptionMode`'s docblock). AFTER stays enforced (the
  // default): a proposal that INTRODUCES an incompatible hierarchy is
  // exactly what R2 requires this diff to catch before an upgrade.
  const beforeRegistry = buildRegistryFromSerializedSchema(
    before,
    "unenforced-baseline",
  );
  const afterRegistry = buildRegistryFromSerializedSchema(after);

  const context: RelationClassificationContext = {
    removedKindNames: computeRemovedKindNames(before, after),
    disjointnessPairs: nodeDisjointnessDelta(beforeRegistry, afterRegistry),
    uniquenessGroups: nodeUniquenessComponentGroups(
      before,
      after,
      beforeRegistry,
      afterRegistry,
    ),
    endpointAllowances: edgeEndpointAssignabilityDelta(
      before,
      after,
      beforeRegistry,
      afterRegistry,
    ),
  };

  for (const relation of removedRelations) {
    changes.push(classifyRelation("removed", relation, context));
  }
  for (const relation of addedRelations) {
    changes.push(classifyRelation("added", relation, context));
  }

  return changes;
}

// ============================================================
// The fold
// ============================================================

function pairKey(pair: readonly [string, string]): string {
  return `${pair[0]}\0${pair[1]}`;
}

function groupKey(group: UniquenessComponentProbeGroup): string {
  return `${group.constraintName}\0${group.coveredKinds.join(" ")}`;
}

/**
 * The probe plan for a whole diff: every probe the classified changes carry,
 * unioned per kind and deduped, with a probe kind DROPPED when its
 * aggregated payload is empty — there is nothing for a commit preflight to
 * check, so there is nothing to run. This is what makes
 * `prepareSchemaTighteningPreflight` return `undefined` (no preflight
 * owed, no atomic-backend requirement) for a tightening that happens to
 * touch no live data, rather than for every `warning`-severity change
 * unconditionally.
 *
 * Deterministic order: `nodeDisjointness`, `nodeUniquenessComponent`, then
 * `edgeEndpointAssignability`, then `edgeAcyclicity`.
 */
export function ontologyTighteningProbes(
  changes: readonly OntologyChange[],
): readonly OntologyDataProbe[] {
  const pairs = new Map<string, readonly [string, string]>();
  const groups = new Map<string, UniquenessComponentProbeGroup>();
  const allowances = new Map<string, EdgeEndpointAllowance>();
  const acyclicEdgeKinds = new Set<string>();

  for (const change of changes) {
    for (const probe of change.probes ?? []) {
      switch (probe.kind) {
        case "nodeDisjointness": {
          for (const pair of probe.pairs) pairs.set(pairKey(pair), pair);
          break;
        }
        case "nodeUniquenessComponent": {
          for (const group of probe.groups) groups.set(groupKey(group), group);
          break;
        }
        case "edgeEndpointAssignability": {
          for (const allowance of probe.allowances) {
            allowances.set(allowance.edgeKind, allowance);
          }
          break;
        }
        case "edgeAcyclicity": {
          for (const edgeKind of probe.edgeKinds)
            acyclicEdgeKinds.add(edgeKind);
          break;
        }
      }
    }
  }

  const result: OntologyDataProbe[] = [];
  if (pairs.size > 0) {
    result.push({
      kind: "nodeDisjointness",
      pairs: [...pairs.values()].toSorted((left, right) =>
        compareStrings(pairKey(left), pairKey(right)),
      ),
    });
  }
  if (groups.size > 0) {
    result.push({
      kind: "nodeUniquenessComponent",
      groups: [...groups.values()].toSorted((left, right) =>
        compareStrings(groupKey(left), groupKey(right)),
      ),
    });
  }
  if (allowances.size > 0) {
    result.push({
      kind: "edgeEndpointAssignability",
      allowances: [...allowances.values()].toSorted((left, right) =>
        compareStrings(left.edgeKind, right.edgeKind),
      ),
    });
  }
  if (acyclicEdgeKinds.size > 0) {
    result.push({
      kind: "edgeAcyclicity",
      edgeKinds: [...acyclicEdgeKinds].toSorted(compareStrings),
    });
  }
  return result;
}
