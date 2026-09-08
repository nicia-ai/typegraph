import { type GraphIdentityConfig } from "../core/define-graph";
import { type AnyEdgeType, type NodeType } from "../core/types";
import { ConfigurationError } from "../errors";
import {
  type NamedOntologyRelation,
  type OntologyKindClassification,
  validateOntologyRelations,
} from "../ontology/validation";
import { requireDefined } from "../utils/presence";
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
 * Builds the registry composition needs two passes require: `KindRegistry`
 * supplies `isAssignableToAny` (subclass-closure based, unaffected by
 * composition), so `buildCompositionRelation` needs a registry to run
 * against before its own result can be attached to one. The first registry
 * is validation-only and discarded; the second, identical but for its
 * `composition` field, is what every caller gets back.
 */
function buildRegistryWithComposition(
  input: Readonly<{
    nodeKinds: ReadonlyMap<string, NodeType>;
    edgeKinds: ReadonlyMap<string, AnyEdgeType>;
    ontology: readonly NamedOntologyRelation[];
    edgeFacts: ReadonlyMap<string, EdgeKindFacts>;
    identity?: GraphIdentityConfig;
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

  return new KindRegistry(
    input.nodeKinds,
    input.edgeKinds,
    closures,
    input.identity,
    composition,
  );
}
