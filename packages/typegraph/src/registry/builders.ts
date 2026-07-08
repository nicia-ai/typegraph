/**
 * Builder functions for creating KindRegistry from GraphDef.
 */
import {
  getEdgeKinds,
  getNodeKinds,
  type GraphDef,
} from "../core/define-graph";
import {
  type AnyEdgeType,
  type EdgeRegistration,
  type NodeRegistration,
  type NodeType,
} from "../core/types";
import {
  computeClosuresFromOntology,
  createEmptyClosures,
  KindRegistry,
} from "./kind-registry";
import {
  type EdgeEndpointKinds,
  validateImpliesEndpointCompatibility,
} from "./validate-implies";

// ============================================================
// Build Registry from GraphDef
// ============================================================

/**
 * Builds a KindRegistry from a GraphDef.
 *
 * This precomputes all transitive closures for efficient runtime queries.
 *
 * @example
 * ```typescript
 * const graph = defineGraph({
 *   id: "my_graph",
 *   nodes: { Person: { type: Person }, Company: { type: Company } },
 *   edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
 *   ontology: [subClassOf(Company, Organization)],
 * });
 *
 * const registry = buildKindRegistry(graph);
 * registry.isSubClassOf("Company", "Organization"); // true
 * ```
 */
export function buildKindRegistry<G extends GraphDef>(graph: G): KindRegistry {
  // Extract node types
  const nodeTypes = extractNodeTypes(graph);

  // Extract edge types
  const edgeTypes = extractEdgeTypes(graph);

  // Compute closures from ontology
  const closures =
    graph.ontology.length > 0 ?
      computeClosuresFromOntology(graph.ontology)
    : createEmptyClosures();

  const registry = new KindRegistry(nodeTypes, edgeTypes, closures);
  validateImpliesEndpointCompatibility(
    graph.ontology.map((relation) => ({
      metaEdgeName: relation.metaEdge.name,
      from: relation.from,
      to: relation.to,
    })),
    buildEdgeEndpointKinds(graph.edges),
    registry,
  );

  return registry;
}

/**
 * Maps each registered edge kind to its declared domain/range kind names,
 * for `validateImpliesEndpointCompatibility`. A `Map` (rather than the
 * plain `graph.edges` object) so a lookup for an edge kind literally named
 * "toString" or another `Object.prototype` member can't resolve to an
 * inherited member instead of `undefined`.
 */
function buildEdgeEndpointKinds(
  edges: Record<string, EdgeRegistration>,
): ReadonlyMap<string, EdgeEndpointKinds> {
  const result = new Map<string, EdgeEndpointKinds>();
  for (const [kind, registration] of Object.entries(edges)) {
    result.set(kind, {
      from: registration.from.map((node) => node.kind),
      to: registration.to.map((node) => node.kind),
    });
  }
  return result;
}

// ============================================================
// Node Kind Extraction
// ============================================================

/**
 * Extracts all node types from a GraphDef into a Map.
 */
function extractNodeTypes<G extends GraphDef>(
  graph: G,
): ReadonlyMap<string, NodeType> {
  const result = new Map<string, NodeType>();

  for (const typeName of getNodeKinds(graph)) {
    const registration = graph.nodes[typeName] as NodeRegistration;
    result.set(typeName, registration.type);
  }

  return result;
}

// ============================================================
// Edge Type Extraction
// ============================================================

/**
 * Extracts all edge types from a GraphDef into a Map.
 */
function extractEdgeTypes<G extends GraphDef>(
  graph: G,
): ReadonlyMap<string, AnyEdgeType> {
  const result = new Map<string, AnyEdgeType>();

  for (const typeName of getEdgeKinds(graph)) {
    const registration = graph.edges[typeName] as EdgeRegistration;
    result.set(typeName, registration.type);
  }

  return result;
}
