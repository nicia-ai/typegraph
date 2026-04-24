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
 * import { createSqliteBackend, tables } from "@nicia-ai/typegraph/sqlite";
 *
 * const sqlite = new Database("app.db");
 * const db = drizzle(sqlite);
 * const backend = createSqliteBackend(db, { tables });
 * ```
 */
import { getTableName, type SQL, sql } from "drizzle-orm";

import { BackendDisposedError, ConfigurationError } from "../../errors";
import type { SqlTableNames } from "../../query/compiler/schema";
import {
  buildFulltextCapabilities,
  fts5Strategy,
  type FulltextStrategy,
} from "../../query/dialect/fulltext-strategy";
import {
  type BackendCapabilities,
  type CreateVectorIndexParams,
  type DeleteEmbeddingParams,
  type DeleteFulltextBatchParams,
  type DeleteFulltextParams,
  type DropVectorIndexParams,
  type FulltextSearchParams,
  type FulltextSearchResult,
  type GraphBackend,
  SQLITE_CAPABILITIES,
  type TransactionBackend,
  type TransactionOptions,
  type UpsertEmbeddingParams,
  type UpsertFulltextBatchParams,
  type UpsertFulltextParams,
} from "../types";
import {
  type AnySqliteDatabase,
  createSqliteExecutionAdapter,
  type SqliteExecutionAdapter,
  type SqliteExecutionProfileHints,
} from "./execution/sqlite-execution";
export type { SqliteTransactionMode } from "./execution/sqlite-execution";
import { generateSqliteDDL } from "./ddl";
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
   * Set `transactionMode: "none"` for drivers that do not support transactions
   * (e.g. Cloudflare D1, Durable Objects).
   */
  executionProfile?: SqliteExecutionProfileHints;
  /**
   * Fulltext strategy override. Defaults to `fts5Strategy` (SQLite's
   * built-in FTS5 virtual table). Most users should leave this alone.
   */
  fulltext?: FulltextStrategy;
  /**
   * Set to `true` when sqlite-vec has been loaded on the connection.
   * Enables vector embedding persistence via `upsertEmbedding` /
   * `deleteEmbedding`, which the store's embedding-sync path relies on
   * whenever node schemas declare `embedding()` fields. When omitted the
   * backend does not expose those methods and embedding values pass
   * through writes without being indexed — matching existing behavior
   * for backends without sqlite-vec. `createLocalSqliteBackend` sets
   * this automatically when it loads the extension.
   */
  hasVectorEmbeddings?: boolean;
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
const CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT = 3;
const SQLITE_CHECK_UNIQUE_BATCH_CHUNK_SIZE = Math.max(
  1,
  SQLITE_MAX_BIND_PARAMETERS - CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT,
);

type SerializedExecutionQueue = Readonly<{
  dispose: () => void;
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
}>;

// ============================================================
// Utilities
// ============================================================

const toNodeRow = createNodeRowMapper(SQLITE_ROW_MAPPER_CONFIG);
const toEdgeRow = createEdgeRowMapper(SQLITE_ROW_MAPPER_CONFIG);
const toUniqueRow = createUniqueRowMapper(SQLITE_ROW_MAPPER_CONFIG);
const toSchemaVersionRow = createSchemaVersionRowMapper(SQLITE_ROW_MAPPER_CONFIG);

/** A shared promise that never settles — used to absorb post-dispose work. */
const PENDING_FOREVER: Promise<never> = new Promise<never>(noop);

function pendingForever<T>(): Promise<T> {
  return PENDING_FOREVER;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

function createSerializedExecutionQueue(): SerializedExecutionQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;

  function isDisposed(): boolean {
    return disposed;
  }

  return {
    dispose() {
      disposed = true;
    },

    runExclusive<T>(task: () => Promise<T>): Promise<T> {
      if (isDisposed()) return Promise.reject(new BackendDisposedError());

      // When disposed, runTask returns a never-settling promise so that no
      // rejection propagates through the 7+ async wrappers between this
      // queue and the store-level caller. A rejection here would become an
      // unhandled rejection if the caller abandoned the promise during
      // teardown — and JavaScript offers no way to `.catch()` a rejection
      // at the bottom of a chain without every async wrapper above it also
      // creating an independently-unhandled rejected promise.
      //
      // The tradeoff: an active caller whose operation was queued before
      // dispose() will see a permanently-pending promise rather than a
      // BackendDisposedError. Post-dispose submissions (the check above)
      // still reject immediately since the caller actively holds that
      // promise.
      const runTask = async (): Promise<T> => {
        if (isDisposed()) return pendingForever<T>();
        try {
          return await task();
        } catch (error) {
          if (isDisposed()) return pendingForever<T>();
          throw error;
        }
      };
      const result = tail.then(runTask, runTask);
      tail = result.then(
        () => 0,
        () => 0,
      );
      return result;
    },
  };
}

function runWithSerializedQueue<T>(
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
  fulltextStrategy: FulltextStrategy;
  /** Wire up upsertEmbedding / deleteEmbedding. See transaction options for details. */
  hasVectorEmbeddings?: boolean;
}>;

type CreateSqliteTransactionBackendOptions = Readonly<{
  capabilities: GraphBackend["capabilities"];
  db: AnySqliteDatabase;
  executionAdapter?: SqliteExecutionAdapter;
  operationStrategy: ReturnType<typeof createSqliteOperationStrategy>;
  profileHints: SqliteExecutionProfileHints;
  tableNames: SqlTableNames;
  fulltextStrategy: FulltextStrategy;
  /**
   * When true, the backend exposes upsertEmbedding / deleteEmbedding —
   * detected by probing `vec_f32(...)` on the connection at boot so the
   * store's embedding-sync path persists vectors to the embeddings table.
   */
  hasVectorEmbeddings?: boolean;
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
    fulltextStrategy,
  } = options;

  function execGet<T>(query: SQL): Promise<T | undefined> {
    // Workaround: drizzle-team/drizzle-orm#1049 — db.get() crashes with
    // the libsql driver when no rows match (normalizeRow receives undefined).
    // Using db.all()[0] avoids the crash for all drivers.
    //
    // All three exec helpers use `await` unconditionally rather than
    // `instanceof Promise` because Drizzle returns SQLiteRaw thenables
    // that are NOT Promise instances (drizzle-team/drizzle-orm#2275).
    return runWithSerializedQueue(serializedQueue, async () => {
      const rows = await db.all(query);
      return (rows as T[])[0];
    });
  }

  function execAll<T>(query: SQL): Promise<T[]> {
    return runWithSerializedQueue(serializedQueue, async () => {
      return await db.all(query);
    });
  }

  function execRun(query: SQL): Promise<void> {
    return runWithSerializedQueue(serializedQueue, async () => {
      await db.run(query);
    });
  }

  const commonBackend = createCommonOperationBackend({
    batchConfig: {
      checkUniqueBatchChunkSize: SQLITE_CHECK_UNIQUE_BATCH_CHUNK_SIZE,
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

  const vectorEmbeddingMethods =
    options.hasVectorEmbeddings
      ? {
          async upsertEmbedding(params: UpsertEmbeddingParams): Promise<void> {
            const query = operationStrategy.buildUpsertEmbedding(
              params,
              nowIso(),
            );
            await execRun(query);
          },
          async deleteEmbedding(params: DeleteEmbeddingParams): Promise<void> {
            const query = operationStrategy.buildDeleteEmbedding(params);
            await execRun(query);
          },
        }
      : {};

  const operationBackend: TransactionBackend = {
    ...commonBackend,
    ...executeRawMethod,
    ...vectorEmbeddingMethods,
    capabilities,
    dialect: "sqlite",
    tableNames,
    fulltextStrategy,

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

    // === Fulltext Operations ===

    async upsertFulltext(params: UpsertFulltextParams): Promise<void> {
      const timestamp = nowIso();
      const statements = operationStrategy.buildUpsertFulltext(
        params,
        timestamp,
      );
      for (const stmt of statements) {
        await execRun(stmt);
      }
    },

    async deleteFulltext(params: DeleteFulltextParams): Promise<void> {
      const statements = operationStrategy.buildDeleteFulltext(params);
      for (const stmt of statements) {
        await execRun(stmt);
      }
    },

    async upsertFulltextBatch(
      params: UpsertFulltextBatchParams,
    ): Promise<void> {
      if (params.rows.length === 0) return;
      const timestamp = nowIso();
      const statements = operationStrategy.buildUpsertFulltextBatch(
        params,
        timestamp,
      );
      for (const stmt of statements) {
        await execRun(stmt);
      }
    },

    async deleteFulltextBatch(
      params: DeleteFulltextBatchParams,
    ): Promise<void> {
      if (params.nodeIds.length === 0) return;
      const statements = operationStrategy.buildDeleteFulltextBatch(params);
      for (const stmt of statements) {
        await execRun(stmt);
      }
    },

    async fulltextSearch(
      params: FulltextSearchParams,
    ): Promise<readonly FulltextSearchResult[]> {
      const query = operationStrategy.buildFulltextSearch(params);
      const rows = await execAll<{
        node_id: string;
        score: number;
        snippet: string | null;
      }>(query);
      return rows.map((row, index) => ({
        nodeId: row.node_id,
        score: row.score,
        rank: index + 1,
        ...(row.snippet === null ? {} : { snippet: row.snippet }),
      }));
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
  const fulltextStrategy = options.fulltext ?? fts5Strategy;
  const profileHints = options.executionProfile ?? {};
  const executionAdapter = createSqliteExecutionAdapter(db, { profileHints });
  const { isSync, transactionMode } = executionAdapter.profile;
  const baseCapabilities: BackendCapabilities =
    transactionMode === "none"
      ? { ...SQLITE_CAPABILITIES, transactions: false }
      : SQLITE_CAPABILITIES;
  const capabilities: BackendCapabilities = {
    ...baseCapabilities,
    fulltext: buildFulltextCapabilities(fulltextStrategy),
  };

  const tableNames: SqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    embeddings: getTableName(tables.embeddings),
    fulltext: tables.fulltextTableName,
  };
  const operationStrategy = createSqliteOperationStrategy(
    tables,
    fulltextStrategy,
  );
  const serializedQueue = isSync ? createSerializedExecutionQueue() : undefined;
  // Explicit opt-in: wire upsertEmbedding / deleteEmbedding only when
  // the caller confirms sqlite-vec is loaded. Probing synchronously
  // isn't portable across drizzle SQLite drivers (sync vs async), so
  // the gate lives with the caller that loaded the extension.
  const hasVectorEmbeddings = options.hasVectorEmbeddings === true;
  const operations = createSqliteOperationBackend({
    capabilities,
    db,
    executionAdapter,
    operationStrategy,
    tableNames,
    fulltextStrategy,
    hasVectorEmbeddings,
    ...(serializedQueue === undefined ? {} : { serializedQueue }),
  });

  const backend: GraphBackend = {
    ...operations,

    async bootstrapTables(): Promise<void> {
      const statements = generateSqliteDDL(tables, fulltextStrategy);
      for (const statement of statements) {
        await db.run(sql.raw(statement));
      }
    },

    async setActiveSchema(graphId: string, version: number): Promise<void> {
      await backend.transaction(async (txBackend) => {
        await txBackend.setActiveSchema(graphId, version);
      });
    },

    async transaction<T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      _options?: TransactionOptions,
    ): Promise<T> {
      if (transactionMode === "none") {
        throw new ConfigurationError(
          "This SQLite backend does not support atomic transactions. " +
            "Operations within a transaction are not rolled back on failure. " +
            "Use backend.capabilities.transactions to check for transaction support, " +
            "or use individual operations with manual error handling.",
          {
            backend: "sqlite",
            capability: "transactions",
            supportsTransactions: false,
          },
        );
      }

      if (transactionMode === "sql") {
        return runWithSerializedQueue(serializedQueue, async () => {
          const txBackend = createTransactionBackend({
            capabilities,
            db,
            executionAdapter,
            operationStrategy,
            profileHints: { isSync: true },
            tableNames,
            fulltextStrategy,
            hasVectorEmbeddings,
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

      // transactionMode === "drizzle"
      return runWithSerializedQueue(serializedQueue, async () =>
        db.transaction(async (tx) => {
          const txBackend = createTransactionBackend({
            capabilities,
            db: tx,
            operationStrategy,
            profileHints: { isSync },
            tableNames,
            fulltextStrategy,
            hasVectorEmbeddings,
          });
          return fn(txBackend);
        }) as Promise<T>,
      );
    },

    close(): Promise<void> {
      serializedQueue?.dispose();
      return Promise.resolve();
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
    fulltextStrategy: options.fulltextStrategy,
    ...(options.hasVectorEmbeddings === undefined
      ? {}
      : { hasVectorEmbeddings: options.hasVectorEmbeddings }),
  });
}

// Re-export schema utilities
export type { SqliteTableNames,SqliteTables } from "./schema/sqlite";
export { createSqliteTables, tables } from "./schema/sqlite";
