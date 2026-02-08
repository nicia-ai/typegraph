/**
 * Result mapping utilities for query execution.
 *
 * Transforms raw database rows into typed SelectContext and result objects.
 */
import { type NodeType } from "../../core/types";
import { parseSqlitePath } from "../../utils";
import { type Traversal } from "../ast";
import type {
  AliasMap,
  EdgeAliasMap,
  QueryBuilderState,
  SelectableEdge,
  SelectableNode,
  SelectContext,
} from "../builder/types";
import { type SqlDialect } from "../compiler/index";

/**
 * Transforms SQLite path columns from pipe-delimited strings to arrays.
 * PostgreSQL returns native arrays, so no transformation needed.
 */
export function transformPathColumns(
  rows: readonly Record<string, unknown>[],
  state: QueryBuilderState,
  dialect: SqlDialect,
): readonly Record<string, unknown>[] {
  if (dialect !== "sqlite") return rows;

  // Find path columns from variable-length traversals
  const pathAliases: string[] = [];
  for (const t of state.traversals) {
    if (t.variableLength?.collectPath) {
      pathAliases.push(t.variableLength.pathAlias ?? `${t.nodeAlias}_path`);
    }
  }

  if (pathAliases.length === 0) return rows;

  return rows.map((row) => {
    let transformed: Record<string, unknown> | undefined;
    for (const alias of pathAliases) {
      const value = row[alias];
      if (typeof value === "string") {
        transformed ??= { ...row };
        transformed[alias] = parseSqlitePath(value);
      }
    }
    return transformed ?? row;
  });
}

// Reserved keys that cannot be overwritten by user props
const RESERVED_NODE_KEYS = new Set(["id", "kind", "meta"]);
const RESERVED_EDGE_KEYS = new Set(["id", "kind", "fromId", "toId", "meta"]);

/**
 * Converts null to undefined for consistent typing.
 * Database backends return null for missing values, but our types use undefined.
 */
function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Assigns props to a target object, excluding reserved keys to prevent runtime
 * collisions with system fields (id, kind, meta, etc).
 */
function assignPropsExcludingReserved(
  target: Record<string, unknown>,
  props: Record<string, unknown>,
  reservedKeys: Set<string>,
): void {
  for (const [key, value] of Object.entries(props)) {
    if (!reservedKeys.has(key)) {
      target[key] = value;
    }
  }
}

/**
 * Builds a SelectableNode from row data for a given alias.
 *
 * Props are spread at top level, metadata goes under `meta`.
 * Reserved keys (id, kind, meta) in props are filtered out to prevent collisions.
 * Null values from database are normalized to undefined.
 */
export function buildSelectableNode(
  row: Record<string, unknown>,
  alias: string,
): SelectableNode<NodeType> {
  const id = row[`${alias}_id`] as string;
  const kind = row[`${alias}_kind`] as string;
  const propsRaw: unknown = row[`${alias}_props`];
  const rawProps: Record<string, unknown> =
    typeof propsRaw === "string" ?
      (JSON.parse(propsRaw) as Record<string, unknown>)
    : ((propsRaw as Record<string, unknown> | undefined) ?? {});

  // Metadata columns - these are now always projected in CTEs
  // Normalize null → undefined for optional fields
  const version = row[`${alias}_version`] as number;
  const validFrom = nullToUndefined(
    row[`${alias}_valid_from`] as string | null,
  );
  const validTo = nullToUndefined(row[`${alias}_valid_to`] as string | null);
  const createdAt = row[`${alias}_created_at`] as string;
  const updatedAt = row[`${alias}_updated_at`] as string;
  const deletedAt = nullToUndefined(
    row[`${alias}_deleted_at`] as string | null,
  );

  const result: Record<string, unknown> = {
    id,
    kind,
    meta: {
      version,
      validFrom,
      validTo,
      createdAt,
      updatedAt,
      deletedAt,
    },
  };

  assignPropsExcludingReserved(result, rawProps, RESERVED_NODE_KEYS);
  return result as SelectableNode<NodeType>;
}

/**
 * Builds a SelectableNode from row data, returning undefined when the node
 * doesn't exist (for optional traversals with LEFT JOIN).
 */
function buildSelectableNodeOrUndefined(
  row: Record<string, unknown>,
  alias: string,
): SelectableNode<NodeType> | undefined {
  const id = row[`${alias}_id`] as string | null | undefined;
  if (id === null || id === undefined) {
    return undefined;
  }
  return buildSelectableNode(row, alias);
}

/**
 * Builds a SelectableEdge from row data for a given edge alias.
 *
 * Props are spread at top level, metadata goes under `meta`.
 * Reserved keys (id, kind, fromId, toId, meta) in props are filtered out to prevent collisions.
 * Null values from database are normalized to undefined.
 * Returns undefined if the edge doesn't exist (for optional traversals with LEFT JOIN).
 */
function buildSelectableEdge(
  row: Record<string, unknown>,
  alias: string,
): SelectableEdge | undefined {
  const id = row[`${alias}_id`] as string | null | undefined;

  // For optional traversals, edge may be null (LEFT JOIN)
  if (id === null || id === undefined) {
    return undefined;
  }

  const kind = row[`${alias}_kind`] as string;
  const fromId = row[`${alias}_from_id`] as string;
  const toId = row[`${alias}_to_id`] as string;

  const propsRaw: unknown = row[`${alias}_props`];
  const rawProps: Record<string, unknown> =
    typeof propsRaw === "string" ?
      (JSON.parse(propsRaw) as Record<string, unknown>)
    : ((propsRaw as Record<string, unknown> | undefined) ?? {});

  // Metadata columns - these are always projected in traversal CTEs
  // Normalize null → undefined for optional fields
  const validFrom = nullToUndefined(
    row[`${alias}_valid_from`] as string | null,
  );
  const validTo = nullToUndefined(row[`${alias}_valid_to`] as string | null);
  const createdAt = row[`${alias}_created_at`] as string;
  const updatedAt = row[`${alias}_updated_at`] as string;
  const deletedAt = nullToUndefined(
    row[`${alias}_deleted_at`] as string | null,
  );

  const result: Record<string, unknown> = {
    id,
    kind,
    fromId,
    toId,
    meta: {
      validFrom,
      validTo,
      createdAt,
      updatedAt,
      deletedAt,
    },
  };

  assignPropsExcludingReserved(result, rawProps, RESERVED_EDGE_KEYS);
  return result as SelectableEdge;
}

/**
 * Builds a SelectContext from a raw database row.
 * Includes both node aliases and edge aliases.
 */
export function buildSelectContext<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
>(
  row: Record<string, unknown>,
  startAlias: string,
  traversals: readonly Traversal[],
): SelectContext<Aliases, EdgeAliases> {
  // Build the start node as initial context entry
  const context: Record<
    string,
    SelectableNode<NodeType> | SelectableEdge | undefined
  > = {
    [startAlias]: buildSelectableNode(row, startAlias),
  };

  // Build traversal nodes and edges
  for (const traversal of traversals) {
    const nodeAlias = traversal.nodeAlias;
    const edgeAlias = traversal.edgeAlias;

    // Add node
    context[nodeAlias] =
      traversal.optional ?
        buildSelectableNodeOrUndefined(row, nodeAlias)
      : buildSelectableNode(row, nodeAlias);

    // Add edge (may be undefined for optional traversals)
    context[edgeAlias] = buildSelectableEdge(row, edgeAlias);
  }

  return context as SelectContext<Aliases, EdgeAliases>;
}

/**
 * Maps raw database rows to typed results using a select function.
 */
export function mapResults<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
  R,
>(
  rows: readonly Record<string, unknown>[],
  startAlias: string,
  traversals: readonly Traversal[],
  selectFunction: (context: SelectContext<Aliases, EdgeAliases>) => R,
): readonly R[] {
  return rows.map((row) => {
    const context = buildSelectContext<Aliases, EdgeAliases>(
      row,
      startAlias,
      traversals,
    );
    return selectFunction(context);
  });
}
