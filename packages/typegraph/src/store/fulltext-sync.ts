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

import { resolveBackendFulltext } from "../backend/capabilities/fulltext";
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
import {
  ConfigurationError,
  UnsupportedBackendCapabilityError,
} from "../errors";
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
 * a node kind declares `searchable()` fields but `resolveBackendFulltext`
 * reports the backend has no fulltext support at all (`fulltext: false`).
 * Used by `syncFulltext` / `syncFulltextBatchForKind` on the create/update
 * paths, where an unavailable backend cannot honor the write. Deletes are
 * exempt: a fulltext-off backend maintains no sidecar to remove a row
 * from, so `deleteNodeFulltext` succeeds instead of refusing.
 *
 * Exported for the set-based update paths (`executeNodeSetUpdate` /
 * `applyNodeSetUpdate`), which reach the same "unavailable" branch ahead of
 * their own batch-member presence checks, and so need the same refusal
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
    "This backend declares no fulltext capability. Remove the " +
      "searchable() declaration, or use a backend with fulltext support.",
  );
}

/**
 * Narrows an optional fulltext member to defined. Called only after
 * `resolveBackendFulltext` has already confirmed the backend declares
 * fulltext support, so a member missing at this point is not an
 * availability decision but a backend contract violation — a bundled
 * backend never reaches this, and a third-party one that declares the
 * capability without the member gets a `ConfigurationError` naming exactly
 * which member is missing, not `refuseFulltextUnavailable`'s
 * capability-absent error.
 */
export function assertFulltextMember<T>(
  member: T | undefined,
  memberName: string,
  backend: GraphBackend | TransactionBackend,
): asserts member is T {
  if (member !== undefined) return;
  throw new ConfigurationError(
    `Backend declares a fulltext capability but is missing the "${memberName}" member`,
    {
      backend: backend.dialect,
      capability: "fulltext",
      missingMember: memberName,
    },
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

  if (getSearchableFields(schema).length === 0) return;

  // `resolveBackendFulltext` is the one decision for "is fulltext
  // available on this backend"; a missing member past that point is a
  // contract violation asserted separately below, never re-derived here.
  if (resolveBackendFulltext(backend) === false) {
    refuseFulltextUnavailable(backend, ctx.nodeKind);
  }
  assertFulltextMember(backend.upsertFulltext, "upsertFulltext", backend);
  assertFulltextMember(backend.deleteFulltext, "deleteFulltext", backend);

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
  if (getSearchableFields(schema).length === 0) return;

  // `resolveBackendFulltext` is the one decision for "is fulltext
  // available on this backend"; a missing member past that point is a
  // contract violation asserted separately below, never re-derived here.
  if (resolveBackendFulltext(backend) === false) {
    refuseFulltextUnavailable(backend, nodeKind);
  }
  assertFulltextMember(backend.upsertFulltext, "upsertFulltext", backend);
  assertFulltextMember(backend.deleteFulltext, "deleteFulltext", backend);

  // The bail-out above guarantees the schema has searchable fields for
  // every remaining line, so an item with no computed content always
  // means "clear its row" rather than "not applicable".
  const rows: { nodeId: string; content: string; language: string }[] = [];
  const emptyContentIds: string[] = [];
  for (const item of items) {
    const computed = computeFulltextContent(schema, item.props);
    if (computed === undefined) {
      emptyContentIds.push(item.nodeId);
    } else {
      rows.push({
        nodeId: item.nodeId,
        content: computed.content,
        language: computed.language,
      });
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

  if (getSearchableFields(schema).length === 0) return;

  // Unlike `syncFulltext`, an unavailable backend does not refuse here: a
  // delete removes data rather than accepting a write the backend cannot
  // index, and this backend maintains no fulltext sidecar to issue that
  // removal against, so the delete is a no-op rather than a refusal. If
  // fulltext was active before this backend was reconfigured with
  // `fulltext: false`, an existing row is left in place, unmaintained.
  if (resolveBackendFulltext(backend) === false) return;

  assertFulltextMember(backend.deleteFulltext, "deleteFulltext", backend);

  await backend.deleteFulltext({
    graphId: ctx.graphId,
    nodeKind: ctx.nodeKind,
    nodeId: ctx.nodeId,
  });
}
