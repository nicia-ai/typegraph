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
import {
  and,
  eq,
  getTableName,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import { BackendDisposedError, ConfigurationError } from "../../errors";
import type { ResolvedSqlTableNames } from "../../query/compiler/schema";
import { quoteIdentifier } from "../../query/compiler/utils";
import {
  buildFulltextCapabilities,
  fts5Strategy,
  type FulltextStrategy,
} from "../../query/dialect/fulltext-strategy";
import {
  assertVectorSearchLimit,
  buildVectorCapabilities,
  type VectorSlot,
  type VectorStrategy,
} from "../../query/dialect/vector-strategy";
import { chunk as chunkArray } from "../../utils/array";
import { isMissingTableError } from "../../utils/sql-errors";
import {
  type AdoptedTransaction,
  type BackendCapabilities,
  type CommitSchemaVersionParams,
  type ContributionMaterializationIdentity,
  type ContributionMaterializationRow,
  type CreateVectorIndexParams,
  type DeleteEmbeddingParams,
  type DeleteFulltextBatchParams,
  type DeleteFulltextParams,
  type DropVectorIndexParams,
  type FulltextSearchParams,
  type FulltextSearchResult,
  type GraphBackend,
  type HybridSearchParams,
  type HybridSearchRow,
  type IndexMaterializationRow,
  INTERNAL_TEMPORARY_WRITES,
  type KindRemovalRow,
  type RecordContributionMaterializationParams,
  type RecordIndexMaterializationParams,
  type RecordKindRemovalParams,
  type SchemaVersionRow,
  type SetActiveVersionParams,
  SQLITE_CAPABILITIES,
  SQLITE_MAX_BIND_PARAMETERS,
  type TransactionBackend,
  type TransactionOptions,
  type UpsertEmbeddingBatchParams,
  type UpsertEmbeddingParams,
  type UpsertFulltextBatchParams,
  type UpsertFulltextParams,
  type VectorSearchParams,
  type VectorSearchResult,
} from "../types";
import {
  type AnySqliteDatabase,
  createSqliteExecutionAdapter,
  type SqliteExecutionAdapter,
  type SqliteExecutionProfileHints,
} from "./execution/sqlite-execution";
import {
  EMBEDDING_UPSERT_PARAM_COUNT,
  mapVectorWriteError,
  vectorSlotFromCreateIndexParams,
  vectorSlotFromDropIndexParams,
  vectorSlotFromParams,
} from "./vector-runtime";
export type { SqliteTransactionMode } from "./execution/sqlite-execution";
import {
  buildContributionInsertValues,
  buildContributionOnConflictSet,
  type ContributionMaterializer,
  createContributionMaterializer,
  gateFulltext,
  gateFulltextMethods,
  mapContributionMaterializationRow,
  SQLITE_CONTRIBUTION_MAT_TIMESTAMPS,
} from "./contribution-materializations";
import { generateSqliteCreateTableSQL, generateSqliteDDL } from "./ddl";
import {
  buildMaterializationInsertValues,
  buildMaterializationOnConflictSet,
  mapMaterializationRow,
  SQLITE_INDEX_MAT_TIMESTAMPS,
} from "./index-materializations";
import {
  buildKindRemovalInsertValues,
  buildKindRemovalOnConflictSet,
  mapKindRemovalRow,
  SQLITE_KIND_REMOVAL_TIMESTAMPS,
} from "./kind-removals";
import {
  assertAdoptedDialect,
  type CommonOperationBackend,
  createCommonOperationBackend,
  type InternalOperationBackend,
} from "./operation-backend-core";
import { hybridCandidatesRef, mapHybridSearchRow } from "./operations/hybrid";
import { createSqliteOperationStrategy } from "./operations/strategy";
import {
  coerceNumericScore,
  createEdgeRowMapper,
  createNodeRowMapper,
  createSchemaVersionRowMapper,
  createUniqueRowMapper,
  nowIso,
  SQLITE_ROW_MAPPER_CONFIG,
} from "./row-mappers";
import { type SqliteTables, tables as defaultTables } from "./schema/sqlite";

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
   * Set `transactionMode: "none"` for drivers without transactions (e.g.
   * Cloudflare D1). Durable Objects (`drizzle(ctx.storage)`) auto-detect
   * `transactionMode: "do-sqlite"` and do not need a hint.
   */
  executionProfile?: SqliteExecutionProfileHints;
  /**
   * Fulltext strategy override. Defaults to `fts5Strategy` (SQLite's
   * built-in FTS5 virtual table). Most users should leave this alone.
   */
  fulltext?: FulltextStrategy;
  /**
   * Vector strategy override. When present, the backend owns per-`(kind,
   * field)` typed storage through this strategy (DDL, upsert, delete,
   * similarity search, ANN index lifecycle) and advertises
   * `strategy.capabilities` as `capabilities.vector`. `createLibsqlBackend`
   * passes `libsqlVectorStrategy` unconditionally; `createLocalSqliteBackend`
   * passes `sqliteVecStrategy` when the extension loads. When absent the
   * backend exposes no vector capability and embedding values pass through
   * writes without being indexed — matching existing behavior for SQLite
   * connections without a vector extension.
   */
  vector?: VectorStrategy;
  /**
   * Override specific backend capabilities. Useful for custom SQLite builds
   * or tests that need to simulate an engine-level capability gap.
   */
  capabilities?: Partial<BackendCapabilities>;
}>;

const NODE_INSERT_PARAM_COUNT = 9;
const EDGE_INSERT_PARAM_COUNT = 12;
const GET_NODES_FIXED_PARAM_COUNT = 2;
const GET_EDGES_FIXED_PARAM_COUNT = 1;
const CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT = 3;
const FULLTEXT_UPSERT_PARAM_COUNT = 6;
const FULLTEXT_DELETE_FIXED_PARAM_COUNT = 2;
const UNIQUE_INSERT_PARAM_COUNT = 6;

/**
 * `PRAGMA analysis_limit` value `refreshStatistics()` sets before running
 * `ANALYZE`. Unlike Postgres (whose `ANALYZE` always examines a bounded
 * sample sized off `default_statistics_target`), SQLite's `ANALYZE`
 * defaults to a full table/index scan — O(table size) per call. A caller
 * streaming a bulk load through repeated `bulkInsert()` calls (the only
 * practical pattern for a multi-million-row load) re-triggers
 * `refreshStatistics()` on every batch once that batch's row count crosses
 * `AUTO_REFRESH_STATISTICS_ROW_THRESHOLD`; without this bound, per-call
 * cost grows with total table size, integrating to O(n²) total load time.
 * 1000 is SQLite's own documented suggestion for large databases.
 */
export const SQLITE_ANALYZE_ROW_LIMIT = 1000;

/**
 * Batch chunk sizes for the SQLite operation backend, derived from the
 * connection's bound-parameter budget. Keys mirror the operation backend's
 * `batchConfig`.
 */
export type SqliteBatchChunkSizes = Readonly<{
  checkUniqueBatchChunkSize: number;
  edgeInsertBatchSize: number;
  /** Rows per embedding batch upsert (5 binds per row). */
  embeddingUpsertBatchSize: number;
  /** Rows per fulltext batch upsert (6 binds per row on FTS5). */
  fulltextUpsertBatchSize: number;
  /** Node ids per fulltext batch delete (2 fixed binds + one per id). */
  fulltextDeleteChunkSize: number;
  getEdgesChunkSize: number;
  getNodesChunkSize: number;
  nodeInsertBatchSize: number;
  uniqueInsertBatchSize: number;
}>;

/**
 * Derives batch chunk sizes from a per-statement bound-parameter budget.
 * The budget varies by driver — better-sqlite3 compiles in 32,766, D1 caps
 * at ~100, undetectable async drivers keep the 999 floor — so chunk math is
 * computed per backend instance rather than fixed at module scope.
 */
export function computeSqliteBatchChunkSizes(
  maxBindParameters: number,
): SqliteBatchChunkSizes {
  return {
    checkUniqueBatchChunkSize: Math.max(
      1,
      maxBindParameters - CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT,
    ),
    embeddingUpsertBatchSize: Math.max(
      1,
      Math.floor(maxBindParameters / EMBEDDING_UPSERT_PARAM_COUNT),
    ),
    fulltextUpsertBatchSize: Math.max(
      1,
      Math.floor(maxBindParameters / FULLTEXT_UPSERT_PARAM_COUNT),
    ),
    fulltextDeleteChunkSize: Math.max(
      1,
      maxBindParameters - FULLTEXT_DELETE_FIXED_PARAM_COUNT,
    ),
    edgeInsertBatchSize: Math.max(
      1,
      Math.floor(maxBindParameters / EDGE_INSERT_PARAM_COUNT),
    ),
    getEdgesChunkSize: Math.max(
      1,
      maxBindParameters - GET_EDGES_FIXED_PARAM_COUNT,
    ),
    getNodesChunkSize: Math.max(
      1,
      maxBindParameters - GET_NODES_FIXED_PARAM_COUNT,
    ),
    nodeInsertBatchSize: Math.max(
      1,
      Math.floor(maxBindParameters / NODE_INSERT_PARAM_COUNT),
    ),
    uniqueInsertBatchSize: Math.max(
      1,
      Math.floor(maxBindParameters / UNIQUE_INSERT_PARAM_COUNT),
    ),
  };
}

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
const toSchemaVersionRow = createSchemaVersionRowMapper(
  SQLITE_ROW_MAPPER_CONFIG,
);

/** A shared promise that never settles — used to absorb post-dispose work. */
const PENDING_FOREVER: Promise<never> = new Promise<never>(noop);

function pendingForever<T>(): Promise<T> {
  return PENDING_FOREVER;
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

/**
 * Tracks which serialized queue (if any) the current async execution is
 * running a task for, so a re-entrant submission — a root-backend operation
 * awaited from inside a transaction already occupying the same queue — can be
 * rejected with a typed error instead of deadlocking (the enclosing task holds
 * the queue slot until it completes, so the inner operation can never run).
 *
 * AsyncLocalStorage is loaded lazily and optionally: it is available on Node
 * and on Cloudflare workers with the `nodejs_als` compatibility flag, and a
 * runtime without it simply skips the detection (the queue behaves as before).
 */
type QueueTaskContext = Readonly<{
  getStore: () => unknown;
  run: <T>(store: object, callback: () => T) => T;
}>;

let queueTaskContext: QueueTaskContext | undefined;

async function loadQueueTaskContext(): Promise<void> {
  try {
    const asyncHooks = await import("node:async_hooks");
    queueTaskContext = new asyncHooks.AsyncLocalStorage<object>();
  } catch {
    // AsyncLocalStorage unavailable on this runtime: re-entrant submissions
    // stay undetected, matching the queue's previous behavior.
  }
}

// eslint-disable-next-line unicorn/prefer-top-level-await -- the dual CJS/ESM build cannot use top-level await
void loadQueueTaskContext();

function rejectReentrantQueueSubmission(): Promise<never> {
  return Promise.reject(
    new ConfigurationError(
      "This operation was awaited from inside a transaction running on the " +
        "same SQLite backend and would deadlock: the transaction holds the " +
        "backend's serialized execution slot until it completes, so the " +
        "operation could never run.",
      { backend: "sqlite", capability: "concurrentRootAccess" },
      {
        suggestion:
          "Inside a store.transaction callback, use the transaction-scoped " +
          "context (tx.nodes / tx.edges / tx.backend) instead of the root " +
          "store or backend, or move the operation outside the transaction.",
      },
    ),
  );
}

function createSerializedExecutionQueue(): SerializedExecutionQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let disposed = false;
  // Unique per queue: a task running on THIS queue must not submit back to it,
  // but may freely submit to a different backend's queue.
  const taskMarker: object = {};

  function isDisposed(): boolean {
    return disposed;
  }

  return {
    dispose() {
      disposed = true;
    },

    runExclusive<T>(task: () => Promise<T>): Promise<T> {
      if (isDisposed()) return Promise.reject(new BackendDisposedError());
      if (queueTaskContext?.getStore() === taskMarker) {
        return rejectReentrantQueueSubmission();
      }

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
          const context = queueTaskContext;
          return context === undefined ?
              await task()
            : await context.run(taskMarker, () => task());
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

/**
 * The async storage transaction runner Drizzle's durable-sqlite driver
 * exposes as `db.$client` (`ctx.storage.transaction(async () => ...)`).
 * Structural because drizzle-orm does not export the DO `$client` type.
 */
interface DurableObjectStorageClient {
  transaction?: <R>(closure: () => Promise<R>) => Promise<R>;
}

/** Every SQLite "atomic transactions unavailable" refusal shares this shape. */
function throwSqliteTransactionsDisabled(message: string): never {
  throw new ConfigurationError(message, {
    backend: "sqlite",
    capability: "transactions",
    supportsTransactions: false,
  });
}

function buildSqliteCapabilities(
  options: Readonly<{
    fulltextStrategy: FulltextStrategy;
    vectorStrategy: VectorStrategy | undefined;
    transactionMode: SqliteExecutionAdapter["profile"]["transactionMode"];
    maxBindParameters: number;
  }>,
): BackendCapabilities {
  const base =
    options.transactionMode === "none" ?
      { ...SQLITE_CAPABILITIES, transactions: false }
    : SQLITE_CAPABILITIES;
  return {
    ...base,
    maxBindParameters: options.maxBindParameters,
    fulltext: buildFulltextCapabilities(options.fulltextStrategy),
    ...(options.vectorStrategy === undefined ?
      {}
    : { vector: buildVectorCapabilities(options.vectorStrategy) }),
  };
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
  tableNames: ResolvedSqlTableNames;
  fulltextStrategy: FulltextStrategy;
  /**
   * Active vector strategy, or `undefined` when the connection has no
   * vector extension. When present, the backend exposes upsertEmbedding /
   * deleteEmbedding / vectorSearch / createVectorIndex / dropVectorIndex,
   * all routed through this strategy's per-`(kind, field)` storage.
   */
  vectorStrategy?: VectorStrategy | undefined;
  /**
   * Shared durable-marker materializer. The vector methods assert a
   * slot's marker (SELECT, never DDL) on the hot path and `createVectorIndex`
   * ensures it (privileged) — replacing the old in-process ensure-latch.
   * Shared across the outer backend and every transaction-scoped backend
   * so a slot's marker is resolved at most once per process.
   */
  contributionMaterializer: ContributionMaterializer;
}>;

type CreateSqliteTransactionBackendOptions = Readonly<{
  capabilities: GraphBackend["capabilities"];
  db: AnySqliteDatabase;
  executionAdapter?: SqliteExecutionAdapter;
  operationStrategy: ReturnType<typeof createSqliteOperationStrategy>;
  profileHints: SqliteExecutionProfileHints;
  tableNames: ResolvedSqlTableNames;
  fulltextStrategy: FulltextStrategy;
  /** Active vector strategy. See {@link CreateSqliteOperationBackendOptions}. */
  vectorStrategy?: VectorStrategy | undefined;
  /** Shared durable-marker materializer. See {@link CreateSqliteOperationBackendOptions}. */
  contributionMaterializer: ContributionMaterializer;
}>;

function createSqliteOperationBackend(
  options: CreateSqliteOperationBackendOptions,
): InternalOperationBackend {
  const {
    capabilities,
    db,
    executionAdapter,
    operationStrategy,
    serializedQueue,
    tableNames,
    fulltextStrategy,
    vectorStrategy,
    contributionMaterializer,
  } = options;

  // CRUD statements route through the execution adapter's compiled path on
  // synchronous drivers so a repeated operation shape re-binds parameters
  // against a cached prepared statement instead of re-preparing through
  // drizzle's session on every call. Async drivers (remote libsql, D1)
  // have no statement cache and keep the drizzle fallback.
  const compiledExecute = executionAdapter.executeCompiled;
  const compiledRun = executionAdapter.executeCompiledRun;

  function execGet<T>(query: SQL): Promise<T | undefined> {
    // Fallback uses db.all()[0], not db.get(): drizzle-team/drizzle-orm#1049
    // — db.get() crashes with the libsql driver when no rows match
    // (normalizeRow receives undefined).
    //
    // The fallback branches use `await` unconditionally rather than
    // `instanceof Promise` because Drizzle returns SQLiteRaw thenables
    // that are NOT Promise instances (drizzle-team/drizzle-orm#2275).
    return runWithSerializedQueue(serializedQueue, async () => {
      if (compiledExecute === undefined) {
        const rows = await db.all(query);
        return (rows as T[])[0];
      }
      const rows = await compiledExecute<T>(executionAdapter.compile(query));
      return rows[0];
    });
  }

  function execAll<T>(query: SQL): Promise<T[]> {
    return runWithSerializedQueue(serializedQueue, async () => {
      if (compiledExecute === undefined) {
        return await db.all(query);
      }
      return [...(await compiledExecute<T>(executionAdapter.compile(query)))];
    });
  }

  function execRun(query: SQL): Promise<void> {
    return runWithSerializedQueue(serializedQueue, async () => {
      if (compiledRun === undefined) {
        await db.run(query);
        return;
      }
      await compiledRun(executionAdapter.compile(query));
    });
  }

  const batchConfig = computeSqliteBatchChunkSizes(
    capabilities.maxBindParameters ?? SQLITE_MAX_BIND_PARAMETERS,
  );
  const commonBackend = createCommonOperationBackend({
    batchConfig,
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
    vectorStrategy === undefined ?
      {}
    : {
        async upsertEmbedding(params: UpsertEmbeddingParams): Promise<void> {
          const slot = vectorSlotFromParams(params);
          // Assert the slot's durable marker (SELECT, cached) — never DDL.
          // The per-field table is provisioned by the privileged migrator
          // (`createStoreWithSchema` → `materializeVectorContributions`).
          await contributionMaterializer.assertVectorSlot(slot);
          const statements = vectorStrategy.buildUpsert(slot, params, nowIso());
          try {
            for (const statement of statements) {
              await execRun(statement);
            }
          } catch (error) {
            throw mapVectorWriteError(error, params);
          }
        },
        async upsertEmbeddingBatch(
          params: UpsertEmbeddingBatchParams,
        ): Promise<void> {
          if (params.rows.length === 0) return;
          const slot = vectorSlotFromParams(params);
          // Same SELECT-only marker assert as the single-row path — never DDL.
          await contributionMaterializer.assertVectorSlot(slot);
          // Last-write-wins dedupe: a multi-row upsert cannot affect one
          // row twice.
          const rowsById = new Map(
            params.rows.map((row) => [row.nodeId, row] as const),
          );
          const rows = [...rowsById.values()];
          const timestamp = nowIso();
          try {
            for (const chunk of chunkArray(
              rows,
              batchConfig.embeddingUpsertBatchSize,
            )) {
              const statements =
                vectorStrategy.buildUpsertBatch === undefined ?
                  chunk.flatMap((row) =>
                    vectorStrategy.buildUpsert(
                      slot,
                      {
                        graphId: params.graphId,
                        nodeKind: params.nodeKind,
                        nodeId: row.nodeId,
                        fieldPath: params.fieldPath,
                        embedding: row.embedding,
                        dimensions: params.dimensions,
                        metric: params.metric,
                        indexType: params.indexType,
                      },
                      timestamp,
                    ),
                  )
                : vectorStrategy.buildUpsertBatch(
                    slot,
                    { ...params, rows: chunk },
                    timestamp,
                  );
              for (const statement of statements) {
                await execRun(statement);
              }
            }
          } catch (error) {
            throw mapVectorWriteError(error, params);
          }
        },
        async deleteEmbedding(params: DeleteEmbeddingParams): Promise<void> {
          // Assert the slot's durable marker before deleting. A delete can
          // run before any embedding was ever written for the field (e.g. a
          // node hard-deleted having never carried one); the per-field table
          // was provisioned at boot, so the DELETE is a clean no-op against
          // an existing (possibly empty) table, matching the Postgres path
          // (where a DELETE on a missing relation would abort an enclosing
          // transaction). SELECT-only assert, never DDL.
          const slot = vectorSlotFromParams(params);
          await contributionMaterializer.assertVectorSlot(slot);
          const statements = vectorStrategy.buildDelete(slot, params);
          for (const statement of statements) {
            await execRun(statement);
          }
        },
        async vectorSearch(
          params: VectorSearchParams,
        ): Promise<readonly VectorSearchResult[]> {
          assertVectorSearchLimit(params.limit);
          // Deliberately NOT marker-gated: search is read-only (no DDL
          // hazard to gate), and its params carry the caller's runtime
          // metric override, which legitimately diverges from the
          // provisioned shape on strategies that bake the metric into the
          // DDL (sqlite-vec). An unprovisioned slot surfaces the engine's
          // missing-relation error — the same contract as a query-builder
          // `similarTo()` predicate; `createVerifiedStore` catches both at
          // attach.
          const slot = vectorSlotFromParams(params);
          const query = vectorStrategy.buildSearch(
            slot,
            params,
            // Store-compiled candidates (predicates + subclass + currency)
            // take precedence; the live-node default covers direct backend use.
            params.candidates ??
              operationStrategy.buildLiveNodeIds(
                params.graphId,
                params.nodeKind,
              ),
          );
          let rows: readonly { node_id: string; score: number }[];
          try {
            rows = await execAll<{ node_id: string; score: number }>(query);
          } catch (error) {
            // A query vector whose dimension no longer matches the stored
            // column surfaces the same typed error as the write path.
            throw mapVectorWriteError(error, params);
          }
          return rows.map((row) => ({
            nodeId: row.node_id,
            score: row.score,
          }));
        },
        // Single-statement hybrid needs ROW_NUMBER(); a capability profile
        // that disables window functions keeps the store's multi-statement
        // fallback by simply not exposing the member.
        ...(capabilities.windowFunctions ?
          {
            async hybridSearch(
              params: HybridSearchParams,
            ): Promise<readonly HybridSearchRow[]> {
              assertVectorSearchLimit(params.limit);
              // Source depths get the same boundary validation the
              // fallback path applies (vectorSearch validates its limit;
              // the fulltext depth is validated inside
              // buildFulltextSearch).
              assertVectorSearchLimit(params.vector.k);
              const slot = vectorSlotFromParams({
                graphId: params.graphId,
                nodeKind: params.nodeKind,
                fieldPath: params.vector.fieldPath,
                dimensions: params.vector.dimensions,
                metric: params.vector.metric,
                indexType: params.vector.indexType,
              });
              // Read-only, not marker-gated — see vectorSearch above.
              const candidates =
                params.candidates ??
                operationStrategy.buildLiveNodeIds(
                  params.graphId,
                  params.nodeKind,
                );
              const vectorParams: VectorSearchParams = {
                graphId: params.graphId,
                nodeKind: params.nodeKind,
                fieldPath: params.vector.fieldPath,
                queryEmbedding: params.vector.queryEmbedding,
                metric: params.vector.metric,
                dimensions: params.vector.dimensions,
                indexType: params.vector.indexType,
                limit: params.vector.k,
                ...(params.vector.minScore === undefined ?
                  {}
                : { minScore: params.vector.minScore }),
              };
              // The vector leg references the statement's shared
              // tg_hybrid_cand CTE; the actual candidates SQL is emitted
              // once by buildHybridSearch.
              const vectorSql = vectorStrategy.buildSearch(
                slot,
                vectorParams,
                hybridCandidatesRef(),
              );
              const statement = operationStrategy.buildHybridSearch(
                { ...params, candidates },
                vectorSql,
                params.vector.metric === "cosine",
              );
              let raw: readonly Record<string, unknown>[];
              try {
                raw = await execAll<Record<string, unknown>>(statement);
              } catch (error) {
                throw mapVectorWriteError(error, vectorParams);
              }
              return raw.map((row) => mapHybridSearchRow(row, toNodeRow));
            },
          }
        : {}),
      };

  const operationBackend: InternalOperationBackend = {
    ...commonBackend,
    ...executeRawMethod,
    ...vectorEmbeddingMethods,
    capabilities,
    dialect: "sqlite",
    tableNames,
    fulltextStrategy,
    ...(vectorStrategy === undefined ? {} : { vectorStrategy }),

    async createVectorIndex(params: CreateVectorIndexParams): Promise<void> {
      if (vectorStrategy === undefined) return;
      const slot = vectorSlotFromCreateIndexParams(params);
      // Ensure the per-field table + its durable marker first (privileged,
      // idempotent), then create its ANN index. `ownedTables` already folds
      // the index DDL in, so the explicit `buildCreateIndex` step is
      // belt-and-suspenders for slots whose index intent changed after the
      // table was first materialized.
      await contributionMaterializer.ensureVectorSlot(slot);
      const indexStatement = vectorStrategy.buildCreateIndex?.(slot);
      if (indexStatement !== undefined) {
        await execRun(indexStatement);
      }
    },

    async dropVectorIndex(params: DropVectorIndexParams): Promise<void> {
      if (vectorStrategy === undefined) return;
      const slot = vectorSlotFromDropIndexParams(params);
      const dropStatement = vectorStrategy.buildDropIndex?.(slot);
      if (dropStatement === undefined) return;
      try {
        await execRun(dropStatement);
      } catch (error) {
        // The per-field table (and thus its index) may never have been
        // materialized; DROP INDEX IF EXISTS against a missing table errors
        // on some drivers, so treat that as already-dropped.
        if (!isMissingTableError(error)) throw error;
      }
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
      // The strategy emits ONE statement over every row it is given, so
      // the bind budget is enforced here — same contract as node/edge
      // batch inserts.
      for (const rows of chunkArray(
        params.rows,
        batchConfig.fulltextUpsertBatchSize,
      )) {
        const statements = operationStrategy.buildUpsertFulltextBatch(
          { ...params, rows },
          timestamp,
        );
        for (const stmt of statements) {
          await execRun(stmt);
        }
      }
    },

    async deleteFulltextBatch(
      params: DeleteFulltextBatchParams,
    ): Promise<void> {
      if (params.nodeIds.length === 0) return;
      for (const nodeIds of chunkArray(
        params.nodeIds,
        batchConfig.fulltextDeleteChunkSize,
      )) {
        const statements = operationStrategy.buildDeleteFulltextBatch({
          ...params,
          nodeIds,
        });
        for (const stmt of statements) {
          await execRun(stmt);
        }
      }
    },

    async fulltextSearch(
      params: FulltextSearchParams,
    ): Promise<readonly FulltextSearchResult[]> {
      const query = operationStrategy.buildFulltextSearch(params);
      const rows = await execAll<{
        node_id: string;
        score: number | string;
        snippet: string | null;
      }>(query);
      return rows.map((row, index) => ({
        nodeId: row.node_id,
        score: coerceNumericScore(row.score),
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

    compileSql(
      query: SQL,
    ): Readonly<{ sql: string; params: readonly unknown[] }> {
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
  // The active vector strategy gates upsertEmbedding / deleteEmbedding /
  // vectorSearch and supplies the per-`(kind, field)` storage. Passed by
  // the caller that knows the connection's vector capability
  // (`createLibsqlBackend` always; `createLocalSqliteBackend` when the
  // extension loads); absent for plain SQLite drivers with no extension.
  const vectorStrategy = options.vector;
  const capabilities: BackendCapabilities = {
    ...buildSqliteCapabilities({
      fulltextStrategy,
      vectorStrategy,
      transactionMode,
      maxBindParameters: executionAdapter.profile.maxBindParameters,
    }),
    ...options.capabilities,
  };

  const tableNames: ResolvedSqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    recordedNodes: getTableName(tables.recordedNodes),
    recordedEdges: getTableName(tables.recordedEdges),
    recordedClock: getTableName(tables.recordedClock),
    revisionOrigins: getTableName(tables.revisionOrigins),
    fulltext: tables.fulltextTableName,
    uniques: getTableName(tables.uniques),
  };
  // refreshStatistics() scopes ANALYZE to these — matching the Postgres
  // backend, which never touches unrelated tables sharing the database.
  // The recorded relations are ANALYZEd separately under a missing-table
  // guard: a schema created before recorded-time history landed
  // (bring-your-own-connection, no DDL re-run) has no recorded_* tables.
  const coreAnalyzeTables = [
    tableNames.nodes,
    tableNames.edges,
    tableNames.uniques,
    tableNames.fulltext,
  ];
  const recordedAnalyzeTables = [
    tableNames.recordedNodes,
    tableNames.recordedEdges,
    tableNames.recordedClock,
  ] as const;
  const operationStrategy = createSqliteOperationStrategy(
    tables,
    fulltextStrategy,
  );
  // Serialize top-level operations per backend on every transaction-capable
  // mode ("sql", "drizzle", "do-sqlite"). SQLite is single-writer, and two
  // concurrent `transaction()` calls on one connection open overlapping BEGINs
  // and collide with SQLITE_BUSY; the queue makes each top-level operation —
  // including a whole transaction — run to completion before the next starts.
  // A transaction's inner reads/writes run on the tx-scoped backend, which
  // does not carry the queue (see CreateSqliteTransactionBackendOptions);
  // awaiting a ROOT-backend operation from inside the transaction callback
  // would deadlock, so the queue rejects such re-entrant submissions with a
  // typed error (see rejectReentrantQueueSubmission). `none` drivers (D1 /
  // neon-http) have no transactions and manage their own concurrency, so they
  // stay unqueued.
  const serializedQueue =
    transactionMode === "none" ? undefined : createSerializedExecutionQueue();

  // Durable fulltext + vector materialization (#135): the dialect-specific
  // marker-table primitives. Orchestration (materialize / assert /
  // per-instance cache) lives once in `createContributionMaterializer`,
  // shared by the outer backend and every transaction-scoped backend so a
  // slot's marker is resolved at most once per process. Built before
  // `operations` so the operation backend's vector methods can assert/
  // ensure through it instead of issuing DDL on the hot path.
  const matTable = tables.contributionMaterializations;

  async function ensureContributionMaterializationsTableImpl(): Promise<void> {
    await db.run(sql.raw(generateSqliteCreateTableSQL(matTable)));
  }

  async function getContributionMaterializationRow(
    identity: ContributionMaterializationIdentity,
  ): Promise<ContributionMaterializationRow | undefined> {
    const rows = await db
      .select()
      .from(matTable)
      .where(
        and(
          eq(matTable.graphId, identity.graphId),
          eq(matTable.logicalName, identity.logicalName),
          eq(matTable.owner, identity.owner),
          eq(matTable.tableName, identity.tableName),
        ),
      );
    const row = rows[0];
    if (row === undefined) return undefined;
    return mapContributionMaterializationRow(
      row,
      SQLITE_CONTRIBUTION_MAT_TIMESTAMPS.decode,
    );
  }

  async function getContributionMaterializationRows(
    graphId: string,
  ): Promise<readonly ContributionMaterializationRow[]> {
    const rows = await db
      .select()
      .from(matTable)
      .where(eq(matTable.graphId, graphId));
    return rows.map((row) =>
      mapContributionMaterializationRow(
        row,
        SQLITE_CONTRIBUTION_MAT_TIMESTAMPS.decode,
      ),
    );
  }

  async function recordContributionMaterializationRow(
    params: RecordContributionMaterializationParams,
  ): Promise<void> {
    await db
      .insert(matTable)
      .values(
        buildContributionInsertValues(
          params,
          SQLITE_CONTRIBUTION_MAT_TIMESTAMPS.encode,
        ),
      )
      .onConflictDoUpdate({
        target: [
          matTable.graphId,
          matTable.logicalName,
          matTable.owner,
          matTable.tableName,
        ],
        set: buildContributionOnConflictSet(
          matTable.materializedAt,
          params.materializedAt,
        ),
      });
  }

  async function deleteContributionMaterializationRow(
    identity: ContributionMaterializationIdentity,
  ): Promise<void> {
    await db
      .delete(matTable)
      .where(
        and(
          eq(matTable.graphId, identity.graphId),
          eq(matTable.logicalName, identity.logicalName),
          eq(matTable.owner, identity.owner),
          eq(matTable.tableName, identity.tableName),
        ),
      );
  }

  const contributionMaterializer = createContributionMaterializer({
    dialect: "sqlite",
    fulltextStrategy,
    fulltextTableName: tables.fulltextTableName,
    vectorStrategy,
    execDdl: async (statement) => {
      await db.run(sql.raw(statement));
    },
    ensureMarkerTable: ensureContributionMaterializationsTableImpl,
    getMarkers: getContributionMaterializationRows,
    recordMarker: recordContributionMaterializationRow,
    deleteMarker: deleteContributionMaterializationRow,
  });

  const operations = createSqliteOperationBackend({
    capabilities,
    db,
    executionAdapter,
    operationStrategy,
    tableNames,
    fulltextStrategy,
    vectorStrategy,
    contributionMaterializer,
    ...(serializedQueue === undefined ? {} : { serializedQueue }),
  });

  /**
   * #140: the `transactionMode: "do-sqlite"` primitive. Cloudflare
   * Durable Objects expose an async storage transaction runner —
   * `ctx.storage.transaction(async () => ...)`, surfaced by Drizzle as
   * `db.$client.transaction` — that rolls back SQL writes across
   * `await`. There is no Drizzle tx handle on DO: the storage
   * transaction is ambient on the object, so callers bind the *outer*
   * `db` (as the "sql" path binds the outer connection). Drizzle's own
   * `db.transaction()` here is `ctx.storage.transactionSync` and cannot
   * span an await, so it is deliberately not used. Shared by
   * `transaction()` (business writes) and `runSchemaWriteTransaction()`
   * (schema-version commits — data only, never DDL: the #135 invariant
   * holds because `bootstrapTables` runs outside any transaction).
   */
  function runDoSqliteStorageTransaction<T>(run: () => Promise<T>): Promise<T> {
    const storage = (db as { $client?: DurableObjectStorageClient }).$client;
    const storageTransaction = storage?.transaction;
    if (typeof storageTransaction !== "function") {
      throwSqliteTransactionsDisabled(
        "transactionMode 'do-sqlite' requires a Drizzle Durable Objects " +
          "database (drizzle(ctx.storage)) whose `$client` exposes the " +
          "async storage `transaction(async () => ...)` runner.",
      );
    }
    return runWithSerializedQueue(
      serializedQueue,
      async () => storageTransaction.call(storage, run) as Promise<T>,
    );
  }

  /**
   * Executes a transaction-frame statement (BEGIN IMMEDIATE / COMMIT /
   * ROLLBACK) through the prepared-statement cache when the driver has one.
   * These are the hottest statements on the per-write path (every single
   * write is its own transaction). Local libsql also uses "sql" transaction
   * mode but is async (no compiled path) and keeps the drizzle fallback.
   */
  async function runFrameStatement(query: SQL): Promise<void> {
    const compiledRun = executionAdapter.executeCompiledRun;
    if (compiledRun === undefined) {
      await db.run(query);
      return;
    }
    await compiledRun(executionAdapter.compile(query));
  }

  /**
   * Runs `fn` inside a SQLite write transaction (BEGIN IMMEDIATE) so that
   * the read-then-write inside `commitSchemaVersion` / `setActiveVersion`
   * is serialized against concurrent writers — a deferred BEGIN would let
   * two transactions race past the CAS read and one would later fail
   * with SQLITE_BUSY instead of producing a clean StaleVersionError.
   *
   * Refuses on `transactionMode: "none"`. The orphan-row crash window
   * cannot be eliminated without atomicity.
   */
  function runSchemaWriteTransaction<T>(
    fn: (tx: CommonOperationBackend) => Promise<T>,
  ): Promise<T> {
    if (transactionMode === "none") {
      throwSqliteTransactionsDisabled(
        "commitSchemaVersion and setActiveVersion require atomic transactions, " +
          "but this SQLite backend has transactions disabled. Configure a " +
          "driver that supports transactions (better-sqlite3, libsql, " +
          "bun:sqlite) to use schema commits.",
      );
    }

    if (transactionMode === "sql") {
      return runWithSerializedQueue(serializedQueue, async () => {
        // Write-lock is held here, so the schema-write-capable
        // InternalOperationBackend is used intentionally (see its type).
        const txBackend = createTransactionBackend({
          capabilities,
          db,
          executionAdapter,
          operationStrategy,
          profileHints: { isSync },
          tableNames,
          fulltextStrategy,
          vectorStrategy,
          contributionMaterializer,
        });
        await runFrameStatement(sql`BEGIN IMMEDIATE`);
        try {
          const result = await fn(txBackend);
          await runFrameStatement(sql`COMMIT`);
          return result;
        } catch (error) {
          await runFrameStatement(sql`ROLLBACK`);
          throw error;
        }
      });
    }

    if (transactionMode === "do-sqlite") {
      // No interactive lock-mode control on the DO storage runner; the
      // serialized queue (always present — DO is sync) provides the
      // single-writer ordering that "immediate" gives the other paths.
      // Raw txBackend (no `gateFulltext`, unlike the business
      // `transaction()` do-sqlite branch): schema-version commits are
      // data-only and never touch fulltext (#135), matching the "sql"
      // and "drizzle" schema-write branches.
      return runDoSqliteStorageTransaction(async () => {
        const txBackend = createTransactionBackend({
          capabilities,
          db,
          operationStrategy,
          profileHints: { isSync },
          tableNames,
          fulltextStrategy,
          vectorStrategy,
          contributionMaterializer,
        });
        return fn(txBackend);
      });
    }

    // transactionMode === "drizzle". Drizzle's sqlite-core transaction
    // accepts a `behavior` option that maps to BEGIN / BEGIN IMMEDIATE /
    // BEGIN EXCLUSIVE; "immediate" is what we need to acquire a reserved
    // write lock at the start of the transaction.
    return runWithSerializedQueue(
      serializedQueue,
      async () =>
        db.transaction(
          async (tx) => {
            const txBackend = createTransactionBackend({
              capabilities,
              db: tx,
              operationStrategy,
              profileHints: { isSync },
              tableNames,
              fulltextStrategy,
              vectorStrategy,
              contributionMaterializer,
            });
            return fn(txBackend);
          },
          { behavior: "immediate" },
        ) as Promise<T>,
    );
  }

  // Shared by the "drizzle" branch of `transaction()` (TypeGraph opens
  // the tx) and `adoptTransaction()` (#134 — the caller already opened
  // it): bind a tx-scoped backend to the *literal* `tx` client and gate
  // fulltext on the durable marker (a cached SELECT, never DDL).
  function bindTransactionBackend(tx: AnySqliteDatabase): TransactionBackend {
    const txBackend = createTransactionBackend({
      capabilities,
      db: tx,
      operationStrategy,
      profileHints: { isSync },
      tableNames,
      fulltextStrategy,
      vectorStrategy,
      contributionMaterializer,
    });
    return gateFulltext(txBackend, contributionMaterializer.assertInitialized);
  }

  const backend: GraphBackend = {
    ...operations,

    async bootstrapTables(): Promise<void> {
      const statements = generateSqliteDDL(tables, fulltextStrategy);
      for (const statement of statements) {
        await db.run(sql.raw(statement));
      }
    },

    async ensureRevisionOriginsTable(): Promise<void> {
      await db.run(
        sql.raw(generateSqliteCreateTableSQL(tables.revisionOrigins)),
      );
    },

    // Every fulltext-touching method asserts the durable marker instead
    // of lazily emitting DDL. Steady state performs zero ensure; an
    // uninitialized database throws `StoreNotInitializedError` rather
    // than self-healing (#135). Shared verbatim with the tx-scoped gate
    // via `gateFulltextMethods`.
    ...gateFulltextMethods(
      operations,
      contributionMaterializer.assertInitialized,
    ),

    async executeDdl(ddl: string): Promise<void> {
      await db.run(sql.raw(ddl));
    },

    async ensureIndexMaterializationsTable(): Promise<void> {
      await db.run(
        sql.raw(generateSqliteCreateTableSQL(tables.indexMaterializations)),
      );
    },

    async getIndexMaterialization(
      indexName: string,
    ): Promise<IndexMaterializationRow | undefined> {
      const t = tables.indexMaterializations;
      const rows = await db.select().from(t).where(eq(t.indexName, indexName));
      const row = rows[0];
      if (row === undefined) return undefined;
      return mapMaterializationRow(row, SQLITE_INDEX_MAT_TIMESTAMPS.decode);
    },

    async getIndexMaterializations(
      statusKeys: readonly string[],
    ): Promise<readonly IndexMaterializationRow[]> {
      if (statusKeys.length === 0) return [];
      const t = tables.indexMaterializations;
      const rows = await db
        .select()
        .from(t)
        .where(inArray(t.indexName, [...statusKeys]));
      return rows.map((row) =>
        mapMaterializationRow(row, SQLITE_INDEX_MAT_TIMESTAMPS.decode),
      );
    },

    async recordIndexMaterialization(
      params: RecordIndexMaterializationParams,
    ): Promise<void> {
      const t = tables.indexMaterializations;
      await db
        .insert(t)
        .values(
          buildMaterializationInsertValues(
            params,
            SQLITE_INDEX_MAT_TIMESTAMPS.encode,
          ),
        )
        .onConflictDoUpdate({
          target: t.indexName,
          set: buildMaterializationOnConflictSet(
            t.materializedAt,
            params.materializedAt,
          ),
        });
    },

    async ensureContributionMaterializationsTable(): Promise<void> {
      await ensureContributionMaterializationsTableImpl();
    },

    async getContributionMaterialization(
      identity: ContributionMaterializationIdentity,
    ): Promise<ContributionMaterializationRow | undefined> {
      return getContributionMaterializationRow(identity);
    },

    async recordContributionMaterialization(
      params: RecordContributionMaterializationParams,
    ): Promise<void> {
      await recordContributionMaterializationRow(params);
    },

    async assertRuntimeContributionsInitialized(
      graphId: string,
    ): Promise<void> {
      await contributionMaterializer.assertInitialized(graphId);
    },

    async ensureKindRemovalsTable(): Promise<void> {
      await db.run(sql.raw(generateSqliteCreateTableSQL(tables.kindRemovals)));
    },

    async getPendingKindRemovals(
      graphId: string,
    ): Promise<readonly KindRemovalRow[]> {
      const t = tables.kindRemovals;
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.graphId, graphId), isNull(t.removedAt)));
      return rows.map((row) =>
        mapKindRemovalRow(row, SQLITE_KIND_REMOVAL_TIMESTAMPS.decode),
      );
    },

    async getAllKindRemovals(
      graphId: string,
    ): Promise<readonly KindRemovalRow[]> {
      const t = tables.kindRemovals;
      const rows = await db.select().from(t).where(eq(t.graphId, graphId));
      return rows.map((row) =>
        mapKindRemovalRow(row, SQLITE_KIND_REMOVAL_TIMESTAMPS.decode),
      );
    },

    async recordKindRemoval(params: RecordKindRemovalParams): Promise<void> {
      const t = tables.kindRemovals;
      await db
        .insert(t)
        .values(
          buildKindRemovalInsertValues(
            params,
            SQLITE_KIND_REMOVAL_TIMESTAMPS.encode,
          ),
        )
        .onConflictDoUpdate({
          target: [t.graphId, t.kindName, t.entity, t.schemaVersion],
          set: buildKindRemovalOnConflictSet(t.removedAt, params.removedAt),
        });
    },

    async ensureReconciliationMarkersTable(): Promise<void> {
      await db.run(
        sql.raw(generateSqliteCreateTableSQL(tables.reconciliationMarkers)),
      );
    },

    async ensureRuntimeContributions(graphId: string): Promise<void> {
      await contributionMaterializer.ensureRuntimeContributions(graphId);
    },

    /**
     * Superseded by `ensureRuntimeContributions(graphId)` (#129).
     * Retained as a thin back-compat wrapper for callers predating
     * #129; #135 routed it through the durable-marker writer.
     */
    async ensureFulltextTable(graphId: string): Promise<void> {
      await contributionMaterializer.ensureRuntimeContributions(graphId);
    },

    // Vector counterparts of the runtime-contribution methods. Present
    // only when a vector strategy is wired (omitted on a plain SQLite
    // connection with no vector extension), mirroring the embedding/
    // search methods.
    ...(vectorStrategy === undefined ?
      {}
    : {
        async ensureVectorSlotContribution(
          slot: VectorSlot,
          options_?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
        ): Promise<void> {
          await contributionMaterializer.ensureVectorSlot(slot, options_);
        },

        async ensureVectorSlotContributions(
          slots: readonly VectorSlot[],
          options_?: Readonly<{ force?: boolean; onDrift?: "throw" | "skip" }>,
        ): Promise<void> {
          await contributionMaterializer.ensureVectorSlots(slots, options_);
        },

        async assertVectorSlotInitialized(slot: VectorSlot): Promise<void> {
          await contributionMaterializer.assertVectorSlot(slot);
        },

        async assertVectorSlotsInitialized(
          slots: readonly VectorSlot[],
        ): Promise<void> {
          await contributionMaterializer.assertVectorSlots(slots);
        },

        async deleteVectorSlotContribution(slot: VectorSlot): Promise<void> {
          await contributionMaterializer.dropVectorSlot(slot);
        },
      }),

    async getReconciliationMarker(
      graphId: string,
    ): Promise<number | undefined> {
      const t = tables.reconciliationMarkers;
      const rows = await db.select().from(t).where(eq(t.graphId, graphId));
      return rows[0]?.reconciledToVersion;
    },

    async setReconciliationMarker(
      graphId: string,
      version: number,
    ): Promise<void> {
      const t = tables.reconciliationMarkers;
      await db
        .insert(t)
        .values({ graphId, reconciledToVersion: version })
        .onConflictDoUpdate({
          target: t.graphId,
          set: { reconciledToVersion: version },
        });
    },

    async refreshStatistics(): Promise<void> {
      // `ANALYZE` populates `sqlite_stat1`. With no stat table, the
      // planner falls back to heuristics that, at least for FTS5
      // virtual-table queries and multi-column index selection, can be
      // an order of magnitude slower. Running it explicitly makes the
      // planner data-driven.
      //
      // Scoped to TypeGraph-managed tables only (matching the Postgres
      // backend) — a bare `ANALYZE` touches every table in the database
      // file, including unrelated ones sharing it. Bounded by
      // `analysis_limit` (see its doc comment) so cost stays roughly
      // constant per call regardless of table size — the value is a
      // fixed internal constant, not user input, so inlining it via
      // `sql.raw` is safe; SQLite's `PRAGMA` does not accept bound
      // parameters for its value.
      await db.run(
        sql`PRAGMA analysis_limit = ${sql.raw(String(SQLITE_ANALYZE_ROW_LIMIT))}`,
      );
      for (const tableName of coreAnalyzeTables) {
        await db.run(sql`ANALYZE ${quoteIdentifier(tableName)}`);
      }
      // The recorded relations may be absent on a schema created before
      // recorded-time history landed (bring-your-own-connection, no DDL
      // re-run); ANALYZE on a missing table errors, so skip those.
      for (const tableName of recordedAnalyzeTables) {
        try {
          await db.run(sql`ANALYZE ${quoteIdentifier(tableName)}`);
        } catch (error) {
          if (!isMissingTableError(error)) throw error;
        }
      }
    },

    async commitSchemaVersion(
      params: CommitSchemaVersionParams,
    ): Promise<SchemaVersionRow> {
      return runSchemaWriteTransaction((target) =>
        target.commitSchemaVersion(params),
      );
    },

    async setActiveVersion(params: SetActiveVersionParams): Promise<void> {
      await runSchemaWriteTransaction((target) =>
        target.setActiveVersion(params),
      );
    },

    async transaction<T>(
      fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      const temporaryWrites =
        options?.temporaryWrites === INTERNAL_TEMPORARY_WRITES;
      if (temporaryWrites && options.accessMode !== "read_only") {
        throw new ConfigurationError(
          "Temporary-write transactions must be semantically read-only.",
          { dialect: "sqlite" },
        );
      }
      if (transactionMode === "none") {
        throwSqliteTransactionsDisabled(
          "This SQLite backend does not support atomic transactions. " +
            "Operations within a transaction are not rolled back on failure. " +
            "Use backend.capabilities.transactions to check for transaction support, " +
            "or use individual operations with manual error handling.",
        );
      }

      // #134/#135: NO DDL or ensure here. The tx-scoped backend
      // exposes raw fulltext methods without self-ensure wrappers; the
      // single gate is `Store.transaction()`, which asserts the durable
      // contribution marker (one cached SELECT) before this method is
      // reached. The caller's BEGIN never carries CREATE statements.
      if (transactionMode === "sql") {
        return runWithSerializedQueue(serializedQueue, async () => {
          // Not `bindTransactionBackend(...)`: this path frames the tx
          // with manual BEGIN/COMMIT on the *outer* `db`, so it must
          // reuse that connection's already-built `executionAdapter`
          // rather than synthesize a fresh one for a distinct handle.
          // Serves sync drivers AND local libsql connections: both keep
          // one stable connection, where raw BEGIN/COMMIT composes and
          // Drizzle's `db.transaction()` (which for libsql abandons the
          // client's connection — fatal for `:memory:`) must be avoided.
          const txBackend = createTransactionBackend({
            capabilities,
            db,
            executionAdapter,
            operationStrategy,
            profileHints: { isSync },
            tableNames,
            fulltextStrategy,
            vectorStrategy,
            contributionMaterializer,
          });
          // Read-only multi-statement operations need one snapshot but must not
          // reserve SQLite's single writer slot. Business transactions retain
          // BEGIN IMMEDIATE so read-then-write cannot lose a lock-upgrade race.
          await runFrameStatement(
            (
              options?.accessMode === "read_only" ||
                temporaryWrites
            ) ?
              sql`BEGIN`
            : sql`BEGIN IMMEDIATE`,
          );

          try {
            const result = await fn(
              gateFulltext(
                txBackend,
                contributionMaterializer.assertInitialized,
              ),
              db,
            );
            await runFrameStatement(sql`COMMIT`);
            return result;
          } catch (error) {
            await runFrameStatement(sql`ROLLBACK`);
            throw error;
          }
        });
      }

      if (transactionMode === "do-sqlite") {
        return runDoSqliteStorageTransaction(async () =>
          fn(bindTransactionBackend(db), db),
        );
      }

      // transactionMode === "drizzle". Read-only work uses a deferred snapshot;
      // business transactions retain BEGIN IMMEDIATE for safe lock upgrades.
      return runWithSerializedQueue(
        serializedQueue,
        async () =>
          db.transaction(async (tx) => fn(bindTransactionBackend(tx), tx), {
            behavior:
              (
                options?.accessMode === "read_only" ||
                temporaryWrites
              ) ?
                "deferred"
              : "immediate",
          }) as Promise<T>,
      );
    },

    adoptTransaction(externalTx: AdoptedTransaction): TransactionBackend {
      // #134: parity with Postgres. Cross-store atomicity needs real
      // rollback; on a "none" driver the caller's relational write
      // would commit with no way to undo the graph write. Refuse
      // loudly rather than silently degrade.
      if (transactionMode === "none") {
        throwSqliteTransactionsDisabled(
          "Cross-store atomicity is unavailable on this SQLite backend: " +
            "transactions are disabled (transactionMode: 'none'). Adopting " +
            "an external transaction here would let the caller's relational " +
            "write commit with no way to roll back the graph write. " +
            "Configure a driver that supports transactions (better-sqlite3, " +
            "libsql, bun:sqlite).",
        );
      }
      assertAdoptedDialect<AnySqliteDatabase>(
        externalTx,
        BaseSQLiteDatabase,
        "sqlite",
      );
      // serializedQueue is deliberately NOT applied to an adopted tx: a
      // sync better-sqlite3 driver runs the adopted statements on the
      // caller's stack, so wrapping a caller-driven tx in our queue
      // could deadlock against the caller's outer `db.transaction(...)`.
      return bindTransactionBackend(externalTx);
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
): InternalOperationBackend {
  const txExecutionAdapter =
    options.executionAdapter ??
    createSqliteExecutionAdapter(options.db, {
      profileHints: options.profileHints,
    });

  // The transaction-scoped backend shares the outer backend's
  // contribution materializer: the per-field vector table is provisioned
  // (DDL) only by the privileged outer backend, so a tx-scoped vector op
  // only ASSERTS the durable marker (SELECT, never DDL) and can't poison
  // anything on rollback. The shared per-instance cache means a slot
  // confirmed once stays a pure `Set.has` inside every later transaction.
  return createSqliteOperationBackend({
    capabilities: options.capabilities,
    db: options.db,
    executionAdapter: txExecutionAdapter,
    operationStrategy: options.operationStrategy,
    tableNames: options.tableNames,
    fulltextStrategy: options.fulltextStrategy,
    vectorStrategy: options.vectorStrategy,
    contributionMaterializer: options.contributionMaterializer,
  });
}

// Re-export schema utilities
export type { SqliteTableNames, SqliteTables } from "./schema/sqlite";
export { createSqliteTables, tables } from "./schema/sqlite";
