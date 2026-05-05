/**
 * Types for serialized schema storage.
 *
 * These types represent the JSON-serializable format used for
 * homoiconic schema storage in the database.
 *
 * The Zod schema (serializedSchemaZod) is the single source of truth.
 * The TypeScript type (SerializedSchema) is inferred from it.
 */
import { z } from "zod";

import {
  type Cardinality,
  type Collation,
  type DeleteBehavior,
  type EndpointExistence,
  type KindAnnotations,
  type TemporalMode,
  type UniquenessScope,
} from "../core/types";
import { type InferenceType } from "../ontology/types";

// ============================================================
// Enum Zod Schemas
//
// These mirror the literal union types from core/types.ts and
// ontology/types.ts. The Zod schema validates that stored values
// are members of the known set — unknown enum values from newer
// schema versions are rejected at the parse boundary rather than
// silently cast to narrow union types.
// ============================================================

const deleteBehaviorZod = z.enum(["restrict", "cascade", "disconnect"]);

const cardinalityZod = z.enum(["many", "one", "unique", "oneActive"]);

const endpointExistenceZod = z.enum(["notDeleted", "currentlyValid", "ever"]);

const temporalModeZod = z.enum([
  "current",
  "asOf",
  "includeEnded",
  "includeTombstones",
]);

const uniquenessScopeZod = z.enum(["kind", "kindWithSubClasses"]);

const collationZod = z.enum(["binary", "caseInsensitive"]);

const inferenceTypeZod = z.enum([
  "subsumption",
  "hierarchy",
  "substitution",
  "constraint",
  "composition",
  "association",
  "none",
]);

// ============================================================
// JSON Schema Types (from Zod)
// ============================================================

/**
 * JSON Schema type (subset used by Zod toJSONSchema).
 *
 * This is a simplified version - the actual JSON Schema has many more properties.
 */
export type JsonSchema = Readonly<{
  $schema?: string;
  type?: string | readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  not?: JsonSchema;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  [key: string]: unknown;
}>;

// ============================================================
// Serialized Meta-Edge
// ============================================================

/**
 * Serialized representation of a meta-edge.
 */
export type SerializedMetaEdge = Readonly<{
  name: string;
  transitive: boolean;
  symmetric: boolean;
  reflexive: boolean;
  inverse: string | undefined;
  inference: InferenceType;
  description: string | undefined;
}>;

// ============================================================
// Serialized Ontology Relation
// ============================================================

/**
 * Serialized representation of an ontology relation.
 */
export type SerializedOntologyRelation = Readonly<{
  metaEdge: string; // Meta-edge name
  from: string; // Node kind name or external IRI
  to: string; // Node kind name or external IRI
}>;

// ============================================================
// Serialized Closures
// ============================================================

/**
 * Precomputed closures stored in the schema for fast runtime lookup.
 */
export type SerializedClosures = Readonly<{
  subClassAncestors: Record<string, readonly string[]>;
  subClassDescendants: Record<string, readonly string[]>;
  broaderClosure: Record<string, readonly string[]>;
  narrowerClosure: Record<string, readonly string[]>;
  equivalenceSets: Record<string, readonly string[]>;
  disjointPairs: readonly string[]; // ["Organization|Person", ...]
  partOfClosure: Record<string, readonly string[]>;
  hasPartClosure: Record<string, readonly string[]>;
  iriToKind: Record<string, string>;
  edgeInverses: Record<string, string>; // {"likes": "likedBy", ...}
  edgeImplicationsClosure: Record<string, readonly string[]>;
  edgeImplyingClosure: Record<string, readonly string[]>;
}>;

// ============================================================
// Serialized Ontology
// ============================================================

/**
 * Complete serialized ontology section.
 */
export type SerializedOntology = Readonly<{
  metaEdges: Record<string, SerializedMetaEdge>;
  relations: readonly SerializedOntologyRelation[];
  closures: SerializedClosures;
}>;

// ============================================================
// Serialized Uniqueness Constraint
// ============================================================

/**
 * Serialized representation of a uniqueness constraint.
 */
export type SerializedUniqueConstraint = Readonly<{
  name: string;
  fields: readonly string[];
  where: string | undefined; // Serialized predicate or undefined
  scope: UniquenessScope;
  collation: Collation;
}>;

// ============================================================
// Serialized Node Definition
// ============================================================

/**
 * Serialized representation of a node kind.
 */
export type SerializedNodeDef = Readonly<{
  kind: string;
  properties: JsonSchema;
  uniqueConstraints: readonly SerializedUniqueConstraint[];
  onDelete: DeleteBehavior;
  description: string | undefined;
  annotations?: KindAnnotations;
}>;

// ============================================================
// Serialized Edge Definition
// ============================================================

/**
 * Serialized representation of an edge kind.
 */
export type SerializedEdgeDef = Readonly<{
  kind: string;
  fromKinds: readonly string[];
  toKinds: readonly string[];
  properties: JsonSchema;
  cardinality: Cardinality;
  endpointExistence: EndpointExistence;
  description: string | undefined;
  annotations?: KindAnnotations;
}>;

// ============================================================
// Serialized Schema
// ============================================================

/**
 * Validates that each record key matches the identifier field inside its value.
 * Catches corruption like `nodes.Person.kind = "Company"`.
 */
function checkRecordKeyMatchesField(
  field: string,
  section: string,
): (
  record: Record<string, Record<string, unknown>>,
  ctx: z.RefinementCtx,
) => void {
  return (record, ctx) => {
    for (const [key, value] of Object.entries(record)) {
      const embedded = value[field];
      if (typeof embedded === "string" && embedded !== key) {
        ctx.addIssue({
          code: "custom",
          path: [key, field],
          message: `Record key "${key}" does not match ${field} "${embedded}" in ${section}`,
        });
      }
    }
  };
}

/**
 * Zod schema for validating serialized schema documents read from the database.
 *
 * Enum fields (temporalMode, cardinality, deleteBehavior, etc.) are validated
 * against the real literal unions — unknown enum values from newer schema
 * versions are rejected at the parse boundary.
 *
 * Nested objects use .loose() so that extra structural fields added by newer
 * versions are accepted without failing validation (forward compatibility for
 * shape, strict for semantics).
 */
export const serializedSchemaZod = z.object({
  graphId: z.string(),
  version: z.number(),
  generatedAt: z.string(),
  nodes: z
    .record(
      z.string(),
      z
        .object({
          kind: z.string(),
          properties: z.record(z.string(), z.unknown()),
          uniqueConstraints: z.array(
            z
              .object({
                name: z.string(),
                fields: z.array(z.string()),
                where: z.string().optional(),
                scope: uniquenessScopeZod,
                collation: collationZod,
              })
              .loose(),
          ),
          onDelete: deleteBehaviorZod,
          description: z.string().optional(),
          annotations: z.record(z.string(), z.json()).optional(),
        })
        .loose(),
    )
    .superRefine(checkRecordKeyMatchesField("kind", "nodes")),
  edges: z
    .record(
      z.string(),
      z
        .object({
          kind: z.string(),
          fromKinds: z.array(z.string()),
          toKinds: z.array(z.string()),
          properties: z.record(z.string(), z.unknown()),
          cardinality: cardinalityZod,
          endpointExistence: endpointExistenceZod,
          description: z.string().optional(),
          annotations: z.record(z.string(), z.json()).optional(),
        })
        .loose(),
    )
    .superRefine(checkRecordKeyMatchesField("kind", "edges")),
  ontology: z
    .object({
      metaEdges: z
        .record(
          z.string(),
          z
            .object({
              name: z.string(),
              transitive: z.boolean(),
              symmetric: z.boolean(),
              reflexive: z.boolean(),
              inference: inferenceTypeZod,
              inverse: z.string().optional(),
              description: z.string().optional(),
            })
            .loose(),
        )
        .superRefine(checkRecordKeyMatchesField("name", "ontology.metaEdges")),
      relations: z.array(
        z
          .object({
            metaEdge: z.string(),
            from: z.string(),
            to: z.string(),
          })
          .loose(),
      ),
      closures: z
        .object({
          subClassAncestors: z.record(z.string(), z.array(z.string())),
          subClassDescendants: z.record(z.string(), z.array(z.string())),
          broaderClosure: z.record(z.string(), z.array(z.string())),
          narrowerClosure: z.record(z.string(), z.array(z.string())),
          equivalenceSets: z.record(z.string(), z.array(z.string())),
          disjointPairs: z.array(z.string()),
          partOfClosure: z.record(z.string(), z.array(z.string())),
          hasPartClosure: z.record(z.string(), z.array(z.string())),
          iriToKind: z.record(z.string(), z.string()),
          edgeInverses: z.record(z.string(), z.string()),
          edgeImplicationsClosure: z.record(z.string(), z.array(z.string())),
          edgeImplyingClosure: z.record(z.string(), z.array(z.string())),
        })
        .loose(),
    })
    .loose(),
  defaults: z
    .object({
      onNodeDelete: deleteBehaviorZod,
      temporalMode: temporalModeZod,
    })
    .loose(),
});

/**
 * Complete serialized schema document.
 *
 * This is the format stored in the schema_doc column of
 * typegraph_schema_versions. The type is kept explicit rather than
 * inferred from the Zod schema so that downstream code sees the
 * precise literal union types (DeleteBehavior, TemporalMode, etc.)
 * instead of the broader `string` type that Zod's passthrough schema uses.
 */
export type SerializedSchema = Readonly<{
  graphId: string;
  version: number;
  generatedAt: string;
  nodes: Record<string, SerializedNodeDef>;
  edges: Record<string, SerializedEdgeDef>;
  ontology: SerializedOntology;
  defaults: Readonly<{
    onNodeDelete: DeleteBehavior;
    temporalMode: TemporalMode;
  }>;
}>;

// ============================================================
// Schema Hash
// ============================================================

/**
 * A schema hash for detecting changes.
 *
 * We hash the schema content (excluding version and generatedAt)
 * to detect if the schema has actually changed.
 */
export type SchemaHash = string;
