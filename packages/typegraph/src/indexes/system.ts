/**
 * System-index declarations — the single source of truth for the plain
 * btree indexes TypeGraph ships on its own relations.
 *
 * Both dialect schema factories (`createSqliteTables` /
 * `createPostgresTables`) derive their Drizzle index builders from this
 * list, so the two dialects cannot drift, and
 * `materializeSystemIndexes()` derives the same indexes as runtime DDL so
 * an index added in a new library version reaches already-initialized
 * databases (bootstrap DDL only runs on first boot — see
 * `loadActiveSchemaWithBootstrap`).
 *
 * Scope: non-unique btree column indexes on the four graph relations,
 * where performance iteration actually happens. Primary keys, unique /
 * partial-unique constraints, and status-table indexes are structural —
 * they are created with their table and never retrofitted — and stay in
 * the schema files.
 *
 * Changing a declaration's shape under the same suffix is a signature
 * drift: `materializeSystemIndexes` reports `failed` for it until the
 * operator drops the old physical index. Rename (new suffix) instead,
 * exactly like graph-declared indexes.
 */

/** The TypeGraph relations that carry system indexes. */
export type SystemIndexTable =
  "nodes" | "edges" | "recordedNodes" | "recordedEdges";

type LiveColumn =
  | "graph_id"
  | "kind"
  | "id"
  | "deleted_at"
  | "valid_from"
  | "valid_to"
  | "created_at";

type LiveEdgeColumn =
  LiveColumn | "from_kind" | "from_id" | "to_kind" | "to_id";

type RecordedColumn =
  | "graph_id"
  | "kind"
  | "id"
  | "valid_from"
  | "valid_to"
  | "recorded_from"
  | "recorded_to";

type RecordedEdgeColumn =
  RecordedColumn | "from_kind" | "from_id" | "to_kind" | "to_id";

type SystemIndexColumnsFor<T extends SystemIndexTable> =
  T extends "nodes" ? LiveColumn
  : T extends "edges" ? LiveEdgeColumn
  : T extends "recordedNodes" ? RecordedColumn
  : RecordedEdgeColumn;

type SystemIndexDeclarationFor<T extends SystemIndexTable> = Readonly<{
  table: T;
  /** Physical index name is `${physicalTableName}_${suffix}`. */
  suffix: string;
  columns: readonly [SystemIndexColumnsFor<T>, ...SystemIndexColumnsFor<T>[]];
}>;

export type SystemIndexDeclaration =
  | SystemIndexDeclarationFor<"nodes">
  | SystemIndexDeclarationFor<"edges">
  | SystemIndexDeclarationFor<"recordedNodes">
  | SystemIndexDeclarationFor<"recordedEdges">;

export const SYSTEM_INDEX_DECLARATIONS: readonly SystemIndexDeclaration[] = [
  // ---------------------------------------------------------- nodes
  { table: "nodes", suffix: "kind_idx", columns: ["graph_id", "kind"] },
  // Listing shape: kind partition ordered by creation with the
  // soft-delete column ahead of it so `deleted_at IS NULL` list queries
  // stay index-served.
  {
    table: "nodes",
    suffix: "kind_created_idx",
    columns: ["graph_id", "kind", "deleted_at", "created_at"],
  },
  {
    table: "nodes",
    suffix: "deleted_idx",
    columns: ["graph_id", "deleted_at"],
  },
  {
    table: "nodes",
    suffix: "valid_idx",
    columns: ["graph_id", "valid_from", "valid_to"],
  },
  // Bare-id lookup: the primary key leads with `kind` (graph_id, kind,
  // id), so a `WHERE graph_id = ? AND id = ?` probe that doesn't know the
  // kind can't seek it — SQLite falls back to a graph_id-only scan of
  // every node in the graph (~3M at LDBC SF1).
  // `store.algorithms.degree`'s node-kind subquery does exactly that
  // lookup (it resolves the seed's kind by id), so without this index
  // degree is a full nodes scan (~95ms at SF1). See typegraph#280.
  { table: "nodes", suffix: "id_idx", columns: ["graph_id", "id"] },

  // ---------------------------------------------------------- edges
  { table: "edges", suffix: "kind_idx", columns: ["graph_id", "kind"] },
  // Directional traversal index (outgoing): supports endpoint lookups
  // and extra filtering by edge kind / target kind. Includes every
  // system column the compiled query's soft-delete/temporal-validity
  // predicate touches (deleted_at, valid_from, valid_to), trailed by
  // to_id — the compiled traversal join reads `n.id = e.to_id` for an
  // outgoing traversal (standard-builders.ts), so without to_id here
  // the join still fetches the edge's heap row for that one column
  // even with the seek/predicate columns covered.
  {
    table: "edges",
    suffix: "from_idx",
    columns: [
      "graph_id",
      "from_kind",
      "from_id",
      "kind",
      "to_kind",
      "deleted_at",
      "valid_from",
      "valid_to",
      "to_id",
    ],
  },
  // Directional traversal index (incoming): mirrors from_idx for
  // reverse traversals, trailed by from_id for the same reason
  // (`n.id = e.from_id` for an incoming traversal).
  {
    table: "edges",
    suffix: "to_idx",
    columns: [
      "graph_id",
      "to_kind",
      "to_id",
      "kind",
      "from_kind",
      "deleted_at",
      "valid_from",
      "valid_to",
      "from_id",
    ],
  },
  {
    table: "edges",
    suffix: "kind_created_idx",
    columns: ["graph_id", "kind", "deleted_at", "created_at"],
  },
  {
    table: "edges",
    suffix: "deleted_idx",
    columns: ["graph_id", "deleted_at"],
  },
  {
    table: "edges",
    suffix: "valid_idx",
    columns: ["graph_id", "valid_from", "valid_to"],
  },
  // Cardinality enforcement: the one-per-endpoint check probes for a
  // currently-valid edge of a kind from a specific endpoint.
  {
    table: "edges",
    suffix: "cardinality_idx",
    columns: ["graph_id", "kind", "from_kind", "from_id", "valid_to"],
  },

  // ---------------------------------------------------------- recordedNodes
  {
    table: "recordedNodes",
    suffix: "entity_idx",
    columns: ["graph_id", "kind", "id", "recorded_from", "recorded_to"],
  },
  {
    table: "recordedNodes",
    suffix: "open_idx",
    columns: ["graph_id", "recorded_to"],
  },
  {
    table: "recordedNodes",
    suffix: "valid_idx",
    columns: ["graph_id", "valid_from", "valid_to"],
  },
  // Bare-id lookup parity with the live nodes table: recorded-pinned
  // reads swap this relation in as the node source, and `entity_idx`
  // leads with `kind`, so the same kind-by-bare-id probe (e.g.
  // `degree()` at a recorded coordinate) would otherwise scan every
  // historical version in the graph. See typegraph#280.
  { table: "recordedNodes", suffix: "id_idx", columns: ["graph_id", "id"] },

  // ---------------------------------------------------------- recordedEdges
  {
    table: "recordedEdges",
    suffix: "entity_idx",
    columns: ["graph_id", "kind", "id", "recorded_from", "recorded_to"],
  },
  {
    table: "recordedEdges",
    suffix: "open_idx",
    columns: ["graph_id", "recorded_to"],
  },
  {
    table: "recordedEdges",
    suffix: "from_idx",
    columns: [
      "graph_id",
      "from_kind",
      "from_id",
      "kind",
      "to_kind",
      "recorded_from",
      "recorded_to",
    ],
  },
  {
    table: "recordedEdges",
    suffix: "to_idx",
    columns: [
      "graph_id",
      "to_kind",
      "to_id",
      "kind",
      "from_kind",
      "recorded_from",
      "recorded_to",
    ],
  },
  {
    table: "recordedEdges",
    suffix: "valid_idx",
    columns: ["graph_id", "valid_from", "valid_to"],
  },
];

/** Default physical table names for the system-index relations. */
const DEFAULT_SYSTEM_INDEX_TABLE_NAMES: Readonly<
  Record<SystemIndexTable, string>
> = {
  nodes: "typegraph_nodes",
  edges: "typegraph_edges",
  recordedNodes: "typegraph_recorded_nodes",
  recordedEdges: "typegraph_recorded_edges",
};

/**
 * Resolves the physical table name for a system-index relation, honoring
 * a backend's table-name overrides.
 */
export function resolveSystemIndexTableName(
  table: SystemIndexTable,
  overrides:
    Readonly<Partial<Record<SystemIndexTable, string | undefined>>> | undefined,
): string {
  return overrides?.[table] ?? DEFAULT_SYSTEM_INDEX_TABLE_NAMES[table];
}

/** Physical index name: `${physicalTableName}_${suffix}`. */
export function systemIndexName(
  physicalTableName: string,
  suffix: string,
): string {
  return `${physicalTableName}_${suffix}`;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Runtime DDL for one system index — byte-compatible with the index the
 * bootstrap path creates from the Drizzle schema (same name, same
 * columns), plus `CONCURRENTLY` where the dialect supports building
 * without blocking writes.
 */
export function generateSystemIndexDDL(
  declaration: SystemIndexDeclaration,
  physicalTableName: string,
  options: Readonly<{ concurrent: boolean }>,
): string {
  const name = quoteIdentifier(
    systemIndexName(physicalTableName, declaration.suffix),
  );
  const table = quoteIdentifier(physicalTableName);
  const columns = declaration.columns
    .map((column) => quoteIdentifier(column))
    .join(", ");
  const concurrently = options.concurrent ? "CONCURRENTLY " : "";
  return `CREATE INDEX ${concurrently}IF NOT EXISTS ${name} ON ${table} (${columns});`;
}
