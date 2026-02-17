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

  return new KindRegistry(nodeTypes, edgeTypes, closures);
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
