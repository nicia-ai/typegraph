/**
 * Embedding type for vector search.
 *
 * Creates a Zod-compatible schema for vector embeddings with
 * dimension validation and metadata for query compilation.
 */
import { z } from "zod";

// ============================================================
// Embedding Brand Symbol
// ============================================================

/**
 * Symbol used to brand embedding values at the type level.
 * This allows TypeScript to distinguish embedding arrays from regular
 * number arrays in the query builder type system.
 */
declare const EMBEDDING_BRAND: unique symbol;

/**
 * Branded embedding type for type-level distinction.
 * At runtime this is just `readonly number[]`, but TypeScript can
 * distinguish it from regular arrays for query builder typing.
 */
export type EmbeddingValue = readonly number[] & {
  readonly [EMBEDDING_BRAND]: true;
};

// ============================================================
// Embedding Metadata Symbol
// ============================================================

/**
 * Symbol key for storing embedding dimensions on the schema.
 * This allows the schema introspector to detect embedding types
 * and extract dimension information.
 */
export const EMBEDDING_DIMENSIONS_KEY = "_embeddingDimensions" as const;

// ============================================================
// Embedding Schema Type
// ============================================================

/**
 * A Zod schema for vector embeddings with attached dimension metadata.
 * Uses the branded EmbeddingValue type for type-level distinction.
 */
export type EmbeddingSchema<D extends number = number> =
  z.ZodType<EmbeddingValue> &
    Readonly<{
      [EMBEDDING_DIMENSIONS_KEY]: D;
    }>;

// ============================================================
// Embedding Factory
// ============================================================

/**
 * Creates a Zod schema for vector embeddings.
 *
 * The dimension is validated at runtime and attached as metadata
 * for the schema introspector and query compiler.
 *
 * @param dimensions - The number of dimensions (e.g., 384, 512, 768, 1536, 3072)
 * @returns A Zod schema that validates embedding arrays
 *
 * @example
 * ```typescript
 * // OpenAI ada-002 embeddings
 * const Document = defineNode("Document", {
 *   schema: z.object({
 *     title: z.string(),
 *     embedding: embedding(1536),
 *   }),
 * });
 *
 * // Sentence transformers
 * const Sentence = defineNode("Sentence", {
 *   schema: z.object({
 *     text: z.string(),
 *     embedding: embedding(384), // all-MiniLM-L6-v2
 *   }),
 * });
 *
 * // Optional embeddings are supported
 * const Article = defineNode("Article", {
 *   schema: z.object({
 *     content: z.string(),
 *     embedding: embedding(1536).optional(),
 *   }),
 * });
 * ```
 */
export function embedding<D extends number>(dimensions: D): EmbeddingSchema<D> {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `Embedding dimensions must be a positive integer, got: ${dimensions}`,
    );
  }

  // Use EmbeddingValue as the output type for proper type branding.
  // At runtime, validation accepts any number array with correct dimensions.
  const schema = z.custom<EmbeddingValue>(
    (value): value is EmbeddingValue => {
      if (!Array.isArray(value)) {
        return false;
      }
      if (value.length !== dimensions) {
        return false;
      }
      return value.every((n) => typeof n === "number" && Number.isFinite(n));
    },
    {
      message: `Expected an array of ${dimensions} finite numbers`,
    },
  );

  // Attach dimensions metadata for introspection
  return Object.assign(schema, {
    [EMBEDDING_DIMENSIONS_KEY]: dimensions,
  }) as EmbeddingSchema<D>;
}

// ============================================================
// Type Guards
// ============================================================

/**
 * Checks if a value is an embedding schema.
 */
export function isEmbeddingSchema(value: unknown): value is EmbeddingSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    EMBEDDING_DIMENSIONS_KEY in value &&
    typeof (value as Record<string, unknown>)[EMBEDDING_DIMENSIONS_KEY] ===
      "number"
  );
}

/**
 * Gets the dimensions from an embedding schema.
 * Returns undefined if the schema is not an embedding schema.
 */
export function getEmbeddingDimensions(schema: z.ZodType): number | undefined {
  if (isEmbeddingSchema(schema)) {
    return schema[EMBEDDING_DIMENSIONS_KEY];
  }
  return undefined;
}
