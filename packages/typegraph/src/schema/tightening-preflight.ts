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
import { type SchemaCommitPreflightBackend } from "../backend/types";
import { MigrationError } from "../errors";
import { createSqlSchema } from "../query/compiler/schema";
import { getDialect } from "../query/dialect";
import {
  readEdgeAcyclicityViolations,
  standaloneAcyclicRelation,
} from "../store/acyclicity";
import {
  auditConstraintFences,
  type ConstraintFenceViolation,
  uniquenessAxisGroupFor,
} from "../store/claims/verify";
import { buildRegistryFromSerializedSchema } from "./deserializer";
import {
  type EdgeCardinalityDeclaration,
  newlyConstrainedEdgeAxes,
} from "./edge-cardinality-change";
import {
  classifyOntologyChanges,
  type OntologyChange,
  type OntologyDataProbe,
  type OntologySnapshot,
  ontologyTighteningProbes,
} from "./ontology-change";

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

/** The probes grouped by kind — at most one of each, per `ontologyTighteningProbes`. */
type GroupedProbes = Readonly<{
  disjointness?:
    Extract<OntologyDataProbe, { kind: "nodeDisjointness" }> | undefined;
  uniqueness?:
    Extract<OntologyDataProbe, { kind: "nodeUniquenessComponent" }> | undefined;
  endpoints?:
    | Extract<OntologyDataProbe, { kind: "edgeEndpointAssignability" }>
    | undefined;
  acyclicity?: Extract<OntologyDataProbe, { kind: "edgeAcyclicity" }> | undefined;
}>;

function groupProbesByKind(
  probes: readonly OntologyDataProbe[],
): GroupedProbes {
  let disjointness:
    Extract<OntologyDataProbe, { kind: "nodeDisjointness" }> | undefined;
  let uniqueness:
    Extract<OntologyDataProbe, { kind: "nodeUniquenessComponent" }> | undefined;
  let endpoints:
    | Extract<OntologyDataProbe, { kind: "edgeEndpointAssignability" }>
    | undefined;
  let acyclicity:
    Extract<OntologyDataProbe, { kind: "edgeAcyclicity" }> | undefined;
  for (const probe of probes) {
    switch (probe.kind) {
      case "nodeDisjointness": {
        disjointness = probe;
        break;
      }
      case "nodeUniquenessComponent": {
        uniqueness = probe;
        break;
      }
      case "edgeEndpointAssignability": {
        endpoints = probe;
        break;
      }
      case "edgeAcyclicity": {
        acyclicity = probe;
        break;
      }
    }
  }
  return { disjointness, uniqueness, endpoints, acyclicity };
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

function buildOntologyTighteningViolatedError(
  params: SchemaTighteningPreflightParams,
  changes: readonly OntologyChange[],
  violations: readonly ConstraintFenceViolation[],
): MigrationError {
  const shown = previewViolations(violations);
  // Only the changes that actually required a data check: a `safe` or
  // `breaking` change in the same diff (`relatedTo` added alongside the
  // `disjointWith` this refusal is about, say) carries no `probes` and would
  // otherwise show up in `details.changes` as if it, too, were implicated —
  // see `MigrationErrorDetails`'s `"ontology-tightening-violated"` docblock.
  const probedChanges = changes.filter(
    (change) => (change.probes ?? []).length > 0,
  );
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
   * {@link EDGE_CARDINALITY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR}
   * when this commit newly constrains an edge cardinality — on either axis,
   * including a brand-new kind — {@link
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
 * proposal tightens nothing on either the ontology or the edge-cardinality
 * axis. Its `run` step executes INSIDE the schema-commit transaction.
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
  if (probes.length === 0 && newlyConstrainedAxes.length === 0) {
    return undefined;
  }

  // Built once, outside the returned closure: every commit path already ran
  // `buildKindRegistry` on the target graph before reaching the preflight, so
  // this cannot throw here for a reason the commit has not already surfaced.
  const proposedRegistry = buildRegistryFromSerializedSchema(params.after);

  const grouped = groupProbesByKind(probes);
  const uniquenessGroups = (grouped.uniqueness?.groups ?? []).map((group) =>
    uniquenessAxisGroupFor(group.constraintName, group.coveredKinds),
  );

  const run = async (target: SchemaCommitPreflightBackend): Promise<void> => {
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
        edgeCardinalities: newlyConstrainedAxes,
        edgeEndpointAllowances: grouped.endpoints?.allowances ?? [],
      },
      uniquenessGroups,
      registry: proposedRegistry,
    });

    // `edgeAcyclicity` does NOT go through `auditConstraintFences` /
    // `readConstraintFenceViolations` (the non-recursive row-shape port every
    // other family above reads through): folding the recursive predicate
    // behind it would create a second implementation of "is there a cycle".
    // It runs `readEdgeAcyclicityViolations` directly, scoped to exactly the
    // edge kinds THIS commit newly declares `acyclic: true` on — the same
    // delta-scoping discipline as every family above.
    const acyclicityViolations =
      grouped.acyclicity === undefined ? [] : (
        await readEdgeAcyclicityViolations(
          {
            graphId: params.graphId,
            schema: createSqlSchema(target.tableNames),
            dialect: getDialect(target.dialect),
            target,
            operation: "schema-commit:acyclic-tightening",
          },
          grouped.acyclicity.edgeKinds.map((edgeKind) =>
            standaloneAcyclicRelation(edgeKind),
          ),
        )
      );

    const violations = [...claimBackedViolations, ...acyclicityViolations];
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
    throw buildOntologyTighteningViolatedError(params, changes, violations);
  };

  return {
    run,
    capabilityError:
      newlyConstrainedAxes.length > 0 ?
        EDGE_CARDINALITY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR
      : ONTOLOGY_TIGHTENING_ATOMIC_PREFLIGHT_CAPABILITY_ERROR,
  };
}
