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

import {
  type GraphBackend,
  type NodeFulltextSync,
  type NodeInsertProjection,
  type TransactionBackend,
} from "../backend/types";
import {
  DEFAULT_SEARCHABLE_LANGUAGE,
  getSearchableFields,
  type SearchableFieldInfo,
} from "../core/searchable";
import { UnsupportedBackendCapabilityError } from "../errors";
import { readOwnProperty } from "../utils/object";

export { getSearchableFields } from "../core/searchable";

export type FulltextSyncContext = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  backend: GraphBackend | TransactionBackend;
}>;

const FIELD_SEPARATOR = "\n";

/**
 * Refuses with a typed error, rather than silently dropping the write, when
 * a node kind declares `searchable()` fields but the backend has no
 * fulltext support (`fulltext: false`). The backend's fulltext methods are
 * absent in that state (mirroring the vector methods on a vector-off
 * backend), so `syncFulltext` / `syncFulltextBatchForKind` /
 * `deleteNodeFulltext` would otherwise no-op forever instead of surfacing
 * the mismatch at the first write.
 *
 * Exported for the set-based update paths (`executeNodeSetUpdate` /
 * `applyNodeSetUpdate`), which probe for the batch fulltext members
 * directly rather than through the single-row `upsertFulltext` /
 * `deleteFulltext` presence check above, and so need the same refusal
 * without duplicating its error shape.
 */
export function refuseFulltextUnavailable(
  backend: GraphBackend | TransactionBackend,
  nodeKind: string,
): never {
  throw new UnsupportedBackendCapabilityError(
    `Node kind "${nodeKind}" declares searchable() fields`,
    "fulltext",
    { backend: backend.dialect, nodeKind, reason: "fulltext_unsupported" },
    "This backend was created with `fulltext: false`. Remove the " +
      "searchable() declaration, or use a backend with fulltext support.",
  );
}

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
    const value = readOwnProperty(props, field.fieldPath);
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
 * Resolves the complete fulltext side effect for one node row.
 * `undefined` means the schema has no searchable fields; an explicit delete
 * keeps an all-empty searchable row from being mistaken for no projection.
 */
export function resolveNodeFulltextProjection(
  schema: z.ZodType,
  props: Record<string, unknown>,
): Extract<NodeInsertProjection, { kind: "fulltext" }> | undefined {
  if (getSearchableFields(schema).length === 0) return undefined;
  const computed = computeFulltextContent(schema, props);
  return computed === undefined ?
      { kind: "fulltext", action: "delete" }
    : { kind: "fulltext", action: "upsert", ...computed };
}

/** Resolves the ordinary identity-carrying fulltext synchronization input. */
function resolveNodeFulltextSync(
  schema: z.ZodType,
  props: Record<string, unknown>,
  identity: Readonly<{
    graphId: string;
    nodeKind: string;
    nodeId: string;
  }>,
): NodeFulltextSync | undefined {
  if (getSearchableFields(schema).length === 0) return undefined;
  const computed = computeFulltextContent(schema, props);
  return computed === undefined ?
      { ...identity, action: "delete" }
    : { ...identity, action: "upsert", ...computed };
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

  // Member presence rather than `resolveBackendFulltext`: this same check is
  // what narrows `backend.upsertFulltext` / `backend.deleteFulltext` from
  // optional to defined for the calls below, so it doubles as the type
  // guard the rest of the function relies on.
  if (!backend.upsertFulltext || !backend.deleteFulltext) {
    if (getSearchableFields(schema).length > 0) {
      refuseFulltextUnavailable(backend, ctx.nodeKind);
    }
    return;
  }

  const sync = resolveNodeFulltextSync(schema, props, ctx);
  if (sync?.action === "upsert") {
    await backend.upsertFulltext({
      graphId: ctx.graphId,
      nodeKind: ctx.nodeKind,
      nodeId: ctx.nodeId,
      content: sync.content,
      language: sync.language,
    });
    return;
  }
  if (sync === undefined) return;
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
  // Member presence rather than `resolveBackendFulltext`: this same check is
  // what narrows `backend.upsertFulltext` / `backend.deleteFulltext` from
  // optional to defined for the calls below, so it doubles as the type
  // guard the rest of the function relies on.
  if (!backend.upsertFulltext || !backend.deleteFulltext) {
    if (getSearchableFields(schema).length > 0) {
      refuseFulltextUnavailable(backend, nodeKind);
    }
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

  // Member presence rather than `resolveBackendFulltext`: this is the type
  // guard that narrows `backend.deleteFulltext` for the call below.
  if (!backend.deleteFulltext) {
    if (getSearchableFields(schema).length > 0) {
      refuseFulltextUnavailable(backend, ctx.nodeKind);
    }
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
