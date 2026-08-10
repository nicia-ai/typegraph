/**
 * Result mapping utilities for query execution.
 *
 * Transforms raw database rows into typed SelectContext and result objects.
 */
import {
  normalizeRequiredRowTimestamp,
  normalizeRowTimestamp,
} from "../../backend/row-mappers";
import { type NodeType } from "../../core/types";
import { normalizePath } from "../../utils";
import { createDataKeyedBag } from "../../utils/object";
import { stripIdentityPathTokens } from "../../utils/path";
import { type Traversal } from "../ast";
import type {
  AliasMap,
  EdgeAliasMap,
  QueryBuilderState,
  RecursiveAliasMap,
  SelectableEdge,
  SelectableNode,
  SelectContext,
} from "../builder/types";
import { type SqlDialect } from "../dialect/types";

/**
 * A variable-length traversal's path column, plus whether its tokens carry the
 * identity-expansion `kind || SEP || id` wrapper the compiler emits for cycle
 * detection.
 */
type PathColumn = Readonly<{
  alias: string;
  identityExpanded: boolean;
}>;

function collectPathColumns(state: QueryBuilderState): readonly PathColumn[] {
  const columns: PathColumn[] = [];
  for (const traversal of state.traversals) {
    const pathAlias = traversal.variableLength?.pathAlias;
    if (pathAlias !== undefined) {
      columns.push({
        alias: pathAlias,
        identityExpanded: traversal.includeIdentityMembers === true,
      });
    }
  }
  return columns;
}

/**
 * Materializes path columns into the array of bare node IDs the public
 * traversal contract promises.
 *
 * SQLite returns pipe-delimited strings and PostgreSQL native arrays, so the
 * shape is normalized here. Identity-expanded traversals additionally carry
 * composite `kind || SEP || id` tokens (the compiler needs them so folded peers
 * stay distinct for cycle detection); those are stripped here so identity and
 * non-identity traversals produce identical path output on both dialects.
 *
 * This is the single seam where paths become caller-visible arrays — every
 * execution path (execute, prepared, paginated, selective) funnels through it,
 * so stripping exactly once here is safe.
 */
export function transformPathColumns(
  rows: readonly Record<string, unknown>[],
  state: QueryBuilderState,
  _dialect: SqlDialect,
): readonly Record<string, unknown>[] {
  const pathColumns = collectPathColumns(state);
  if (pathColumns.length === 0) return rows;

  const result: Record<string, unknown>[] = [];
  let changed = false;
  for (const row of rows) {
    let transformed: Record<string, unknown> | undefined;
    for (const { alias, identityExpanded } of pathColumns) {
      const value = row[alias];
      if (value === undefined) continue;
      const normalized = normalizePath(value);
      const path =
        identityExpanded ? stripIdentityPathTokens(normalized) : normalized;
      // normalizePath returns native arrays by reference, so an already-shaped
      // path that needs no stripping leaves the row untouched.
      if (path === value) continue;
      transformed ??= { ...row };
      transformed[alias] = path;
    }
    if (transformed === undefined) {
      result.push(row);
    } else {
      changed = true;
      result.push(transformed);
    }
  }
  // Preserve reference identity when no rows were transformed
  return changed ? result : rows;
}

// Reserved keys that cannot be overwritten by user props
const RESERVED_NODE_KEYS: ReadonlySet<string> = new Set(["id", "kind", "meta"]);
const RESERVED_EDGE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "fromId",
  "toId",
  "meta",
]);

/**
 * The props to spread onto a selectable node/edge, with reserved keys dropped
 * so user props cannot collide with system fields (id, kind, meta, …).
 *
 * The accumulator is a {@link createDataKeyedBag} and the caller SPREADS the
 * result rather than assigning key-by-key onto the public object: `props` comes
 * straight off `JSON.parse` of the row's props column, which yields `__proto__`
 * as an ordinary own key, and `target[key] = value` would hand that key to
 * `Object.prototype`'s setter and drop the value. Spreading (a
 * `CreateDataProperty`, not a `Set`) carries it as an own key while leaving the
 * public result on `Object.prototype`, exactly as `rowToNode` already does.
 */
function propsExcludingReserved(
  props: Record<string, unknown>,
  reservedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const kept = createDataKeyedBag<unknown>();
  for (const [key, value] of Object.entries(props)) {
    if (!reservedKeys.has(key)) {
      kept[key] = value;
    }
  }
  return kept;
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
  const validFrom = normalizeRowTimestamp(
    row[`${alias}_valid_from`],
    `${alias}_valid_from`,
  );
  const validTo = normalizeRowTimestamp(
    row[`${alias}_valid_to`],
    `${alias}_valid_to`,
  );
  const createdAt = normalizeRequiredRowTimestamp(
    row[`${alias}_created_at`],
    `${alias}_created_at`,
  );
  const updatedAt = normalizeRequiredRowTimestamp(
    row[`${alias}_updated_at`],
    `${alias}_updated_at`,
  );
  const deletedAt = normalizeRowTimestamp(
    row[`${alias}_deleted_at`],
    `${alias}_deleted_at`,
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
    ...propsExcludingReserved(rawProps, RESERVED_NODE_KEYS),
  };

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
  const validFrom = normalizeRowTimestamp(
    row[`${alias}_valid_from`],
    `${alias}_valid_from`,
  );
  const validTo = normalizeRowTimestamp(
    row[`${alias}_valid_to`],
    `${alias}_valid_to`,
  );
  const createdAt = normalizeRequiredRowTimestamp(
    row[`${alias}_created_at`],
    `${alias}_created_at`,
  );
  const updatedAt = normalizeRequiredRowTimestamp(
    row[`${alias}_updated_at`],
    `${alias}_updated_at`,
  );
  const deletedAt = normalizeRowTimestamp(
    row[`${alias}_deleted_at`],
    `${alias}_deleted_at`,
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
    ...propsExcludingReserved(rawProps, RESERVED_EDGE_KEYS),
  };

  return result as SelectableEdge;
}

/**
 * Builds a SelectContext from a raw database row.
 * Includes node aliases, edge aliases, and recursive metadata (depth/path).
 */
export function buildSelectContext<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty when no recursive aliases
  RecursiveAliases extends RecursiveAliasMap = {},
>(
  row: Record<string, unknown>,
  startAlias: string,
  traversals: readonly Traversal[],
): SelectContext<Aliases, EdgeAliases, RecursiveAliases> {
  // Data-keyed: alias names chosen by the caller's query, which the kind-name
  // pattern admits `__proto__` for. (The computed-key literal this replaced was
  // itself safe — a computed key is a `CreateDataProperty` — but the traversal
  // assignments below are not, so the whole bag is built the one right way.)
  const context = createDataKeyedBag<
    | SelectableNode<NodeType>
    | SelectableEdge
    | number
    | readonly string[]
    | undefined
  >();
  // Build the start node as initial context entry
  context[startAlias] = buildSelectableNode(row, startAlias);

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

    // Add recursive depth/path values
    const vl = traversal.variableLength;
    if (vl !== undefined) {
      if (vl.depthAlias !== undefined) {
        context[vl.depthAlias] = row[vl.depthAlias] as number;
      }
      if (vl.pathAlias !== undefined) {
        context[vl.pathAlias] = row[vl.pathAlias] as readonly string[];
      }
    }
  }

  // Spread at the boundary: the context is handed to the CALLER's `select`
  // callback, and `select((ctx) => ctx)` returns it verbatim as the row. See
  // `createDataKeyedBag` in ../../utils/object.ts — the spread is what keeps a
  // `__proto__` alias an own key instead of reaching the prototype setter.
  return { ...context } as SelectContext<
    Aliases,
    EdgeAliases,
    RecursiveAliases
  >;
}

/**
 * Maps raw database rows to typed results using a select function.
 */
export function mapResults<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
  R,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty when no recursive aliases
  RA extends RecursiveAliasMap = {},
>(
  rows: readonly Record<string, unknown>[],
  startAlias: string,
  traversals: readonly Traversal[],
  selectFunction: (context: SelectContext<Aliases, EdgeAliases, RA>) => R,
): readonly R[] {
  return rows.map((row) => {
    const context = buildSelectContext<Aliases, EdgeAliases, RA>(
      row,
      startAlias,
      traversals,
    );
    return selectFunction(context);
  });
}
