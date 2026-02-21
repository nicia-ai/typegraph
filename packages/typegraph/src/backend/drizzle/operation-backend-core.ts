import { type SQL } from "drizzle-orm";

import { DatabaseOperationError, UniquenessError } from "../../errors";
import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  CountEdgesByKindParams,
  CountEdgesFromParams,
  CountNodesByKindParams,
  DeleteEdgeParams,
  DeleteNodeParams,
  DeleteUniqueParams,
  EdgeExistsBetweenParams,
  EdgeRow,
  FindEdgesByKindParams,
  FindEdgesConnectedToParams,
  FindNodesByKindParams,
  HardDeleteEdgeParams,
  HardDeleteNodeParams,
  InsertEdgeParams,
  InsertNodeParams,
  InsertSchemaParams,
  InsertUniqueParams,
  NodeRow,
  SchemaVersionRow,
  TransactionBackend,
  UniqueRow,
  UpdateEdgeParams,
  UpdateNodeParams,
} from "../types";
import { type CommonOperationStrategy } from "./operations/strategy";
import { nowIso as defaultNowIso } from "./row-mappers";

type CommonOperationBackend = Pick<
  TransactionBackend,
  | "checkUnique"
  | "checkUniqueBatch"
  | "clearGraph"
  | "countEdgesByKind"
  | "countEdgesFrom"
  | "countNodesByKind"
  | "deleteEdge"
  | "deleteNode"
  | "deleteUnique"
  | "edgeExistsBetween"
  | "findEdgesByKind"
  | "findEdgesConnectedTo"
  | "findNodesByKind"
  | "getActiveSchema"
  | "getEdge"
  | "getEdges"
  | "getNode"
  | "getNodes"
  | "getSchemaVersion"
  | "hardDeleteEdge"
  | "hardDeleteNode"
  | "insertEdge"
  | "insertEdgeNoReturn"
  | "insertEdgesBatch"
  | "insertEdgesBatchReturning"
  | "insertNode"
  | "insertNodeNoReturn"
  | "insertNodesBatch"
  | "insertNodesBatchReturning"
  | "insertSchema"
  | "insertUnique"
  | "setActiveSchema"
  | "updateEdge"
  | "updateNode"
>;

type OperationBackendExecution = Readonly<{
  execAll: <TRow>(query: SQL) => Promise<readonly TRow[]>;
  execGet: <TRow>(query: SQL) => Promise<TRow | undefined>;
  execRun: (query: SQL) => Promise<void>;
}>;

type OperationBackendBatchConfig = Readonly<{
  edgeInsertBatchSize: number;
  getEdgesChunkSize: number;
  getNodesChunkSize: number;
  nodeInsertBatchSize: number;
}>;

type OperationBackendRowMappers = Readonly<{
  toEdgeRow: (row: Record<string, unknown>) => EdgeRow;
  toNodeRow: (row: Record<string, unknown>) => NodeRow;
  toSchemaVersionRow: (row: Record<string, unknown>) => SchemaVersionRow;
  toUniqueRow: (row: Record<string, unknown>) => UniqueRow;
}>;

type CreateCommonOperationBackendOptions = Readonly<{
  batchConfig: OperationBackendBatchConfig;
  execution: OperationBackendExecution;
  nowIso?: (() => string) | undefined;
  operationStrategy: CommonOperationStrategy;
  rowMappers: OperationBackendRowMappers;
}>;

function chunkArray<T>(
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  if (values.length <= size) {
    return [values];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function createCommonOperationBackend(
  options: CreateCommonOperationBackendOptions,
): CommonOperationBackend {
  const { batchConfig, execution, operationStrategy, rowMappers } = options;
  const nowIso = options.nowIso ?? defaultNowIso;

  return {
    async insertNode(params: InsertNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNode(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row) throw new DatabaseOperationError("Insert node failed: no row returned", { operation: "insert", entity: "node" });
      return rowMappers.toNodeRow(row);
    },

    async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNodeNoReturn(params, timestamp);
      await execution.execRun(query);
    },

    async insertNodesBatch(params: readonly InsertNodeParams[]): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, batchConfig.nodeInsertBatchSize)) {
        const query = operationStrategy.buildInsertNodesBatch(chunk, timestamp);
        await execution.execRun(query);
      }
    },

    async insertNodesBatchReturning(
      params: readonly InsertNodeParams[],
    ): Promise<readonly NodeRow[]> {
      if (params.length === 0) {
        return [];
      }
      const timestamp = nowIso();
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(params, batchConfig.nodeInsertBatchSize)) {
        const query =
          operationStrategy.buildInsertNodesBatchReturning(chunk, timestamp);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toNodeRow(row)));
      }
      return allRows;
    },

    async getNode(
      graphId: string,
      kind: string,
      id: string,
    ): Promise<NodeRow | undefined> {
      const query = operationStrategy.buildGetNode(graphId, kind, id);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toNodeRow(row) : undefined;
    },

    async getNodes(
      graphId: string,
      kind: string,
      ids: readonly string[],
    ): Promise<readonly NodeRow[]> {
      if (ids.length === 0) return [];
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(ids, batchConfig.getNodesChunkSize)) {
        const query = operationStrategy.buildGetNodes(graphId, kind, chunk);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toNodeRow(row)));
      }
      return allRows;
    },

    async updateNode(params: UpdateNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateNode(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row) throw new DatabaseOperationError("Update node failed: no row returned", { operation: "update", entity: "node" });
      return rowMappers.toNodeRow(row);
    },

    async deleteNode(params: DeleteNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteNode(params, timestamp);
      await execution.execRun(query);
    },

    // IMPORTANT: This cascade is not atomic. Callers must ensure this runs
    // within a transaction to prevent partial deletion on intermediate failure.
    async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
      const deleteUniquesQuery = operationStrategy.buildHardDeleteUniquesByNode(
        params.graphId,
        params.id,
      );
      await execution.execRun(deleteUniquesQuery);

      const deleteEmbeddingsQuery =
        operationStrategy.buildHardDeleteEmbeddingsByNode(
          params.graphId,
          params.kind,
          params.id,
        );
      await execution.execRun(deleteEmbeddingsQuery);

      const deleteEdgesQuery = operationStrategy.buildHardDeleteEdgesByNode(
        params.graphId,
        params.kind,
        params.id,
      );
      await execution.execRun(deleteEdgesQuery);

      const query = operationStrategy.buildHardDeleteNode(params);
      await execution.execRun(query);
    },

    async insertEdge(params: InsertEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdge(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row) throw new DatabaseOperationError("Insert edge failed: no row returned", { operation: "insert", entity: "edge" });
      return rowMappers.toEdgeRow(row);
    },

    async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdgeNoReturn(params, timestamp);
      await execution.execRun(query);
    },

    async insertEdgesBatch(params: readonly InsertEdgeParams[]): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, batchConfig.edgeInsertBatchSize)) {
        const query = operationStrategy.buildInsertEdgesBatch(chunk, timestamp);
        await execution.execRun(query);
      }
    },

    async insertEdgesBatchReturning(
      params: readonly InsertEdgeParams[],
    ): Promise<readonly EdgeRow[]> {
      if (params.length === 0) {
        return [];
      }
      const timestamp = nowIso();
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(params, batchConfig.edgeInsertBatchSize)) {
        const query =
          operationStrategy.buildInsertEdgesBatchReturning(chunk, timestamp);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toEdgeRow(row)));
      }
      return allRows;
    },

    async getEdge(graphId: string, id: string): Promise<EdgeRow | undefined> {
      const query = operationStrategy.buildGetEdge(graphId, id);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toEdgeRow(row) : undefined;
    },

    async getEdges(
      graphId: string,
      ids: readonly string[],
    ): Promise<readonly EdgeRow[]> {
      if (ids.length === 0) return [];
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(ids, batchConfig.getEdgesChunkSize)) {
        const query = operationStrategy.buildGetEdges(graphId, chunk);
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toEdgeRow(row)));
      }
      return allRows;
    },

    async updateEdge(params: UpdateEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateEdge(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row) throw new DatabaseOperationError("Update edge failed: no row returned", { operation: "update", entity: "edge" });
      return rowMappers.toEdgeRow(row);
    },

    async deleteEdge(params: DeleteEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteEdge(params, timestamp);
      await execution.execRun(query);
    },

    async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<void> {
      const query = operationStrategy.buildHardDeleteEdge(params);
      await execution.execRun(query);
    },

    async countEdgesFrom(params: CountEdgesFromParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesFrom(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async edgeExistsBetween(params: EdgeExistsBetweenParams): Promise<boolean> {
      const query = operationStrategy.buildEdgeExistsBetween(params);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row !== undefined;
    },

    async findEdgesConnectedTo(
      params: FindEdgesConnectedToParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesConnectedTo(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toEdgeRow(row));
    },

    async findNodesByKind(
      params: FindNodesByKindParams,
    ): Promise<readonly NodeRow[]> {
      const query = operationStrategy.buildFindNodesByKind(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toNodeRow(row));
    },

    async countNodesByKind(params: CountNodesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountNodesByKind(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async findEdgesByKind(
      params: FindEdgesByKindParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesByKind(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toEdgeRow(row));
    },

    async countEdgesByKind(params: CountEdgesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesByKind(params);
      const row = await execution.execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async insertUnique(params: InsertUniqueParams): Promise<void> {
      const query = operationStrategy.buildInsertUnique(params);
      const result = await execution.execGet<{ node_id: string }>(query);

      if (result && result.node_id !== params.nodeId) {
        throw new UniquenessError({
          constraintName: params.constraintName,
          kind: params.nodeKind,
          existingId: result.node_id,
          newId: params.nodeId,
          fields: [],
        });
      }
    },

    async deleteUnique(params: DeleteUniqueParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteUnique(params, timestamp);
      await execution.execRun(query);
    },

    async checkUnique(
      params: CheckUniqueParams,
    ): Promise<UniqueRow | undefined> {
      const query = operationStrategy.buildCheckUnique(params);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toUniqueRow(row) : undefined;
    },

    async checkUniqueBatch(
      params: CheckUniqueBatchParams,
    ): Promise<readonly UniqueRow[]> {
      if (params.keys.length === 0) return [];
      const query = operationStrategy.buildCheckUniqueBatch(params);
      const rows = await execution.execAll<Record<string, unknown>>(query);
      return rows.map((row) => rowMappers.toUniqueRow(row));
    },

    async getActiveSchema(
      graphId: string,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetActiveSchema(graphId);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toSchemaVersionRow(row) : undefined;
    },

    async insertSchema(params: InsertSchemaParams): Promise<SchemaVersionRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertSchema(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row) throw new DatabaseOperationError("Insert schema failed: no row returned", { operation: "insert", entity: "schema" });
      return rowMappers.toSchemaVersionRow(row);
    },

    async getSchemaVersion(
      graphId: string,
      version: number,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetSchemaVersion(graphId, version);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toSchemaVersionRow(row) : undefined;
    },

    async setActiveSchema(graphId: string, version: number): Promise<void> {
      const queries = operationStrategy.buildSetActiveSchema(graphId, version);
      await execution.execRun(queries.deactivateAll);
      await execution.execRun(queries.activateVersion);
    },

    async clearGraph(graphId: string): Promise<void> {
      const statements = operationStrategy.buildClearGraph(graphId);
      for (const statement of statements) {
        await execution.execRun(statement);
      }
    },
  };
}
