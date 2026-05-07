/**
 * Pure-value document format for runtime graph extensions.
 *
 * A `RuntimeGraphDocument` is a plain JSON-serializable description of
 * additional node kinds, edge kinds, and ontology relations that should
 * be merged into a graph at runtime. The document is the canonical
 * artifact: every restart re-compiles it back to the same Zod-bearing
 * `NodeType` / `EdgeType` / `OntologyRelation` shapes.
 *
 * The supported property-type subset is intentionally narrower than full
 * JSON Schema — only what compiles cleanly to Zod and what real
 * agent-induced schemas use in practice. Anything outside this set fails
 * loudly at `defineRuntimeExtension(...)`.
 */
import { type KindAnnotations } from "../core/types";
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
export type RuntimeSearchableModifier = Readonly<{
  language?: string;
}>;

/**
 * Per-property modifier: declare a vector embedding with the given
 * dimensionality. Compiles to `embedding(dimensions)` and is only valid on
 * `array` properties whose item type is `number`. Rejected elsewhere.
 */
export type RuntimeEmbeddingModifier = Readonly<{
  dimensions: number;
}>;

/**
 * Modifiers shared by every runtime property type.
 *
 * `optional: true` flips the field from required-with-runtime-validation
 * to `.optional()` and removes it from the parent object's `required`
 * list. `searchable` and `embedding` only apply to specific underlying
 * types — see the per-modifier docs.
 */
type RuntimePropertyModifiers = Readonly<{
  optional?: boolean;
  searchable?: RuntimeSearchableModifier;
  embedding?: RuntimeEmbeddingModifier;
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
export type RuntimeStringProperty = Readonly<{
  type: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: "datetime" | "uri" | "email" | "uuid" | "date";
}> &
  RuntimePropertyModifiers;

/**
 * Number property. `int: true` requires whole numbers; `min` / `max` are
 * inclusive bounds. Compiles to `z.number().int()?.min(...)?.max(...)`.
 */
export type RuntimeNumberProperty = Readonly<{
  type: "number";
  min?: number;
  max?: number;
  int?: boolean;
}> &
  RuntimePropertyModifiers;

/**
 * Boolean property. Compiles to `z.boolean()`.
 */
export type RuntimeBooleanProperty = Readonly<{
  type: "boolean";
}> &
  RuntimePropertyModifiers;

/**
 * Closed-set string enum. Compiles to `z.enum([...values])`. Must contain
 * at least one value; duplicate values are rejected at validation time.
 */
export type RuntimeEnumProperty = Readonly<{
  type: "enum";
  values: readonly string[];
}> &
  RuntimePropertyModifiers;

/**
 * Array property. `items` is any of the scalar property types or an
 * object property — nested arrays are forbidden in v1. Compiles to
 * `z.array(<items>)`. The `embedding` modifier turns this into a
 * vector embedding instead of a generic array.
 */
export type RuntimeArrayProperty = Readonly<{
  type: "array";
  items: RuntimeArrayItemType;
}> &
  RuntimePropertyModifiers;

/**
 * Element types allowed inside an array — every leaf property type plus
 * single-level object. Nesting an array inside an array is rejected at
 * validation time so the v1 surface stays a flat tree.
 */
export type RuntimeArrayItemType =
  | RuntimeStringProperty
  | RuntimeNumberProperty
  | RuntimeBooleanProperty
  | RuntimeEnumProperty
  | RuntimeObjectProperty;

/**
 * Object property. `properties` is a single nesting level; deeper objects
 * are rejected at validation time so the v1 surface is auditable at a
 * glance.
 */
export type RuntimeObjectProperty = Readonly<{
  type: "object";
  properties: Readonly<Record<string, RuntimeObjectFieldProperty>>;
}> &
  RuntimePropertyModifiers;

/**
 * Property types allowed inside an `object`'s `properties` — leaf scalars
 * and arrays only. Nested objects are blocked here to enforce the
 * single-nesting-level rule.
 */
export type RuntimeObjectFieldProperty =
  | RuntimeStringProperty
  | RuntimeNumberProperty
  | RuntimeBooleanProperty
  | RuntimeEnumProperty
  | RuntimeArrayProperty;

/**
 * Top-level property descriptor for a node or edge field.
 *
 * The discriminated union covers every type in the v1 subset; arbitrary
 * `unknown` inputs are validated against this set at
 * `defineRuntimeExtension(...)` time.
 */
export type RuntimePropertyType =
  | RuntimeStringProperty
  | RuntimeNumberProperty
  | RuntimeBooleanProperty
  | RuntimeEnumProperty
  | RuntimeArrayProperty
  | RuntimeObjectProperty;

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
export type RuntimeUniqueWhere = Readonly<{
  field: string;
  op: "isNull" | "isNotNull";
}>;

/**
 * Unique constraint declaration. `fields` must reference declared
 * properties on the kind. Defaults match the existing `UniqueConstraint`:
 * `scope: "kind"`, `collation: "binary"`.
 */
export type RuntimeUniqueConstraint = Readonly<{
  name: string;
  fields: readonly string[];
  scope?: "kind" | "kindWithSubClasses";
  collation?: "binary" | "caseInsensitive";
  where?: RuntimeUniqueWhere;
}>;

// ============================================================
// Node and Edge Documents
// ============================================================

/**
 * Runtime declaration of a node kind.
 *
 * Property names follow the same reserved-key rules as compile-time
 * `defineNode` (`id`, `kind`, `meta`, and the `$`-prefix accessor
 * namespace are forbidden). Annotation values must be JSON.
 */
export type RuntimeNodeDocument = Readonly<{
  description?: string;
  annotations?: KindAnnotations;
  properties: Readonly<Record<string, RuntimePropertyType>>;
  unique?: readonly RuntimeUniqueConstraint[];
}>;

/**
 * Runtime declaration of an edge kind.
 *
 * `from` / `to` reference node kind names — either kinds declared in this
 * same document or compile-time kinds the document is being merged into.
 * Endpoints that resolve to nothing within the document are flagged as
 * soft references at validation time but not rejected; the final
 * cross-graph check happens when the document is merged into a host
 * `GraphDef`.
 */
export type RuntimeEdgeDocument = Readonly<{
  description?: string;
  annotations?: KindAnnotations;
  from: readonly string[];
  to: readonly string[];
  properties?: Readonly<Record<string, RuntimePropertyType>>;
}>;

// ============================================================
// Ontology
// ============================================================

/**
 * Runtime ontology relation. `metaEdge` is one of the built-in
 * meta-edge names (subClassOf, broader, disjointWith, etc.).
 *
 * `from` / `to` are either node-kind names declared in this document or
 * external IRI strings. The pure-value document does not distinguish the
 * two — the compiler treats endpoints that match a declared kind as
 * `NodeType` references and falls back to passing the raw string for
 * IRIs (matching the existing `OntologyRelation` shape, where
 * `from`/`to` are `NodeType | EdgeType | string`).
 */
export type RuntimeOntologyRelation = Readonly<{
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
 * `CURRENT_RUNTIME_DOCUMENT_VERSION` is load-bearing for future major
 * bumps: when v2 ships, `CURRENT` becomes `2` but `LEGACY` stays at
 * `1`, so a v1-era stored document still parses as v1 (and the
 * version-mismatch path can route it through a migration) rather than
 * being silently misinterpreted as v2.
 */
export const LEGACY_RUNTIME_DOCUMENT_VERSION = 1 as const;

/**
 * Current major version of the `RuntimeGraphDocument` format.
 *
 * Documents with a higher major version than this constant are
 * rejected with `RUNTIME_EXTENSION_VERSION_UNSUPPORTED` — there is no
 * automatic downgrade path. Minor / additive changes ride forward-
 * compat via `.loose()` on every nested object schema.
 */
export const CURRENT_RUNTIME_DOCUMENT_VERSION = 1 as const;

/**
 * Type of the `RuntimeGraphDocument.version` field. Stays `number`
 * rather than `typeof CURRENT_RUNTIME_DOCUMENT_VERSION` because the
 * field can carry any major across the library version range a
 * stored document might have been written by — the
 * runtime-vs-supported check happens in the validator, not at the
 * type level. Pinning to the current literal would prevent a v1
 * runtime from typing a v2 document at all, which is the wrong
 * relationship: we WANT a v1 runtime to receive v2 documents and
 * report `RUNTIME_EXTENSION_VERSION_UNSUPPORTED` cleanly.
 */
export type RuntimeDocumentVersion = number;

/**
 * The canonical pure-value runtime extension document.
 *
 * Frozen at construction. Round-trips losslessly through `JSON.stringify`
 * / `JSON.parse`; the `RuntimeGraphDocument → CompiledExtension` direction
 * is provided by `compileRuntimeExtension(...)`. There is no
 * `Zod → RuntimeGraphDocument` direction because runtime kinds always
 * originate as documents.
 *
 * `version` is the major-version tag for the document format. The
 * compiler accepts documents whose version is equal to the current
 * supported major (today: 1) or absent (treated as 1 for back-compat
 * with documents persisted before the field existed). Higher majors
 * surface as `RUNTIME_EXTENSION_VERSION_UNSUPPORTED` so a newer-version
 * document committed by a future writer can't be silently misread by
 * an older runtime. See `runtime-extensions.md` for the format-versioning
 * policy.
 */
export type RuntimeGraphDocument = Readonly<{
  version?: RuntimeDocumentVersion;
  nodes?: Readonly<Record<string, RuntimeNodeDocument>>;
  edges?: Readonly<Record<string, RuntimeEdgeDocument>>;
  ontology?: readonly RuntimeOntologyRelation[];
}>;
