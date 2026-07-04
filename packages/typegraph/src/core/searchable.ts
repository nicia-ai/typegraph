/**
 * Searchable string type for fulltext search.
 *
 * `searchable()` attaches `SearchableMetadata` to a plain Zod string so
 * the schema introspector and fulltext-sync layer can keep the fulltext
 * index in sync with node data.
 *
 * The metadata is preserved by Zod's `.meta()` across refinements
 * (`.min(1)`, `.trim()`, `.regex(...)`) and wrapper types (`.optional()`,
 * `.nullable()`, `.default(...)`, pipes) — `getSearchableMetadata()` walks
 * these variants so runtime indexing works whether or not a user chains
 * additional modifiers.
 *
 * `$fulltext` is exposed on every `NodeAccessor` at the type level; a
 * runtime guard throws a clear error if you call `.matches()` on an
 * alias whose node kind has no `searchable()` fields. This is simpler
 * and more predictable than a type-level brand that silently disappears
 * behind `.min(1)`.
 *
 * @example
 * ```typescript
 * const Document = defineNode("Document", {
 *   schema: z.object({
 *     title: searchable({ language: "english" }),
 *     body: searchable().min(1),
 *     authorId: z.string(),
 *   }),
 * });
 * ```
 */
import { z } from "zod";

export const SEARCHABLE_FIELD_KEY = "_searchableField" as const;

export const DEFAULT_SEARCHABLE_LANGUAGE = "english" as const;

const SEARCHABLE_WRAPPER_TYPES = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
  "success",
]);

/**
 * Searchable field metadata attached to a Zod schema.
 */
export type SearchableMetadata = Readonly<{
  /**
   * Language for stemming / tokenization.
   * Postgres: passed to `to_tsvector(regconfig, ...)`.
   * SQLite FTS5: tokenizer is fixed at table-create time, so the
   * language is recorded but not applied per-row.
   */
  language: string;
}>;

/**
 * Branded Zod string schema. The `SEARCHABLE_FIELD_KEY` marker is
 * attached both as a direct property (fast runtime check) and via Zod's
 * `.meta()` (so it survives `.min()`, `.trim()`, etc.).
 */
export type SearchableSchema = z.ZodString &
  Readonly<{
    [SEARCHABLE_FIELD_KEY]: SearchableMetadata;
  }>;

export type SearchableOptions = Readonly<{
  language?: string;
}>;

type SearchableMetaRecord = Readonly<
  Partial<Record<typeof SEARCHABLE_FIELD_KEY, unknown>>
>;

type SearchableSchemaDef = Readonly<{
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
}>;

function readSearchableMetadata(
  value: unknown,
): SearchableMetadata | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const language = (value as Partial<SearchableMetadata>).language;
  return typeof language === "string" ? { language } : undefined;
}

function getSearchableMetadataFromSchemaMeta(
  schema: z.ZodType,
): SearchableMetadata | undefined {
  const meta = schema.meta() as SearchableMetaRecord | undefined;
  return readSearchableMetadata(meta?.[SEARCHABLE_FIELD_KEY]);
}

/**
 * Creates a Zod string schema tagged as fulltext-searchable.
 *
 * The returned schema passes runtime validation unchanged — the tag only
 * affects how TypeGraph treats the field for indexing and search. Pair
 * with `.optional()` / `.nullable()` / `.min()` / `.trim()` exactly like
 * any other Zod string; `getSearchableMetadata()` finds the metadata
 * through all of them.
 */
export function searchable(options: SearchableOptions = {}): SearchableSchema {
  const language = options.language ?? DEFAULT_SEARCHABLE_LANGUAGE;

  if (language.length === 0) {
    throw new Error("searchable() language must be a non-empty string");
  }

  const metadata: SearchableMetadata = { language };
  const schema = z.string().meta({
    [SEARCHABLE_FIELD_KEY]: metadata,
  });

  return Object.assign(schema, {
    [SEARCHABLE_FIELD_KEY]: metadata,
  });
}

export function isSearchableSchema(value: unknown): value is SearchableSchema {
  if (typeof value !== "object" || value === null) return false;
  if (!(SEARCHABLE_FIELD_KEY in value)) return false;
  return (
    readSearchableMetadata(
      (value as Record<string, unknown>)[SEARCHABLE_FIELD_KEY],
    ) !== undefined
  );
}

export function getSearchableMetadata(
  schema: z.ZodType,
): SearchableMetadata | undefined {
  if (isSearchableSchema(schema)) {
    return schema[SEARCHABLE_FIELD_KEY];
  }

  const directMetadata = getSearchableMetadataFromSchemaMeta(schema);
  if (directMetadata !== undefined) {
    return directMetadata;
  }

  const def = schema.def as SearchableSchemaDef;
  if (
    SEARCHABLE_WRAPPER_TYPES.has(schema.type) &&
    def.innerType !== undefined
  ) {
    return getSearchableMetadata(def.innerType);
  }

  if (schema.type === "pipe") {
    return (
      (def.in === undefined ? undefined : getSearchableMetadata(def.in)) ??
      (def.out === undefined ? undefined : getSearchableMetadata(def.out))
    );
  }

  return undefined;
}

// ============================================================
// Schema-level searchable-field resolution
// ============================================================

/** One searchable field discovered on a node schema. */
export type SearchableFieldInfo = Readonly<{
  fieldPath: string;
  metadata: SearchableMetadata;
}>;

/**
 * Cache keyed by the Zod schema *instance*. Schemas are immutable at
 * runtime and the same `nodeKind.schema` reference is reused across
 * every CRUD call, so this collapses the per-use introspection cost to
 * one walk per schema for the lifetime of the process.
 */
const searchableFieldsCache = new WeakMap<
  z.ZodType,
  readonly SearchableFieldInfo[]
>();

/**
 * Extracts searchable field information from a Zod schema.
 *
 * Handles top-level searchable() strings as well as wrapped variants
 * (optional / nullable / default / readonly / pipe).
 */
export function getSearchableFields(
  schema: z.ZodType,
): readonly SearchableFieldInfo[] {
  const cached = searchableFieldsCache.get(schema);
  if (cached) return cached;

  const fields = computeSearchableFields(schema);
  searchableFieldsCache.set(schema, fields);
  return fields;
}

function computeSearchableFields(
  schema: z.ZodType,
): readonly SearchableFieldInfo[] {
  if (schema.type !== "object") return [];

  const def = schema.def as { shape?: Record<string, z.ZodType> };
  const shape = def.shape;
  if (!shape) return [];

  const fields: SearchableFieldInfo[] = [];
  for (const [fieldPath, fieldSchema] of Object.entries(shape)) {
    const metadata = getSearchableMetadata(fieldSchema);
    if (metadata !== undefined) {
      fields.push({ fieldPath, metadata });
    }
  }
  warnIfConflictingLanguages(fields);
  return fields;
}

/**
 * Warns (once per schema, via the WeakMap memo above) when a schema's
 * searchable fields declare different `language` values. The first
 * field's language wins on the stored row; true per-field multilingual
 * indexing is not supported today.
 */
function warnIfConflictingLanguages(
  fields: readonly SearchableFieldInfo[],
): void {
  if (fields.length < 2) return;
  const languages = new Set(fields.map((field) => field.metadata.language));
  if (languages.size < 2) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") {
    return;
  }
  const fieldSummary = fields
    .map((field) => `${field.fieldPath}=${field.metadata.language}`)
    .join(", ");
  const winning = fields[0]?.metadata.language ?? DEFAULT_SEARCHABLE_LANGUAGE;
  console.warn(
    `[typegraph] searchable() fields declare conflicting languages ` +
      `(${fieldSummary}). The first field's language ("${winning}") is ` +
      `used for the combined fulltext row.`,
  );
}

/**
 * The one language a kind's fulltext rows are written with — the first
 * searchable field's declared language (the winning-language rule the
 * write path applies). `undefined` when the schema has no searchable
 * fields.
 *
 * Search paths use this to parse queries with a CONSTANT regconfig: the
 * per-row `websearch_to_tsquery("language", ...)` form makes the tsquery
 * non-constant, so PostgreSQL's GIN index on `tsv` can never serve the
 * match and every search scans the kind's rows.
 */
export function resolveDeclaredFulltextLanguage(
  schema: z.ZodType,
): string | undefined {
  return getSearchableFields(schema)[0]?.metadata.language;
}
