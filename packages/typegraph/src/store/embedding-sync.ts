/**
 * Embedding Sync Utilities
 *
 * Handles automatic synchronization of embedding fields with the embeddings table.
 * When nodes with embedding properties are created, updated, or deleted,
 * these utilities ensure the embeddings table stays in sync.
 */
import { type z } from "zod";

import { type GraphBackend, type TransactionBackend } from "../backend/types";
import { getEmbeddingDimensions, isEmbeddingSchema } from "../core/embedding";

// ============================================================
// Types
// ============================================================

/**
 * Information about an embedding field in a node schema.
 */
type EmbeddingFieldInfo = Readonly<{
  /** The field path (e.g., "embedding" or "contentEmbedding") */
  fieldPath: string;
  /** The number of dimensions for this embedding */
  dimensions: number;
}>;

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
 * Extracts embedding field information from a Zod schema.
 * Returns all embedding fields found at the top level of an object schema.
 */
export function getEmbeddingFields(
  schema: z.ZodType,
): readonly EmbeddingFieldInfo[] {
  // Check if schema is an object type
  if (schema.type !== "object") {
    return [];
  }

  const def = schema.def as { shape?: Record<string, z.ZodType> };
  const shape = def.shape;
  if (!shape) {
    return [];
  }

  const fields: EmbeddingFieldInfo[] = [];

  for (const [fieldPath, fieldSchema] of Object.entries(shape)) {
    // Check if this field is an embedding (possibly wrapped in optional/nullable)
    const dimensions = getEmbeddingDimensionsFromField(fieldSchema);
    if (dimensions !== undefined) {
      fields.push({ fieldPath, dimensions });
    }
  }

  return fields;
}

/**
 * Gets embedding dimensions from a field schema, handling wrappers like optional/nullable.
 */
function getEmbeddingDimensionsFromField(
  schema: z.ZodType,
): number | undefined {
  // Check the schema directly
  const directDimensions = getEmbeddingDimensions(schema);
  if (directDimensions !== undefined) {
    return directDimensions;
  }

  // Check if it's wrapped (optional, nullable, default, etc.)
  const unwrapped = unwrapToEmbedding(schema);
  if (unwrapped) {
    return getEmbeddingDimensions(unwrapped);
  }

  return undefined;
}

/**
 * Unwraps wrapper types to find an embedding schema.
 */
function unwrapToEmbedding(schema: z.ZodType): z.ZodType | undefined {
  const type = schema.type;
  const def = schema.def as { innerType?: z.ZodType };

  // Handle common wrapper types
  if (
    (type === "optional" ||
      type === "nullable" ||
      type === "default" ||
      type === "readonly") &&
    def.innerType
  ) {
    // Check if inner type is an embedding
    if (isEmbeddingSchema(def.innerType)) {
      return def.innerType;
    }
    // Recursively unwrap
    return unwrapToEmbedding(def.innerType);
  }

  return undefined;
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
      });
    } else if (value === undefined) {
      // Delete any existing embedding for this field
      await backend.deleteEmbedding({
        graphId: ctx.graphId,
        nodeKind: ctx.nodeKind,
        nodeId: ctx.nodeId,
        fieldPath: field.fieldPath,
      });
    }
    // If value is null or invalid, skip (validation should have caught this)
  }
}

/**
 * Deletes all embeddings for a node.
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
