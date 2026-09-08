/**
 * The data preflight an ontology tightening owes, run INSIDE the
 * schema-commit transaction.
 *
 * `classifyOntologyChanges` + `ontologyTighteningProbes` (`./ontology-change`)
 * decide WHAT to check; `auditConstraintFences`
 * (`src/store/claims/verify.ts`) is the ONE reader that actually checks it,
 * shared with `store.verifyConstraintFences()`. This module's only job is to
 * turn a proposed schema transition into the one `ConstraintFenceAuditPlan`
 * that reader needs, and to turn a non-empty violation report into the
 * `MigrationError` a caller refuses the commit with.
 */
import { type SchemaCommitPreflightBackend } from "../backend/types";
import { MigrationError } from "../errors";
import {
  auditConstraintFences,
  type ConstraintFenceViolation,
  uniquenessAxisGroupFor,
} from "../store/claims/verify";
import { buildRegistryFromSerializedSchema } from "./deserializer";
import {
  classifyOntologyChanges,
  type OntologyChange,
  type OntologyDataProbe,
  type OntologySnapshot,
  ontologyTighteningProbes,
} from "./ontology-change";

export type OntologyTighteningPreflightParams = Readonly<{
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
    }
  }
  return { disjointness, uniqueness, endpoints };
}

function buildOntologyTighteningViolatedError(
  params: OntologyTighteningPreflightParams,
  changes: readonly OntologyChange[],
  violations: readonly ConstraintFenceViolation[],
): MigrationError {
  const shown = violations
    .slice(0, 2)
    .map((violation) => JSON.stringify(violation))
    .join("; ");
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

/**
 * The data preflight an ontology tightening owes, or `undefined` when the
 * proposal tightens nothing. Runs INSIDE the schema-commit transaction.
 *
 * Takes NO advisory lock. Under the PREVIOUS schema the tightening's kinds
 * are not yet disjoint (or their uniqueness components have not yet merged,
 * or the edge kind's endpoints have not yet shrunk), so a writer creating
 * the very row that will violate the new axiom owes no claim and takes no
 * lock — the lock cannot fence what it cannot see. The residual window this
 * leaves is the one the existing kind-emptiness fence already carries: a
 * writer that commits under the previous schema version between this probe
 * and the version CAS is invisible to it.
 * `store.verifyConstraintFences()` remains the post-hoc detector for exactly
 * that window.
 *
 * @throws ConfigurationError if either `params.before` or `params.after`
 *   cannot be interpreted as a coherent ontology and `params.changes` was
 *   not supplied (propagates from `classifyOntologyChanges`).
 */
export function prepareOntologyTighteningPreflight(
  params: OntologyTighteningPreflightParams,
): ((target: SchemaCommitPreflightBackend) => Promise<void>) | undefined {
  const changes =
    params.changes ?? classifyOntologyChanges(params.before, params.after);
  const probes = ontologyTighteningProbes(changes);
  if (probes.length === 0) return undefined;

  // Built once, outside the returned closure: every commit path already ran
  // `buildKindRegistry` on the target graph before reaching the preflight, so
  // this cannot throw here for a reason the commit has not already surfaced.
  const proposedRegistry = buildRegistryFromSerializedSchema(params.after);

  const grouped = groupProbesByKind(probes);
  const uniquenessGroups = (grouped.uniqueness?.groups ?? []).map((group) =>
    uniquenessAxisGroupFor(group.constraintName, group.coveredKinds),
  );

  return async (target: SchemaCommitPreflightBackend): Promise<void> => {
    const violations = await auditConstraintFences(target, {
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
        // Item A never touches cardinality.
        edgeCardinalities: [],
        edgeEndpointAllowances: grouped.endpoints?.allowances ?? [],
      },
      uniquenessGroups,
      registry: proposedRegistry,
    });
    if (violations.length === 0) return;
    throw buildOntologyTighteningViolatedError(params, changes, violations);
  };
}
