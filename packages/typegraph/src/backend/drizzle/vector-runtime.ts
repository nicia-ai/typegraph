/**
 * Backend-runtime glue between a `VectorStrategy` and the Drizzle
 * SQLite / PostgreSQL backends. Holds the slot-construction and
 * write-error-mapping responsibilities that belong in the backend rather
 * than the strategy:
 *
 * - **Slot construction.** The backend stays graph-agnostic: it never
 *   inspects the graph/registry. The store resolves a field's
 *   `dimensions` / `metric` / `indexType` from the schema and threads
 *   them through `UpsertEmbeddingParams` / `VectorSearchParams` /
 *   `CreateVectorIndexParams`; these helpers reshape those params into the
 *   `VectorSlot` a strategy addresses its storage with.
 * - **Write-error mapping.** Turns a raw engine dimension-mismatch into a
 *   typed {@link EmbeddingDimensionChangedError} with actionable guidance.
 *
 * Per-field table creation is no longer done here: it rides the #135
 * durable-contribution machinery (`createContributionMaterializer`),
 * materialized by the privileged migrator at boot and asserted (SELECT,
 * never DDL) on the runtime hot path — see `contribution-materializations.ts`.
 */
import { EmbeddingDimensionChangedError } from "../../errors";
import { type VectorSlot } from "../../query/dialect/vector-strategy";
import { parseDimensionMismatch } from "../../utils/sql-errors";
import {
  type CreateVectorIndexParams,
  type DropVectorIndexParams,
} from "../types";

/**
 * Placeholder dimension for slots built from params that don't carry one
 * (`DropVectorIndexParams`). The dimension is never read on the drop path —
 * it addresses an index by `(nodeKind, fieldPath)` alone.
 */
const VECTOR_SLOT_PLACEHOLDER_DIMENSIONS = 1;

/**
 * Reshapes the storage-addressing fields shared by every embedding param type
 * (upsert / search / delete) into a {@link VectorSlot}. Picks only the six slot
 * fields, dropping each param type's payload (`embedding`, `queryEmbedding`,
 * `limit`, …). Delete carries the real `dimensions`/`metric`/`indexType` (not
 * just `(nodeKind, fieldPath)`) so the backend can idempotently ensure the
 * correctly-shaped per-field table before deleting.
 */
/**
 * Bound parameters per row in every strategy's embedding upsert SQL
 * (graph_id, node_id, created_at, updated_at, embedding). Backends derive
 * their batch chunk size from the connection's bound-parameter budget and
 * this count. sqlite-vec's companion IN-list DELETE binds one parameter per
 * row plus graph_id, which stays under the same budget.
 */
export const EMBEDDING_UPSERT_PARAM_COUNT = 5;

export function vectorSlotFromParams(
  params: Omit<VectorSlot, "indexParams">,
): VectorSlot {
  return {
    graphId: params.graphId,
    nodeKind: params.nodeKind,
    fieldPath: params.fieldPath,
    dimensions: params.dimensions,
    metric: params.metric,
    indexType: params.indexType,
  };
}

export function vectorSlotFromCreateIndexParams(
  params: CreateVectorIndexParams,
): VectorSlot {
  return {
    ...vectorSlotFromParams(params),
    ...(params.indexParams === undefined ?
      {}
    : { indexParams: params.indexParams }),
  };
}

/**
 * A `VectorSlot` for `dropVectorIndex`. `DropVectorIndexParams` carries
 * only `(nodeKind, fieldPath)` — enough to address the index, whose name a
 * strategy derives from those alone (it is metric- and dimension-
 * independent). `indexType: "hnsw"` makes `buildDropIndex` emit a real
 * `DROP INDEX IF EXISTS` (harmless when none exists); the placeholder
 * `metric`/`dimensions` are never read on the drop path.
 */
export function vectorSlotFromDropIndexParams(
  params: DropVectorIndexParams,
): VectorSlot {
  return {
    graphId: params.graphId,
    nodeKind: params.nodeKind,
    fieldPath: params.fieldPath,
    dimensions: VECTOR_SLOT_PLACEHOLDER_DIMENSIONS,
    metric: "cosine",
    indexType: "hnsw",
  };
}

/**
 * Maps a raw engine vector-dimension-mismatch failure from an embedding
 * upsert into a typed {@link EmbeddingDimensionChangedError} with actionable
 * guidance. Unrelated errors pass through unchanged. Used by both backends so
 * a write after a field's `embedding(N)` → `embedding(M)` change surfaces
 * "run reembedVectorField" instead of a cryptic `expected N dimensions` error.
 */
export function mapVectorWriteError(
  error: unknown,
  params: Readonly<{ nodeKind: string; fieldPath: string }>,
): unknown {
  const mismatch = parseDimensionMismatch(error);
  if (mismatch === undefined) return error;
  const attempted = mismatch.actual ?? "a different number of";
  return new EmbeddingDimensionChangedError(
    `Embedding "${params.nodeKind}.${params.fieldPath}" was written with ${attempted} dimensions, but its per-field storage expects ${mismatch.expected}. The field's embedding dimension changed; existing vectors must be recreated and re-embedded.`,
    {
      kind: params.nodeKind,
      fieldPath: params.fieldPath,
      storedDimensions: mismatch.expected,
      ...(mismatch.actual === undefined ?
        {}
      : { declaredDimensions: mismatch.actual }),
    },
    { cause: error },
  );
}
