/**
 * Row Mappers for Store
 *
 * Transforms database rows into typed Node and Edge objects.
 */
import {
  type EdgeRow as BackendEdgeRow,
  type NodeRow as BackendNodeRow,
} from "../backend/types";
import {
  filterReservedKeys,
  RESERVED_EDGE_KEYS,
  RESERVED_NODE_KEYS,
} from "./reserved-keys";
import { type Edge, type EdgeMeta, type Node, type NodeMeta } from "./types";

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
