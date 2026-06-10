/**
 * Recorded-time history capture SQL (F1a).
 *
 * Builds the pre-image capture statements, the per-dialect atomic
 * execution unit, the best-effort value-insert fallback, and the read /
 * prune queries against the `typegraph_node_history` /
 * `typegraph_edge_history` side-tables. Per-dialect SQL shape is
 * sanctioned here (this is the backend-core write path, not `src/query`):
 * Postgres composes one data-modifying CTE; SQLite emits the capture and
 * mutation as two statements the core runs inside one transaction.
 */
import { type SQL, sql } from "drizzle-orm";

import { type HistoryOp, type SqlDialect } from "../../types";
import { quotedColumn, sqlNull, type Tables } from "./shared";

/**
 * The currency-interval end plus audit columns stamped on a captured
 * history row. `recordedTo` is T (when the ending version stopped being
 * current); `recordedFrom` is sourced from the pre-image's `updated_at`.
 */
export type HistoryAudit = Readonly<{
  op: HistoryOp;
  recordedTo: string;
  schemaVersion: number;
  txId: string;
  /** Pre-serialized JSON string, or undefined for no meta. */
  meta: string | undefined;
}>;

/**
 * Whether the capture (and its mutation) targets only a live row
 * (`deleted_at IS NULL`). MUST mirror the mutation's own WHERE so the
 * capture writes a history row if and only if the mutation changes a row —
 * otherwise a Postgres data-modifying CTE (or a SQLite two-statement pair)
 * would record a phantom transition for a no-op update of a tombstoned
 * row. `true` for update/delete; `false` for restore/hardDelete.
 */
type CaptureScope = Readonly<{ onlyLive: boolean }>;

export type HistoryStrategy = Readonly<{
  /** INSERT…SELECT pre-image of one node (atomic capture). */
  buildCaptureNode: (
    graphId: string,
    kind: string,
    id: string,
    audit: HistoryAudit,
    scope: CaptureScope,
  ) => SQL;
  /** INSERT…SELECT pre-image of one edge (atomic capture). */
  buildCaptureEdge: (
    graphId: string,
    id: string,
    audit: HistoryAudit,
    scope: CaptureScope,
  ) => SQL;
  /**
   * INSERT…SELECT pre-image of every edge connected to a node, mirroring
   * `buildHardDeleteEdgesByNode` (the hard-delete cascade). Always
   * `onlyLive: false` — hard delete removes tombstoned edges too.
   */
  buildCaptureEdgesByNode: (
    graphId: string,
    nodeKind: string,
    nodeId: string,
    audit: HistoryAudit,
  ) => SQL;
  /**
   * Compose a capture and its mutation into the dialect's atomic
   * execution unit: Postgres → one data-modifying CTE statement; SQLite →
   * `[capture, mutation]` (run by the core inside one transaction). The
   * last statement is always the mutation, so its RETURNING row (if any)
   * is the result.
   */
  combine: (capture: SQL, mutation: SQL) => readonly SQL[];
  /** Best-effort capture: INSERT…VALUES from an application-held pre-image. */
  buildInsertNodeHistoryFromRow: (
    row: NodePreImage,
    audit: HistoryAudit,
  ) => SQL;
  buildInsertEdgeHistoryFromRow: (
    row: EdgePreImage,
    audit: HistoryAudit,
  ) => SQL;
  buildGetNodeHistory: (graphId: string, kind: string, id: string) => SQL;
  buildGetEdgeHistory: (graphId: string, id: string) => SQL;
  buildPruneNodeHistory: (graphId: string, before: string) => SQL;
  buildPruneEdgeHistory: (graphId: string, before: string) => SQL;
}>;

/** The node columns a best-effort capture reads back into the application. */
export type NodePreImage = Readonly<{
  graph_id: string;
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

export type EdgePreImage = Readonly<{
  graph_id: string;
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

function columnList(columns: readonly Readonly<{ name: string }>[]): SQL {
  return sql.raw(
    columns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", "),
  );
}

// The capture's WHERE must mirror the mutation's: `onlyLive` adds the
// `deleted_at IS NULL` guard for update/delete so the capture writes iff
// the mutation changes a row (no phantom on a no-op update of a tombstone).
function liveClause(
  deletedAtColumn: Readonly<{ name: string }>,
  scope: CaptureScope,
): SQL {
  return scope.onlyLive
    ? sql` AND ${quotedColumn(deletedAtColumn)} IS NULL`
    : sql``;
}

export function createHistoryStrategy(
  tables: Tables,
  dialect: SqlDialect,
): HistoryStrategy {
  const { nodes, edges, nodeHistory, edgeHistory } = tables;

  // Pre-image source columns in canonical order — must align positionally
  // with the leading history target columns below.
  const nodePreImageColumns = columnList([
    nodes.graphId,
    nodes.kind,
    nodes.id,
    nodes.props,
    nodes.version,
    nodes.validFrom,
    nodes.validTo,
    nodes.createdAt,
    nodes.updatedAt,
    nodes.deletedAt,
  ]);
  const edgePreImageColumns = columnList([
    edges.graphId,
    edges.id,
    edges.kind,
    edges.fromKind,
    edges.fromId,
    edges.toKind,
    edges.toId,
    edges.props,
    edges.validFrom,
    edges.validTo,
    edges.createdAt,
    edges.updatedAt,
    edges.deletedAt,
  ]);

  // History INSERT target columns (surrogate `history_id` omitted — it
  // autoincrements). Order: pre-image columns, then the audit columns.
  const nodeHistoryTarget = columnList([
    nodeHistory.graphId,
    nodeHistory.kind,
    nodeHistory.id,
    nodeHistory.props,
    nodeHistory.version,
    nodeHistory.validFrom,
    nodeHistory.validTo,
    nodeHistory.createdAt,
    nodeHistory.updatedAt,
    nodeHistory.deletedAt,
    nodeHistory.recordedFrom,
    nodeHistory.recordedTo,
    nodeHistory.op,
    nodeHistory.schemaVersion,
    nodeHistory.txId,
    nodeHistory.meta,
  ]);
  const edgeHistoryTarget = columnList([
    edgeHistory.graphId,
    edgeHistory.id,
    edgeHistory.kind,
    edgeHistory.fromKind,
    edgeHistory.fromId,
    edgeHistory.toKind,
    edgeHistory.toId,
    edgeHistory.props,
    edgeHistory.validFrom,
    edgeHistory.validTo,
    edgeHistory.createdAt,
    edgeHistory.updatedAt,
    edgeHistory.deletedAt,
    edgeHistory.recordedFrom,
    edgeHistory.recordedTo,
    edgeHistory.op,
    edgeHistory.schemaVersion,
    edgeHistory.txId,
    edgeHistory.meta,
  ]);

  function metaValue(meta: string | undefined): SQL {
    if (meta === undefined) return sql`NULL`;
    return dialect === "postgres" ? sql`${meta}::jsonb` : sql`${meta}`;
  }

  function propsValue(props: string): SQL {
    return dialect === "postgres" ? sql`${props}::jsonb` : sql`${props}`;
  }

  // The six trailing SELECT values appended after the pre-image columns:
  // recorded_from is the row's own updated_at; the rest are bound audit
  // values. `updatedAtColumn` is unqualified — safe in a single-table
  // SELECT (the capture's FROM).
  function auditSelect(
    updatedAtColumn: Readonly<{ name: string }>,
    audit: HistoryAudit,
  ): SQL {
    return sql`${quotedColumn(updatedAtColumn)}, ${audit.recordedTo}, ${audit.op}, ${audit.schemaVersion}, ${audit.txId}, ${metaValue(audit.meta)}`;
  }

  return {
    buildCaptureNode(graphId, kind, id, audit, scope): SQL {
      return sql`INSERT INTO ${nodeHistory} (${nodeHistoryTarget}) SELECT ${nodePreImageColumns}, ${auditSelect(nodes.updatedAt, audit)} FROM ${nodes} WHERE ${quotedColumn(nodes.graphId)} = ${graphId} AND ${quotedColumn(nodes.kind)} = ${kind} AND ${quotedColumn(nodes.id)} = ${id}${liveClause(nodes.deletedAt, scope)}`;
    },

    buildCaptureEdge(graphId, id, audit, scope): SQL {
      return sql`INSERT INTO ${edgeHistory} (${edgeHistoryTarget}) SELECT ${edgePreImageColumns}, ${auditSelect(edges.updatedAt, audit)} FROM ${edges} WHERE ${quotedColumn(edges.graphId)} = ${graphId} AND ${quotedColumn(edges.id)} = ${id}${liveClause(edges.deletedAt, scope)}`;
    },

    buildCaptureEdgesByNode(graphId, nodeKind, nodeId, audit): SQL {
      return sql`INSERT INTO ${edgeHistory} (${edgeHistoryTarget}) SELECT ${edgePreImageColumns}, ${auditSelect(edges.updatedAt, audit)} FROM ${edges} WHERE ${quotedColumn(edges.graphId)} = ${graphId} AND ((${quotedColumn(edges.fromKind)} = ${nodeKind} AND ${quotedColumn(edges.fromId)} = ${nodeId}) OR (${quotedColumn(edges.toKind)} = ${nodeKind} AND ${quotedColumn(edges.toId)} = ${nodeId}))`;
    },

    combine(capture, mutation): readonly SQL[] {
      if (dialect === "postgres") {
        // A data-modifying CTE: all sub-statements share one snapshot, so
        // the capture's SELECT reads the pre-image while the main mutation
        // writes the new version — atomic in a single statement.
        return [sql`WITH "__tg_history" AS (${capture}) ${mutation}`];
      }
      return [capture, mutation];
    },

    buildInsertNodeHistoryFromRow(row, audit): SQL {
      return sql`INSERT INTO ${nodeHistory} (${nodeHistoryTarget}) VALUES (${row.graph_id}, ${row.kind}, ${row.id}, ${propsValue(row.props)}, ${row.version}, ${sqlNull(row.valid_from)}, ${sqlNull(row.valid_to)}, ${row.created_at}, ${row.updated_at}, ${sqlNull(row.deleted_at)}, ${row.updated_at}, ${audit.recordedTo}, ${audit.op}, ${audit.schemaVersion}, ${audit.txId}, ${metaValue(audit.meta)})`;
    },

    buildInsertEdgeHistoryFromRow(row, audit): SQL {
      return sql`INSERT INTO ${edgeHistory} (${edgeHistoryTarget}) VALUES (${row.graph_id}, ${row.id}, ${row.kind}, ${row.from_kind}, ${row.from_id}, ${row.to_kind}, ${row.to_id}, ${propsValue(row.props)}, ${sqlNull(row.valid_from)}, ${sqlNull(row.valid_to)}, ${row.created_at}, ${row.updated_at}, ${sqlNull(row.deleted_at)}, ${row.updated_at}, ${audit.recordedTo}, ${audit.op}, ${audit.schemaVersion}, ${audit.txId}, ${metaValue(audit.meta)})`;
    },

    buildGetNodeHistory(graphId, kind, id): SQL {
      return sql`SELECT * FROM ${nodeHistory} WHERE ${quotedColumn(nodeHistory.graphId)} = ${graphId} AND ${quotedColumn(nodeHistory.kind)} = ${kind} AND ${quotedColumn(nodeHistory.id)} = ${id} ORDER BY ${quotedColumn(nodeHistory.recordedTo)} DESC, ${quotedColumn(nodeHistory.recordedFrom)} DESC, ${quotedColumn(nodeHistory.version)} DESC, ${quotedColumn(nodeHistory.historyId)} DESC`;
    },

    buildGetEdgeHistory(graphId, id): SQL {
      // Edges carry no `version` column, so ordering is by the recorded
      // interval plus the surrogate id as a deterministic tiebreak.
      return sql`SELECT * FROM ${edgeHistory} WHERE ${quotedColumn(edgeHistory.graphId)} = ${graphId} AND ${quotedColumn(edgeHistory.id)} = ${id} ORDER BY ${quotedColumn(edgeHistory.recordedTo)} DESC, ${quotedColumn(edgeHistory.recordedFrom)} DESC, ${quotedColumn(edgeHistory.historyId)} DESC`;
    },

    buildPruneNodeHistory(graphId, before): SQL {
      return sql`DELETE FROM ${nodeHistory} WHERE ${quotedColumn(nodeHistory.graphId)} = ${graphId} AND ${quotedColumn(nodeHistory.recordedTo)} < ${before}`;
    },

    buildPruneEdgeHistory(graphId, before): SQL {
      return sql`DELETE FROM ${edgeHistory} WHERE ${quotedColumn(edgeHistory.graphId)} = ${graphId} AND ${quotedColumn(edgeHistory.recordedTo)} < ${before}`;
    },
  };
}
