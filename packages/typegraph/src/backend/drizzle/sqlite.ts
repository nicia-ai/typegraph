/**
 * SQLite backend adapter for TypeGraph.
 *
 * Works with any Drizzle SQLite database instance:
 * - better-sqlite3
 * - libsql / Turso
 * - Cloudflare D1
 * - bun:sqlite
 * - sql.js
 *
 * @example
 * ```typescript
 * import { drizzle } from "drizzle-orm/better-sqlite3";
 * import Database from "better-sqlite3";
 * import { createSqliteBackend } from "@nicia-ai/typegraph/drizzle/sqlite";
 * import { tables } from "@nicia-ai/typegraph/drizzle/schema/sqlite";
 *
 * const sqlite = new Database("app.db");
 * const db = drizzle(sqlite);
 * const backend = createSqliteBackend(db, { tables });
 * ```
 */
import { getTableName, type SQL, sql } from "drizzle-orm";

import { ConfigurationError, UniquenessError } from "../../errors";
import type { SqlTableNames } from "../../query/compiler/schema";
import {
  type CheckUniqueParams,
  type CountEdgesByKindParams,
  type CountEdgesFromParams,
  type CountNodesByKindParams,
  type CreateVectorIndexParams,
  D1_CAPABILITIES,
  type DeleteEdgeParams,
  type DeleteNodeParams,
  type DeleteUniqueParams,
  type DropVectorIndexParams,
  type EdgeExistsBetweenParams,
  type EdgeRow,
  type FindEdgesByKindParams,
  type FindEdgesConnectedToParams,
  type FindNodesByKindParams,
  type GraphBackend,
  type HardDeleteEdgeParams,
  type HardDeleteNodeParams,
  type InsertEdgeParams,
  type InsertNodeParams,
  type InsertSchemaParams,
  type InsertUniqueParams,
  type NodeRow,
  type SchemaVersionRow,
  SQLITE_CAPABILITIES,
  type TransactionBackend,
  type TransactionOptions,
  type UniqueRow,
  type UpdateEdgeParams,
  type UpdateNodeParams,
} from "../types";
import {
  type AnySqliteDatabase,
  createSqliteExecutionAdapter,
  type SqliteExecutionAdapter,
  type SqliteExecutionProfileHints,
} from "./execution/sqlite-execution";
import { createSqliteOperationStrategy } from "./operations/strategy";
import { type SqliteTables, tables as defaultTables } from "./schema/sqlite";
import {
  createSqliteVectorIndex,
  dropSqliteVectorIndex,
  type VectorIndexOptions,
} from "./vector-index";

// ============================================================
// Types
// ============================================================

/**
 * Options for creating a SQLite backend.
 */
export type SqliteBackendOptions = Readonly<{
  /**
   * Custom table definitions. Use createSqliteTables() to customize table names.
   * Defaults to standard TypeGraph table names.
   */
  tables?: SqliteTables;
  /**
   * Optional execution profile hints used to avoid runtime driver reflection.
   * Set `isD1: true` when using Cloudflare D1.
   */
  executionProfile?: SqliteExecutionProfileHints;
}>;

const SQLITE_MAX_BIND_PARAMETERS = 999;
const NODE_INSERT_PARAM_COUNT = 9;
const EDGE_INSERT_PARAM_COUNT = 12;
const SQLITE_NODE_INSERT_BATCH_SIZE = Math.max(
  1,
  Math.floor(SQLITE_MAX_BIND_PARAMETERS / NODE_INSERT_PARAM_COUNT),
);
const SQLITE_EDGE_INSERT_BATCH_SIZE = Math.max(
  1,
  Math.floor(SQLITE_MAX_BIND_PARAMETERS / EDGE_INSERT_PARAM_COUNT),
);
const SQLITE_GET_NODES_ID_CHUNK_SIZE = Math.max(
  1,
  SQLITE_MAX_BIND_PARAMETERS - 2,
);
const SQLITE_GET_EDGES_ID_CHUNK_SIZE = Math.max(
  1,
  SQLITE_MAX_BIND_PARAMETERS - 1,
);

type SerializedExecutionQueue = Readonly<{
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
}>;

// ============================================================
// Utilities
// ============================================================

/**
 * Gets the current timestamp in ISO format.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Converts null to undefined.
 */
function nullToUndefined<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

/**
 * Converts a database row to NodeRow type.
 * Raw SQL returns snake_case column names.
 */
function toNodeRow(row: Record<string, unknown>): NodeRow {
  return {
    graph_id: row.graph_id as string,
    kind: row.kind as string,
    id: row.id as string,
    props: row.props as string,
    version: row.version as number,
    valid_from: nullToUndefined(row.valid_from as string | null),
    valid_to: nullToUndefined(row.valid_to as string | null),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: nullToUndefined(row.deleted_at as string | null),
  };
}

/**
 * Converts a database row to EdgeRow type.
 * Raw SQL returns snake_case column names.
 */
function toEdgeRow(row: Record<string, unknown>): EdgeRow {
  return {
    graph_id: row.graph_id as string,
    id: row.id as string,
    kind: row.kind as string,
    from_kind: row.from_kind as string,
    from_id: row.from_id as string,
    to_kind: row.to_kind as string,
    to_id: row.to_id as string,
    props: row.props as string,
    valid_from: nullToUndefined(row.valid_from as string | null),
    valid_to: nullToUndefined(row.valid_to as string | null),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: nullToUndefined(row.deleted_at as string | null),
  };
}

/**
 * Converts a database row to UniqueRow type.
 * Raw SQL returns snake_case column names.
 */
function toUniqueRow(row: Record<string, unknown>): UniqueRow {
  return {
    graph_id: row.graph_id as string,
    node_kind: row.node_kind as string,
    constraint_name: row.constraint_name as string,
    key: row.key as string,
    node_id: row.node_id as string,
    concrete_kind: row.concrete_kind as string,
    deleted_at: nullToUndefined(row.deleted_at as string | null),
  };
}

/**
 * Converts a database row to SchemaVersionRow type.
 * Raw SQL returns snake_case column names.
 */
function toSchemaVersionRow(row: Record<string, unknown>): SchemaVersionRow {
  // SQLite returns is_active as number (0 or 1) or string ('0' or '1')
  // Boolean('0') is true in JavaScript, so we need explicit conversion
  const isActiveValue = row.is_active;
  const isActive = isActiveValue === 1 || isActiveValue === "1" || isActiveValue === true;

  return {
    graph_id: row.graph_id as string,
    version: row.version as number,
    schema_hash: row.schema_hash as string,
    schema_doc: row.schema_doc as string,
    created_at: row.created_at as string,
    is_active: isActive,
  };
}

function chunkArray<T>(
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  if (values.length <= size) return [values];

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function createSerializedExecutionQueue(): SerializedExecutionQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    async runExclusive<T>(task: () => Promise<T>): Promise<T> {
      const runTask = async (): Promise<T> => task();
      const result = tail.then(runTask, runTask);
      tail = result.then(
        () => 0,
        () => 0,
      );
      return result;
    },
  };
}

async function runWithSerializedQueue<T>(
  queue: SerializedExecutionQueue | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (queue === undefined) return task();
  return queue.runExclusive(task);
}

// ============================================================
// Backend Factory
// ============================================================

/**
 * Creates a TypeGraph backend for SQLite databases.
 *
 * Works with any Drizzle SQLite instance regardless of the underlying driver.
 *
 * @param db - A Drizzle SQLite database instance
 * @param options - Backend configuration
 * @returns A GraphBackend implementation
 */
type CreateSqliteOperationBackendOptions = Readonly<{
  capabilities: GraphBackend["capabilities"];
  db: AnySqliteDatabase;
  executionAdapter: SqliteExecutionAdapter;
  operationStrategy: ReturnType<typeof createSqliteOperationStrategy>;
  serializedQueue?: SerializedExecutionQueue;
  tableNames: SqlTableNames;
}>;

type CreateSqliteTransactionBackendOptions = Readonly<{
  capabilities: GraphBackend["capabilities"];
  db: AnySqliteDatabase;
  executionAdapter?: SqliteExecutionAdapter;
  operationStrategy: ReturnType<typeof createSqliteOperationStrategy>;
  profileHints: SqliteExecutionProfileHints;
  tableNames: SqlTableNames;
}>;

function createSqliteOperationBackend(
  options: CreateSqliteOperationBackendOptions,
): TransactionBackend {
  const {
    capabilities,
    db,
    executionAdapter,
    operationStrategy,
    serializedQueue,
    tableNames,
  } = options;

  async function execGet<T>(query: SQL): Promise<T | undefined> {
    return runWithSerializedQueue(serializedQueue, async () => {
      const result = db.get(query);
      return (result instanceof Promise ? await result : result) as T | undefined;
    });
  }

  async function execAll<T>(query: SQL): Promise<T[]> {
    return runWithSerializedQueue(serializedQueue, async () => {
      const result = db.all(query);
      return (result instanceof Promise ? await result : result) as T[];
    });
  }

  async function execRun(query: SQL): Promise<void> {
    await runWithSerializedQueue(serializedQueue, async () => {
      const result = db.run(query);
      if (result instanceof Promise) await result;
    });
  }

  const operationBackend: TransactionBackend = {
    dialect: "sqlite",
    capabilities,
    tableNames,

    // === Node Operations ===

    async insertNode(params: InsertNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNode(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert node failed: no row returned");
      return toNodeRow(row);
    },

    async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNodeNoReturn(params, timestamp);
      await execRun(query);
    },

    async insertNodesBatch(
      params: readonly InsertNodeParams[],
    ): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, SQLITE_NODE_INSERT_BATCH_SIZE)) {
        const query = operationStrategy.buildInsertNodesBatch(chunk, timestamp);
        await execRun(query);
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
      for (const chunk of chunkArray(params, SQLITE_NODE_INSERT_BATCH_SIZE)) {
        const query =
          operationStrategy.buildInsertNodesBatchReturning(chunk, timestamp);
        const rows = await execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => toNodeRow(row)));
      }
      return allRows;
    },

    async getNode(
      graphId: string,
      kind: string,
      id: string,
    ): Promise<NodeRow | undefined> {
      const query = operationStrategy.buildGetNode(graphId, kind, id);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toNodeRow(row) : undefined;
    },

    async getNodes(
      graphId: string,
      kind: string,
      ids: readonly string[],
    ): Promise<readonly NodeRow[]> {
      if (ids.length === 0) return [];
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(ids, SQLITE_GET_NODES_ID_CHUNK_SIZE)) {
        const query = operationStrategy.buildGetNodes(graphId, kind, chunk);
        const rows = await execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => toNodeRow(row)));
      }
      return allRows;
    },

    async updateNode(params: UpdateNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateNode(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Update node failed: no row returned");
      return toNodeRow(row);
    },

    async deleteNode(params: DeleteNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteNode(params, timestamp);
      await execRun(query);
    },

    async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
      const deleteUniquesQuery = operationStrategy.buildHardDeleteUniquesByNode(
        params.graphId,
        params.id,
      );
      await execRun(deleteUniquesQuery);

      const deleteEmbeddingsQuery =
        operationStrategy.buildHardDeleteEmbeddingsByNode(
          params.graphId,
          params.kind,
          params.id,
        );
      await execRun(deleteEmbeddingsQuery);

      const query = operationStrategy.buildHardDeleteNode(params);
      await execRun(query);
    },

    // === Edge Operations ===

    async insertEdge(params: InsertEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdge(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert edge failed: no row returned");
      return toEdgeRow(row);
    },

    async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdgeNoReturn(params, timestamp);
      await execRun(query);
    },

    async insertEdgesBatch(
      params: readonly InsertEdgeParams[],
    ): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, SQLITE_EDGE_INSERT_BATCH_SIZE)) {
        const query = operationStrategy.buildInsertEdgesBatch(chunk, timestamp);
        await execRun(query);
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
      for (const chunk of chunkArray(params, SQLITE_EDGE_INSERT_BATCH_SIZE)) {
        const query =
          operationStrategy.buildInsertEdgesBatchReturning(chunk, timestamp);
        const rows = await execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => toEdgeRow(row)));
      }
      return allRows;
    },

    async getEdge(graphId: string, id: string): Promise<EdgeRow | undefined> {
      const query = operationStrategy.buildGetEdge(graphId, id);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toEdgeRow(row) : undefined;
    },

    async getEdges(
      graphId: string,
      ids: readonly string[],
    ): Promise<readonly EdgeRow[]> {
      if (ids.length === 0) return [];
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(ids, SQLITE_GET_EDGES_ID_CHUNK_SIZE)) {
        const query = operationStrategy.buildGetEdges(graphId, chunk);
        const rows = await execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => toEdgeRow(row)));
      }
      return allRows;
    },

    async updateEdge(params: UpdateEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateEdge(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Update edge failed: no row returned");
      return toEdgeRow(row);
    },

    async deleteEdge(params: DeleteEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteEdge(params, timestamp);
      await execRun(query);
    },

    async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<void> {
      const query = operationStrategy.buildHardDeleteEdge(params);
      await execRun(query);
    },

    // === Edge Cardinality Operations ===

    async countEdgesFrom(params: CountEdgesFromParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesFrom(params);
      const row = await execGet<{ count: number }>(query);
      return row?.count ?? 0;
    },

    async edgeExistsBetween(params: EdgeExistsBetweenParams): Promise<boolean> {
      const query = operationStrategy.buildEdgeExistsBetween(params);
      const row = await execGet<Record<string, unknown>>(query);
      return row !== undefined;
    },

    // === Edge Query Operations ===

    async findEdgesConnectedTo(
      params: FindEdgesConnectedToParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesConnectedTo(params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toEdgeRow(row));
    },

    // === Collection Query Operations ===

    async findNodesByKind(
      params: FindNodesByKindParams,
    ): Promise<readonly NodeRow[]> {
      const query = operationStrategy.buildFindNodesByKind(params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toNodeRow(row));
    },

    async countNodesByKind(params: CountNodesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountNodesByKind(params);
      const row = await execGet<{ count: number }>(query);
      return row?.count ?? 0;
    },

    async findEdgesByKind(
      params: FindEdgesByKindParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesByKind(params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toEdgeRow(row));
    },

    async countEdgesByKind(params: CountEdgesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesByKind(params);
      const row = await execGet<{ count: number }>(query);
      return row?.count ?? 0;
    },

    // === Unique Constraint Operations ===

    async insertUnique(params: InsertUniqueParams): Promise<void> {
      const query = operationStrategy.buildInsertUnique(params);
      const result = await execGet<{ node_id: string }>(query);

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
      await execRun(query);
    },

    async checkUnique(
      params: CheckUniqueParams,
    ): Promise<UniqueRow | undefined> {
      const query = operationStrategy.buildCheckUnique(params);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toUniqueRow(row) : undefined;
    },

    // === Schema Operations ===

    async getActiveSchema(
      graphId: string,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetActiveSchema(graphId);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toSchemaVersionRow(row) : undefined;
    },

    async insertSchema(params: InsertSchemaParams): Promise<SchemaVersionRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertSchema(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert schema failed: no row returned");
      return toSchemaVersionRow(row);
    },

    async getSchemaVersion(
      graphId: string,
      version: number,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetSchemaVersion(graphId, version);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toSchemaVersionRow(row) : undefined;
    },

    async setActiveSchema(graphId: string, version: number): Promise<void> {
      const queries = operationStrategy.buildSetActiveSchema(graphId, version);
      await execRun(queries.deactivateAll);
      await execRun(queries.activateVersion);
    },

    // === Embedding Operations (SQLite no-op index management) ===

    createVectorIndex(params: CreateVectorIndexParams): Promise<void> {
      const indexOptions: VectorIndexOptions = {
        graphId: params.graphId,
        nodeKind: params.nodeKind,
        fieldPath: params.fieldPath,
        dimensions: params.dimensions,
        indexType: params.indexType,
        metric: params.metric,
        ...(params.indexParams?.m === undefined
          ? {}
          : { hnswM: params.indexParams.m }),
        ...(params.indexParams?.efConstruction === undefined
          ? {}
          : { hnswEfConstruction: params.indexParams.efConstruction }),
        ...(params.indexParams?.lists === undefined
          ? {}
          : { ivfflatLists: params.indexParams.lists }),
      };

      const result = createSqliteVectorIndex(indexOptions);

      if (!result.success) {
        throw new Error(result.message ?? "Failed to create SQLite vector index");
      }
      return Promise.resolve();
    },

    dropVectorIndex(params: DropVectorIndexParams): Promise<void> {
      const result = dropSqliteVectorIndex(
        params.graphId,
        params.nodeKind,
        params.fieldPath,
      );
      if (!result.success) {
        throw new Error(result.message ?? "Failed to drop SQLite vector index");
      }
      return Promise.resolve();
    },

    // === Query Execution ===

    async execute<T>(query: SQL): Promise<readonly T[]> {
      return runWithSerializedQueue(serializedQueue, async () =>
        executionAdapter.execute<T>(query),
      );
    },

    compileSql(query: SQL): Readonly<{ sql: string; params: readonly unknown[] }> {
      return executionAdapter.compile(query);
    },
  };

  const executeCompiled = executionAdapter.executeCompiled;
  if (executeCompiled !== undefined) {
    (operationBackend as { executeRaw?: TransactionBackend["executeRaw"] }).executeRaw = function <T>(
      sqlText: string,
      params: readonly unknown[],
    ): Promise<readonly T[]> {
      return runWithSerializedQueue(serializedQueue, async () =>
        executeCompiled<T>({ params, sql: sqlText }),
      );
    };
  }

  return operationBackend;
}

export function createSqliteBackend(
  db: AnySqliteDatabase,
  options: SqliteBackendOptions = {},
): GraphBackend {
  const tables = options.tables ?? defaultTables;
  const profileHints = options.executionProfile ?? {};
  const executionAdapter = createSqliteExecutionAdapter(db, { profileHints });
  const { isD1, isSync } = executionAdapter.profile;
  const capabilities = isD1 ? D1_CAPABILITIES : SQLITE_CAPABILITIES;

  const tableNames: SqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    embeddings: getTableName(tables.embeddings),
  };
  const operationStrategy = createSqliteOperationStrategy(tables);
  const serializedQueue = isSync ? createSerializedExecutionQueue() : undefined;
  const operations = createSqliteOperationBackend({
    capabilities,
    db,
    executionAdapter,
    operationStrategy,
    tableNames,
    ...(serializedQueue === undefined ? {} : { serializedQueue }),
  });

  const backend: GraphBackend = {
    ...operations,

    async setActiveSchema(graphId: string, version: number): Promise<void> {
      await backend.transaction(async (txBackend) => {
        await txBackend.setActiveSchema(graphId, version);
      });
    },

    async transaction<T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      _options?: TransactionOptions,
    ): Promise<T> {
      if (isD1) {
        throw new ConfigurationError(
          "Cloudflare D1 does not support atomic transactions. " +
            "Operations within a transaction are not rolled back on failure. " +
            "Use backend.capabilities.transactions to check for transaction support, " +
            "or use individual operations with manual error handling.",
          {
            backend: "D1",
            capability: "transactions",
            supportsTransactions: false,
          },
        );
      }

      if (isSync) {
        return runWithSerializedQueue(serializedQueue, async () => {
          const txBackend = createTransactionBackend({
            capabilities,
            db,
            executionAdapter,
            operationStrategy,
            profileHints: { isD1: false, isSync: true },
            tableNames,
          });
          db.run(sql`BEGIN`);

          try {
            const result = await fn(txBackend);
            db.run(sql`COMMIT`);
            return result;
          } catch (error) {
            db.run(sql`ROLLBACK`);
            throw error;
          }
        });
      }

      return db.transaction(async (tx) => {
        const txBackend = createTransactionBackend({
          capabilities,
          db: tx as AnySqliteDatabase,
          operationStrategy,
          profileHints: { isD1: false, isSync: false },
          tableNames,
        });
        return fn(txBackend);
      }) as Promise<T>;
    },

    async close(): Promise<void> {
      // Drizzle doesn't expose a close method
      // Users manage connection lifecycle themselves
    },
  };

  return backend;
}

function createTransactionBackend(
  options: CreateSqliteTransactionBackendOptions,
): TransactionBackend {
  const txExecutionAdapter =
    options.executionAdapter ??
    createSqliteExecutionAdapter(options.db, {
      profileHints: options.profileHints,
    });

  return createSqliteOperationBackend({
    capabilities: options.capabilities,
    db: options.db,
    executionAdapter: txExecutionAdapter,
    operationStrategy: options.operationStrategy,
    tableNames: options.tableNames,
  });
}

// Re-export schema utilities
export type { SqliteTables, TableNames } from "./schema/sqlite";
export { createSqliteTables, tables } from "./schema/sqlite";
