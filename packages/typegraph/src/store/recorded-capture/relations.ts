import {
  type EdgeRow,
  type NodeRow,
  rowPropsToJsonText,
  type TransactionBackend,
} from "../../backend/types";
import { RECORDED_MAX_REVISION } from "../../core/temporal";
import { ConfigurationError } from "../../errors";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { generateId } from "../../utils/id";
import { executeStatement } from "./guards";

export type RecordedOperation = "create" | "update" | "delete";

export type RecordedInsert<Row> = Readonly<{
  row: Row;
  operation: RecordedOperation;
}>;

/**
 * `meta`, `schema_version`, and `tx_id` are reserved SQL:2011 audit columns of
 * the recorded relations. They are not yet populated by a writer, so every
 * captured row stamps `meta` with this empty object and leaves `schema_version`
 * / `tx_id` NULL; they are carried now so the relation shape is stable when a
 * populator lands.
 */
const RECORDED_HISTORY_META = "{}";

/**
 * Recorded-relation column order. The same list builds each INSERT's column
 * clause and derives the per-statement chunk size, so adding a column updates
 * both in lockstep instead of relying on a hand-counted bind-parameter count.
 */
export const RECORDED_NODE_COLUMNS = [
  "history_id",
  "graph_id",
  "kind",
  "id",
  "props",
  "version",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
  "recorded_from",
  "recorded_to",
  "op",
  "schema_version",
  "tx_id",
  "meta",
] as const;

export const RECORDED_EDGE_COLUMNS = [
  "history_id",
  "graph_id",
  "id",
  "kind",
  "from_kind",
  "from_id",
  "to_kind",
  "to_id",
  "props",
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
  "recorded_from",
  "recorded_to",
  "op",
  "schema_version",
  "tx_id",
  "meta",
] as const;

const RECORDED_NODE_COLUMN_LIST = sql.raw(RECORDED_NODE_COLUMNS.join(", "));
const RECORDED_EDGE_COLUMN_LIST = sql.raw(RECORDED_EDGE_COLUMNS.join(", "));

/**
 * Conservative per-statement bound-parameter budget, used only as the fallback
 * when a backend does not advertise `capabilities.maxBindParameters`.
 */
const RECORDED_BIND_PARAM_BUDGET = 900;

export function recordedBindParamBudget(
  target: Pick<TransactionBackend, "capabilities">,
): number {
  const budget =
    target.capabilities.maxBindParameters ?? RECORDED_BIND_PARAM_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new ConfigurationError(
      `backend capabilities.maxBindParameters must be a positive integer, got: ${String(budget)}`,
      {
        code: "INVALID_BACKEND_CAPABILITY",
        capability: "maxBindParameters",
        value: budget,
      },
    );
  }
  return budget;
}

/**
 * Rows per recorded INSERT statement: the backend's real bound-parameter ceiling
 * divided by the per-row column count.
 */
function recordedChunkSize(
  target: Pick<TransactionBackend, "capabilities">,
  columnCount: number,
): number {
  const budget = recordedBindParamBudget(target);
  return Math.max(1, Math.floor(budget / columnCount));
}

/**
 * Builds one recorded column's value from an after-image row, the commit
 * instant, and the operation. Each recorded relation maps every column name to
 * one of these, so VALUES tuples are derived from the column list.
 */
type RecordedCellBuilder<Row> = (
  row: Row,
  recordedRevision: number,
  operation: RecordedOperation,
) => SqlFragment;

type RecordedCommonColumn =
  | "history_id"
  | "graph_id"
  | "id"
  | "kind"
  | "props"
  | "valid_from"
  | "valid_to"
  | "created_at"
  | "updated_at"
  | "deleted_at"
  | "recorded_from"
  | "recorded_to"
  | "op"
  | "schema_version"
  | "tx_id"
  | "meta";

function sqlNull(value: string | undefined): SqlFragment {
  return value === undefined ? sql.raw("NULL") : sql`${value}`;
}

function recordedCommonCells<Row extends NodeRow | EdgeRow>(): Record<
  RecordedCommonColumn,
  RecordedCellBuilder<Row>
> {
  return {
    history_id: () => sql`${generateId()}`,
    graph_id: (row) => sql`${row.graph_id}`,
    id: (row) => sql`${row.id}`,
    kind: (row) => sql`${row.kind}`,
    props: (row) => sql`${rowPropsToJsonText(row.props)}`,
    valid_from: (row) => sql`${sqlNull(row.valid_from)}`,
    valid_to: (row) => sql`${sqlNull(row.valid_to)}`,
    created_at: (row) => sql`${row.created_at}`,
    updated_at: (row) => sql`${row.updated_at}`,
    deleted_at: (row) => sql`${sqlNull(row.deleted_at)}`,
    recorded_from: (_row, recordedRevision) => sql`${recordedRevision}`,
    recorded_to: () => sql`${RECORDED_MAX_REVISION}`,
    op: (_row, _recordedCommit, operation) => sql`${operation}`,
    schema_version: () => sql`NULL`,
    tx_id: () => sql`NULL`,
    meta: () => sql`${RECORDED_HISTORY_META}`,
  };
}

const recordedNodeCells: Record<
  (typeof RECORDED_NODE_COLUMNS)[number],
  RecordedCellBuilder<NodeRow>
> = {
  ...recordedCommonCells<NodeRow>(),
  version: (row) => sql`${row.version}`,
};

const recordedEdgeCells: Record<
  (typeof RECORDED_EDGE_COLUMNS)[number],
  RecordedCellBuilder<EdgeRow>
> = {
  ...recordedCommonCells<EdgeRow>(),
  from_kind: (row) => sql`${row.from_kind}`,
  from_id: (row) => sql`${row.from_id}`,
  to_kind: (row) => sql`${row.to_kind}`,
  to_id: (row) => sql`${row.to_id}`,
};

function recordedValuesTuple<Row, Column extends string>(
  columns: readonly Column[],
  cells: Record<Column, RecordedCellBuilder<Row>>,
  row: Row,
  recordedRevision: number,
  operation: RecordedOperation,
): SqlFragment {
  const tuple = columns.map((column) =>
    cells[column](row, recordedRevision, operation),
  );
  return sql`(${sql.join(tuple, sql`, `)})`;
}

async function insertRecordedRows<Row, Column extends string>(
  target: TransactionBackend,
  table: SqlFragment,
  columnList: SqlFragment,
  columns: readonly Column[],
  cells: Record<Column, RecordedCellBuilder<Row>>,
  inserts: readonly RecordedInsert<Row>[],
  recordedRevision: number,
): Promise<void> {
  if (inserts.length === 0) return;
  const values = inserts.map((insert) =>
    recordedValuesTuple(
      columns,
      cells,
      insert.row,
      recordedRevision,
      insert.operation,
    ),
  );
  await executeStatement(
    target,
    sql`
      INSERT INTO ${table} (${columnList})
      VALUES ${sql.join(values, sql`, `)}
    `,
  );
}

export function recordedNodeChunkSize(target: TransactionBackend): number {
  return recordedChunkSize(target, RECORDED_NODE_COLUMNS.length);
}

export function recordedEdgeChunkSize(target: TransactionBackend): number {
  return recordedChunkSize(target, RECORDED_EDGE_COLUMNS.length);
}

export function insertRecordedNodeRows(
  target: TransactionBackend,
  table: SqlFragment,
  inserts: readonly RecordedInsert<NodeRow>[],
  recordedRevision: number,
): Promise<void> {
  return insertRecordedRows(
    target,
    table,
    RECORDED_NODE_COLUMN_LIST,
    RECORDED_NODE_COLUMNS,
    recordedNodeCells,
    inserts,
    recordedRevision,
  );
}

export function insertRecordedEdgeRows(
  target: TransactionBackend,
  table: SqlFragment,
  inserts: readonly RecordedInsert<EdgeRow>[],
  recordedRevision: number,
): Promise<void> {
  return insertRecordedRows(
    target,
    table,
    RECORDED_EDGE_COLUMN_LIST,
    RECORDED_EDGE_COLUMNS,
    recordedEdgeCells,
    inserts,
    recordedRevision,
  );
}
