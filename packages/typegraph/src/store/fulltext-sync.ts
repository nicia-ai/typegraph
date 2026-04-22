/**
 * Keeps the fulltext index in sync with node data. One row per node:
 * the values of every `searchable()` field are concatenated (joined by
 * `\n`) and stored as the indexed `content`, so a single FTS query can
 * match terms spanning multiple source fields — which a per-field
 * layout cannot, since FTS5 / Postgres MATCH require all terms in one
 * indexed document.
 *
 * Sync runs inline in the node-operation call path, so it inherits the
 * caller's transaction context.
 */
import { type z } from "zod";

import { type GraphBackend, type TransactionBackend } from "../backend/types";
import {
  DEFAULT_SEARCHABLE_LANGUAGE,
  getSearchableMetadata,
  type SearchableMetadata,
} from "../core/searchable";

type SearchableFieldInfo = Readonly<{
  fieldPath: string;
  metadata: SearchableMetadata;
}>;

export type FulltextSyncContext = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  backend: GraphBackend | TransactionBackend;
}>;

/**
 * Cache keyed by the Zod schema *instance*. Schemas are immutable at
 * runtime and the same `nodeKind.schema` reference is reused across
 * every CRUD call, so this collapses the per-write introspection cost
 * to one walk per schema for the lifetime of the process.
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
 * Emits a one-time warning per schema when searchable fields declare
 * different `language` values. The first field's language wins on the
 * stored row; true per-field multilingual indexing is not supported
 * today. This fires from `computeSearchableFields`, which is memoized
 * via a WeakMap keyed by schema instance — so the warning is emitted
 * at most once per schema for the lifetime of the process.
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
      `recorded on the fulltext row; true multilingual indexing requires ` +
      `a dedicated node kind per language.`,
  );
}

const FIELD_SEPARATOR = "\n";

/**
 * Picks a representative language when a node has searchable fields with
 * different language settings. Users who need true per-field
 * multilingual indexing should split the data across node kinds.
 */
function resolveCombinedLanguage(
  fields: readonly SearchableFieldInfo[],
): string {
  return fields[0]?.metadata.language ?? DEFAULT_SEARCHABLE_LANGUAGE;
}

/**
 * Computes the combined fulltext content for a node, or `undefined`
 * if the node has no non-empty searchable fields.
 *
 * Shared between `syncFulltext` (per-write) and `rebuildFulltextIndex`
 * (bulk) so the two never drift.
 */
export function computeFulltextContent(
  schema: z.ZodType,
  props: Record<string, unknown>,
): { content: string; language: string } | undefined {
  const searchableFields = getSearchableFields(schema);
  if (searchableFields.length === 0) return undefined;

  const parts: string[] = [];
  for (const field of searchableFields) {
    const value = props[field.fieldPath];
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    }
  }
  if (parts.length === 0) return undefined;

  return {
    content: parts.join(FIELD_SEPARATOR),
    language: resolveCombinedLanguage(searchableFields),
  };
}

/**
 * Syncs the fulltext index row after a node create or update.
 *
 * Concatenates the values of all searchable fields into a single content
 * string and upserts it. If every field is empty / undefined, deletes
 * any existing row for the node.
 */
export async function syncFulltext(
  ctx: FulltextSyncContext,
  schema: z.ZodType,
  props: Record<string, unknown>,
): Promise<void> {
  const { backend } = ctx;

  if (!backend.upsertFulltext || !backend.deleteFulltext) {
    return;
  }

  // `computeFulltextContent` returns `undefined` both when the schema has
  // no `searchable()` fields and when every value is empty — either case
  // means the row should not exist. Delete any stale row only when the
  // schema declares searchable fields (nothing to clean up otherwise).
  const computed = computeFulltextContent(schema, props);
  if (computed !== undefined) {
    await backend.upsertFulltext({
      graphId: ctx.graphId,
      nodeKind: ctx.nodeKind,
      nodeId: ctx.nodeId,
      content: computed.content,
      language: computed.language,
    });
    return;
  }
  if (getSearchableFields(schema).length === 0) return;
  await backend.deleteFulltext({
    graphId: ctx.graphId,
    nodeKind: ctx.nodeKind,
    nodeId: ctx.nodeId,
  });
}

/**
 * Deletes the fulltext row for a node.
 * Called on soft-delete; hard-delete is handled by the backend cascade.
 */
export async function deleteNodeFulltext(
  ctx: FulltextSyncContext,
  schema: z.ZodType,
): Promise<void> {
  const { backend } = ctx;

  if (!backend.deleteFulltext) {
    return;
  }

  if (getSearchableFields(schema).length === 0) {
    return;
  }

  await backend.deleteFulltext({
    graphId: ctx.graphId,
    nodeKind: ctx.nodeKind,
    nodeId: ctx.nodeId,
  });
}
