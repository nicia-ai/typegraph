/**
 * Schema deserializer for loading stored schemas.
 *
 * Reconstructs runtime objects from SerializedSchema.
 * Note: Zod schemas cannot be fully reconstructed from JSON Schema,
 * so this provides access to the serialized data for introspection.
 */
import { type AnyEdgeType, type NodeType } from "../core/types";
import { type NamedOntologyRelation } from "../ontology/validation";
import { buildValidatedKindRegistry } from "../registry/build-validated";
import { compositionRelationFields } from "../registry/composition-relation";
import { type EdgeKindFacts } from "../registry/edge-kind-facts";
import type { KindRegistry } from "../registry/kind-registry";
import { hasOwnKey } from "../utils/object";
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

  /** Get the durable TypeGraph Identity Profile configuration. */
  getIdentity: () => SerializedSchema["identity"];

  /** Get the raw serialized schema */
  getRaw: () => SerializedSchema;

  /** Build a validated KindRegistry by recomputing closures from relations */
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

    // Own-key reads, for the same reason {@link buildSerializedEdgeKindFacts} below
    // uses a `Map`: `schema` is parsed out of a stored JSON document and the
    // caller supplies the name, so a raw read hands back an `Object.prototype`
    // member typed as a definition for any name no kind is registered under.
    getNode: (name) =>
      hasOwnKey(schema.nodes, name) ? schema.nodes[name] : undefined,
    getNodeNames: () => nodeNames,

    getEdge: (name) =>
      hasOwnKey(schema.edges, name) ? schema.edges[name] : undefined,
    getEdgeNames: () => edgeNames,

    getMetaEdge: (name) =>
      hasOwnKey(schema.ontology.metaEdges, name) ?
        schema.ontology.metaEdges[name]
      : undefined,
    getMetaEdgeNames: () => metaEdgeNames,

    getRelations: () => schema.ontology.relations,
    getClosures: () => schema.ontology.closures,

    getDefaults: () => schema.defaults,
    getIdentity: () => schema.identity,
    getRaw: () => schema,

    buildRegistry: () => buildRegistryFromSerializedSchema(schema),
  };
}

// ============================================================
// Registry Building
// ============================================================

/**
 * Builds a KindRegistry from a serialized schema's ontology, edges, and
 * identity slices.
 *
 * Persisted closures are a legacy inspection artifact. Relations are validated
 * and closures are recomputed so old schemas gain current hardening rules.
 *
 * Deliberately narrower than `SerializedSchema`: `nodes` carries no
 * information this construction needs (node kinds are discovered through the
 * ontology relations and edge endpoints, and no Zod schema can be
 * reconstructed from JSON Schema anyway), so the ontology-tightening
 * classifier (`src/schema/ontology-change.ts`) can build a registry for
 * either side of a diff from an `OntologySnapshot` without also carrying the
 * property-schema slice.
 *
 * Exported (renamed from the former private `buildRegistryFromRelations`) so
 * the deserializer's registry and the ontology-tightening classifier's
 * registry are the SAME construction — one owner, so a persisted ontology
 * cannot be interpreted two different ways by two call sites.
 */
export function buildRegistryFromSerializedSchema(
  schema: Pick<SerializedSchema, "ontology" | "nodes" | "edges" | "identity">,
): KindRegistry {
  // Build empty node/edge kind maps (we don't have the actual Zod schemas)
  const nodeKinds = new Map<string, NodeType>();
  const edgeKinds = new Map<string, AnyEdgeType>();
  return buildValidatedKindRegistry({
    nodeKinds,
    edgeKinds,
    ontology: schema.ontology.relations.map(
      (relation): NamedOntologyRelation => ({
        metaEdge: relation.metaEdge,
        from: relation.from,
        to: relation.to,
        ...compositionRelationFields(relation),
      }),
    ),
    edgeFacts: buildSerializedEdgeKindFacts(schema.edges),
    // The registry above is built with EMPTY node/edge kind maps (no Zod
    // schemas survive serialization), so the equivalence-class check needs
    // its own classifier built from the document's own `nodes`/`edges`
    // records, or every name would classify as neither and the check would
    // silently pass a persisted schema `buildValidatedKindRegistry` would
    // otherwise refuse.
    kindClassification: {
      isNodeKind: (name) => hasOwnKey(schema.nodes, name),
      isEdgeKind: (name) => hasOwnKey(schema.edges, name),
    },
    ...(schema.identity === undefined ? {} : { identity: schema.identity }),
  });
}

/**
 * Maps each edge kind's serialized definition to its domain/range kind
 * names and cardinalities, for `validateImpliesEndpointCompatibility`, for
 * `expandEdgeEndpointAllowance` (`src/registry/edge-endpoint-allowance.ts`),
 * and for `buildCompositionRelation`
 * (`src/registry/composition-relation.ts`). A `Map` (rather than the plain
 * `schema.edges` object) so a lookup for an edge kind literally named
 * "toString" or another `Object.prototype` member can't resolve to an
 * inherited member instead of `undefined`.
 */
export function buildSerializedEdgeKindFacts(
  edges: Record<string, SerializedEdgeDef>,
): ReadonlyMap<string, EdgeKindFacts> {
  const result = new Map<string, EdgeKindFacts>();
  for (const [kind, def] of Object.entries(edges)) {
    const pairs: { from: string; to: string }[] = [];
    if (def.targetKindsBySource === undefined) {
      for (const fromKind of def.fromKinds) {
        for (const toKind of def.toKinds) {
          pairs.push({ from: fromKind, to: toKind });
        }
      }
    } else {
      for (const [sourceKind, targetKinds] of Object.entries(
        def.targetKindsBySource,
      )) {
        for (const targetKind of targetKinds) {
          pairs.push({ from: sourceKind, to: targetKind });
        }
      }
    }
    result.set(kind, {
      from: def.fromKinds,
      to: def.toKinds,
      pairs,
      cardinality: def.cardinality,
      targetCardinality: def.targetCardinality,
    });
  }
  return result;
}
