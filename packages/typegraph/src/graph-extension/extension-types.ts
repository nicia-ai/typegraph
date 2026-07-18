/**
 * Pure-value document format for graph extensions.
 *
 * A `GraphExtension` is a plain JSON-serializable description of
 * additional node kinds, edge kinds, and ontology relations that should
 * be merged into a graph at runtime. The document is the canonical
 * artifact: every restart re-compiles it back to the same Zod-bearing
 * `NodeType` / `EdgeType` / `OntologyRelation` shapes.
 *
 * The supported property-type subset is intentionally narrower than full
 * JSON Schema — only what compiles cleanly to Zod and what real
 * agent-induced schemas use in practice. Anything outside this set fails
 * loudly at `defineGraphExtension(...)`.
 */
import { type KindAnnotations, type NullCheckOp } from "../core/types";
import { type MetaEdgeName } from "../ontology/constants";

// ============================================================
// Property Types
// ============================================================

/**
 * Per-property modifier: tag the field as fulltext-searchable.
 *
 * Compiles to a `searchable({ language })`-wrapped Zod string when applied
 * to a `string` property. Rejected on any other property type at validation
 * time.
 */
export type ExtensionSearchableModifier = Readonly<{
  language?: string;
}>;

/**
 * Per-property modifier: declare a vector embedding with the given
 * dimensionality. Compiles to `embedding(dimensions)` and is only valid on
 * `array` properties whose item type is `number`. Rejected elsewhere.
 */
export type ExtensionEmbeddingModifier = Readonly<{
  dimensions: number;
}>;

/**
 * Modifiers shared by every graph-extension property type.
 *
 * `optional: true` flips the field from required-with-graph-extension-validation
 * to `.optional()` and removes it from the parent object's `required`
 * list. `searchable` and `embedding` only apply to specific underlying
 * types — see the per-modifier docs.
 */
export type ExtensionPropertyModifiers = Readonly<{
  optional?: boolean;
  searchable?: ExtensionSearchableModifier;
  embedding?: ExtensionEmbeddingModifier;
  description?: string;
}>;

/**
 * String property. Compiles to `z.string()` plus the requested refinements.
 * `format` accepts the two formats motivated by induced schemas in
 * practice — covers ISO datetimes, URIs, email addresses, UUIDs, and
 * date-only strings. Each format routes to the corresponding Zod
 * factory (`z.iso.datetime()`, `z.url()`, `z.email()`, `z.uuid()`,
 * `z.iso.date()`); other JSON-Schema formats are deliberately not
 * supported in v1.
 */
export type ExtensionStringProperty = Readonly<{
  type: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "datetime" | "uri" | "email" | "uuid" | "date";
}> &
  ExtensionPropertyModifiers;

/**
 * Number property. `int: true` requires whole numbers; `min` / `max` are
 * inclusive bounds. Compiles to `z.number().int()?.min(...)?.max(...)`.
 */
export type ExtensionNumberProperty = Readonly<{
  type: "number";
  min?: number;
  max?: number;
  int?: boolean;
}> &
  ExtensionPropertyModifiers;

/**
 * Boolean property. Compiles to `z.boolean()`.
 */
export type ExtensionBooleanProperty = Readonly<{
  type: "boolean";
}> &
  ExtensionPropertyModifiers;

/**
 * Closed-set string enum. Compiles to `z.enum([...values])`. Must contain
 * at least one value; duplicate values are rejected at validation time.
 */
export type ExtensionEnumProperty = Readonly<{
  type: "enum";
  values: readonly string[];
}> &
  ExtensionPropertyModifiers;

/**
 * Array property. `items` is any of the scalar property types or an
 * object property — nested arrays are forbidden in v1. Compiles to
 * `z.array(<items>)`. The `embedding` modifier turns this into a
 * vector embedding instead of a generic array.
 */
export type ExtensionArrayProperty = Readonly<{
  type: "array";
  items: ExtensionArrayItemType;
}> &
  ExtensionPropertyModifiers;

/**
 * Element types allowed inside an array — every leaf property type plus
 * single-level object. Nesting an array inside an array is rejected at
 * validation time so the v1 surface stays a flat tree.
 */
export type ExtensionArrayItemType =
  | ExtensionStringProperty
  | ExtensionNumberProperty
  | ExtensionBooleanProperty
  | ExtensionEnumProperty
  | ExtensionObjectProperty;

/**
 * Object property. `properties` is a single nesting level; deeper objects
 * are rejected at validation time so the v1 surface is auditable at a
 * glance.
 */
export type ExtensionObjectProperty = Readonly<{
  type: "object";
  properties: Readonly<Record<string, ExtensionObjectFieldProperty>>;
}> &
  ExtensionPropertyModifiers;

/**
 * Property types allowed inside an `object`'s `properties` — leaf scalars
 * and arrays only. Nested objects are blocked here to enforce the
 * single-nesting-level rule.
 */
export type ExtensionObjectFieldProperty =
  | ExtensionStringProperty
  | ExtensionNumberProperty
  | ExtensionBooleanProperty
  | ExtensionEnumProperty
  | ExtensionArrayProperty;

/**
 * Top-level property descriptor for a node or edge field.
 *
 * The discriminated union covers every type in the v1 subset; arbitrary
 * `unknown` inputs are validated against this set at
 * `defineGraphExtension(...)` time.
 */
export type ExtensionPropertyType =
  | ExtensionStringProperty
  | ExtensionNumberProperty
  | ExtensionBooleanProperty
  | ExtensionEnumProperty
  | ExtensionArrayProperty
  | ExtensionObjectProperty;

// ============================================================
// Unique Constraints
// ============================================================

/**
 * Document-side `where` clause for a unique constraint.
 *
 * Mirrors `serializeWherePredicate`'s capability — the only operations
 * round-trippable through the persisted form are `isNull` and `isNotNull`.
 * Anything richer (equality, `in`, etc.) is rejected at validation time.
 */
export type ExtensionUniqueWhere = Readonly<{
  field: string;
  op: NullCheckOp;
}>;

/**
 * Unique constraint declaration. `fields` must reference declared
 * properties on the kind. Defaults match the existing `UniqueConstraint`:
 * `scope: "kind"`, `collation: "binary"`.
 */
export type ExtensionUniqueConstraint = Readonly<{
  name: string;
  fields: readonly string[];
  scope?: "kind" | "kindWithSubClasses";
  collation?: "binary" | "caseInsensitive";
  where?: ExtensionUniqueWhere;
}>;

// ============================================================
// Node and Edge Documents
// ============================================================

/**
 * Graph-extension declaration of a node kind.
 *
 * Property names follow the same reserved-key rules as compile-time
 * `defineNode` (`id`, `kind`, `meta`, and the `$`-prefix accessor
 * namespace are forbidden). Annotation values must be JSON.
 */
export type ExtensionNodeDef = Readonly<{
  description?: string;
  annotations?: KindAnnotations;
  properties: Readonly<Record<string, ExtensionPropertyType>>;
  unique?: readonly ExtensionUniqueConstraint[];
}>;

/**
 * Graph-extension declaration of an edge kind.
 *
 * `from` / `to` reference node kind names — either kinds declared in this
 * same document or compile-time kinds the document is being merged into.
 * Endpoints that resolve to nothing within the document are flagged as
 * soft references at validation time but not rejected; the final
 * cross-graph check happens when the document is merged into a host
 * `GraphDef`.
 */
export type ExtensionEdgeDef = Readonly<{
  description?: string;
  annotations?: KindAnnotations;
  from: readonly string[];
  to: readonly string[];
  properties?: Readonly<Record<string, ExtensionPropertyType>>;
}>;

// ============================================================
// Indexes (relational)
// ============================================================

/**
 * Document-level analogue of compile-time `defineNodeIndex` /
 * `defineEdgeIndex`. Mirrors `serializeWherePredicate`'s persistence-
 * round-trippable subset: only `isNull` / `isNotNull` predicates are
 * supported in v1, matching `ExtensionUniqueWhere`.
 */
export type ExtensionIndexWhere = Readonly<{
  field: string;
  op: NullCheckOp;
}>;

/**
 * Graph-extension-declared node index. `kind` references either a kind
 * declared in this same document or a compile-time host kind resolved
 * at merge time. `fields` and `coveringFields` are top-level property
 * names — JSON-pointer paths are not supported in v1, matching the
 * `ExtensionUniqueConstraint` v1 surface.
 */
export type ExtensionNodeIndex = Readonly<{
  entity: "node";
  kind: string;
  name?: string;
  fields: readonly string[];
  coveringFields?: readonly string[];
  unique?: boolean;
  scope?: "graphAndKind" | "graph" | "none";
  where?: ExtensionIndexWhere;
}>;

/**
 * Graph-extension-declared edge index. `direction` mirrors
 * `EdgeIndexDirection`; `kind` references a graph-extension or compile-time
 * edge kind.
 */
export type ExtensionEdgeIndex = Readonly<{
  entity: "edge";
  kind: string;
  name?: string;
  direction?: "out" | "in" | "none";
  fields: readonly string[];
  coveringFields?: readonly string[];
  unique?: boolean;
  scope?: "graphAndKind" | "graph" | "none";
  where?: ExtensionIndexWhere;
}>;

export type ExtensionIndex = ExtensionNodeIndex | ExtensionEdgeIndex;

// ============================================================
// Ontology
// ============================================================

/**
 * Graph-extension ontology relation. `metaEdge` is one of the built-in
 * meta-edge names (subClassOf, broader, disjointWith, etc.).
 *
 * `from` / `to` are either node-kind names declared in this document or
 * external IRI strings. The pure-value document does not distinguish the
 * two — the compiler treats endpoints that match a declared kind as
 * `NodeType` references and falls back to passing the raw string for
 * IRIs (matching the existing `OntologyRelation` shape, where
 * `from`/`to` are `NodeType | EdgeType | string`).
 */
export type ExtensionOntologyRelation = Readonly<{
  metaEdge: MetaEdgeName;
  from: string;
  to: string;
}>;

// ============================================================
// Document
// ============================================================

/**
 * Stable default major used when a stored document omits `version`.
 *
 * Pinned to `1` permanently. Pre-versioning documents (those persisted
 * before the field existed) and documents that explicitly omit
 * `version` are interpreted as `1` regardless of which major the
 * library currently supports. Splitting this from
 * `CURRENT_GRAPH_EXTENSION_VERSION` is load-bearing for future major
 * bumps: when v2 ships, `CURRENT` becomes `2` but `LEGACY` stays at
 * `1`, so a v1-era stored document still parses as v1 (and the
 * version-mismatch path can route it through a migration) rather than
 * being silently misinterpreted as v2.
 */
export const LEGACY_GRAPH_EXTENSION_VERSION = 1 as const;

/**
 * Current major version of the `GraphExtension` format.
 *
 * Documents with a higher major version than this constant are
 * rejected with `GRAPH_EXTENSION_VERSION_UNSUPPORTED` — there is no
 * automatic downgrade path. Minor / additive changes ride forward-
 * compat via `.loose()` on every nested object schema.
 */
export const CURRENT_GRAPH_EXTENSION_VERSION = 1 as const;

/**
 * Type of the `GraphExtension.version` field. Stays `number`
 * rather than `typeof CURRENT_GRAPH_EXTENSION_VERSION` because the
 * field can carry any major across the library version range a
 * stored document might have been written by — the
 * document-vs-supported check happens in the validator, not at the
 * type level. Pinning to the current literal would prevent a v1
 * v1 library from typing a v2 document at all, which is the wrong
 * relationship: we WANT a v1 library to receive v2 documents and
 * report `GRAPH_EXTENSION_VERSION_UNSUPPORTED` cleanly.
 */
export type GraphExtensionVersion = number;

/**
 * The canonical pure-value graph-extension document.
 *
 * Frozen at construction. Round-trips losslessly through `JSON.stringify`
 * / `JSON.parse`; the `GraphExtension → CompiledExtension` direction
 * is provided by `compileGraphExtension(...)`. There is no
 * `Zod → GraphExtension` direction because graph-extension kinds always
 * originate as documents.
 *
 * `version` is the major-version tag for the document format. The
 * compiler accepts documents whose version is equal to the current
 * supported major (today: 1) or absent (the canonical persisted form
 * omits `version` when it equals the legacy default — see
 * `serializer.ts` — so the round-trip default is "absent means legacy
 * major"). Higher majors surface as
 * `GRAPH_EXTENSION_VERSION_UNSUPPORTED` so a newer-version extension
 * committed by a future writer can't be silently misread by an older
 * runtime. See `graph-extensions.md` for the format-versioning policy.
 */
export type GraphExtension = Readonly<{
  version?: GraphExtensionVersion;
  nodes?: Readonly<Record<string, ExtensionNodeDef>>;
  edges?: Readonly<Record<string, ExtensionEdgeDef>>;
  ontology?: readonly ExtensionOntologyRelation[];
  /**
   * Graph-extension-declared relational indexes. Each entry references a
   * node or edge kind by name — either declared in this document or
   * a compile-time host kind that the document is being merged into.
   * Vector indexes auto-derive from `embedding()` modifiers on
   * graph-extension kinds; this slot is for explicit relational indexes
   * (analogue of compile-time `defineGraph({ indexes: [...] })`).
   */
  indexes?: readonly ExtensionIndex[];
}>;

/**
 * Top-level v1 slots a `GraphExtension` document may carry. Single
 * source of truth for both the strict-authoring validator (typo rejection
 * via `defineGraphExtension`) and the persistence Zod schema (which
 * leaves the field set loose for forward compatibility but uses this
 * list to drive the Zod object shape).
 */
export const GRAPH_EXTENSION_TOP_LEVEL_KEYS = [
  "version",
  "nodes",
  "edges",
  "ontology",
  "indexes",
] as const;

export type GraphExtensionTopLevelKey =
  (typeof GRAPH_EXTENSION_TOP_LEVEL_KEYS)[number];
