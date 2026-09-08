import { type GraphIdentityConfig } from "../core/define-graph";
import { type AnyEdgeType, type NodeType } from "../core/types";
import { ConfigurationError } from "../errors";
import {
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_SAME_AS,
  META_EDGE_SUB_CLASS_OF,
} from "../ontology/constants";
import {
  type NamedOntologyRelation,
  type OntologyKindClassification,
  validateOntologyRelations,
} from "../ontology/validation";
import { type JsonSchema } from "../schema/types";
import { requireDefined } from "../utils/presence";
import { encodeTupleKey } from "../utils/tuple-key";
import { buildCompositionRelation } from "./composition-relation";
import { type EdgeKindFacts } from "./edge-kind-facts";
import {
  computeClosuresFromNamedOntology,
  createEmptyClosures,
  KindRegistry,
  type RegistryClosures,
} from "./kind-registry";
import { validateImpliesEndpointCompatibility } from "./validate-implies";
import { validateInverseEndpointCompatibility } from "./validate-inverse";
import {
  findStructuralSubsumptionViolations,
  type StructuralSubsumptionViolation,
} from "./validate-structural-subsumption";

/**
 * How `buildValidatedKindRegistry` enforces the C.2 structural-subsumption
 * contract for the registry it is about to build:
 *
 * - `"enforce"` — the default, and the only mode a store actually reads or
 *   writes through. An incompatible `subClassOf`/`equivalentTo` pair throws.
 * - `"unenforced-baseline"` — for a registry built ONLY to diff against a
 *   proposal (the BEFORE side of `classifyOntologyChanges`,
 *   `src/schema/ontology-change.ts`). Enforcing the before-side would wedge
 *   the fix-forward migration that repairs an already-incoherent persisted
 *   document — removing the offending relation is itself a relation change,
 *   so the diff would rebuild the (still-incoherent) BEFORE registry and
 *   throw before it could ever classify the removal as the fix. R2 ("refused
 *   on load") is satisfied by the live registry every commit path already
 *   builds from the code graph declaring the same relations, and by
 *   `getSchemaChanges` reporting it via the AFTER-side build — a diff is not
 *   a load.
 *
 * `tests/structural-subsumption-enforcement.test.ts` asserts every call site
 * supplies this explicitly (never falls through to a default silently) and
 * that exactly one names `"unenforced-baseline"`.
 */
export type StructuralSubsumptionMode = "enforce" | "unenforced-baseline";

function declaredSubsumptionPairs(
  ontology: readonly NamedOntologyRelation[],
): ReadonlySet<string> {
  const pairs = new Set<string>();
  for (const relation of ontology) {
    switch (relation.metaEdge) {
      case META_EDGE_SUB_CLASS_OF: {
        pairs.add(encodeTupleKey([relation.from, relation.to]));
        break;
      }
      case META_EDGE_EQUIVALENT_TO:
      case META_EDGE_SAME_AS: {
        // Equivalence is inherently bidirectional — both directions are a
        // DECLARED relation, never a transitive-only consequence.
        pairs.add(encodeTupleKey([relation.from, relation.to]));
        pairs.add(encodeTupleKey([relation.to, relation.from]));
        break;
      }
      default: {
        break;
      }
    }
  }
  return pairs;
}

function structuralSubsumptionErrorCode(
  violation: StructuralSubsumptionViolation,
): string {
  if (violation.viaEquivalence) {
    return violation.verdict === "not-subtype" ?
        "ONTOLOGY_EQUIVALENCE_NOT_STRUCTURAL_SUBTYPE"
      : "ONTOLOGY_EQUIVALENCE_SCHEMA_INCOMPARABLE";
  }
  return violation.verdict === "not-subtype" ?
      "ONTOLOGY_SUBCLASS_NOT_STRUCTURAL_SUBTYPE"
    : "ONTOLOGY_SUBCLASS_SCHEMA_INCOMPARABLE";
}

function structuralSubsumptionSuggestion(
  violation: StructuralSubsumptionViolation,
): string {
  if (violation.verdict === "incomparable") {
    return (
      "The projected JSON Schema cannot judge this pair " +
      "($ref, allOf, not, or an unmodeled keyword) — simplify the schemas " +
      "or drop the relation."
    );
  }
  return (
    "Give the child these properties with compatible types, " +
    "or declare broader(child, parent) instead."
  );
}

function assertStructuralSubsumption(
  registry: KindRegistry,
  ontology: readonly NamedOntologyRelation[],
  nodePropertySchemas: (kind: string) => JsonSchema | undefined,
  mode: StructuralSubsumptionMode,
): void {
  if (mode !== "enforce") return;

  const declaredPairs = declaredSubsumptionPairs(ontology);
  const violations = findStructuralSubsumptionViolations(
    registry,
    (a, b) => registry.equivalenceSets.get(a)?.has(b) ?? false,
    nodePropertySchemas,
    (first, second) => declaredPairs.has(encodeTupleKey([first, second])),
  );
  if (violations.length === 0) return;

  const first = requireDefined(violations[0]);
  const relationName = first.viaEquivalence ? "equivalentTo" : "subClassOf";
  const declaredNote = first.declared ? "declared" : "implied transitively";
  throw new ConfigurationError(
    `Ontology is incoherent: ${relationName}(${first.childKind}, ${first.parentKind}) ` +
      `(${declaredNote}) is not a structural subtype of its target ` +
      `(${first.verdict}: ${first.reason}).`,
    {
      code: structuralSubsumptionErrorCode(first),
      childKind: first.childKind,
      parentKind: first.parentKind,
      viaEquivalence: first.viaEquivalence,
      declared: first.declared,
      reason: first.reason,
      path: first.path,
      violations,
    },
    { suggestion: structuralSubsumptionSuggestion(first) },
  );
}

export function buildValidatedKindRegistry(
  input: Readonly<{
    nodeKinds: ReadonlyMap<string, NodeType>;
    edgeKinds: ReadonlyMap<string, AnyEdgeType>;
    ontology: readonly NamedOntologyRelation[];
    edgeFacts: ReadonlyMap<string, EdgeKindFacts>;
    identity?: GraphIdentityConfig;
    /**
     * How to tell a registered node kind from a registered edge kind, for the
     * equivalence-class check. Defaults to this input's own kind maps; the
     * schema deserializer supplies its own because it builds a registry with
     * EMPTY kind maps (it has no Zod schemas) and would otherwise classify
     * every name as neither.
     */
    kindClassification?: OntologyKindClassification;
    /**
     * Projects a registered node kind's properties to JSON Schema for the
     * C.2 structural-subsumption check. Required — not optional — so no
     * construction can silently skip the check.
     */
    nodePropertySchemas: (kind: string) => JsonSchema | undefined;
    /** See {@link StructuralSubsumptionMode}. Required for the same reason. */
    structuralSubsumption: StructuralSubsumptionMode;
  }>,
): KindRegistry {
  const kindClassification: OntologyKindClassification =
    input.kindClassification ?? {
      isNodeKind: (name: string) => input.nodeKinds.has(name),
      isEdgeKind: (name: string) => input.edgeKinds.has(name),
    };

  if (input.ontology.length === 0) {
    const registry = new KindRegistry(
      input.nodeKinds,
      input.edgeKinds,
      createEmptyClosures(),
      input.identity,
    );
    validateImpliesEndpointCompatibility(input.edgeFacts, registry);
    return registry;
  }

  const issues = validateOntologyRelations(input.ontology, kindClassification);
  if (issues.length > 0) {
    const firstIssue = requireDefined(issues[0]);
    throw new ConfigurationError(
      `Ontology is incoherent: ${firstIssue.message}`,
      {
        code: firstIssue.code,
        issues,
      },
      {
        suggestion:
          "Correct the ontology relations before constructing or loading the graph registry.",
      },
    );
  }

  const closures = computeClosuresFromNamedOntology(input.ontology);
  return buildRegistryWithComposition(input, closures);
}

/**
 * Building the registry composition attaches to takes two passes:
 * `KindRegistry` supplies `isAssignableToAny` (subclass-closure based,
 * unaffected by composition), so `buildCompositionRelation` needs a registry
 * to run against before its own result can be attached to one. The first
 * registry is validation-only and discarded; the second, identical but for
 * its `composition` field, is what every caller gets back.
 */
function buildRegistryWithComposition(
  input: Readonly<{
    nodeKinds: ReadonlyMap<string, NodeType>;
    edgeKinds: ReadonlyMap<string, AnyEdgeType>;
    ontology: readonly NamedOntologyRelation[];
    edgeFacts: ReadonlyMap<string, EdgeKindFacts>;
    identity?: GraphIdentityConfig;
    nodePropertySchemas: (kind: string) => JsonSchema | undefined;
    structuralSubsumption: StructuralSubsumptionMode;
  }>,
  closures: RegistryClosures,
): KindRegistry {
  const registryForValidation = new KindRegistry(
    input.nodeKinds,
    input.edgeKinds,
    closures,
    input.identity,
  );
  validateImpliesEndpointCompatibility(input.edgeFacts, registryForValidation);
  validateInverseEndpointCompatibility(
    input.ontology,
    input.edgeFacts,
    registryForValidation,
  );

  const { relation: composition, issues: compositionIssues } =
    buildCompositionRelation(
      input.ontology,
      input.edgeFacts,
      registryForValidation,
    );
  if (compositionIssues.length > 0) {
    const firstIssue = requireDefined(compositionIssues[0]);
    throw new ConfigurationError(
      `Composition ontology is incoherent: ${firstIssue.message}`,
      {
        code: firstIssue.code,
        issues: compositionIssues,
      },
      {
        suggestion:
          "Correct the partOf/hasPart declarations before constructing or loading the graph registry.",
      },
    );
  }

  const registry = new KindRegistry(
    input.nodeKinds,
    input.edgeKinds,
    closures,
    input.identity,
    composition,
  );
  assertStructuralSubsumption(
    registry,
    input.ontology,
    input.nodePropertySchemas,
    input.structuralSubsumption,
  );
  return registry;
}
