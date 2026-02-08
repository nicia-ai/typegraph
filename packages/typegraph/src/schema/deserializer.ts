/**
 * Schema deserializer for loading stored schemas.
 *
 * Reconstructs runtime objects from SerializedSchema.
 * Note: Zod schemas cannot be fully reconstructed from JSON Schema,
 * so this provides access to the serialized data for introspection.
 */
import { KindRegistry } from "../registry/kind-registry";
import {
  type SerializedClosures,
  type SerializedEdgeDef,
  type SerializedMetaEdge,
  type SerializedNodeDef,
  type SerializedOntologyRelation,
  type SerializedSchema,
} from "./types";

// ============================================================
// Deserialized Schema
// ============================================================

/**
 * A deserialized schema provides read-only access to schema metadata.
 *
 * Note: Unlike the original GraphDef, this does not include Zod schemas
 * since those cannot be reconstructed from JSON Schema. Use this for
 * introspection and metadata access only.
 */
export type DeserializedSchema = Readonly<{
  graphId: string;
  version: number;
  generatedAt: string;

  /** Get node definition by name */
  getNode: (name: string) => SerializedNodeDef | undefined;

  /** Get all node names */
  getNodeNames: () => readonly string[];

  /** Get edge definition by name */
  getEdge: (name: string) => SerializedEdgeDef | undefined;

  /** Get all edge names */
  getEdgeNames: () => readonly string[];

  /** Get meta-edge definition by name */
  getMetaEdge: (name: string) => SerializedMetaEdge | undefined;

  /** Get all meta-edge names */
  getMetaEdgeNames: () => readonly string[];

  /** Get all ontology relations */
  getRelations: () => readonly SerializedOntologyRelation[];

  /** Get precomputed closures */
  getClosures: () => SerializedClosures;

  /** Get graph defaults */
  getDefaults: () => SerializedSchema["defaults"];

  /** Get the raw serialized schema */
  getRaw: () => SerializedSchema;

  /** Build a KindRegistry from the closures */
  buildRegistry: () => KindRegistry;
}>;

// ============================================================
// Deserialization
// ============================================================

/**
 * Deserializes a SerializedSchema into a DeserializedSchema.
 *
 * @param schema - The serialized schema to deserialize
 * @returns A deserialized schema with accessor methods
 */
export function deserializeSchema(
  schema: SerializedSchema,
): DeserializedSchema {
  const nodeNames = Object.keys(schema.nodes);
  const edgeNames = Object.keys(schema.edges);
  const metaEdgeNames = Object.keys(schema.ontology.metaEdges);

  return {
    graphId: schema.graphId,
    version: schema.version,
    generatedAt: schema.generatedAt,

    getNode: (name) => schema.nodes[name],
    getNodeNames: () => nodeNames,

    getEdge: (name) => schema.edges[name],
    getEdgeNames: () => edgeNames,

    getMetaEdge: (name) => schema.ontology.metaEdges[name],
    getMetaEdgeNames: () => metaEdgeNames,

    getRelations: () => schema.ontology.relations,
    getClosures: () => schema.ontology.closures,

    getDefaults: () => schema.defaults,
    getRaw: () => schema,

    buildRegistry: () => buildRegistryFromClosures(schema),
  };
}

// ============================================================
// Registry Building
// ============================================================

/**
 * Builds a KindRegistry from serialized closures.
 *
 * This allows query execution without recomputing closures.
 */
function buildRegistryFromClosures(schema: SerializedSchema): KindRegistry {
  const { closures } = schema.ontology;

  // Convert Record<string, string[]> back to Map<string, Set<string>>
  const subClassAncestors = recordToMap(closures.subClassAncestors);
  const subClassDescendants = recordToMap(closures.subClassDescendants);
  const broaderClosure = recordToMap(closures.broaderClosure);
  const narrowerClosure = recordToMap(closures.narrowerClosure);
  const equivalenceSets = recordToMap(closures.equivalenceSets);
  const partOfClosure = recordToMap(closures.partOfClosure);
  const hasPartClosure = recordToMap(closures.hasPartClosure);
  const iriToKind = simpleRecordToMap(closures.iriToKind);
  const disjointPairs = new Set(closures.disjointPairs);
  const edgeInverses = simpleRecordToMap(closures.edgeInverses);
  const edgeImplicationsClosure = recordToMap(closures.edgeImplicationsClosure);
  const edgeImplyingClosure = recordToMap(closures.edgeImplyingClosure);

  // Build empty node/edge kind maps (we don't have the actual Zod schemas)
  const nodeKinds = new Map();
  const edgeKinds = new Map();

  return new KindRegistry(nodeKinds, edgeKinds, {
    subClassAncestors,
    subClassDescendants,
    broaderClosure,
    narrowerClosure,
    equivalenceSets,
    iriToKind,
    disjointPairs,
    partOfClosure,
    hasPartClosure,
    edgeInverses,
    edgeImplicationsClosure,
    edgeImplyingClosure,
  });
}

/**
 * Converts Record<string, string[]> to Map<string, Set<string>>.
 */
function recordToMap(
  record: Record<string, readonly string[]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const [key, values] of Object.entries(record)) {
    result.set(key, new Set(values));
  }
  return result;
}

/**
 * Converts Record<string, string> to Map<string, string>.
 */
function simpleRecordToMap(
  record: Record<string, string>,
): ReadonlyMap<string, string> {
  return new Map(Object.entries(record));
}
