/**
 * The data preflight a schema tightening owes, run INSIDE the schema-commit
 * transaction.
 *
 * `classifyOntologyChanges` + `ontologyTighteningProbes` (`./ontology-change`)
 * decide WHAT the ontology half must check; `newlyConstrainedEdgeAxes` decides
 * the same for the edge-cardinality half. `auditConstraintFences`
 * (`src/store/claims/verify.ts`) is the ONE reader that actually checks
 * either, shared with `store.verifyConstraintFences()`. This module's only
 * job is to turn a proposed schema transition into the one
 * `ConstraintFenceAuditPlan` that reader needs, and to turn a non-empty
 * violation report into the `MigrationError` a caller refuses the commit
 * with.
 *
 * Generalizes the ontology-only preflight rather than forking it:
 * `OntologySnapshot` already carries `edges`, so no input change was needed
 * to add the cardinality half.
 */
import { schemaKindHasRows } from "../backend/schema-kind-emptiness";
import { type SchemaCommitPreflightBackend } from "../backend/types";
import { MigrationError } from "../errors";
import { createSqlSchema } from "../query/compiler/schema";
import { getDialect } from "../query/dialect";
import { type KindRegistry } from "../registry/kind-registry";
import {
  type AcyclicEdgeRelation,
  declaredAcyclicEdgeRelations,
  readEdgeAcyclicityViolations,
} from "../store/acyclicity";
import { COMPOSITION_RELATION_NAME } from "../store/claims/axis";
import { compositionEdgeCardinalityDeclarations } from "../store/claims/composition-claims";
import {
  axisRowMembership,
  rowMembershipWidens,
} from "../store/claims/edge-claims";
import {
  auditConstraintFences,
  type ConstraintFenceViolation,
  uniquenessAxisGroupFor,
} from "../store/claims/verify";
import {
  readCompositionUnattachedParts,
  requiredCompositionPartKinds,
} from "../store/operations/composition-create";
import { groupBy } from "../utils/array";
import { hasOwnKey } from "../utils/object";
import { buildRegistryFromSerializedSchema } from "./deserializer";
import {
  type EdgeCardinalityDeclaration,
  newlyConstrainedEdgeAxes,
} from "./edge-cardinality-change";
import {
  type AddedEdgeKindProbes,
  addedEdgeKindProbes,
  buildSchemaBaselineRegistry,
  classifyOntologyChanges,
  type OntologyChange,
  type OntologyDataProbe,
  type OntologySnapshot,
  ontologyTighteningProbes,
} from "./ontology-change";
import {
  assertUniquenessClaimGatesOpen,
  declaredKindUniqueConstraints,
  mayGateUniquenessClaims,
  type UniquenessClaimGate,
  uniquenessClaimGates,
} from "./uniqueness-claim-gate";

/**
 * What a caller of `commitNewSchemaVersionWithPreflight` refuses with when
 * the backend cannot commit a preflight atomically. Reusing IDENTITY's code
 * for a tightening-only commit would misdirect an operator on a graph with
 * identity disabled, so `prepareSchemaTighteningPreflight` hands back the
 * SPECIFIC bag its own decision earned, rather than a caller re-deriving
 * which half (ontology or edge-cardinality) is actually why the atomic
 * primitive is needed.
 */
export type AtomicPreflightCapabilityError = Readonly<{
  code: string;
  message: string;
  suggestion?: string;
}>;

/**
 * Thrown when an ontology tightening needs the atomic preflight-commit
 * primitive and the backend does not implement it.
 */
const ONTOLOGY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR: AtomicPreflightCapabilityError =
  {
    code: "ONTOLOGY_TIGHTENING_REQUIRES_ATOMIC_BACKEND",
    message:
      "This backend cannot atomically validate an ontology tightening against existing data as part of a schema transition.",
    suggestion:
      "Run this migration through a backend built by `createSqliteBackend` or " +
      "`createPostgresBackend`, or implement `commitSchemaVersionWithPreflight`.",
  };

/**
 * Thrown when an edge-cardinality tightening (a commit that newly declares a
 * constrained `cardinality` or `targetCardinality` on an edge kind, INCLUDING
 * a brand-new kind — see {@link newlyConstrainedEdgeAxes}) needs the atomic
 * preflight-commit primitive and the backend does not implement it. Kept
 * distinct from {@link ONTOLOGY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR}
 * so the refusal names the axis a caller actually declared, rather than
 * blaming "ontology" for a commit that touched no disjointness, uniqueness,
 * or endpoint-assignability axiom at all.
 */
const EDGE_CARDINALITY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR: AtomicPreflightCapabilityError =
  {
    code: "EDGE_CARDINALITY_TIGHTENING_REQUIRES_ATOMIC_BACKEND",
    message:
      "This backend cannot atomically validate a newly-constrained edge cardinality against existing data as part of a schema transition.",
    suggestion:
      "Run this migration through a backend built by `createSqliteBackend` or " +
      "`createPostgresBackend`, or implement `commitSchemaVersionWithPreflight`.",
  };

/**
 * Thrown when a commit that changes where — or whether — existing rows hold
 * uniqueness claims needs the atomic preflight-commit primitive and the
 * backend does not implement it. The emptiness probe that decides the commit
 * must run in the transaction that publishes it; a backend that cannot do
 * that cannot make the decision at all.
 */
const UNIQUENESS_CLAIM_GATE_ATOMIC_PREFLIGHT_CAPABILITY_ERROR: AtomicPreflightCapabilityError =
  {
    code: "UNIQUE_CONSTRAINT_CHANGE_REQUIRES_ATOMIC_BACKEND",
    message:
      "This backend cannot atomically verify that a kind is empty while changing a uniqueness constraint that covers it as part of a schema transition.",
    suggestion:
      "Run this migration through a backend built by `createSqliteBackend` or " +
      "`createPostgresBackend`, or implement `commitSchemaVersionWithPreflight`.",
  };

export type SchemaTighteningPreflightParams = Readonly<{
  graphId: string;
  fromVersion: number;
  toVersion: number;
  before: OntologySnapshot;
  after: OntologySnapshot;
  /**
   * The already-classified diff, when a caller computed one (`ensureSchema`
   * and `Store.evolve` both diff `before`/`after` before reaching this
   * preflight). Reusing it avoids reclassifying the identical
   * `before`/`after` pair a second time in the same commit; `migrateSchema`
   * and `evolve`'s dropped-kinds branch, which never compute a diff, omit
   * this and classification runs internally, once.
   */
  changes?: readonly OntologyChange[];
}>;

/**
 * The probe of one kind, or `undefined` when this diff carries none —
 * `ontologyTighteningProbes` emits at most one probe per kind, so the first
 * match is the only one.
 */
function probeOfKind<K extends OntologyDataProbe["kind"]>(
  probes: readonly OntologyDataProbe[],
  kind: K,
): Extract<OntologyDataProbe, { kind: K }> | undefined {
  return probes.find((probe) => probe.kind === kind) as
    Extract<OntologyDataProbe, { kind: K }> | undefined;
}

/** The first couple of violations, rendered for a refusal message. */
function previewViolations(
  violations: readonly ConstraintFenceViolation[],
): string {
  return violations
    .slice(0, 2)
    .map((violation) => JSON.stringify(violation))
    .join("; ");
}

/**
 * Required-existence check. Resolves the delta's `via` edge kinds to their REQUIRED-existence
 * part kinds against the PROPOSED registry — reusing
 * {@link requiredCompositionPartKinds} (`../store/operations/composition-create`)
 * rather than re-spelling "which part kinds does a required existence pair
 * name" a second time, so this probe can never admit an `existence:
 * "optional"` pair's part kind (which can never violate `compositionExistence`)
 * or miss a subclass of a declared required part kind — reads
 * {@link readCompositionUnattachedParts} for the
 * result, dedupes, one owner of "which part kinds does this probe's
 * edge-kind list name", shared by nothing else because this preflight is
 * its only caller.
 */
async function readCompositionUnattachedPartsForEdgeKinds(
  proposedRegistry: KindRegistry,
  target: SchemaCommitPreflightBackend,
  graphId: string,
  edgeKinds: readonly string[],
): Promise<readonly ConstraintFenceViolation[]> {
  const requiredPartKinds = new Set(
    requiredCompositionPartKinds(proposedRegistry),
  );
  const partKinds = new Set<string>();
  for (const pair of proposedRegistry.compositionRelation().pairs) {
    if (!edgeKinds.includes(pair.viaEdgeKind)) continue;
    for (const concreteKind of proposedRegistry.expandSubClasses(
      pair.partKind,
    )) {
      if (requiredPartKinds.has(concreteKind)) partKinds.add(concreteKind);
    }
  }
  if (partKinds.size === 0) return [];
  const unattached = await readCompositionUnattachedParts(
    proposedRegistry,
    target,
    graphId,
    [...partKinds],
  );
  const byPartKind = groupBy(unattached, (part) => part.kind);
  return [...byPartKind.entries()].map(([partKind, parts]) => ({
    family: "compositionExistence" as const,
    partKind,
    parts,
  }));
}

/**
 * The probes an added edge kind owes, narrowed to the kinds that hold rows: a
 * kind with none (the ordinary case, a kind that never existed) has nothing
 * either probe could find, and is settled by one emptiness read rather than
 * by the audit families.
 */
async function populatedAddedEdgeKindProbes(
  target: SchemaCommitPreflightBackend,
  graphId: string,
  probes: AddedEdgeKindProbes,
): Promise<AddedEdgeKindProbes> {
  const populated = new Set<string>();
  for (const { edgeKind } of probes.endpointAllowances) {
    const hasRows = await schemaKindHasRows(target, graphId, {
      entity: "edge",
      kind: edgeKind,
      rows: "nonDeleted",
    });
    if (hasRows) populated.add(edgeKind);
  }
  return {
    endpointAllowances: probes.endpointAllowances.filter((allowance) =>
      populated.has(allowance.edgeKind),
    ),
    acyclicEdgeKinds: probes.acyclicEdgeKinds.filter((edgeKind) =>
      populated.has(edgeKind),
    ),
  };
}

/** The edge kinds a schema snapshot declares `acyclic: true`. */
function standaloneAcyclicEdgeKinds(
  snapshot: OntologySnapshot,
): readonly string[] {
  return Object.entries(snapshot.edges)
    .filter(([, edge]) => edge.acyclic === true)
    .map(([edgeKind]) => edgeKind);
}

/**
 * Whether the proposed composition relation holds a row the baseline's did
 * not: a member edge kind it lacked, a member read in the other orientation,
 * or a member whose ended rows now count (`"openRows"` → `"allRows"` — a
 * `oneActive` realizing edge redeclared `one`, or declared `acyclic: true`).
 * Such a commit can close a cycle out of rows that were legal under the
 * baseline, so the proposed relation owes the probe.
 */
function compositionRelationWidened(
  baseline: AcyclicEdgeRelation | undefined,
  proposed: AcyclicEdgeRelation,
): boolean {
  const baselineMembers = new Map(
    (baseline?.members ?? []).map((member) => [member.edgeKind, member]),
  );
  return proposed.members.some((member) => {
    const prior = baselineMembers.get(member.edgeKind);
    return (
      prior?.reversed !== member.reversed ||
      rowMembershipWidens(prior.membership, member.membership)
    );
  });
}

/**
 * The composition occupancy declarations this commit must audit, built by
 * the one owner of the per-edge-kind declaration list
 * ({@link compositionEdgeCardinalityDeclarations}) over the PROPOSED schema.
 *
 * Delta-scoped: a declaration is audited only when its edge kind realizes a
 * `partOf`/`hasPart` pair THIS commit adds (`addedPairEdgeKinds`, the
 * `composition` probe's edge kinds) or when its row membership widens from
 * the baseline's ({@link rowMembershipWidens}: a `oneActive` realizing edge
 * redeclared `one`, whose ended rows start holding the part). A pre-existing,
 * unchanged pair's data is never re-walked by an unrelated commit, the same
 * discipline `edgeCardinalities`/`disjointKindPairs` honor. The delta only
 * selects which edge kinds' rows are the OUTER (reported) rows: each
 * declaration's `scope.holders` is still the whole graph's composition
 * holder list, so a changed edge kind's row is found contending against an
 * unchanged edge kind's live row — two wholes held through two realizing
 * edges.
 */
function compositionDeclarationsToAudit(
  baselineRegistry: KindRegistry,
  proposedRegistry: KindRegistry,
  addedPairEdgeKinds: readonly string[],
): readonly EdgeCardinalityDeclaration[] {
  const baselineMembership = new Map(
    compositionEdgeCardinalityDeclarations(baselineRegistry).map(
      (declaration) => [declaration.edgeKind, axisRowMembership(declaration)],
    ),
  );
  return compositionEdgeCardinalityDeclarations(proposedRegistry).filter(
    (declaration) => {
      if (addedPairEdgeKinds.includes(declaration.edgeKind)) return true;
      const prior = baselineMembership.get(declaration.edgeKind);
      return (
        prior !== undefined &&
        rowMembershipWidens(prior, axisRowMembership(declaration))
      );
    },
  );
}

/**
 * The acyclic relations this commit must probe, built by the one owner of the
 * relation list ({@link declaredAcyclicEdgeRelations}) over the PROPOSED
 * schema — the relations the write path enforces once this version is live:
 *
 * - each edge kind this commit newly declares `acyclic: true` on, as its own
 *   standalone relation;
 * - the composition relation, whole, when the commit adds a
 *   `partOf`/`hasPart` pair or widens the relation's population
 *   ({@link compositionRelationWidened}). Whole rather than delta-scoped: a
 *   cycle can span a pre-existing pair and the changed one.
 */
function acyclicRelationsToProbe(
  params: SchemaTighteningPreflightParams,
  baselineRegistry: KindRegistry,
  proposedRegistry: KindRegistry,
  newlyAcyclicEdgeKinds: readonly string[],
  addsCompositionPair: boolean,
): readonly AcyclicEdgeRelation[] {
  const proposed = declaredAcyclicEdgeRelations(
    proposedRegistry,
    standaloneAcyclicEdgeKinds(params.after),
  );
  const proposedComposition = proposed.find(
    (relation) => relation.name === COMPOSITION_RELATION_NAME,
  );
  const probesComposition =
    proposedComposition !== undefined &&
    (addsCompositionPair ||
      compositionRelationWidened(
        declaredAcyclicEdgeRelations(
          baselineRegistry,
          standaloneAcyclicEdgeKinds(params.before),
        ).find((relation) => relation.name === COMPOSITION_RELATION_NAME),
        proposedComposition,
      ));
  return proposed.filter((relation) =>
    relation.name === COMPOSITION_RELATION_NAME ?
      probesComposition
    : newlyAcyclicEdgeKinds.includes(relation.name),
  );
}

function buildOntologyTighteningViolatedError(
  params: SchemaTighteningPreflightParams,
  probedChanges: readonly OntologyChange[],
  violations: readonly ConstraintFenceViolation[],
): MigrationError {
  const shown = previewViolations(violations);
  return new MigrationError(
    `Ontology tightening refused: ${String(violations.length)} existing row(s) violate the proposed ontology. ` +
      `${shown}. Run store.verifyConstraintFences() to list them, resolve the rows, then retry.`,
    {
      graphId: params.graphId,
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
      reason: "ontology-tightening-violated",
      changes: probedChanges,
      violations,
    },
  );
}

function buildEdgeCardinalityTighteningViolatedError(
  params: SchemaTighteningPreflightParams,
  axes: readonly EdgeCardinalityDeclaration[],
  violations: readonly ConstraintFenceViolation[],
): MigrationError {
  const shown = previewViolations(violations);
  return new MigrationError(
    `Edge cardinality tightening refused: ${String(violations.length)} existing row(s) violate the proposed cardinality. ` +
      `${shown}. Run store.verifyConstraintFences() to list them, resolve the rows, then retry.`,
    {
      graphId: params.graphId,
      fromVersion: params.fromVersion,
      toVersion: params.toVersion,
      reason: "edge-cardinality-tightening-violated",
      axes,
      violations,
    },
  );
}

/**
 * The data preflight a schema tightening owes, alongside the capability
 * error a caller refuses with when its backend cannot commit that preflight
 * atomically.
 */
export type SchemaTighteningPreflight = Readonly<{
  run: (target: SchemaCommitPreflightBackend) => Promise<void>;
  /**
   * Only the ontology changes that owe a data check. A `safe` or `breaking`
   * change in the same diff (`relatedTo` added alongside a `disjointWith`,
   * say) carries no `probes` and is not implicated by a refusal — see
   * `MigrationErrorDetails`'s `"ontology-tightening-violated"` docblock.
   */
  probedChanges: readonly OntologyChange[];
  /** The edge-cardinality axes this transition newly constrains. */
  newlyConstrainedAxes: readonly EdgeCardinalityDeclaration[];
  /**
   * The uniqueness constraints this transition can only publish while the
   * kind declaring them holds no rows: `run` refuses the commit when one
   * does, before any other check.
   */
  uniquenessClaimGates: readonly UniquenessClaimGate[];
  /**
   * {@link EDGE_CARDINALITY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR}
   * when this commit newly constrains an edge cardinality — on either axis,
   * including a brand-new kind — else {@link
   * UNIQUENESS_CLAIM_GATE_ATOMIC_PREFLIGHT_CAPABILITY_ERROR} when it owes a
   * uniqueness claim gate and no ontology probe, and {@link
   * ONTOLOGY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR} otherwise. Decided
   * HERE, from the same `newlyConstrainedAxes` fold `run` above closes over,
   * so a caller names the axis this exact preflight is about instead of
   * re-deriving which half applies (and risking a refusal that blames
   * "ontology" for a commit that touched no disjointness, uniqueness, or
   * endpoint-assignability axiom at all).
   */
  capabilityError: AtomicPreflightCapabilityError;
}>;

/**
 * The data preflight a schema tightening owes, or `undefined` when the
 * proposal tightens nothing on the ontology or the edge-cardinality axis and
 * strands no uniqueness claim. Its `run` step executes INSIDE the
 * schema-commit transaction.
 *
 * The uniqueness claim gate runs first: it is one emptiness probe per gated
 * kind, and a commit it refuses is not legal whatever the audits below would
 * find.
 *
 * Takes NO advisory lock. Under the PREVIOUS schema the tightening's kinds
 * are not yet disjoint (or their uniqueness components have not yet merged,
 * or the edge kind's endpoints have not yet shrunk, or the edge kind's
 * cardinality was not yet this constrained), so a writer creating the very
 * row that will violate the new axiom owes no claim and takes no lock — the
 * lock cannot fence what it cannot see. The residual window this leaves is
 * the one the existing kind-emptiness fence already carries: a writer that
 * commits under the previous schema version between this probe and the
 * version CAS is invisible to it.
 * `store.verifyConstraintFences()` remains the post-hoc detector for exactly
 * that window.
 *
 * When BOTH halves have violations, the edge-cardinality refusal wins: it is
 * the more specific diagnosis, and the two reasons are mutually exclusive
 * gates on the same commit (fixing one leaves the other still refusing on
 * retry). The same preference governs `capabilityError`.
 *
 * @throws ConfigurationError if either `params.before` or `params.after`
 *   cannot be interpreted as a coherent ontology and `params.changes` was
 *   not supplied (propagates from `classifyOntologyChanges`).
 */
export function prepareSchemaTighteningPreflight(
  params: SchemaTighteningPreflightParams,
): SchemaTighteningPreflight | undefined {
  const changes =
    params.changes ?? classifyOntologyChanges(params.before, params.after);
  const probes = ontologyTighteningProbes(changes);
  const newlyConstrainedAxes = newlyConstrainedEdgeAxes(
    params.before,
    params.after,
  );
  const uniqueConstraints = declaredKindUniqueConstraints(
    params.before,
    params.after,
  );
  const mayGateUniqueness = mayGateUniquenessClaims(
    uniqueConstraints,
    changes.length > 0,
  );
  const addsEdgeKind = Object.keys(params.after.edges).some(
    (edgeKind) => !hasOwnKey(params.before.edges, edgeKind),
  );
  if (
    probes.length === 0 &&
    newlyConstrainedAxes.length === 0 &&
    !mayGateUniqueness &&
    !addsEdgeKind
  ) {
    return undefined;
  }
  const probedChanges = changes.filter(
    (change) => (change.probes ?? []).length > 0,
  );

  // Built once, outside the returned closure: every commit path already ran
  // `buildKindRegistry` on the target graph before reaching the preflight, so
  // this cannot throw here for a reason the commit has not already surfaced.
  const proposedRegistry = buildRegistryFromSerializedSchema(params.after);

  // BEFORE is read only for where its claims sit and which rows its
  // populations count.
  const baselineRegistry = buildSchemaBaselineRegistry(params.before);
  const gates =
    mayGateUniqueness ?
      uniquenessClaimGates(
        uniqueConstraints,
        baselineRegistry,
        proposedRegistry,
      )
    : [];
  if (
    probes.length === 0 &&
    newlyConstrainedAxes.length === 0 &&
    gates.length === 0 &&
    !addsEdgeKind
  ) {
    return undefined;
  }
  const addedEdgeKinds = addedEdgeKindProbes(
    params.before,
    params.after,
    proposedRegistry,
  );

  const grouped = {
    disjointness: probeOfKind(probes, "nodeDisjointness"),
    uniqueness: probeOfKind(probes, "nodeUniqueness"),
    endpoints: probeOfKind(probes, "edgeEndpointAssignability"),
    acyclicity: probeOfKind(probes, "edgeAcyclicity"),
    composition: probeOfKind(probes, "composition"),
    compositionExistence: probeOfKind(probes, "compositionExistence"),
  } as const;
  const uniquenessGroups = (grouped.uniqueness?.groups ?? []).map((group) =>
    uniquenessAxisGroupFor(group.constraintName, group.coveredKinds),
  );

  const compositionEdgeCardinalities = compositionDeclarationsToAudit(
    baselineRegistry,
    proposedRegistry,
    grouped.composition?.edgeKinds ?? [],
  );

  const run = async (target: SchemaCommitPreflightBackend): Promise<void> => {
    await assertUniquenessClaimGatesOpen(target, params, gates);
    const populatedAddedEdgeKinds = await populatedAddedEdgeKindProbes(
      target,
      params.graphId,
      addedEdgeKinds,
    );
    const endpointAllowances = [
      ...(grouped.endpoints?.allowances ?? []),
      ...populatedAddedEdgeKinds.endpointAllowances,
    ];
    const acyclicEdgeKinds = [
      ...(grouped.acyclicity?.edgeKinds ?? []),
      ...populatedAddedEdgeKinds.acyclicEdgeKinds,
    ];
    const probedAcyclicRelations = acyclicRelationsToProbe(
      params,
      baselineRegistry,
      proposedRegistry,
      acyclicEdgeKinds,
      grouped.composition !== undefined,
    );

    const claimBackedViolations = await auditConstraintFences(target, {
      declarations: {
        graphId: params.graphId,
        // Delta-scoped, not graph-wide: the audit reads only the pairs,
        // constraint names, and edge kinds THIS tightening affects, so a
        // pre-existing violation elsewhere in the graph can never make this
        // commit refuse.
        disjointKindPairs: grouped.disjointness?.pairs ?? [],
        uniqueConstraintNames: [
          ...new Set(uniquenessGroups.map((group) => group.constraintName)),
        ],
        edgeCardinalities: [
          ...newlyConstrainedAxes,
          ...compositionEdgeCardinalities,
        ],
        edgeEndpointAllowances: endpointAllowances,
      },
      uniquenessGroups,
      registry: proposedRegistry,
    });

    // `edgeAcyclicity` does NOT go through `auditConstraintFences` /
    // `readConstraintFenceViolations` (the non-recursive row-shape port every
    // other family above reads through): folding the recursive predicate
    // behind it would create a second implementation of "is there a cycle".
    // It runs `readEdgeAcyclicityViolations` directly, over exactly the
    // relations THIS commit can newly violate (`acyclicRelationsToProbe`),
    // which include an added `acyclic: true` kind that already holds rows.
    const acyclicityViolations =
      probedAcyclicRelations.length === 0 ?
        []
      : await readEdgeAcyclicityViolations(
          {
            graphId: params.graphId,
            registry: proposedRegistry,
            schema: createSqlSchema(target.tableNames),
            dialect: getDialect(target.dialect),
            target,
            operation: "schema-commit:acyclic-tightening",
          },
          probedAcyclicRelations,
        );

    // Third composition check: for every required-existence part
    // kind this commit's added pair(s) name, does a LIVE part already have
    // no live whole? Delta-scoped to WHICH part kinds are checked (only
    // those a `compositionRequiredWhole` probe names); the check itself
    // still reads the PROPOSED registry's full composition relation for
    // each — an already-attached part via a pre-existing edge kind under
    // the same part kind is found, not missed, matching
    // `readCompositionUnattachedParts`'s own docblock.
    const compositionExistenceViolations =
      grouped.compositionExistence === undefined ?
        []
      : await readCompositionUnattachedPartsForEdgeKinds(
          proposedRegistry,
          target,
          params.graphId,
          grouped.compositionExistence.edgeKinds,
        );

    const violations = [
      ...claimBackedViolations,
      ...acyclicityViolations,
      ...compositionExistenceViolations,
    ];
    if (violations.length === 0) return;

    const cardinalityViolations = violations.filter(
      (violation) => violation.family === "edgeCardinality",
    );
    if (cardinalityViolations.length > 0) {
      throw buildEdgeCardinalityTighteningViolatedError(
        params,
        newlyConstrainedAxes,
        cardinalityViolations,
      );
    }
    throw buildOntologyTighteningViolatedError(
      params,
      probedChanges,
      violations,
    );
  };

  return {
    run,
    probedChanges,
    newlyConstrainedAxes,
    uniquenessClaimGates: gates,
    capabilityError:
      newlyConstrainedAxes.length > 0 ?
        EDGE_CARDINALITY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR
      : gates.length > 0 && probes.length === 0 && !addsEdgeKind ?
        UNIQUENESS_CLAIM_GATE_ATOMIC_PREFLIGHT_CAPABILITY_ERROR
      : ONTOLOGY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR,
  };
}
