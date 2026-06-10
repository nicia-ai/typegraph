/**
 * Row Mappers for Store
 *
 * Transforms database rows into typed Node and Edge objects.
 */
import {
  type EdgeHistoryRow,
  type EdgeRow as BackendEdgeRow,
  type NodeHistoryRow,
  type NodeRow as BackendNodeRow,
} from "../backend/types";
import {
  filterReservedKeys,
  RESERVED_EDGE_KEYS,
  RESERVED_NODE_KEYS,
} from "./reserved-keys";
import {
  type Edge,
  type EdgeHistoryEntry,
  type EdgeMeta,
  type Node,
  type NodeHistoryEntry,
  type NodeMeta,
} from "./types";

/**
 * Raw node row from database (without graph_id).
 * Derived from BackendNodeRow so BackendNodeRow is assignable without casts.
 */
export type NodeRow = Omit<BackendNodeRow, "graph_id">;

/**
 * Raw edge row from database (without graph_id).
 * Derived from BackendEdgeRow so BackendEdgeRow is assignable without casts.
 */
export type EdgeRow = Omit<BackendEdgeRow, "graph_id">;

/**
 * Converts null to undefined for consistent typing.
 * Database backends return null for missing values, but our types use undefined.
 */
function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Transforms a database row into a typed Node object.
 *
 * Props are spread at top level, metadata goes under `meta`.
 * Reserved keys (id, kind, meta) in props are filtered out to prevent collisions.
 * Null values from database are normalized to undefined.
 */
export function rowToNode(row: NodeRow): Node {
  const rawProps = JSON.parse(row.props) as Record<string, unknown>;
  const props = filterReservedKeys(rawProps, RESERVED_NODE_KEYS);
  return {
    kind: row.kind,
    id: row.id as Node["id"],
    meta: rowToNodeMeta(row),
    ...props,
  };
}

export function rowToNodeMeta(
  row: Pick<
    NodeRow,
    | "version"
    | "valid_from"
    | "valid_to"
    | "created_at"
    | "updated_at"
    | "deleted_at"
  >,
): NodeMeta {
  return {
    version: row.version,
    validFrom: nullToUndefined(row.valid_from),
    validTo: nullToUndefined(row.valid_to),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: nullToUndefined(row.deleted_at),
  };
}

/**
 * Transforms a database row into a typed Edge object.
 *
 * Props are spread at top level, metadata goes under `meta`.
 * Reserved keys in props are filtered out to prevent collisions.
 * Null values from database are normalized to undefined.
 */
export function rowToEdge(row: EdgeRow): Edge {
  const rawProps = JSON.parse(row.props) as Record<string, unknown>;
  const props = filterReservedKeys(rawProps, RESERVED_EDGE_KEYS);
  return {
    id: row.id,
    kind: row.kind,
    fromKind: row.from_kind,
    fromId: row.from_id,
    toKind: row.to_kind,
    toId: row.to_id,
    meta: rowToEdgeMeta(row),
    ...props,
  } as Edge;
}

export function rowToEdgeMeta(
  row: Pick<
    EdgeRow,
    "valid_from" | "valid_to" | "created_at" | "updated_at" | "deleted_at"
  >,
): EdgeMeta {
  return {
    validFrom: nullToUndefined(row.valid_from),
    validTo: nullToUndefined(row.valid_to),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: nullToUndefined(row.deleted_at),
  };
}

/**
 * Parses the history `meta` JSON string into a record, or `undefined`.
 * The backend normalizes the column to a JSON string (or undefined) before
 * it reaches here.
 */
function parseHistoryMeta(
  meta: string | undefined,
): Record<string, unknown> | undefined {
  if (meta === undefined) return undefined;
  return JSON.parse(meta) as Record<string, unknown>;
}

/**
 * Transforms a backend node-history row into a typed {@link NodeHistoryEntry}.
 * The pre-image columns hydrate `image` via {@link rowToNode}; the interval
 * and audit columns become the entry's metadata.
 */
export function rowToNodeHistoryEntry(row: NodeHistoryRow): NodeHistoryEntry {
  return {
    image: rowToNode(row),
    recordedFrom: row.recorded_from,
    recordedTo: row.recorded_to,
    op: row.op,
    schemaVersion: row.schema_version,
    txId: row.tx_id,
    meta: parseHistoryMeta(row.meta),
  };
}

/**
 * Transforms a backend edge-history row into a typed {@link EdgeHistoryEntry}.
 */
export function rowToEdgeHistoryEntry(row: EdgeHistoryRow): EdgeHistoryEntry {
  return {
    image: rowToEdge(row),
    recordedFrom: row.recorded_from,
    recordedTo: row.recorded_to,
    op: row.op,
    schemaVersion: row.schema_version,
    txId: row.tx_id,
    meta: parseHistoryMeta(row.meta),
  };
}
