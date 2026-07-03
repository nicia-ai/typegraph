/**
 * Embedding Sync Utilities
 *
 * Handles automatic synchronization of embedding fields with the embeddings table.
 * When nodes with embedding properties are created, updated, or deleted,
 * these utilities ensure the embeddings table stays in sync.
 */
import { type z } from "zod";

import { type GraphBackend, type TransactionBackend } from "../backend/types";
import {
  type ResolvedEmbeddingField,
  resolveEmbeddingFields,
} from "../core/embedding";

// ============================================================
// Types
// ============================================================

/**
 * Information about an embedding field in a node schema.
 *
 * Re-exports the canonical {@link ResolvedEmbeddingField} so the backend
 * gets `dimensions` plus the resolved index `(metric, indexType)` — all
 * three needed to address the field's typed per-`(kind, field)` storage
 * slot when upserting.
 */
type EmbeddingFieldInfo = ResolvedEmbeddingField;

/**
 * Context for embedding sync operations.
 */
export type EmbeddingSyncContext = Readonly<{
  graphId: string;
  nodeKind: string;
  nodeId: string;
  backend: GraphBackend | TransactionBackend;
}>;

// ============================================================
// Schema Introspection
// ============================================================

/**
 * Cache keyed by the Zod schema instance. Schemas are immutable at
 * runtime; the same reference recurs across every CRUD call.
 */
const embeddingFieldsCache = new WeakMap<
  z.ZodType,
  readonly EmbeddingFieldInfo[]
>();

/**
 * Extracts embedding field information from a Zod schema.
 * Returns all embedding fields found at the top level of an object schema.
 *
 * Thin per-schema-instance memoization over the canonical
 * {@link resolveEmbeddingFields}; the same schema reference recurs across
 * every CRUD call, so caching avoids re-walking the shape each time.
 */
export function getEmbeddingFields(
  schema: z.ZodType,
): readonly EmbeddingFieldInfo[] {
  const cached = embeddingFieldsCache.get(schema);
  if (cached) return cached;
  const fields = resolveEmbeddingFields(schema);
  embeddingFieldsCache.set(schema, fields);
  return fields;
}

// ============================================================
// Embedding Sync Operations
// ============================================================

/**
 * Syncs embeddings after a node create or update operation.
 *
 * For each embedding field in the schema:
 * - If the props contain an embedding value, upsert it to the embeddings table
 * - If the props don't contain an embedding value (undefined), delete any existing embedding
 */
export async function syncEmbeddings(
  ctx: EmbeddingSyncContext,
  schema: z.ZodType,
  props: Record<string, unknown>,
): Promise<void> {
  const { backend } = ctx;

  // Check if backend supports embedding operations
  if (!backend.upsertEmbedding || !backend.deleteEmbedding) {
    return;
  }

  const embeddingFields = getEmbeddingFields(schema);
  if (embeddingFields.length === 0) {
    return;
  }

  for (const field of embeddingFields) {
    const value = props[field.fieldPath];

    if (isValidEmbeddingValue(value)) {
      // Upsert the embedding
      await backend.upsertEmbedding({
        graphId: ctx.graphId,
        nodeKind: ctx.nodeKind,
        nodeId: ctx.nodeId,
        fieldPath: field.fieldPath,
        embedding: value,
        dimensions: field.dimensions,
        metric: field.metric,
        indexType: field.indexType,
      });
    } else if (value === undefined) {
      // Delete any existing embedding for this field
      await backend.deleteEmbedding({
        graphId: ctx.graphId,
        nodeKind: ctx.nodeKind,
        nodeId: ctx.nodeId,
        fieldPath: field.fieldPath,
        dimensions: field.dimensions,
        metric: field.metric,
        indexType: field.indexType,
      });
    }
    // If value is null or invalid, skip (validation should have caught this)
  }
}

/**
 * Syncs embeddings for a batch of same-kind node creates through one
 * `upsertEmbeddingBatch` per field (falling back to per-row
 * `upsertEmbedding` when the backend lacks the batch primitive). Mirrors
 * `syncEmbeddings` per row: present values upsert, `undefined` values
 * delete any existing embedding for the field.
 */
export async function syncEmbeddingsBatchForKind(
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
  if (!backend.upsertEmbedding || !backend.deleteEmbedding) {
    return;
  }

  const embeddingFields = getEmbeddingFields(schema);
  if (embeddingFields.length === 0) {
    return;
  }

  for (const field of embeddingFields) {
    const rows: { nodeId: string; embedding: readonly number[] }[] = [];
    const deletionIds: string[] = [];
    for (const item of items) {
      const value = item.props[field.fieldPath];
      if (isValidEmbeddingValue(value)) {
        rows.push({ nodeId: item.nodeId, embedding: value });
      } else if (value === undefined) {
        deletionIds.push(item.nodeId);
      }
    }

    if (rows.length > 0) {
      if (backend.upsertEmbeddingBatch === undefined) {
        for (const row of rows) {
          await backend.upsertEmbedding({
            graphId,
            nodeKind,
            nodeId: row.nodeId,
            fieldPath: field.fieldPath,
            embedding: row.embedding,
            dimensions: field.dimensions,
            metric: field.metric,
            indexType: field.indexType,
          });
        }
      } else {
        await backend.upsertEmbeddingBatch({
          graphId,
          nodeKind,
          fieldPath: field.fieldPath,
          dimensions: field.dimensions,
          metric: field.metric,
          indexType: field.indexType,
          rows,
        });
      }
    }

    for (const nodeId of deletionIds) {
      await backend.deleteEmbedding({
        graphId,
        nodeKind,
        nodeId,
        fieldPath: field.fieldPath,
        dimensions: field.dimensions,
        metric: field.metric,
        indexType: field.indexType,
      });
    }
  }
}

/**
 * Deletes a node's embeddings for the embedding fields its kind CURRENTLY
 * declares. A field dropped from the schema after the node was written is
 * intentionally NOT swept here — its entire per-field table is reclaimed
 * wholesale by `store.materializeRemovals()` (the deferred-cleanup verb), which
 * also covers live (never-deleted) nodes' rows. So a hard/soft delete can leave
 * a transient orphan row in a removed field's table until the next reclaim pass;
 * that is the deferred-cleanup design, not a leak.
 */
export async function deleteNodeEmbeddings(
  ctx: EmbeddingSyncContext,
  schema: z.ZodType,
): Promise<void> {
  const { backend } = ctx;

  // Check if backend supports embedding operations
  if (!backend.deleteEmbedding) {
    return;
  }

  const embeddingFields = getEmbeddingFields(schema);
  if (embeddingFields.length === 0) {
    return;
  }

  for (const field of embeddingFields) {
    await backend.deleteEmbedding({
      graphId: ctx.graphId,
      nodeKind: ctx.nodeKind,
      nodeId: ctx.nodeId,
      fieldPath: field.fieldPath,
      dimensions: field.dimensions,
      metric: field.metric,
      indexType: field.indexType,
    });
  }
}

// ============================================================
// Validation Helpers
// ============================================================

/**
 * Checks if a value is a valid embedding (array of numbers).
 */
function isValidEmbeddingValue(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every((n) => typeof n === "number" && Number.isFinite(n));
}
