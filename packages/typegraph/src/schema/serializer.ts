/**
 * Schema serializer for homoiconic storage.
 *
 * Converts a GraphDef to a SerializedSchema for database storage.
 * Uses Zod's toJSONSchema() for property schema serialization.
 */
import type * as Crypto from "node:crypto";

import { z } from "zod";

import {
  getEdgeTypeNames,
  getNodeTypeNames,
  type GraphDef,
} from "../core/define-graph";
import {
  type EdgeRegistration,
  type EdgeType,
  type NodeRegistration,
  type NodeType,
  type UniqueConstraint,
} from "../core/types";
import {
  getTypeName,
  type MetaEdge,
  type OntologyRelation,
} from "../ontology/types";
import { computeClosuresFromOntology } from "../registry/kind-registry";
import { nowIso } from "../utils/date";
import {
  type JsonSchema,
  type SchemaHash,
  type SerializedClosures,
  type SerializedEdgeDef,
  type SerializedMetaEdge,
  type SerializedNodeDef,
  type SerializedOntology,
  type SerializedOntologyRelation,
  type SerializedSchema,
  type SerializedUniqueConstraint,
} from "./types";

// ============================================================
// Main Serialization
// ============================================================

/**
 * Serializes a GraphDef to a SerializedSchema.
 *
 * @param graph - The graph definition to serialize
 * @param version - The schema version number
 * @returns The serialized schema
 */
export function serializeSchema<G extends GraphDef>(
  graph: G,
  version: number,
): SerializedSchema {
  const nodes = serializeNodes(graph);
  const edges = serializeEdges(graph);
  const ontology = serializeOntology(graph.ontology);

  return {
    graphId: graph.id,
    version,
    generatedAt: nowIso(),
    nodes,
    edges,
    ontology,
    defaults: {
      onNodeDelete: graph.defaults.onNodeDelete,
      temporalMode: graph.defaults.temporalMode,
    },
  };
}

// ============================================================
// Node Serialization
// ============================================================

/**
 * Serializes all node definitions.
 */
function serializeNodes<G extends GraphDef>(
  graph: G,
): Record<string, SerializedNodeDef> {
  const result: Record<string, SerializedNodeDef> = {};

  for (const kindName of getNodeTypeNames(graph)) {
    const registration = graph.nodes[kindName] as NodeRegistration;
    result[kindName] = serializeNodeDef(registration);
  }

  return result;
}

/**
 * Serializes a single node registration.
 */
function serializeNodeDef(registration: NodeRegistration): SerializedNodeDef {
  const node = registration.type as NodeType;

  return {
    name: node.name,
    properties: serializeZodSchema(node.schema),
    uniqueConstraints: serializeUniqueConstraints(registration.unique ?? []),
    onDelete: registration.onDelete ?? "restrict",
    description: node.description,
  };
}

/**
 * Serializes unique constraints.
 */
function serializeUniqueConstraints(
  constraints: readonly UniqueConstraint[],
): readonly SerializedUniqueConstraint[] {
  return constraints.map((constraint) => ({
    name: constraint.name,
    fields: [...constraint.fields],
    where:
      constraint.where ? serializeWherePredicate(constraint.where) : undefined,
    scope: constraint.scope,
    collation: constraint.collation,
  }));
}

/**
 * A serialized predicate structure (matches UniqueConstraintPredicate from core/types).
 */
type SerializedPredicate = Readonly<{
  __type: "unique_predicate";
  field: string;
  op: "isNull" | "isNotNull";
}>;

/**
 * Field builder returned by the predicate proxy.
 */
type FieldPredicateBuilder = Readonly<{
  isNull: () => SerializedPredicate;
  isNotNull: () => SerializedPredicate;
}>;

/**
 * Predicate builder type for where clause serialization.
 */
type PredicateBuilder = Readonly<Record<string, FieldPredicateBuilder>>;

/**
 * Serializes a where predicate function to a JSON-serializable structure.
 *
 * The where function is called with a proxy builder that captures the
 * field and operation, which can then be serialized and later deserialized.
 */
function serializeWherePredicate(
  whereFunction: (builder: PredicateBuilder) => SerializedPredicate,
): string {
  // Create a proxy builder that captures the predicate structure
  const builder = new Proxy({} as PredicateBuilder, {
    get(_target, field: string): FieldPredicateBuilder {
      return {
        isNull: (): SerializedPredicate => ({
          __type: "unique_predicate",
          field,
          op: "isNull" as const,
        }),
        isNotNull: (): SerializedPredicate => ({
          __type: "unique_predicate",
          field,
          op: "isNotNull" as const,
        }),
      };
    },
  });

  // Call the where function to get the predicate
  const predicate = whereFunction(builder);

  // Serialize the predicate structure as JSON
  return JSON.stringify({ field: predicate.field, op: predicate.op });
}

/**
 * Deserializes a where predicate JSON back to a predicate function.
 *
 * This can be used to reconstruct a UniqueConstraint's where clause
 * from a serialized schema.
 *
 * @param serialized - The JSON string from serialization
 * @returns A where function that returns the predicate structure
 */
/**
 * Unique predicate result type.
 */
type UniquePredicate = Readonly<{
  __type: "unique_predicate";
  field: string;
  op: "isNull" | "isNotNull";
}>;

export function deserializeWherePredicate(
  serialized: string,
): (builder: PredicateBuilder) => UniquePredicate {
  const parsed = JSON.parse(serialized) as {
    field: string;
    op: "isNull" | "isNotNull";
  };

  return (builder: PredicateBuilder): UniquePredicate => {
    const fieldBuilder = builder[parsed.field];
    if (!fieldBuilder) {
      throw new Error(`Unknown field in where predicate: ${parsed.field}`);
    }

    const result =
      parsed.op === "isNull" ? fieldBuilder.isNull() : fieldBuilder.isNotNull();
    return {
      __type: "unique_predicate",
      field: result.field,
      op: result.op,
    };
  };
}

// ============================================================
// Edge Serialization
// ============================================================

/**
 * Serializes all edge definitions.
 */
function serializeEdges<G extends GraphDef>(
  graph: G,
): Record<string, SerializedEdgeDef> {
  const result: Record<string, SerializedEdgeDef> = {};

  for (const kindName of getEdgeTypeNames(graph)) {
    const registration = graph.edges[kindName] as EdgeRegistration;
    result[kindName] = serializeEdgeDef(registration);
  }

  return result;
}

/**
 * Serializes a single edge registration.
 */
function serializeEdgeDef(registration: EdgeRegistration): SerializedEdgeDef {
  const edge = registration.type as EdgeType;

  return {
    name: edge.name,
    fromKinds: registration.from.map((node) => (node as NodeType).name),
    toKinds: registration.to.map((node) => (node as NodeType).name),
    properties: serializeZodSchema(edge.schema),
    cardinality: registration.cardinality ?? "many",
    endpointExistence: registration.endpointExistence ?? "notDeleted",
    description: edge.description,
  };
}

// ============================================================
// Ontology Serialization
// ============================================================

/**
 * Serializes the complete ontology.
 */
function serializeOntology(
  relations: readonly OntologyRelation[],
): SerializedOntology {
  // Collect unique meta-edges
  const metaEdgeMap = new Map<string, MetaEdge>();
  for (const relation of relations) {
    const metaEdge = relation.metaEdge;
    if (!metaEdgeMap.has(metaEdge.name)) {
      metaEdgeMap.set(metaEdge.name, metaEdge);
    }
  }

  // Serialize meta-edges
  const metaEdges: Record<string, SerializedMetaEdge> = {};
  for (const [name, metaEdge] of metaEdgeMap) {
    metaEdges[name] = serializeMetaEdge(metaEdge);
  }

  // Serialize relations
  const serializedRelations = relations.map((relation) =>
    serializeOntologyRelation(relation),
  );

  // Compute and serialize closures
  const closures = serializeClosures(relations);

  return {
    metaEdges,
    relations: serializedRelations,
    closures,
  };
}

/**
 * Serializes a meta-edge.
 */
function serializeMetaEdge(metaEdge: MetaEdge): SerializedMetaEdge {
  return {
    name: metaEdge.name,
    transitive: metaEdge.properties.transitive,
    symmetric: metaEdge.properties.symmetric,
    reflexive: metaEdge.properties.reflexive,
    inverse: metaEdge.properties.inverse,
    inference: metaEdge.properties.inference,
    description: metaEdge.properties.description,
  };
}

/**
 * Serializes an ontology relation.
 */
function serializeOntologyRelation(
  relation: OntologyRelation,
): SerializedOntologyRelation {
  return {
    metaEdge: relation.metaEdge.name,
    from: getTypeName(relation.from),
    to: getTypeName(relation.to),
  };
}

/**
 * Serializes precomputed closures.
 */
function serializeClosures(
  relations: readonly OntologyRelation[],
): SerializedClosures {
  if (relations.length === 0) {
    return {
      subClassAncestors: {},
      subClassDescendants: {},
      broaderClosure: {},
      narrowerClosure: {},
      equivalenceSets: {},
      disjointPairs: [],
      partOfClosure: {},
      hasPartClosure: {},
      iriToKind: {},
      edgeInverses: {},
      edgeImplicationsClosure: {},
      edgeImplyingClosure: {},
    };
  }

  const computed = computeClosuresFromOntology(relations);

  return {
    subClassAncestors: mapToRecord(computed.subClassAncestors),
    subClassDescendants: mapToRecord(computed.subClassDescendants),
    broaderClosure: mapToRecord(computed.broaderClosure),
    narrowerClosure: mapToRecord(computed.narrowerClosure),
    equivalenceSets: mapToRecord(computed.equivalenceSets),
    disjointPairs: [...computed.disjointPairs],
    partOfClosure: mapToRecord(computed.partOfClosure),
    hasPartClosure: mapToRecord(computed.hasPartClosure),
    iriToKind: mapToSimpleRecord(computed.iriToKind),
    edgeInverses: mapToSimpleRecord(computed.edgeInverses),
    edgeImplicationsClosure: mapToRecord(computed.edgeImplicationsClosure),
    edgeImplyingClosure: mapToRecord(computed.edgeImplyingClosure),
  };
}

/**
 * Converts a Map<string, Set<string>> to Record<string, string[]>.
 */
function mapToRecord(
  map: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {};
  for (const [key, values] of map) {
    result[key] = [...values];
  }
  return result;
}

/**
 * Converts a Map<string, string> to Record<string, string>.
 */
function mapToSimpleRecord(
  map: ReadonlyMap<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of map) {
    result[key] = value;
  }
  return result;
}

// ============================================================
// Zod Schema Serialization
// ============================================================

/**
 * Serializes a Zod schema to JSON Schema.
 *
 * Uses Zod 4's toJSONSchema() method for conversion.
 */
function serializeZodSchema(schema: z.ZodType): JsonSchema {
  try {
    // Zod 4 has toJSONSchema as a standard export
    const jsonSchema = z.toJSONSchema(schema);
    return jsonSchema as JsonSchema;
  } catch {
    // Fallback for schemas that can't be converted
    return { type: "object" };
  }
}

// ============================================================
// Schema Hashing
// ============================================================

/**
 * Computes a hash of the schema content for change detection.
 *
 * Excludes version and generatedAt since those change on every save.
 */
export function computeSchemaHash(schema: SerializedSchema): SchemaHash {
  // Create a hashable representation excluding dynamic fields
  const hashable = {
    graphId: schema.graphId,
    nodes: schema.nodes,
    edges: schema.edges,
    ontology: schema.ontology,
    defaults: schema.defaults,
  };

  // Serialize with sorted keys for deterministic output
  const json = JSON.stringify(hashable, sortedReplacer);
  return sha256Hash(json);
}

/**
 * JSON replacer that sorts object keys for deterministic serialization.
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      sorted[key] = (value as Record<string, unknown>)[key];
    }
    return sorted;
  }
  return value;
}

/**
 * Computes SHA-256 hash of a string.
 *
 * Uses Node.js crypto module for reliable cross-platform hashing.
 * Returns first 16 hex characters (64 bits) for a compact but collision-resistant hash.
 */
function sha256Hash(input: string): string {
  // Dynamic import to avoid bundling issues - crypto is a Node.js built-in
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof Crypto;
  return crypto
    .createHash("sha256")
    .update(input, "utf8")
    .digest("hex")
    .slice(0, 16);
}
