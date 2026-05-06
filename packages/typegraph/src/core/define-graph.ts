import { ConfigurationError } from "../errors/index";
import { type IndexDeclaration } from "../indexes/types";
import { type OntologyRelation } from "../ontology/types";
import { type RuntimeGraphDocument } from "../runtime/document-types";
import {
  type AnyEdgeType,
  type DeleteBehavior,
  type EdgeRegistration,
  type EdgeTypeWithEndpoints,
  type GraphDefaults,
  isEdgeType,
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
 * - EdgeType directly (constrained or unconstrained)
 * - EdgeRegistration object (always works, can override/narrow defaults)
 */
type EdgeEntry = EdgeRegistration | AnyEdgeType;

/**
 * Normalized edge map type - all entries become EdgeRegistration.
 * For bare EdgeTypes, constrained endpoints are extracted from the type;
 * unconstrained edges fall back to all node types in the graph.
 */
type NormalizedEdges<
  TNodes extends Record<string, NodeRegistration>,
  TEdges extends Record<string, EdgeEntry>,
> = {
  [K in keyof TEdges]: TEdges[K] extends EdgeRegistration ? TEdges[K]
  : TEdges[K] extends AnyEdgeType ?
    EdgeRegistration<
      TEdges[K],
      TEdges[K]["from"] extends readonly (infer N extends NodeType)[] ? N
      : TNodes[keyof TNodes]["type"],
      TEdges[K]["to"] extends readonly (infer N extends NodeType)[] ? N
      : TNodes[keyof TNodes]["type"]
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
  const builtInFromNames = new Set(edgeType.from.map((n) => n.kind));
  for (const fromNode of registration.from) {
    if (!builtInFromNames.has(fromNode.kind)) {
      throw new ConfigurationError(
        `Edge "${name}" registration has 'from' kind "${fromNode.kind}" ` +
          `not in edge's built-in domain: [${[...builtInFromNames].join(", ")}]`,
        {
          edgeName: name,
          invalidFrom: fromNode.kind,
          allowedFrom: [...builtInFromNames],
        },
        {
          suggestion: `Edge registration can only narrow, not widen, the edge type's built-in constraints.`,
        },
      );
    }
  }

  const builtInToNames = new Set(edgeType.to.map((n) => n.kind));
  for (const toNode of registration.to) {
    if (!builtInToNames.has(toNode.kind)) {
      throw new ConfigurationError(
        `Edge "${name}" registration has 'to' kind "${toNode.kind}" ` +
          `not in edge's built-in range: [${[...builtInToNames].join(", ")}]`,
        {
          edgeName: name,
          invalidTo: toNode.kind,
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
function normalizeEdgeEntry(
  name: string,
  entry: EdgeEntry,
  allNodeTypes: readonly NodeType[],
): EdgeRegistration {
  if (isEdgeType(entry)) {
    if (isEdgeTypeWithEndpoints(entry)) {
      // EdgeType with from/to — convert to EdgeRegistration
      return { type: entry, from: entry.from, to: entry.to };
    }
    // Unconstrained EdgeType — allow any→any
    return { type: entry, from: allNodeTypes, to: allNodeTypes };
  }

  // Already EdgeRegistration — validate narrowing if edge has built-in constraints
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
  allNodeTypes: readonly NodeType[],
): Record<string, EdgeRegistration> {
  const result: Record<string, EdgeRegistration> = {};
  for (const [name, entry] of Object.entries(edges)) {
    result[name] = normalizeEdgeEntry(name, entry, allNodeTypes);
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
  /**
   * Index declarations attached to this graph.
   *
   * Accepts the outputs of `defineNodeIndex` / `defineEdgeIndex` (which
   * already return `IndexDeclaration` values) or pre-built declarations
   * reconstructed from a stored schema or runtime extension document.
   *
   * Validated at definition time: every index must reference a `kind`
   * that exists in `nodes` / `edges`, and index `name`s must be unique
   * within the graph.
   *
   * Index DDL is **not** generated by `defineGraph`. Indexes flow into
   * `SerializedSchema.indexes` so they can later be materialized via
   * `store.materializeIndexes()` — lifting the storage concern out of
   * the schema-version commit path.
   */
  indexes?: readonly IndexDeclaration[];
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
  /**
   * Index declarations attached to this graph. Preserves whatever the
   * caller passed to `defineGraph` (including an explicit empty array)
   * for introspection purposes.
   *
   * The serialized canonical form is order-canonicalized (sorted by
   * `name`) and treats `undefined` and `[]` as the same "no slice" form
   * — an empty array does not bump the schema hash, since indexes are
   * an unordered set keyed by name and `[]` carries no semantic meaning
   * that an absent slice doesn't.
   */
  indexes: readonly IndexDeclaration[] | undefined;
  /**
   * Runtime extension document this graph was merged with, if any. Set
   * by `mergeRuntimeExtension`; never set by `defineGraph` directly.
   * Exists solely so re-serialization is stable — the rest of the
   * system reads the merged kinds through `nodes` / `edges` /
   * `ontology` and never inspects this field. Absent on graphs that
   * have never been runtime-extended; legacy graphs hash byte-identically.
   */
  runtimeDocument: RuntimeGraphDocument | undefined;
}>;

// ============================================================
// Type Helpers
// ============================================================

/**
 * Extract node kind names from a GraphDef.
 */
export type NodeKinds<G extends GraphDef> = keyof G["nodes"] & string;

/**
 * Extract edge kind names from a GraphDef.
 */
export type EdgeKinds<G extends GraphDef> = keyof G["edges"] & string;

/**
 * Get a NodeType from a GraphDef by kind name.
 */
export type GetNodeType<
  G extends GraphDef,
  K extends NodeKinds<G>,
> = G["nodes"][K]["type"];

/**
 * Get an EdgeType from a GraphDef by kind name.
 */
export type GetEdgeType<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = G["edges"][K]["type"];

/**
 * Get all NodeTypes from a GraphDef.
 */
export type AllNodeTypes<G extends GraphDef> = {
  [K in NodeKinds<G>]: G["nodes"][K]["type"];
}[NodeKinds<G>];

/**
 * Get all EdgeTypes from a GraphDef.
 */
export type AllEdgeTypes<G extends GraphDef> = {
  [K in EdgeKinds<G>]: G["edges"][K]["type"];
}[EdgeKinds<G>];

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
  const TNodes extends Record<string, NodeRegistration<NodeType>>,
  const TEdges extends Record<string, EdgeEntry>,
  const TOntology extends readonly OntologyRelation[],
>(
  config: GraphDefConfig<TNodes, TEdges, TOntology>,
): GraphDef<TNodes, NormalizedEdges<TNodes, TEdges>, TOntology> {
  const defaults = {
    onNodeDelete: config.defaults?.onNodeDelete ?? "restrict",
    temporalMode: config.defaults?.temporalMode ?? "current",
  } as const;

  const allNodeTypes = Object.values(config.nodes).map((reg) => reg.type);
  const normalizedEdges = normalizeEdges(config.edges, allNodeTypes);
  const indexes =
    config.indexes === undefined ?
      undefined
    : normalizeIndexes(config.indexes, config.nodes, normalizedEdges);

  return Object.freeze({
    [GRAPH_DEF_BRAND]: true as const,
    id: config.id,
    nodes: config.nodes,
    edges: normalizedEdges,
    ontology: config.ontology ?? ([] as unknown as TOntology),
    defaults,
    indexes,
    runtimeDocument: undefined,
  }) as GraphDef<TNodes, NormalizedEdges<TNodes, TEdges>, TOntology>;
}

// ============================================================
// Index Normalization
// ============================================================

/**
 * Validates the `indexes` config slice:
 *
 * - Every index references a kind that exists in the graph's `nodes`
 *   (for node indexes) or `edges` (for edge indexes).
 * - Index `name`s are unique within the graph.
 */
function normalizeIndexes(
  inputs: readonly IndexDeclaration[],
  nodes: Record<string, NodeRegistration>,
  edges: Record<string, EdgeRegistration>,
): readonly IndexDeclaration[] {
  if (inputs.length === 0) {
    return [];
  }

  const nodeKinds = collectKinds(nodes);
  const edgeKinds = collectKinds(edges);
  const seenNames = new Set<string>();

  for (const declaration of inputs) {
    if (declaration.entity === "node") {
      assertKindRegistered(declaration, nodeKinds, "node");
    } else {
      assertKindRegistered(declaration, edgeKinds, "edge");
    }

    if (seenNames.has(declaration.name)) {
      throw new ConfigurationError(
        `Duplicate index name "${declaration.name}" in defineGraph({ indexes }). ` +
          `Index names must be unique within a graph.`,
        { indexName: declaration.name },
        {
          suggestion: `Pass an explicit { name: "..." } to disambiguate.`,
        },
      );
    }
    seenNames.add(declaration.name);
  }

  return inputs;
}

function collectKinds(
  registrations: Record<string, { type: { kind: string } }>,
): ReadonlySet<string> {
  const kinds = new Set<string>();
  for (const registration of Object.values(registrations)) {
    kinds.add(registration.type.kind);
  }
  return kinds;
}

function assertKindRegistered(
  declaration: IndexDeclaration,
  registeredKinds: ReadonlySet<string>,
  entity: "node" | "edge",
): void {
  if (registeredKinds.has(declaration.kind)) return;

  const slot = entity === "node" ? "nodes" : "edges";
  const suggestion =
    entity === "node" ?
      `Add { ${declaration.kind}: { type: ${declaration.kind} } } to defineGraph({ nodes }) ` +
      `or remove the index from "indexes".`
    : `Register the edge in defineGraph({ edges }) or remove the index from "indexes".`;

  throw new ConfigurationError(
    `Index "${declaration.name}" references ${entity} kind "${declaration.kind}" ` +
      `which is not registered in this graph's "${slot}".`,
    {
      indexName: declaration.name,
      referencedKind: declaration.kind,
      availableKinds: [...registeredKinds],
    },
    { suggestion },
  );
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
 * Gets all node kind names from a GraphDef.
 */
export function getNodeKinds<G extends GraphDef>(
  graph: G,
): readonly (keyof G["nodes"] & string)[] {
  return Object.keys(graph.nodes);
}

/**
 * Gets all edge kind names from a GraphDef.
 */
export function getEdgeKinds<G extends GraphDef>(
  graph: G,
): readonly (keyof G["edges"] & string)[] {
  return Object.keys(graph.edges);
}
