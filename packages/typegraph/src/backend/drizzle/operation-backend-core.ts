import { type SQL } from "drizzle-orm";

import {
  DatabaseOperationError,
  MigrationError,
  SchemaContentConflictError,
  StaleVersionError,
  UniquenessError,
} from "../../errors";
import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  CommitSchemaVersionParams,
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
  InsertUniqueParams,
  NodeRow,
  SchemaVersionRow,
  SetActiveVersionParams,
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
  | "commitSchemaVersion"
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
  | "insertUnique"
  | "setActiveVersion"
  | "updateEdge"
  | "updateNode"
>;

type OperationBackendExecution = Readonly<{
  execAll: <TRow>(query: SQL) => Promise<readonly TRow[]>;
  execGet: <TRow>(query: SQL) => Promise<TRow | undefined>;
  execRun: (query: SQL) => Promise<void>;
}>;

type OperationBackendBatchConfig = Readonly<{
  checkUniqueBatchChunkSize: number;
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

function verifyExpectedActiveVersion(
  graphId: string,
  expected: CommitSchemaVersionParams["expected"],
  actualActiveVersion: number,
): void {
  const expectedVersion = expected.kind === "active" ? expected.version : 0;
  if (actualActiveVersion !== expectedVersion) {
    throw new StaleVersionError({
      graphId,
      expected: expectedVersion,
      actual: actualActiveVersion,
    });
  }
}

export function createCommonOperationBackend(
  options: CreateCommonOperationBackendOptions,
): CommonOperationBackend {
  const { batchConfig, execution, operationStrategy, rowMappers } = options;
  const nowIso = options.nowIso ?? defaultNowIso;

  // Returns 0 when no row is currently active — that's the sentinel
  // `expected: { kind: "initial" }` matches against.
  async function readActiveVersion(graphId: string): Promise<number> {
    const row = await execution.execGet<Record<string, unknown>>(
      operationStrategy.buildGetActiveSchema(graphId),
    );
    return row === undefined ? 0 : rowMappers.toSchemaVersionRow(row).version;
  }

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

      const deleteFulltextStatements =
        operationStrategy.buildDeleteFulltextByNode(
          params.graphId,
          params.kind,
          params.id,
        );
      for (const stmt of deleteFulltextStatements) {
        await execution.execRun(stmt);
      }

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
      const allRows: UniqueRow[] = [];
      for (const chunk of chunkArray(params.keys, batchConfig.checkUniqueBatchChunkSize)) {
        const query = operationStrategy.buildCheckUniqueBatch({ ...params, keys: chunk });
        const rows = await execution.execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => rowMappers.toUniqueRow(row)));
      }
      return allRows;
    },

    async getActiveSchema(
      graphId: string,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetActiveSchema(graphId);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toSchemaVersionRow(row) : undefined;
    },

    async getSchemaVersion(
      graphId: string,
      version: number,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetSchemaVersion(graphId, version);
      const row = await execution.execGet<Record<string, unknown>>(query);
      return row ? rowMappers.toSchemaVersionRow(row) : undefined;
    },

    async commitSchemaVersion(
      params: CommitSchemaVersionParams,
    ): Promise<SchemaVersionRow> {
      // The top-level backend wraps this method in a transaction with
      // appropriate write-locking (BEGIN IMMEDIATE on SQLite,
      // pg_advisory_xact_lock on Postgres) so the read-then-write
      // sequence below is serialized against concurrent commits.

      const existingRaw = await execution.execGet<Record<string, unknown>>(
        operationStrategy.buildGetSchemaVersion(
          params.graphId,
          params.version,
        ),
      );
      const actualActiveVersion = await readActiveVersion(params.graphId);

      // Same-version-different-hash → content conflict. Always wins
      // over CAS: a hash disagreement is operator-intervention
      // territory regardless of which writer "got there first."
      if (existingRaw !== undefined) {
        const existing = rowMappers.toSchemaVersionRow(existingRaw);
        if (existing.schema_hash !== params.schemaHash) {
          throw new SchemaContentConflictError({
            graphId: params.graphId,
            version: params.version,
            existingHash: existing.schema_hash,
            incomingHash: params.schemaHash,
          });
        }
        // Same-version-same-hash already active → idempotent success.
        // Skips the CAS intentionally: same hash means identical
        // content, so there's no disagreement for the caller to refetch.
        if (existing.is_active) {
          return existing;
        }
        // Same-version-same-hash but inactive: orphan row left by a
        // crashed earlier commit. Reactivation requires CAS because
        // we're about to flip the active pointer — fall through.
        verifyExpectedActiveVersion(
          params.graphId,
          params.expected,
          actualActiveVersion,
        );
        const reactivate = operationStrategy.buildSetActiveSchema(
          params.graphId,
          params.version,
        );
        await execution.execRun(reactivate.deactivateAll);
        await execution.execRun(reactivate.activateVersion);
        // Project the result instead of re-SELECTing: the partial
        // unique index guarantees this is the only active row for the
        // graph after the UPDATEs above.
        return { ...existing, is_active: true };
      }

      verifyExpectedActiveVersion(
        params.graphId,
        params.expected,
        actualActiveVersion,
      );

      // Fresh insert path. For the "active" expected case, deactivate
      // the prior active row first so the partial unique index (one
      // active per graph) is satisfied at every statement boundary.
      // The "initial" case has no prior active, so skip.
      if (params.expected.kind === "active") {
        const flip = operationStrategy.buildSetActiveSchema(
          params.graphId,
          params.version,
        );
        await execution.execRun(flip.deactivateAll);
      }

      const timestamp = nowIso();
      const insertQuery = operationStrategy.buildInsertSchema(
        {
          graphId: params.graphId,
          version: params.version,
          schemaHash: params.schemaHash,
          schemaDoc: params.schemaDoc,
          isActive: true,
        },
        timestamp,
      );
      const insertedRaw =
        await execution.execGet<Record<string, unknown>>(insertQuery);
      if (!insertedRaw) {
        throw new DatabaseOperationError(
          "Insert schema failed: no row returned",
          { operation: "insert", entity: "schema" },
        );
      }
      return rowMappers.toSchemaVersionRow(insertedRaw);
    },

    async setActiveVersion(params: SetActiveVersionParams): Promise<void> {
      const actualActiveVersion = await readActiveVersion(params.graphId);
      verifyExpectedActiveVersion(
        params.graphId,
        params.expected,
        actualActiveVersion,
      );

      const targetRaw = await execution.execGet<Record<string, unknown>>(
        operationStrategy.buildGetSchemaVersion(
          params.graphId,
          params.version,
        ),
      );
      if (!targetRaw) {
        throw new MigrationError(
          `Cannot activate version ${params.version}: version does not exist for graph "${params.graphId}".`,
          {
            graphId: params.graphId,
            fromVersion: actualActiveVersion,
            toVersion: params.version,
          },
        );
      }

      const queries = operationStrategy.buildSetActiveSchema(
        params.graphId,
        params.version,
      );
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
