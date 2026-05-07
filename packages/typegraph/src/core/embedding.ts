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

/**
 * Symbol key for storing the embedding's preferred index configuration
 * on the schema. The schema introspector reads this when auto-deriving
 * `VectorIndexDeclaration` entries at `defineGraph()` time.
 */
export const EMBEDDING_INDEX_KEY = "_embeddingIndex" as const;

/**
 * Distance metric used for vector similarity. Pinned at the embedding
 * brand because changing the metric usually means generating different
 * model output (e.g. cosine-normalized vs. raw inner-product), and the
 * stored index needs the same metric to score correctly.
 *
 * - `cosine`: cosine similarity. The default — works for most
 *   sentence-transformer / OpenAI-style embeddings that are already
 *   length-normalized.
 * - `l2`: Euclidean distance. Use when your model outputs vectors
 *   trained for L2 (e.g. some image embedding models).
 * - `inner_product`: dot-product distance. Use when your model outputs
 *   pre-normalized vectors AND you want to skip the cosine
 *   normalization step at query time.
 */
export type EmbeddingMetric = "cosine" | "l2" | "inner_product";

/**
 * Vector index implementation. `hnsw` is the default and what pgvector
 * recommends for most workloads. `ivfflat` is the alternative for
 * larger datasets where memory is the bottleneck. `none` disables
 * automatic index creation for this embedding (the operator can still
 * call `backend.createVectorIndex` manually).
 */
export type EmbeddingIndexType = "hnsw" | "ivfflat" | "none";

/**
 * Per-embedding configuration for the auto-derived
 * `VectorIndexDeclaration`. All fields are optional with sensible
 * defaults (`cosine` / `hnsw` / pgvector defaults: `m=16`,
 * `ef_construction=64`). Override only when your model or dataset has
 * a known reason to.
 */
export type EmbeddingIndexOptions = Readonly<{
  /** Distance metric. Default `"cosine"`. */
  metric?: EmbeddingMetric;
  /** Vector index implementation. Default `"hnsw"`. */
  indexType?: EmbeddingIndexType;
  /** HNSW `m` parameter — max connections per layer. Default `16`. */
  m?: number;
  /** HNSW `ef_construction` parameter — build-time search depth. Default `64`. */
  efConstruction?: number;
  /** IVFFlat `lists` parameter — number of inverted-list partitions. */
  lists?: number;
}>;

/**
 * Resolved embedding index configuration with all defaults applied.
 * What gets attached to the brand and read by the auto-derivation pass.
 */
export type ResolvedEmbeddingIndex = Readonly<{
  metric: EmbeddingMetric;
  indexType: EmbeddingIndexType;
  m: number;
  efConstruction: number;
  lists: number | undefined;
}>;

const DEFAULT_HNSW_M = 16;
const DEFAULT_HNSW_EF_CONSTRUCTION = 64;

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
      [EMBEDDING_INDEX_KEY]: ResolvedEmbeddingIndex;
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
export function embedding<D extends number>(
  dimensions: D,
  options: EmbeddingIndexOptions = {},
): EmbeddingSchema<D> {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `Embedding dimensions must be a positive integer, got: ${dimensions}`,
    );
  }

  const indexConfig = resolveEmbeddingIndex(options);

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

  return Object.assign(schema, {
    [EMBEDDING_DIMENSIONS_KEY]: dimensions,
    [EMBEDDING_INDEX_KEY]: indexConfig,
  });
}

function resolveEmbeddingIndex(
  options: EmbeddingIndexOptions,
): ResolvedEmbeddingIndex {
  const indexType = options.indexType ?? "hnsw";
  const m = options.m ?? DEFAULT_HNSW_M;
  const efConstruction = options.efConstruction ?? DEFAULT_HNSW_EF_CONSTRUCTION;

  if (m <= 0 || !Number.isInteger(m)) {
    throw new Error(
      `embedding() index option 'm' must be a positive integer, got: ${m}`,
    );
  }
  if (efConstruction <= 0 || !Number.isInteger(efConstruction)) {
    throw new Error(
      `embedding() index option 'efConstruction' must be a positive integer, got: ${efConstruction}`,
    );
  }
  if (
    options.lists !== undefined &&
    (options.lists <= 0 || !Number.isInteger(options.lists))
  ) {
    throw new Error(
      `embedding() index option 'lists' must be a positive integer, got: ${options.lists}`,
    );
  }

  return Object.freeze({
    metric: options.metric ?? "cosine",
    indexType,
    m,
    efConstruction,
    lists: options.lists,
  });
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

/**
 * Gets the resolved index configuration from an embedding schema.
 * Returns undefined if the schema is not an embedding schema. Used by
 * the auto-derivation pass at `defineGraph()` time to build vector
 * `IndexDeclaration` entries.
 */
export function getEmbeddingIndex(
  schema: z.ZodType,
): ResolvedEmbeddingIndex | undefined {
  if (!isEmbeddingSchema(schema)) return undefined;
  const candidate = (schema as unknown as Record<string, unknown>)[
    EMBEDDING_INDEX_KEY
  ];
  if (candidate === undefined) return undefined;
  return candidate as ResolvedEmbeddingIndex;
}
