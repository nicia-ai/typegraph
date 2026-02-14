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

import { ConfigurationError } from "../../errors";
import type { SqlTableNames } from "../../query/compiler/schema";
import {
  type CreateVectorIndexParams,
  D1_CAPABILITIES,
  type DropVectorIndexParams,
  type GraphBackend,
  SQLITE_CAPABILITIES,
  type TransactionBackend,
  type TransactionOptions,
} from "../types";
import {
  type AnySqliteDatabase,
  createSqliteExecutionAdapter,
  type SqliteExecutionAdapter,
  type SqliteExecutionProfileHints,
} from "./execution/sqlite-execution";
import { createCommonOperationBackend } from "./operation-backend-core";
import { createSqliteOperationStrategy } from "./operations/strategy";
import {
  createEdgeRowMapper,
  createNodeRowMapper,
  createSchemaVersionRowMapper,
  createUniqueRowMapper,
  nowIso,
  SQLITE_ROW_MAPPER_CONFIG,
} from "./row-mappers";
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

const toNodeRow = createNodeRowMapper(SQLITE_ROW_MAPPER_CONFIG);
const toEdgeRow = createEdgeRowMapper(SQLITE_ROW_MAPPER_CONFIG);
const toUniqueRow = createUniqueRowMapper(SQLITE_ROW_MAPPER_CONFIG);
const toSchemaVersionRow = createSchemaVersionRowMapper(SQLITE_ROW_MAPPER_CONFIG);

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

  const commonBackend = createCommonOperationBackend({
    batchConfig: {
      edgeInsertBatchSize: SQLITE_EDGE_INSERT_BATCH_SIZE,
      getEdgesChunkSize: SQLITE_GET_EDGES_ID_CHUNK_SIZE,
      getNodesChunkSize: SQLITE_GET_NODES_ID_CHUNK_SIZE,
      nodeInsertBatchSize: SQLITE_NODE_INSERT_BATCH_SIZE,
    },
    execution: {
      execAll,
      execGet,
      execRun,
    },
    nowIso,
    operationStrategy,
    rowMappers: {
      toEdgeRow,
      toNodeRow,
      toSchemaVersionRow,
      toUniqueRow,
    },
  });

  const executeCompiled = executionAdapter.executeCompiled;
  const executeRawMethod: Pick<TransactionBackend, "executeRaw"> =
    executeCompiled === undefined ?
      {}
    : {
        executeRaw<T>(
          sqlText: string,
          params: readonly unknown[],
        ): Promise<readonly T[]> {
          return runWithSerializedQueue(serializedQueue, async () =>
            executeCompiled<T>({ params, sql: sqlText }),
          );
        },
      };

  const operationBackend: TransactionBackend = {
    ...commonBackend,
    ...executeRawMethod,
    capabilities,
    dialect: "sqlite",
    tableNames,

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
export type { SqliteTableNames,SqliteTables } from "./schema/sqlite";
export { createSqliteTables, tables } from "./schema/sqlite";
