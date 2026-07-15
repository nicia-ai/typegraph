/**
 * Embedding type for vector search.
 *
 * Creates a Zod-compatible schema for vector embeddings with
 * dimension validation and metadata for query compilation.
 */
import { z } from "zod";

import type { VectorSlot } from "../query/dialect/vector-strategy";
import type { GraphDef } from "./define-graph";

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
  const indexType = options.indexType ?? DEFAULT_EMBEDDING_INDEX_TYPE;
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
    metric: options.metric ?? DEFAULT_EMBEDDING_METRIC,
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

// ============================================================
// Embedding Field Resolution
// ============================================================

/**
 * One resolved embedding field on a node schema — its dot-path plus the
 * fixed `dimensions` and the resolved index `(metric, indexType)`.
 * Sourced from the field's `embedding()` brand, unwrapping `.optional()`
 * / `.nullable()` / `.default()` / `.readonly()` wrappers. The single
 * source of truth shared by embedding sync (write path), the query
 * compiler's `field.similarTo(...)` slot resolution, and search.
 */
export type ResolvedEmbeddingField = Readonly<{
  fieldPath: string;
  dimensions: number;
  metric: EmbeddingMetric;
  indexType: EmbeddingIndexType;
}>;

/**
 * The single source of truth for an embedding field's default metric / index
 * type when unspecified — used by `embedding()` declaration resolution, the
 * field-fallback below, and the legacy-migration slot defaults
 * (`migrate-vectors.ts`) so the three never drift.
 */
export const DEFAULT_EMBEDDING_METRIC: EmbeddingMetric = "cosine";
export const DEFAULT_EMBEDDING_INDEX_TYPE: EmbeddingIndexType = "hnsw";

/**
 * Extracts every top-level embedding field from a node's object schema.
 * Returns `[]` for non-object schemas or schemas with no embedding
 * fields. Embeddings nested inside object properties are out of scope by
 * design (storage keys at the top-level `(kind, fieldPath)` grain).
 */
export function resolveEmbeddingFields(
  schema: z.ZodType,
): readonly ResolvedEmbeddingField[] {
  if (schema.type !== "object") return [];
  const shape = (schema.def as { shape?: Record<string, z.ZodType> }).shape;
  if (!shape) return [];

  const fields: ResolvedEmbeddingField[] = [];
  for (const [fieldPath, fieldSchema] of Object.entries(shape)) {
    const dimensions = resolveEmbeddingDimensions(fieldSchema);
    if (dimensions === undefined) continue;
    const index = resolveEmbeddingIndexConfig(fieldSchema);
    fields.push({
      fieldPath,
      dimensions,
      metric: index?.metric ?? DEFAULT_EMBEDDING_METRIC,
      indexType: index?.indexType ?? DEFAULT_EMBEDDING_INDEX_TYPE,
    });
  }
  return fields;
}

/**
 * Enumerates every embedding `(kind, field)` slot a graph declares, as a
 * fully-resolved {@link VectorSlot}. The single source of truth for "what
 * vector slots does this graph have?", shared by the privileged boot
 * materializer (`materializeVectorContributions`) and the verified-attach
 * gate (`assertVectorContributionsInitialized`) so the two can never
 * provision and assert different sets. Walks `graph.nodes` and reuses
 * {@link resolveEmbeddingFields} per node schema.
 */
export function resolveGraphVectorSlots(
  graph: GraphDef,
): readonly VectorSlot[] {
  const slots: VectorSlot[] = [];
  for (const registration of Object.values(graph.nodes)) {
    const node = registration.type;
    for (const field of resolveEmbeddingFields(node.schema)) {
      slots.push({
        graphId: graph.id,
        nodeKind: node.kind,
        fieldPath: field.fieldPath,
        dimensions: field.dimensions,
        metric: field.metric,
        indexType: field.indexType,
      });
    }
  }
  return slots;
}

function resolveEmbeddingDimensions(schema: z.ZodType): number | undefined {
  const direct = getEmbeddingDimensions(schema);
  if (direct !== undefined) return direct;
  const unwrapped = unwrapToEmbedding(schema);
  return unwrapped === undefined ? undefined : (
      getEmbeddingDimensions(unwrapped)
    );
}

function resolveEmbeddingIndexConfig(
  schema: z.ZodType,
): ResolvedEmbeddingIndex | undefined {
  const direct = getEmbeddingIndex(schema);
  if (direct !== undefined) return direct;
  const unwrapped = unwrapToEmbedding(schema);
  return unwrapped === undefined ? undefined : getEmbeddingIndex(unwrapped);
}

/**
 * Unwraps optional / nullable / default / readonly wrappers to find the
 * inner embedding schema, recursing through chained wrappers. Returns
 * `undefined` when no embedding schema is reachable.
 */
function unwrapToEmbedding(schema: z.ZodType): z.ZodType | undefined {
  const type = schema.type;
  const innerType = (schema.def as { innerType?: z.ZodType }).innerType;
  if (
    (type === "optional" ||
      type === "nullable" ||
      type === "default" ||
      type === "readonly") &&
    innerType
  ) {
    if (isEmbeddingSchema(innerType)) return innerType;
    return unwrapToEmbedding(innerType);
  }
  return undefined;
}
