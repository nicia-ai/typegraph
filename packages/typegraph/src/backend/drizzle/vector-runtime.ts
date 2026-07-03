/**
 * Backend-runtime glue between a {@link VectorStrategy} and the Drizzle
 * SQLite / PostgreSQL backends. Holds the two responsibilities that belong
 * in the backend rather than the strategy:
 *
 * 1. **Slot construction.** The backend stays graph-agnostic: it never
 *    inspects the graph/registry. The store resolves a field's
 *    `dimensions` / `metric` / `indexType` from the schema and threads
 *    them through `UpsertEmbeddingParams` / `VectorSearchParams` /
 *    `CreateVectorIndexParams`; these helpers reshape those params into the
 *    `VectorSlot` a strategy addresses its storage with.
 * 2. **The storage-ensure latch.** A per-storage-shape
 *    in-process latch that runs `strategy.ownedTables(slot).createDdl`
 *    (idempotent `CREATE ... IF NOT EXISTS`) once before the first write to
 *    a slot, so a write never hits a missing per-field table. Shared across
 *    the outer backend and every transaction-scoped backend within one
 *    `createBackend` call. `materializeIndexes()` creates the same storage
 *    idempotently, so the two never conflict.
 */
import { EmbeddingDimensionChangedError } from "../../errors";
import {
  type VectorSlot,
  type VectorStrategy,
} from "../../query/dialect/vector-strategy";
import { parseDimensionMismatch } from "../../utils/sql-errors";
import {
  type CreateVectorIndexParams,
  type DropVectorIndexParams,
} from "../types";

/**
 * In-process per-storage-shape storage-ensure latch. The DDL it runs is
 * idempotent, so re-running it is harmless; the latch only avoids redundant
 * round-trips and de-duplicates concurrent ensures.
 */
export type VectorSlotLatch = Readonly<{
  ensure: (
    strategy: VectorStrategy,
    slot: VectorSlot,
    execDdl: (statement: string) => Promise<void>,
  ) => Promise<void>;
}>;

function vectorSlotKey(slot: VectorSlot): string {
  // JSON of the storage-shaping fields: collision-safe across arbitrary
  // graph/kind/field strings (a raw delimiter could otherwise appear in a name).
  // Metric and index type matter even when the physical table name does not:
  // libSQL folds DiskANN DDL into `ownedTables` only for ANN slots, and
  // sqlite-vec bakes the metric into its virtual-table declaration.
  return JSON.stringify([
    slot.graphId,
    slot.nodeKind,
    slot.fieldPath,
    slot.dimensions,
    slot.metric,
    slot.indexType,
  ]);
}

export function createVectorSlotLatch(): VectorSlotLatch {
  const inFlight = new Map<string, Promise<void>>();

  return {
    ensure(strategy, slot, execDdl): Promise<void> {
      const key = vectorSlotKey(slot);
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;

      const run = (async (): Promise<void> => {
        for (const contribution of strategy.ownedTables(slot)) {
          for (const statement of contribution.createDdl) {
            await execDdl(statement);
          }
        }
      })();
      // Cache only the successful resolution: a failed CREATE (e.g. a
      // transient lock) must not poison the slot so the next write retries.
      const cached = run.catch((error: unknown) => {
        inFlight.delete(key);
        throw error;
      });
      inFlight.set(key, cached);
      return cached;
    },
  };
}

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
    ...(params.indexParams === undefined
      ? {}
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
