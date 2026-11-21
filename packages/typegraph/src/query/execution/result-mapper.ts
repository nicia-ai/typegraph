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
import { ConfigurationError } from "../../errors";
import { normalizePath } from "../../utils";
import { createDataKeyedBag } from "../../utils/object";
import { stripKindQualifiedPathTokens } from "../../utils/path";
import { requireDefined } from "../../utils/presence";
import { type Traversal } from "../ast";
import type {
  AliasMap,
  EdgeAliasMap,
  QualifiedRecursivePath,
  QueryBuilderState,
  RecursiveAliasMap,
  SelectableEdge,
  SelectableNode,
  SelectContext,
} from "../builder/types";
import { recursivePathTokenShape } from "../compiler/recursive-path-token";
import { type SqlDialect } from "../dialect/types";
import {
  aliasColumnName,
  type GeneratedColumns,
  resultColumnName,
} from "../generated-identifier";

/**
 * A variable-length traversal's path column, plus whether its tokens carry the
 * `kind || SEP || id` wrapper the compiler emits for cycle detection.
 */
type PathColumn = Readonly<{
  /** The row key the path is read and written under. */
  alias: string;
  kindQualified: boolean;
  format: "ids" | "qualified";
  optional: boolean;
}>;

function collectPathColumns(
  state: QueryBuilderState,
  columns: GeneratedColumns,
): readonly PathColumn[] {
  const scope = {
    start: { alias: state.startAlias, kinds: state.startKinds },
    traversals: state.traversals,
  };
  const pathColumns: PathColumn[] = [];
  for (const traversal of state.traversals) {
    const pathAlias = traversal.variableLength?.pathAlias;
    const pathColumn =
      pathAlias === undefined ? undefined : (
        columns.columnOf(resultColumnName(pathAlias))
      );
    if (pathColumn !== undefined) {
      pathColumns.push({
        alias: pathColumn,
        kindQualified:
          recursivePathTokenShape(scope, traversal) === "kind_qualified",
        format:
          traversal.variableLength?.pathFormat === "qualified" ?
            "qualified"
          : "ids",
        optional: traversal.optional,
      });
    }
  }
  return pathColumns;
}

/**
 * Materializes path columns into the array of bare node IDs the public
 * traversal contract promises.
 *
 * SQLite returns pipe-delimited strings and PostgreSQL native arrays, so the
 * shape is normalized here. A walk that can visit more than one kind carries
 * composite `kind || SEP || id` tokens (the compiler needs them so same-id
 * nodes of different kinds stay distinct for cycle detection); those are
 * stripped here so every walk produces bare-id path output on both dialects.
 *
 * This is the single seam where paths become caller-visible arrays — every
 * execution path (execute, prepared, paginated, selective) funnels through it,
 * so stripping exactly once here is safe.
 */
export function transformPathColumns(
  rows: readonly Record<string, unknown>[],
  state: QueryBuilderState,
  _dialect: SqlDialect,
  columns: GeneratedColumns,
): readonly Record<string, unknown>[] {
  const pathColumns = collectPathColumns(state, columns);
  if (pathColumns.length === 0) return rows;

  const result: Record<string, unknown>[] = [];
  let changed = false;
  for (const row of rows) {
    let transformed: Record<string, unknown> | undefined;
    for (const { alias, format, kindQualified, optional } of pathColumns) {
      const value = row[alias];
      if (value === undefined) continue;
      if (optional && value === null) {
        transformed ??= { ...row };
        transformed[alias] = undefined;
        continue;
      }
      if (format === "qualified") {
        const path = decodeQualifiedRecursivePath(value, alias);
        transformed ??= { ...row };
        transformed[alias] = path;
        continue;
      }
      const normalized = normalizePath(value);
      const path =
        kindQualified ? stripKindQualifiedPathTokens(normalized) : normalized;
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

function decodeQualifiedRecursivePath(
  value: unknown,
  alias: string,
): QualifiedRecursivePath {
  const parsed: unknown =
    typeof value === "string" ? parseQualifiedPathJson(value, alias) : value;
  if (
    !Array.isArray(parsed) ||
    parsed.length < 2 ||
    (parsed.length - 2) % 5 !== 0
  )
    throw new ConfigurationError(
      `Invalid qualified recursive path in column "${alias}"`,
    );
  if (!parsed.every((entry) => typeof entry === "string"))
    throw new ConfigurationError(
      `Invalid qualified recursive path in column "${alias}"`,
    );
  const tokens = parsed as readonly string[];
  const path: QualifiedRecursivePath[number][] = [
    {
      type: "node",
      kind: requireDefined(tokens[0]),
      id: requireDefined(tokens[1]),
    },
  ];
  for (let index = 2; index < tokens.length; index += 5) {
    const direction = tokens[index + 2];
    if (direction !== "out" && direction !== "in")
      throw new ConfigurationError(
        `Invalid qualified recursive path direction in column "${alias}"`,
      );
    path.push(
      {
        type: "edge",
        kind: requireDefined(tokens[index]),
        id: requireDefined(tokens[index + 1]),
        direction,
      },
      {
        type: "node",
        kind: requireDefined(tokens[index + 3]),
        id: requireDefined(tokens[index + 4]),
      },
    );
  }
  return path;
}

function parseQualifiedPathJson(value: string, alias: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ConfigurationError(
      `Invalid qualified recursive path JSON in column "${alias}"`,
      { alias },
      {
        cause: error,
      },
    );
  }
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

/** The row keys one statement returns a node or edge alias's columns under. */
type AliasColumnKeys = Readonly<{
  id: string | undefined;
  kind: string | undefined;
  props: string | undefined;
  version: string | undefined;
  validFrom: string | undefined;
  validTo: string | undefined;
  createdAt: string | undefined;
  updatedAt: string | undefined;
  deletedAt: string | undefined;
  fromId: string | undefined;
  toId: string | undefined;
}>;

/**
 * Resolves an alias's columns once, so decoding a row reads each by the
 * physical name its statement allocated to the (alias, column) pair.
 */
function aliasColumnKeys(
  alias: string,
  columns: GeneratedColumns,
): AliasColumnKeys {
  const keyOf = (column: string) =>
    columns.columnOf(aliasColumnName(alias, column));
  return {
    id: keyOf("id"),
    kind: keyOf("kind"),
    props: keyOf("props"),
    version: keyOf("version"),
    validFrom: keyOf("valid_from"),
    validTo: keyOf("valid_to"),
    createdAt: keyOf("created_at"),
    updatedAt: keyOf("updated_at"),
    deletedAt: keyOf("deleted_at"),
    fromId: keyOf("from_id"),
    toId: keyOf("to_id"),
  };
}

function readKey(
  row: Readonly<Record<string, unknown>>,
  key: string | undefined,
): unknown {
  return key === undefined ? undefined : row[key];
}

/** A column's name for decoding errors: the alias-derived name it reads as. */
function columnLabel(alias: string, column: string): string {
  return aliasColumnName(alias, column).spelling;
}

function parsedProps(propsRaw: unknown): Record<string, unknown> {
  return typeof propsRaw === "string" ?
      (JSON.parse(propsRaw) as Record<string, unknown>)
    : ((propsRaw as Record<string, unknown> | undefined) ?? {});
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
  columns: GeneratedColumns,
): SelectableNode<NodeType> {
  return selectableNodeFromKeys(row, alias, aliasColumnKeys(alias, columns));
}

function selectableNodeFromKeys(
  row: Record<string, unknown>,
  alias: string,
  keys: AliasColumnKeys,
): SelectableNode<NodeType> {
  const id = readKey(row, keys.id) as string;
  const kind = readKey(row, keys.kind) as string;
  const rawProps = parsedProps(readKey(row, keys.props));

  // Metadata columns - these are now always projected in CTEs
  // Normalize null → undefined for optional fields
  const version = readKey(row, keys.version) as number;
  const validFrom = normalizeRowTimestamp(
    readKey(row, keys.validFrom),
    columnLabel(alias, "valid_from"),
  );
  const validTo = normalizeRowTimestamp(
    readKey(row, keys.validTo),
    columnLabel(alias, "valid_to"),
  );
  const createdAt = normalizeRequiredRowTimestamp(
    readKey(row, keys.createdAt),
    columnLabel(alias, "created_at"),
  );
  const updatedAt = normalizeRequiredRowTimestamp(
    readKey(row, keys.updatedAt),
    columnLabel(alias, "updated_at"),
  );
  const deletedAt = normalizeRowTimestamp(
    readKey(row, keys.deletedAt),
    columnLabel(alias, "deleted_at"),
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
function selectableNodeOrUndefinedFromKeys(
  row: Record<string, unknown>,
  alias: string,
  keys: AliasColumnKeys,
): SelectableNode<NodeType> | undefined {
  const id = readKey(row, keys.id) as string | null | undefined;
  if (id === null || id === undefined) {
    return undefined;
  }
  return selectableNodeFromKeys(row, alias, keys);
}

/**
 * Builds a SelectableEdge from row data for a given edge alias.
 *
 * Props are spread at top level, metadata goes under `meta`.
 * Reserved keys (id, kind, fromId, toId, meta) in props are filtered out to prevent collisions.
 * Null values from database are normalized to undefined.
 * Returns undefined if the edge doesn't exist (for optional traversals with LEFT JOIN).
 */
function selectableEdgeFromKeys(
  row: Record<string, unknown>,
  alias: string,
  keys: AliasColumnKeys,
): SelectableEdge | undefined {
  const id = readKey(row, keys.id) as string | null | undefined;

  // For optional traversals, edge may be null (LEFT JOIN)
  if (id === null || id === undefined) {
    return undefined;
  }

  const kind = readKey(row, keys.kind) as string;
  const fromId = readKey(row, keys.fromId) as string;
  const toId = readKey(row, keys.toId) as string;
  const rawProps = parsedProps(readKey(row, keys.props));

  // Metadata columns - these are always projected in traversal CTEs
  // Normalize null → undefined for optional fields
  const validFrom = normalizeRowTimestamp(
    readKey(row, keys.validFrom),
    columnLabel(alias, "valid_from"),
  );
  const validTo = normalizeRowTimestamp(
    readKey(row, keys.validTo),
    columnLabel(alias, "valid_to"),
  );
  const createdAt = normalizeRequiredRowTimestamp(
    readKey(row, keys.createdAt),
    columnLabel(alias, "created_at"),
  );
  const updatedAt = normalizeRequiredRowTimestamp(
    readKey(row, keys.updatedAt),
    columnLabel(alias, "updated_at"),
  );
  const deletedAt = normalizeRowTimestamp(
    readKey(row, keys.deletedAt),
    columnLabel(alias, "deleted_at"),
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

/** The row keys of every alias and recursive output in a select context. */
type SelectContextKeys = Readonly<{
  start: AliasColumnKeys;
  traversals: readonly Readonly<{
    node: AliasColumnKeys;
    edge: AliasColumnKeys;
    depth: string | undefined;
    path: string | undefined;
  }>[];
}>;

function selectContextKeys(
  startAlias: string,
  traversals: readonly Traversal[],
  columns: GeneratedColumns,
): SelectContextKeys {
  return {
    start: aliasColumnKeys(startAlias, columns),
    traversals: traversals.map((traversal) => {
      const vl = traversal.variableLength;
      return {
        node: aliasColumnKeys(traversal.nodeAlias, columns),
        edge: aliasColumnKeys(traversal.edgeAlias, columns),
        depth:
          vl?.depthAlias === undefined ?
            undefined
          : columns.columnOf(resultColumnName(vl.depthAlias)),
        path:
          vl?.pathAlias === undefined ?
            undefined
          : columns.columnOf(resultColumnName(vl.pathAlias)),
      };
    }),
  };
}

function selectContextFromKeys<
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty when no recursive aliases
  RecursiveAliases extends RecursiveAliasMap = {},
>(
  row: Record<string, unknown>,
  startAlias: string,
  traversals: readonly Traversal[],
  keys: SelectContextKeys,
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
  context[startAlias] = selectableNodeFromKeys(row, startAlias, keys.start);

  // Build traversal nodes and edges
  for (const [index, traversal] of traversals.entries()) {
    const traversalKeys = requireDefined(keys.traversals[index]);
    const nodeAlias = traversal.nodeAlias;
    const edgeAlias = traversal.edgeAlias;

    // Add node
    context[nodeAlias] =
      traversal.optional ?
        selectableNodeOrUndefinedFromKeys(row, nodeAlias, traversalKeys.node)
      : selectableNodeFromKeys(row, nodeAlias, traversalKeys.node);

    // Add edge (may be undefined for optional traversals)
    context[edgeAlias] = selectableEdgeFromKeys(
      row,
      edgeAlias,
      traversalKeys.edge,
    );

    // Add recursive depth/path values
    const vl = traversal.variableLength;
    if (vl !== undefined) {
      if (vl.depthAlias !== undefined) {
        const depth = readKey(row, traversalKeys.depth);
        context[vl.depthAlias] =
          traversal.optional && depth === null ? undefined : (depth as number);
      }
      if (vl.pathAlias !== undefined) {
        const path = readKey(row, traversalKeys.path);
        context[vl.pathAlias] =
          traversal.optional && path === null ?
            undefined
          : (path as readonly string[]);
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
 * Builds a SelectContext from a raw database row.
 * Includes node aliases, edge aliases, and recursive metadata (depth/path).
 * `columns` names the generated columns of the statement the row came from.
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
  columns: GeneratedColumns,
): SelectContext<Aliases, EdgeAliases, RecursiveAliases> {
  return selectContextFromKeys<Aliases, EdgeAliases, RecursiveAliases>(
    row,
    startAlias,
    traversals,
    selectContextKeys(startAlias, traversals, columns),
  );
}

/**
 * Maps raw database rows to typed results using a select function.
 * `columns` names the generated columns of the statement the rows came from.
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
  columns: GeneratedColumns,
): readonly R[] {
  const keys = selectContextKeys(startAlias, traversals, columns);
  return rows.map((row) => {
    const context = selectContextFromKeys<Aliases, EdgeAliases, RA>(
      row,
      startAlias,
      traversals,
      keys,
    );
    return selectFunction(context);
  });
}
