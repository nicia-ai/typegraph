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
  getSearchableFields,
  type SearchableFieldInfo,
} from "../core/searchable";

export { getSearchableFields } from "../core/searchable";

export type FulltextSyncContext = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  backend: GraphBackend | TransactionBackend;
}>;

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
 * Syncs the fulltext rows for a batch of same-kind node creates through
 * one `upsertFulltextBatch` call (falling back to per-row `upsertFulltext`
 * when the backend lacks the batch primitive). Mirrors `syncFulltext`
 * per row: computed content upserts, empty content deletes any stale row
 * when the schema declares searchable fields.
 */
export async function syncFulltextBatchForKind(
  args: Readonly<{
    graphId: string;
    nodeKind: string;
    backend: GraphBackend | TransactionBackend;
  }>,
  schema: z.ZodType,
  items: readonly Readonly<{
    nodeId: string;
    props: Record<string, unknown>;
  }>[],
): Promise<void> {
  const { graphId, nodeKind, backend } = args;
  if (!backend.upsertFulltext || !backend.deleteFulltext) {
    return;
  }

  const rows: { nodeId: string; content: string; language: string }[] = [];
  const emptyContentIds: string[] = [];
  const hasSearchableFields = getSearchableFields(schema).length > 0;
  for (const item of items) {
    const computed = computeFulltextContent(schema, item.props);
    if (computed !== undefined) {
      rows.push({
        nodeId: item.nodeId,
        content: computed.content,
        language: computed.language,
      });
    } else if (hasSearchableFields) {
      emptyContentIds.push(item.nodeId);
    }
  }

  if (rows.length > 0) {
    if (backend.upsertFulltextBatch === undefined) {
      for (const row of rows) {
        await backend.upsertFulltext({
          graphId,
          nodeKind,
          nodeId: row.nodeId,
          content: row.content,
          language: row.language,
        });
      }
    } else {
      await backend.upsertFulltextBatch({ graphId, nodeKind, rows });
    }
  }

  if (emptyContentIds.length > 0) {
    if (backend.deleteFulltextBatch === undefined) {
      for (const nodeId of emptyContentIds) {
        await backend.deleteFulltext({ graphId, nodeKind, nodeId });
      }
    } else {
      await backend.deleteFulltextBatch({
        graphId,
        nodeKind,
        nodeIds: emptyContentIds,
      });
    }
  }
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
