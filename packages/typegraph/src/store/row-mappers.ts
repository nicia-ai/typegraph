/**
 * Row Mappers for Store
 *
 * Transforms database rows into typed Node and Edge objects.
 */
import { type Edge, type Node } from "./types";

/**
 * Raw node row from database.
 */
export type NodeRow = Readonly<{
  kind: string;
  id: string;
  props: string;
  version: number;
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

/**
 * Raw edge row from database.
 */
export type EdgeRow = Readonly<{
  id: string;
  kind: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  props: string;
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

// Reserved keys that cannot be overwritten by user props
const RESERVED_NODE_KEYS = new Set(["id", "kind", "meta"]);

/**
 * Converts null to undefined for consistent typing.
 * Database backends return null for missing values, but our types use undefined.
 */
function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Filters out reserved keys from props to prevent runtime collisions.
 */
function filterReservedKeys(
  props: Record<string, unknown>,
  reservedKeys: Set<string>,
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!reservedKeys.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
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
    meta: {
      version: row.version,
      validFrom: nullToUndefined(row.valid_from),
      validTo: nullToUndefined(row.valid_to),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: nullToUndefined(row.deleted_at),
    },
    ...props,
  } as Node;
}

// Reserved keys that cannot be overwritten by user props on edges
const RESERVED_EDGE_KEYS = new Set([
  "id",
  "kind",
  "meta",
  "fromKind",
  "fromId",
  "toKind",
  "toId",
]);

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
    meta: {
      validFrom: nullToUndefined(row.valid_from),
      validTo: nullToUndefined(row.valid_to),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: nullToUndefined(row.deleted_at),
    },
    ...props,
  } as Edge;
}
