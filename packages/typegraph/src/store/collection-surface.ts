import { type AnyEdgeType, type NodeType } from "../core/types";
import type {
  EdgeCollection,
  NodeCollection,
  StoreViewEdgeCollection,
  StoreViewNodeCollection,
} from "./types";

/**
 * StoreView collection surface buckets.
 *
 * The live NodeCollection / EdgeCollection partition into buckets a StoreView
 * treats differently:
 *
 * - temporal reads honor the pinned coordinate;
 * - current reads have no temporal axis and are refused on temporal pins;
 * - writes are never available on a read-only view; and
 * - batch reads require store.batch() and are absent from a view.
 *
 * These arrays are the single runtime source of truth for the proxy routing and
 * the type-level source for the derived StoreView collection types. The
 * StoreView surface-classification test asserts they exactly partition the live
 * collection methods so new collection methods cannot be silently omitted.
 */

/** Temporal-aware node read method names. */
export const NODE_TEMPORAL_READ_NAMES = [
  "getById",
  "getByIds",
  "find",
  "count",
] as const satisfies readonly (keyof NodeCollection<NodeType, string>)[];

/** Current-state-only node reads (constraint / index lookups). */
export const CURRENT_ONLY_READ_NAMES = [
  "findByConstraint",
  "bulkFindByConstraint",
  "bulkFindByIndex",
] as const satisfies readonly (keyof NodeCollection<NodeType, string>)[];

/** Node write method names: never available on a read-only StoreView. */
export const NODE_WRITE_NAMES = [
  "create",
  "createFromRecord",
  "update",
  "delete",
  "hardDelete",
  "upsertById",
  "upsertByIdFromRecord",
  "bulkCreate",
  "bulkUpsertById",
  "bulkInsert",
  "bulkDelete",
  "getOrCreateByConstraint",
  "bulkGetOrCreateByConstraint",
] as const satisfies readonly (keyof NodeCollection<NodeType, string>)[];

/** Temporal-aware edge read method names. */
export const EDGE_TEMPORAL_READ_NAMES = [
  "getById",
  "getByIds",
  "find",
  "count",
  "findFrom",
  "findTo",
  "findByEndpoints",
] as const satisfies readonly (keyof EdgeCollection<
  AnyEdgeType,
  NodeType,
  NodeType
>)[];

/** Deferred edge batch-read method names. */
export const EDGE_BATCH_READ_NAMES = [
  "batchFindFrom",
  "batchFindTo",
  "batchFindByEndpoints",
] as const satisfies readonly (keyof EdgeCollection<
  AnyEdgeType,
  NodeType,
  NodeType
>)[];

/** Edge write method names: never available on a read-only StoreView. */
export const EDGE_WRITE_NAMES = [
  "create",
  "update",
  "delete",
  "hardDelete",
  "bulkCreate",
  "bulkUpsertById",
  "bulkInsert",
  "bulkDelete",
  "getOrCreateByEndpoints",
  "bulkGetOrCreateByEndpoints",
] as const satisfies readonly (keyof EdgeCollection<
  AnyEdgeType,
  NodeType,
  NodeType
>)[];

/** Recorded-time collection point reads that reconstruct safely by id. */
export const RECORDED_POINT_READ_NAMES = [
  "getById",
  "getByIds",
] as const satisfies readonly (keyof StoreViewNodeCollection<NodeType> &
  keyof StoreViewEdgeCollection<AnyEdgeType, NodeType, NodeType>)[];
