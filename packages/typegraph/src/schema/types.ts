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
import { type IndexDeclaration } from "../indexes/types";
import { type InferenceType } from "../ontology/types";
import { type JsonPointer } from "../query/json-pointer";
import { type RuntimeGraphDocument } from "../runtime/document-types";

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

const indexScopeZod = z.enum(["graphAndKind", "graph", "none"]);

const indexOriginZod = z.enum(["compile-time", "runtime"]);

const edgeIndexDirectionZod = z.enum(["out", "in", "none"]);

const valueTypeZod = z.enum([
  "string",
  "number",
  "boolean",
  "date",
  "array",
  "object",
  "embedding",
  "unknown",
]);

const valueTypeOrUndefinedZod = valueTypeZod.optional();

// ============================================================
// Index WHERE expression Zod schemas
// ============================================================

const systemColumnNameZod = z.enum([
  "graph_id",
  "kind",
  "id",
  "from_kind",
  "from_id",
  "to_kind",
  "to_id",
  "deleted_at",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "version",
]);

const indexWhereOperandZod = z.discriminatedUnion("__type", [
  z.object({
    __type: z.literal("index_operand_system"),
    column: systemColumnNameZod,
    valueType: valueTypeOrUndefinedZod,
  }),
  z.object({
    __type: z.literal("index_operand_prop"),
    field: z.string(),
    valueType: valueTypeOrUndefinedZod,
  }),
]);

const indexWhereLiteralZod = z.object({
  __type: z.literal("index_where_literal"),
  value: z.union([z.string(), z.number(), z.boolean()]),
  valueType: valueTypeZod,
});

const indexWhereOpZod = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
]);

interface IndexWhereExpressionShape {
  __type:
    | "index_where_and"
    | "index_where_or"
    | "index_where_not"
    | "index_where_comparison"
    | "index_where_null_check";
}

const indexWhereExpressionZod: z.ZodType<IndexWhereExpressionShape> = z.lazy(
  () =>
    z.discriminatedUnion("__type", [
      z.object({
        __type: z.literal("index_where_and"),
        predicates: z.array(indexWhereExpressionZod),
      }),
      z.object({
        __type: z.literal("index_where_or"),
        predicates: z.array(indexWhereExpressionZod),
      }),
      z.object({
        __type: z.literal("index_where_not"),
        predicate: indexWhereExpressionZod,
      }),
      z.object({
        __type: z.literal("index_where_comparison"),
        left: indexWhereOperandZod,
        op: indexWhereOpZod,
        right: z.union([indexWhereLiteralZod, z.array(indexWhereLiteralZod)]),
      }),
      z.object({
        __type: z.literal("index_where_null_check"),
        operand: indexWhereOperandZod,
        op: z.enum(["isNull", "isNotNull"]),
      }),
    ]) as unknown as z.ZodType<IndexWhereExpressionShape>,
);

// ============================================================
// IndexDeclaration Zod schema
// ============================================================

// `JsonPointer` is a branded `string`. Validating with the brand
// preserved keeps `SerializedSchema` and the Zod-inferred type aligned
// without an `as unknown` cast at the parse boundary in `manager.ts`.
const jsonPointerZod = z.custom<JsonPointer>(
  (value) => typeof value === "string",
  { message: "Expected a JSON pointer string" },
);

const indexDeclarationCommonShape = {
  name: z.string(),
  // `origin` is optional. `"compile-time"` is the default and is omitted
  // from canonical form so legacy graphs without indexes hash
  // byte-identically. Consumers that need a concrete value should
  // coalesce `index.origin ?? "compile-time"`.
  origin: indexOriginZod.optional(),
  fields: z.array(jsonPointerZod),
  fieldValueTypes: z.array(valueTypeOrUndefinedZod),
  coveringFields: z.array(jsonPointerZod),
  coveringFieldValueTypes: z.array(valueTypeOrUndefinedZod),
  unique: z.boolean(),
  scope: indexScopeZod,
  where: indexWhereExpressionZod.optional(),
} as const;

const nodeIndexDeclarationZod = z
  .object({
    entity: z.literal("node"),
    kind: z.string(),
    ...indexDeclarationCommonShape,
  })
  .loose();

const edgeIndexDeclarationZod = z
  .object({
    entity: z.literal("edge"),
    kind: z.string(),
    direction: edgeIndexDirectionZod,
    ...indexDeclarationCommonShape,
  })
  .loose();

const indexDeclarationZod = z.discriminatedUnion("entity", [
  nodeIndexDeclarationZod,
  edgeIndexDeclarationZod,
]);

// ============================================================
// RuntimeGraphDocument Zod schema
// ============================================================

// Boundary parser for the persisted runtime extension document. The
// pure-value validator in `runtime/validation.ts` is the authoritative
// shape check (re-run on every load via the runtime compiler); this
// schema's job is only to confirm the JSON shape is round-trippable
// and to keep `SerializedSchema.runtimeDocument` typed.
//
// `.loose()` on every nested object accepts forward-compatible
// extensions without breaking older readers — same posture as the rest
// of the schema document.
const runtimePropertyZod = z.record(z.string(), z.unknown());

const runtimeNodeDocumentZod = z
  .object({
    description: z.string().optional(),
    annotations: z.record(z.string(), z.json()).optional(),
    properties: z.record(z.string(), runtimePropertyZod),
    unique: z.array(z.object({}).loose()).optional(),
  })
  .loose();

const runtimeEdgeDocumentZod = z
  .object({
    description: z.string().optional(),
    annotations: z.record(z.string(), z.json()).optional(),
    from: z.array(z.string()),
    to: z.array(z.string()),
    properties: z.record(z.string(), runtimePropertyZod).optional(),
  })
  .loose();

const runtimeOntologyRelationZod = z
  .object({
    metaEdge: z.string(),
    from: z.string(),
    to: z.string(),
  })
  .loose();

const runtimeGraphDocumentZod = z
  .object({
    // Version is parsed loosely here so the persistence boundary
    // never rejects a stored document — the runtime validator owns
    // the version check and produces actionable errors. Documents
    // that pre-date the field round-trip as `version: undefined`.
    version: z.number().optional(),
    nodes: z.record(z.string(), runtimeNodeDocumentZod).optional(),
    edges: z.record(z.string(), runtimeEdgeDocumentZod).optional(),
    ontology: z.array(runtimeOntologyRelationZod).optional(),
  })
  .loose() as unknown as z.ZodType<RuntimeGraphDocument>;

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
  /**
   * Index declarations attached to the graph.
   *
   * Optional: graphs that never declared the slice omit the field
   * entirely so their canonical-form hash is byte-identical to graphs
   * authored before `indexes` existed.
   */
  indexes: z.array(indexDeclarationZod).optional(),
  /**
   * Runtime extension document persisted alongside the compiled
   * `nodes` / `edges` / `ontology` slices. The loader rebuilds runtime
   * Zod validators from this document (the only durable source);
   * legacy graphs omit the field and hash byte-identically to before
   * runtime extensions existed.
   *
   * `.loose()` on the inner shape accepts forward-compatible extensions
   * without breaking older readers.
   */
  runtimeDocument: runtimeGraphDocumentZod.optional(),
  /**
   * Names of node and edge kinds the operator has soft-deprecated via
   * `store.deprecateKinds(...)`. Surfaces in introspection so consumers
   * (codegen, UI tooling, lints) can route around them. Does not affect
   * reads, writes, or queries.
   *
   * Omitted when empty so legacy schemas hash byte-identically.
   */
  deprecatedKinds: z.array(z.string()).optional(),
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
  /**
   * Index declarations attached to the graph.
   *
   * Omitted entirely when the graph never declared the slice — legacy
   * schemas hash byte-identically to before `indexes` existed. Each
   * entry carries an `origin` discriminator: `"compile-time"` is the
   * default and is omitted from the canonical form (see `serializer.ts`);
   * only `"runtime"` is emitted explicitly.
   */
  indexes?: readonly IndexDeclaration[];
  /**
   * Runtime extension document, when this schema was produced from a
   * graph that had been merged with a runtime extension. The loader
   * uses this document (and only this document) to rebuild runtime
   * Zod validators on restart — the merged `nodes` / `edges` /
   * `ontology` maps above carry the JSON-Schema-shaped views for diff
   * machinery and human-readable reporting, but they cannot
   * reconstruct Zod alone.
   *
   * Omitted entirely on graphs that have never been runtime-extended
   * — legacy schemas hash byte-identically.
   */
  runtimeDocument?: RuntimeGraphDocument;
  /**
   * Soft-deprecated node and edge kind names. Set by
   * `store.deprecateKinds(...)`; cleared by `store.undeprecateKinds(...)`.
   * Surfaces in introspection but does not affect reads, writes, or
   * queries. Omitted entirely when empty so legacy schemas hash
   * byte-identically.
   */
  deprecatedKinds?: readonly string[];
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
