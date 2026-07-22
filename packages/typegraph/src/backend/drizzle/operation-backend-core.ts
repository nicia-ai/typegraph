import { is, type SQL } from "drizzle-orm";

import {
  ConfigurationError,
  DatabaseOperationError,
  MigrationError,
  SchemaContentConflictError,
  StaleVersionError,
  UniquenessError,
} from "../../errors";
import type { SqlDialect } from "../../query/dialect/types";
import type {
  CompiledStatementSql,
  CompiledTemporaryStatementSql,
} from "../../query/sql-intent";
import { chunk as chunkArray } from "../../utils/array";
import { nowIso as defaultNowIso } from "../row-mappers";
import type {
  CheckUniqueBatchParams,
  CheckUniqueParams,
  CommitSchemaVersionParams,
  CountEdgesByKindParams,
  CountEdgesFromParams,
  CountNodesByKindParams,
  DeleteEdgeParams,
  DeleteEdgesBatchParams,
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
import { type ExecutableSql } from "./execution/types";
import {
  type CommonOperationStrategy,
  createCachedTableExistence,
  type TableExistenceCacheOptions,
} from "./operations/strategy";

/**
 * The internal operation backend — what `createCommonOperationBackend`
 * returns. Includes `commitSchemaVersion` and `setActiveVersion` so the
 * top-level backend wrappers can call them on a fresh tx-scoped
 * operation backend (created inside the dialect-specific
 * write-locking transaction). These methods are deliberately NOT on
 * the public `TransactionBackend` type — see the comment there.
 */
export type CommonOperationBackend = Pick<
  TransactionBackend,
  | "checkUnique"
  | "checkUniqueBatch"
  | "clearGraph"
  | "countEdgesByKind"
  | "countEdgesFrom"
  | "countNodesByKind"
  | "deleteEdge"
  | "deleteEdgesBatch"
  | "deleteNode"
  | "deleteUnique"
  | "edgeExistsBetween"
  | "executeStatement"
  | "executeTemporaryStatement"
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
  | "hardDeleteEdgesBatch"
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
  | "insertUniqueBatch"
  | "updateEdge"
  | "updateNode"
> &
  Readonly<{
    commitSchemaVersion: (
      params: CommitSchemaVersionParams,
    ) => Promise<SchemaVersionRow>;
    setActiveVersion: (params: SetActiveVersionParams) => Promise<void>;
  }>;

/**
 * The full internal shape the dialect operation-backend factories
 * build: a {@link TransactionBackend} that also exposes the schema-write
 * methods ({@link CommonOperationBackend}). Internal callers holding the
 * dialect's write-lock (`runSchemaWriteTransaction`) use it directly;
 * the public `transaction()` / `adoptTransaction()` boundary narrows it
 * to `TransactionBackend` so user callbacks can't reach
 * `commitSchemaVersion` / `setActiveVersion` and bypass the lock.
 */
export type InternalOperationBackend = TransactionBackend &
  CommonOperationBackend;

const DRIZZLE_DIALECT_LABELS = {
  postgres: "Postgres",
  sqlite: "SQLite",
} as const satisfies Record<SqlDialect, string>;

/**
 * Assert an externally-supplied transaction handle is the expected
 * Drizzle dialect, narrowing it for `adoptTransaction`. A wrong-dialect
 * handle would otherwise surface as an opaque driver error mid-
 * transaction; this fails it loudly at the boundary instead.
 */
export function assertAdoptedDialect<T>(
  externalTx: unknown,
  brand: Parameters<typeof is>[1],
  backend: SqlDialect,
): asserts externalTx is T {
  if (is(externalTx, brand)) return;
  const label = DRIZZLE_DIALECT_LABELS[backend];
  throw new ConfigurationError(
    `adoptTransaction received a handle that is not a ${label} Drizzle ` +
      `transaction. Pass the \`tx\` from a ${label} ` +
      `\`db.transaction(...)\` opened on this backend's connection.`,
    { backend, capability: "adoptTransaction" },
  );
}

type OperationBackendExecution = Readonly<{
  execAll: <TRow>(query: ExecutableSql) => Promise<readonly TRow[]>;
  execGet: <TRow>(query: ExecutableSql) => Promise<TRow | undefined>;
  execRun: (query: ExecutableSql) => Promise<void>;
}>;

type OperationBackendBatchConfig = Readonly<{
  checkUniqueBatchChunkSize: number;
  edgeInsertBatchSize: number;
  getEdgesChunkSize: number;
  getNodesChunkSize: number;
  nodeInsertBatchSize: number;
  uniqueInsertBatchSize: number;
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
  tableExistenceCache?: TableExistenceCacheOptions | undefined;
}>;

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

  // The clear() existence pre-check is the only thing that probes these tables.
  // Positive results are cached by default because on standard schemas the
  // recorded DDL is stable; Postgres disables that cache because visibility is
  // search_path-sensitive. Missing tables stay re-probable unless a caller opts
  // into negative caching.
  const requiredClearTableExists = createCachedTableExistence(
    (tableName) =>
      execution.execGet<Record<string, unknown>>(
        operationStrategy.buildTableExists(tableName),
      ),
    options.tableExistenceCache,
  );

  async function runIgnorableClearStatement(
    statement: Readonly<{
      query: SQL;
      ignoreMissingTable?: boolean;
      requiredTableName?: string;
    }>,
  ): Promise<void> {
    // The existence pre-check is the guard for tables that predate a schema
    // addition (e.g. the recorded relations). It works in or out of a
    // transaction, unlike a SAVEPOINT — which is invalid in autocommit mode on
    // PostgreSQL and would break clear() on a non-transactional backend.
    if (
      statement.ignoreMissingTable === true &&
      statement.requiredTableName !== undefined &&
      !(await requiredClearTableExists(statement.requiredTableName))
    ) {
      return;
    }
    await execution.execRun(statement.query);
  }

  // Returns 0 when no row is currently active — that's the sentinel
  // `expected: { kind: "initial" }` matches against.
  async function readActiveVersion(graphId: string): Promise<number> {
    const row = await execution.execGet<Record<string, unknown>>(
      operationStrategy.buildGetActiveSchema(graphId),
    );
    return row === undefined ? 0 : rowMappers.toSchemaVersionRow(row).version;
  }

  return {
    async executeStatement(query: CompiledStatementSql): Promise<void> {
      await execution.execRun(query);
    },

    async executeTemporaryStatement(
      query: CompiledTemporaryStatementSql,
    ): Promise<void> {
      await execution.execRun(query);
    },

    async insertNode(params: InsertNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNode(params, timestamp);
      const row = await execution.execGet<Record<string, unknown>>(query);
      if (!row)
        throw new DatabaseOperationError(
          "Insert node failed: no row returned",
          {
            operation: "insert",
            entity: "node",
            reason: "no_row_returned",
          },
        );
      return rowMappers.toNodeRow(row);
    },

    async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNodeNoReturn(
        params,
        timestamp,
      );
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
        const query = operationStrategy.buildInsertNodesBatchReturning(
          chunk,
          timestamp,
        );
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
      if (!row)
        throw new DatabaseOperationError(
          "Update node failed: no row returned",
          {
            operation: "update",
            entity: "node",
            reason: "no_row_returned",
          },
        );
      return rowMappers.toNodeRow(row);
    },

    async deleteNode(params: DeleteNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteNode(params, timestamp);
      await execution.execRun(query);
    },

    // IMPORTANT: This cascade is not atomic. Callers must ensure this runs
    // within a transaction to prevent partial deletion on intermediate failure.
    //
    // Embeddings are NOT cleaned up here: they live in per-`(nodeKind,
    // fieldPath)` strategy-owned tables addressable only with the slot
    // context the graph-agnostic backend lacks. The store's hard-delete
    // path (`executeNodeHardDelete`) drives `deleteNodeEmbeddings`, which
    // resolves each embedding field and routes a per-field
    // `backend.deleteEmbedding` through the active vector strategy.
    async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
      const deleteUniquesQuery = operationStrategy.buildHardDeleteUniquesByNode(
        params.graphId,
        params.id,
      );
      await execution.execRun(deleteUniquesQuery);

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
      if (!row)
        throw new DatabaseOperationError(
          "Insert edge failed: no row returned",
          {
            operation: "insert",
            entity: "edge",
            reason: "no_row_returned",
          },
        );
      return rowMappers.toEdgeRow(row);
    },

    async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdgeNoReturn(
        params,
        timestamp,
      );
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
        const query = operationStrategy.buildInsertEdgesBatchReturning(
          chunk,
          timestamp,
        );
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
      if (!row)
        throw new DatabaseOperationError(
          "Update edge failed: no row returned",
          {
            operation: "update",
            entity: "edge",
            reason: "no_row_returned",
          },
        );
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

    async deleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
      if (params.ids.length === 0) return;
      const timestamp = nowIso();
      // The soft-delete UPDATE binds one extra parameter (the `deleted_at`
      // timestamp) on top of the graphId + id-list that `getEdgesChunkSize`
      // is budgeted for, so a full chunk would overflow the bind limit by 1.
      // Reserve a slot for the timestamp. The hard-delete batch below has no
      // such extra bind and keeps the full chunk size.
      const softDeleteChunkSize = Math.max(
        1,
        batchConfig.getEdgesChunkSize - 1,
      );
      for (const chunk of chunkArray(params.ids, softDeleteChunkSize)) {
        const query = operationStrategy.buildDeleteEdgesBatch(
          { graphId: params.graphId, ids: chunk },
          timestamp,
        );
        await execution.execRun(query);
      }
    },

    async hardDeleteEdgesBatch(params: DeleteEdgesBatchParams): Promise<void> {
      if (params.ids.length === 0) return;
      for (const chunk of chunkArray(
        params.ids,
        batchConfig.getEdgesChunkSize,
      )) {
        const query = operationStrategy.buildHardDeleteEdgesBatch({
          graphId: params.graphId,
          ids: chunk,
        });
        await execution.execRun(query);
      }
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

    async insertUniqueBatch(
      entries: readonly InsertUniqueParams[],
    ): Promise<void> {
      if (entries.length === 0) return;

      // A multi-row upsert cannot affect one row twice, so collapse exact
      // duplicates and reject two entries claiming the same conflict target
      // for different nodes up front. Batch validation pre-rejects real
      // conflicts, so this is a defensive invariant, not a semantic path.
      const targetKey = (entry: InsertUniqueParams): string =>
        `${entry.nodeKind}\u0000${entry.constraintName}\u0000${entry.key}`;
      const byTarget = new Map<string, InsertUniqueParams>();
      for (const entry of entries) {
        const existing = byTarget.get(targetKey(entry));
        if (existing === undefined) {
          byTarget.set(targetKey(entry), entry);
          continue;
        }
        if (existing.nodeId !== entry.nodeId) {
          throw new UniquenessError({
            constraintName: entry.constraintName,
            kind: entry.nodeKind,
            existingId: existing.nodeId,
            newId: entry.nodeId,
            fields: [],
          });
        }
      }
      const deduped = [...byTarget.values()];

      for (const chunk of chunkArray(
        deduped,
        batchConfig.uniqueInsertBatchSize,
      )) {
        const query = operationStrategy.buildInsertUniqueBatch(chunk);
        const rows = await execution.execAll<{
          node_kind: string;
          constraint_name: string;
          key: string;
          node_id: string;
        }>(query);
        const ownerByTarget = new Map(
          rows.map((row) => [
            `${row.node_kind}\u0000${row.constraint_name}\u0000${row.key}`,
            row.node_id,
          ]),
        );
        for (const entry of chunk) {
          const owner = ownerByTarget.get(targetKey(entry));
          if (owner !== undefined && owner !== entry.nodeId) {
            throw new UniquenessError({
              constraintName: entry.constraintName,
              kind: entry.nodeKind,
              existingId: owner,
              newId: entry.nodeId,
              fields: [],
            });
          }
        }
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
      for (const chunk of chunkArray(
        params.keys,
        batchConfig.checkUniqueBatchChunkSize,
      )) {
        const query = operationStrategy.buildCheckUniqueBatch({
          ...params,
          keys: chunk,
        });
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
        operationStrategy.buildGetSchemaVersion(params.graphId, params.version),
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
        operationStrategy.buildGetSchemaVersion(params.graphId, params.version),
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
        await runIgnorableClearStatement(statement);
      }
    },
  };
}
