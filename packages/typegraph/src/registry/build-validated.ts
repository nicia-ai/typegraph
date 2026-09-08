import { type GraphIdentityConfig } from "../core/define-graph";
import { type AnyEdgeType, type NodeType } from "../core/types";
import { ConfigurationError } from "../errors";
import {
  type NamedOntologyRelation,
  type OntologyKindClassification,
  validateOntologyRelations,
} from "../ontology/validation";
import { requireDefined } from "../utils/presence";
import {
  computeClosuresFromNamedOntology,
  createEmptyClosures,
  KindRegistry,
} from "./kind-registry";
import {
  type EdgeEndpointKinds,
  validateImpliesEndpointCompatibility,
} from "./validate-implies";
import { validateInverseEndpointCompatibility } from "./validate-inverse";

export function buildValidatedKindRegistry(
  input: Readonly<{
    nodeKinds: ReadonlyMap<string, NodeType>;
    edgeKinds: ReadonlyMap<string, AnyEdgeType>;
    ontology: readonly NamedOntologyRelation[];
    edgeEndpoints: ReadonlyMap<string, EdgeEndpointKinds>;
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
    validateImpliesEndpointCompatibility(input.edgeEndpoints, registry);
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
  const registry = new KindRegistry(
    input.nodeKinds,
    input.edgeKinds,
    closures,
    input.identity,
  );
  validateImpliesEndpointCompatibility(input.edgeEndpoints, registry);
  validateInverseEndpointCompatibility(
    input.ontology,
    input.edgeEndpoints,
    registry,
  );
  return registry;
}
