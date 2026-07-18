import {
  type EdgeRow,
  type HardDeleteNodeParams,
  type NodeRow,
  type TransactionBackend,
} from "../../backend/types";
import { RECORDED_MAX } from "../../core/temporal";
import { sqlValueList } from "../../query/compiler/predicate-utils";
import { type SqlSchema } from "../../query/compiler/schema";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { chunk } from "../../utils/array";
import { isPresent } from "../../utils/presence";
import { getEdgeRowsByIds } from "../edge-fetch";
import { getNodeRowsByIds } from "../node-fetch";
import { allocateRecordedCommit } from "./clock";
import { executeStatement } from "./guards";
import {
  insertRecordedEdgeRows,
  insertRecordedNodeRows,
  recordedEdgeChunkSize,
  type RecordedInsert,
  recordedNodeChunkSize,
  type RecordedOperation,
} from "./relations";

export type TouchedNode = Readonly<{
  entity: "node";
  graphId: string;
  kind: string;
  id: string;
  // The after-image returned by the live write, when it returned one. Carried so
  // flush can build the recorded row without re-reading a row the write already
  // handed back. Absent for writes that return no row.
  afterImage?: NodeRow | undefined;
}>;

export type TouchedEdge = Readonly<{
  entity: "edge";
  graphId: string;
  id: string;
  afterImage?: EdgeRow | undefined;
}>;

export type TouchedEntity = TouchedNode | TouchedEdge;

type IdRow = Readonly<{ id: string }>;
type ClosedRow = Readonly<{ id: string; deleted_at: unknown }>;

export function entityKey(entity: TouchedEntity): string {
  switch (entity.entity) {
    case "node": {
      return `node\u0000${entity.graphId}\u0000${entity.kind}\u0000${entity.id}`;
    }
    case "edge": {
      return `edge\u0000${entity.graphId}\u0000${entity.id}`;
    }
  }
}

/**
 * Closes every open recorded interval for the given ids in one statement and
 * returns, per id, whether the row it just closed was a soft-delete tombstone.
 */
async function closeOpenReturning(
  target: TransactionBackend,
  table: SqlFragment,
  graphId: string,
  ids: readonly string[],
  recordedCommit: string,
  kind?: string,
): Promise<ReadonlyMap<string, boolean>> {
  const kindFilter = kind === undefined ? sql`` : sql`AND kind = ${kind}`;
  const rows = await target.execute<ClosedRow>(
    asCompiledRowsSql(sql`
      UPDATE ${table}
      SET recorded_to = ${recordedCommit}
      WHERE graph_id = ${graphId}
        ${kindFilter}
        AND recorded_to = ${RECORDED_MAX}
        AND id IN (${sqlValueList(ids)})
      RETURNING id, deleted_at
    `),
  );
  return new Map(rows.map((row) => [row.id, isPresent(row.deleted_at)]));
}

function recordedOp(
  hadOpenRow: boolean,
  priorRowWasTombstone: boolean,
  after: Readonly<{ deleted_at: string | undefined }>,
): RecordedOperation {
  if (isPresent(after.deleted_at)) return "delete";
  if (!hadOpenRow || priorRowWasTombstone) return "create";
  return "update";
}

function groupNodesByKind(
  entities: readonly TouchedNode[],
): ReadonlyMap<string, TouchedNode[]> {
  const byKind = new Map<string, TouchedNode[]>();
  for (const entity of entities) {
    const group = byKind.get(entity.kind) ?? [];
    group.push(entity);
    byKind.set(entity.kind, group);
  }
  return byKind;
}

async function resolveAfterImages<Row>(
  entities: readonly Readonly<{ id: string; afterImage?: Row | undefined }>[],
  readMissing: (ids: readonly string[]) => Promise<ReadonlyMap<string, Row>>,
): Promise<ReadonlyMap<string, Row>> {
  const afterById = new Map<string, Row>();
  const needRead: string[] = [];
  for (const entity of entities) {
    if (entity.afterImage === undefined) {
      needRead.push(entity.id);
    } else {
      afterById.set(entity.id, entity.afterImage);
    }
  }
  if (needRead.length > 0) {
    for (const [id, row] of await readMissing(needRead)) afterById.set(id, row);
  }
  return afterById;
}

function recordedInsertsFor<
  Row extends Readonly<{ id: string; deleted_at: string | undefined }>,
>(
  afterById: ReadonlyMap<string, Row>,
  closed: ReadonlyMap<string, boolean>,
): readonly RecordedInsert<Row>[] {
  return [...afterById.values()].map((row) => ({
    row,
    operation: recordedOp(closed.has(row.id), closed.get(row.id) ?? false, row),
  }));
}

export async function flushNodes(
  target: TransactionBackend,
  schema: SqlSchema,
  graphId: string,
  entities: readonly TouchedNode[],
  recordedCommit: string,
): Promise<void> {
  const chunkSize = recordedNodeChunkSize(target);
  for (const [kind, group] of groupNodesByKind(entities)) {
    for (const entityChunk of chunk(group, chunkSize)) {
      const ids = entityChunk.map((entity) => entity.id);
      const closed = await closeOpenReturning(
        target,
        schema.recordedNodesTable,
        graphId,
        ids,
        recordedCommit,
        kind,
      );
      const afterById = await resolveAfterImages(entityChunk, (missing) =>
        getNodeRowsByIds(target, graphId, kind, missing),
      );
      await insertRecordedNodeRows(
        target,
        schema.recordedNodesTable,
        recordedInsertsFor(afterById, closed),
        recordedCommit,
      );
    }
  }
}

export async function flushEdges(
  target: TransactionBackend,
  schema: SqlSchema,
  graphId: string,
  entities: readonly TouchedEdge[],
  recordedCommit: string,
): Promise<void> {
  const chunkSize = recordedEdgeChunkSize(target);
  for (const entityChunk of chunk(entities, chunkSize)) {
    const ids = entityChunk.map((entity) => entity.id);
    const closed = await closeOpenReturning(
      target,
      schema.recordedEdgesTable,
      graphId,
      ids,
      recordedCommit,
    );
    const afterById = await resolveAfterImages(entityChunk, (missing) =>
      getEdgeRowsByIds(target, graphId, missing),
    );
    await insertRecordedEdgeRows(
      target,
      schema.recordedEdgesTable,
      recordedInsertsFor(afterById, closed),
      recordedCommit,
    );
  }
}

async function closeOpenByKind(
  target: TransactionBackend,
  table: SqlFragment,
  graphId: string,
  kind: string,
  recordedCommit: string,
): Promise<void> {
  await executeStatement(
    target,
    sql`
      UPDATE ${table}
      SET recorded_to = ${recordedCommit}
      WHERE graph_id = ${graphId}
        AND kind = ${kind}
        AND recorded_to = ${RECORDED_MAX}
    `,
  );
}

async function closeOpenEdgesByNodeKind(
  target: TransactionBackend,
  schema: SqlSchema,
  graphId: string,
  nodeKind: string,
  recordedCommit: string,
): Promise<void> {
  await executeStatement(
    target,
    sql`
      UPDATE ${schema.recordedEdgesTable}
      SET recorded_to = ${recordedCommit}
      WHERE graph_id = ${graphId}
        AND (from_kind = ${nodeKind} OR to_kind = ${nodeKind})
        AND recorded_to = ${RECORDED_MAX}
    `,
  );
}

export async function closeRecordedHardDeletedKind(
  target: TransactionBackend,
  schema: SqlSchema,
  graphId: string,
  removal: Readonly<{ entity: "node" | "edge"; kind: string }>,
  ownsWriteLock: boolean,
): Promise<void> {
  const recordedCommit = await allocateRecordedCommit(
    target,
    schema,
    graphId,
    ownsWriteLock,
  );
  if (removal.entity === "node") {
    await closeOpenByKind(
      target,
      schema.recordedNodesTable,
      graphId,
      removal.kind,
      recordedCommit,
    );
    await closeOpenEdgesByNodeKind(
      target,
      schema,
      graphId,
      removal.kind,
      recordedCommit,
    );
    return;
  }
  await closeOpenByKind(
    target,
    schema.recordedEdgesTable,
    graphId,
    removal.kind,
    recordedCommit,
  );
}

export async function queryConnectedEdgeIds(
  target: TransactionBackend,
  schema: SqlSchema,
  params: HardDeleteNodeParams,
): Promise<readonly string[]> {
  const rows = await target.execute<IdRow>(
    asCompiledRowsSql(sql`
      SELECT id
      FROM ${schema.edgesTable}
      WHERE graph_id = ${params.graphId}
        AND (
          (from_kind = ${params.kind} AND from_id = ${params.id})
          OR (to_kind = ${params.kind} AND to_id = ${params.id})
        )
    `),
  );
  return rows.map((row) => row.id);
}
