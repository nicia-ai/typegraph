import { type AnyEdgeType, type NodeType } from "../core/types";
import { ConfigurationError } from "../errors";
import {
  type NamedOntologyRelation,
  validateOntologyRelations,
} from "../ontology/validation";
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
  }>,
): KindRegistry {
  if (input.ontology.length === 0) {
    const registry = new KindRegistry(
      input.nodeKinds,
      input.edgeKinds,
      createEmptyClosures(),
    );
    validateImpliesEndpointCompatibility(input.edgeEndpoints, registry);
    return registry;
  }

  const issues = validateOntologyRelations(input.ontology);
  if (issues.length > 0) {
    const firstIssue = issues[0]!;
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
  const registry = new KindRegistry(input.nodeKinds, input.edgeKinds, closures);
  validateImpliesEndpointCompatibility(input.edgeEndpoints, registry);
  validateInverseEndpointCompatibility(
    input.ontology,
    input.edgeEndpoints,
    registry,
  );
  return registry;
}
