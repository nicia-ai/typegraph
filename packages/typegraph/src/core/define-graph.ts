import { ConfigurationError } from "../errors/index";
import { type OntologyRelation } from "../ontology/types";
import {
  type DeleteBehavior,
  type EdgeRegistration,
  type EdgeTypeWithEndpoints,
  type GraphDefaults,
  isEdgeTypeWithEndpoints,
  type NodeRegistration,
  type NodeType,
  type TemporalMode,
} from "./types";

// ============================================================
// Graph Definition Brand Symbol
// ============================================================

/** Brand key for GraphDef */
const GRAPH_DEF_BRAND = "__graphDef" as const;

// ============================================================
// Edge Entry Types
// ============================================================

/**
 * An edge entry in the graph definition.
 * Can be:
 * - EdgeType directly (if it has from/to defined)
 * - EdgeRegistration object (always works, can override/narrow defaults)
 */
type EdgeEntry = EdgeRegistration | EdgeTypeWithEndpoints;

/**
 * Normalized edge map type - all entries become EdgeRegistration.
 */
type NormalizedEdges<TEdges extends Record<string, EdgeEntry>> = {
  [K in keyof TEdges]: TEdges[K] extends EdgeRegistration ? TEdges[K]
  : TEdges[K] extends EdgeTypeWithEndpoints ?
    EdgeRegistration<
      TEdges[K],
      TEdges[K]["from"][number],
      TEdges[K]["to"][number]
    >
  : never;
};

// ============================================================
// Edge Normalization Functions
// ============================================================

/**
 * Validates that an EdgeRegistration's constraints don't widen beyond
 * the edge type's built-in domain/range constraints.
 */
function validateConstraintNarrowing(
  name: string,
  edgeType: EdgeTypeWithEndpoints,
  registration: EdgeRegistration,
): void {
  const builtInFromNames = new Set(edgeType.from.map((n) => n.name));
  for (const fromNode of registration.from) {
    if (!builtInFromNames.has(fromNode.name)) {
      throw new ConfigurationError(
        `Edge "${name}" registration has 'from' kind "${fromNode.name}" ` +
          `not in edge's built-in domain: [${[...builtInFromNames].join(", ")}]`,
        {
          edgeName: name,
          invalidFrom: fromNode.name,
          allowedFrom: [...builtInFromNames],
        },
        {
          suggestion: `Edge registration can only narrow, not widen, the edge type's built-in constraints.`,
        },
      );
    }
  }

  const builtInToNames = new Set(edgeType.to.map((n) => n.name));
  for (const toNode of registration.to) {
    if (!builtInToNames.has(toNode.name)) {
      throw new ConfigurationError(
        `Edge "${name}" registration has 'to' kind "${toNode.name}" ` +
          `not in edge's built-in range: [${[...builtInToNames].join(", ")}]`,
        {
          edgeName: name,
          invalidTo: toNode.name,
          allowedTo: [...builtInToNames],
        },
        {
          suggestion: `Edge registration can only narrow, not widen, the edge type's built-in constraints.`,
        },
      );
    }
  }
}

/**
 * Normalizes a single edge entry to EdgeRegistration.
 */
function normalizeEdgeEntry(name: string, entry: EdgeEntry): EdgeRegistration {
  if (isEdgeTypeWithEndpoints(entry)) {
    // EdgeType with from/to - convert to EdgeRegistration
    return {
      type: entry,
      from: entry.from,
      to: entry.to,
    };
  }

  // Already EdgeRegistration - validate narrowing if edge has built-in constraints
  if (isEdgeTypeWithEndpoints(entry.type)) {
    validateConstraintNarrowing(name, entry.type, entry);
  }

  return entry;
}

/**
 * Normalizes all edge entries to EdgeRegistration.
 */
function normalizeEdges(
  edges: Record<string, EdgeEntry>,
): Record<string, EdgeRegistration> {
  const result: Record<string, EdgeRegistration> = {};
  for (const [name, entry] of Object.entries(edges)) {
    result[name] = normalizeEdgeEntry(name, entry);
  }
  return result;
}

// ============================================================
// Graph Definition Configuration
// ============================================================

/**
 * Configuration for defineGraph.
 */
type GraphDefConfig<
  TNodes extends Record<string, NodeRegistration>,
  TEdges extends Record<string, EdgeEntry>,
  TOntology extends readonly OntologyRelation[],
> = Readonly<{
  /** Unique identifier for this graph */
  id: string;
  /** Node registrations */
  nodes: TNodes;
  /** Edge registrations or EdgeTypes with built-in domain/range */
  edges: TEdges;
  /** Ontology relations */
  ontology?: TOntology;
  /** Graph-wide defaults */
  defaults?: GraphDefaults;
}>;

// ============================================================
// Graph Definition Type
// ============================================================

/**
 * A graph definition.
 *
 * This is a compile-time artifact that describes the structure of a graph.
 * Use `createStore()` to create a runtime store from this definition.
 */
export type GraphDef<
  TNodes extends Record<string, NodeRegistration> = Record<
    string,
    NodeRegistration
  >,
  TEdges extends Record<string, EdgeRegistration> = Record<
    string,
    EdgeRegistration
  >,
  TOntology extends readonly OntologyRelation[] = readonly OntologyRelation[],
> = Readonly<{
  [GRAPH_DEF_BRAND]: true;
  id: string;
  nodes: TNodes;
  edges: TEdges;
  ontology: TOntology;
  defaults: Readonly<{
    onNodeDelete: DeleteBehavior;
    temporalMode: TemporalMode;
  }>;
}>;

// ============================================================
// Type Helpers
// ============================================================

/**
 * Extract node type names from a GraphDef.
 */
export type NodeTypeNames<G extends GraphDef> = keyof G["nodes"] & string;

/**
 * Extract edge type names from a GraphDef.
 */
export type EdgeTypeNames<G extends GraphDef> = keyof G["edges"] & string;

/**
 * Get a NodeType from a GraphDef by name.
 */
export type GetNodeType<
  G extends GraphDef,
  K extends NodeTypeNames<G>,
> = G["nodes"][K]["type"];

/**
 * Get an EdgeType from a GraphDef by name.
 */
export type GetEdgeType<
  G extends GraphDef,
  K extends EdgeTypeNames<G>,
> = G["edges"][K]["type"];

/**
 * Get all NodeTypes from a GraphDef.
 */
export type AllNodeTypes<G extends GraphDef> = {
  [K in NodeTypeNames<G>]: G["nodes"][K]["type"];
}[NodeTypeNames<G>];

/**
 * Get all EdgeTypes from a GraphDef.
 */
export type AllEdgeTypes<G extends GraphDef> = {
  [K in EdgeTypeNames<G>]: G["edges"][K]["type"];
}[EdgeTypeNames<G>];

// ============================================================
// Define Graph Function
// ============================================================

/**
 * Creates a graph definition.
 *
 * @example
 * ```typescript
 * const graph = defineGraph({
 *   id: "my_graph",
 *   nodes: {
 *     Person: { type: Person },
 *     Company: { type: Company },
 *   },
 *   edges: {
 *     // Traditional EdgeRegistration syntax
 *     worksAt: {
 *       type: worksAt,
 *       from: [Person],
 *       to: [Company],
 *       cardinality: "many",
 *     },
 *     // Or use EdgeType directly if it has from/to defined
 *     knows,  // EdgeType with built-in domain/range
 *   },
 *   ontology: [
 *     subClassOf(Company, Organization),
 *     disjointWith(Person, Organization),
 *   ],
 *   defaults: {
 *     onNodeDelete: "restrict",
 *     temporalMode: "current",
 *   },
 * });
 * ```
 */
export function defineGraph<
  TNodes extends Record<string, NodeRegistration<NodeType>>,
  TEdges extends Record<string, EdgeEntry>,
  TOntology extends readonly OntologyRelation[],
>(
  config: GraphDefConfig<TNodes, TEdges, TOntology>,
): GraphDef<TNodes, NormalizedEdges<TEdges>, TOntology> {
  const defaults = {
    onNodeDelete: config.defaults?.onNodeDelete ?? "restrict",
    temporalMode: config.defaults?.temporalMode ?? "current",
  } as const;

  const normalizedEdges = normalizeEdges(config.edges);

  return Object.freeze({
    [GRAPH_DEF_BRAND]: true as const,
    id: config.id,
    nodes: config.nodes,
    edges: normalizedEdges,
    ontology: config.ontology ?? ([] as unknown as TOntology),
    defaults,
  }) as GraphDef<TNodes, NormalizedEdges<TEdges>, TOntology>;
}

// ============================================================
// Graph Definition Utilities
// ============================================================

/**
 * Checks if a value is a GraphDef.
 */
export function isGraphDef(value: unknown): value is GraphDef {
  return (
    typeof value === "object" &&
    value !== null &&
    GRAPH_DEF_BRAND in value &&
    (value as Record<string, unknown>)[GRAPH_DEF_BRAND] === true
  );
}

/**
 * Gets all node type names from a GraphDef.
 */
export function getNodeTypeNames<G extends GraphDef>(
  graph: G,
): readonly string[] {
  return Object.keys(graph.nodes);
}

/**
 * Gets all edge type names from a GraphDef.
 */
export function getEdgeTypeNames<G extends GraphDef>(
  graph: G,
): readonly string[] {
  return Object.keys(graph.edges);
}
