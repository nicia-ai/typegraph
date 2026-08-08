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
 * import { createSqliteBackend, tables } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
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
import {
  buildFulltextCapabilities,
  fts5Strategy,
  type FulltextStrategy,
} from "../../query/dialect/fulltext-strategy";
import {
  assertVectorSearchLimit,
  buildVectorCapabilities,
  resolveEfSearchOverride,
  vectorSearchFrontierTuning,
  type VectorSlot,
  type VectorStrategy,
} from "../../query/dialect/vector-strategy";
import {
  isSqlFragment,
  sql as portableSql,
  type SqlFragment,
} from "../../query/sql-fragment";
import { type CompiledRowsSql } from "../../query/sql-intent";
import { chunk as chunkArray } from "../../utils/array";
import { requireDefined } from "../../utils/presence";
import {
  isMissingTableError,
  isSqliteNotAuthorizedError,
} from "../../utils/sql-errors";
import { FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT } from "../edge-endpoint-sets";
import { buildLiveNodeCandidates } from "../live-node-candidates";
import {
  type AdapterBackend,
  type BackendCapabilities,
  type CommitSchemaVersionIfKindsEmptyResult,
  type CommitSchemaVersionParams,
  type ContributionDiagnostic,
  type ContributionMaterializationIdentity,
  type ContributionMaterializationRow,
  type ContributionProbeEntry,
  type ContributionRebuildResult,
  type ContributionRebuildScope,
  type ContributionRepairResult,
  type ContributionRepopulationStats,
  type CreateVectorIndexParams,
  type DeleteEmbeddingParams,
  type DeleteFulltextBatchParams,
  type DeleteFulltextParams,
  type DropVectorIndexParams,
  type FulltextSearchParams,
  type FulltextSearchResult,
  type GraphAnalyticsCapabilities,
  type GraphBackend,
  type HybridSearchParams,
  type HybridSearchRow,
  type IdentityTableNames,
  type IndexMaterializationRow,
  INTERNAL_TEMPORARY_WRITES,
  type InternalTransactionOptions,
  type KindRemovalRow,
  type LockSchemaVersionForWriteParams,
  normalizeGraphAnalyticsCapabilities,
  type RecordContributionMaterializationParams,
  type RecordIndexMaterializationParams,
  type RecordKindRemovalParams,
  type SchemaKindEmptinessProbe,
  type SchemaVersionRow,
  type SchemaWriteTransactionBackend,
  type SetActiveVersionParams,
  SQLITE_CAPABILITIES,
  SQLITE_MAX_BIND_PARAMETERS,
  type TransactionBackend,
  type TrustedImportOptions,
  type TrustedImportSession,
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
  getDurableObjectStorageClient,
  isBetterSqlite3Client,
  isBunSqliteClient,
  isSqlJsClient,
  type SqliteExecutionAdapter,
  type SqliteExecutionProfile,
  type SqliteExecutionProfileHints,
} from "./execution/sqlite-execution";
import { type ExecutableSql, toDrizzleSql } from "./execution/types";
import {
  EMBEDDING_UPSERT_PARAM_COUNT,
  mapVectorWriteError,
  vectorSlotFromCreateIndexParams,
  vectorSlotFromDropIndexParams,
  vectorSlotFromParams,
} from "./vector-runtime";
export type { SqliteTransactionMode } from "./execution/sqlite-execution";
import {
  coerceNumericScore,
  createEdgeRowMapper,
  createNodeRowMapper,
  createSchemaVersionRowMapper,
  createUniqueRowMapper,
  nowIso,
  SQLITE_ROW_MAPPER_CONFIG,
} from "../row-mappers";
import { markSerializedTransactionResource } from "../transaction-resource";
import {
  buildContributionInsertValues,
  buildContributionOnConflictSet,
  type ContributionMaterializer,
  contributionRebuildSupported,
  createContributionMaterializer,
  gateFulltext,
  gateFulltextMethods,
  mapContributionMaterializationRow,
  SQLITE_CONTRIBUTION_MAT_TIMESTAMPS,
} from "./contribution-materializations";
import {
  generateSqliteCreateTableSQL,
  generateSqliteDDL,
  sqliteContributions,
} from "./ddl";
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
  assertActiveSchemaVersion,
  assertAdoptedDialect,
  commitSchemaVersionIfKindsEmpty,
  createCommonOperationBackend,
  type InternalOperationBackend,
} from "./operation-backend-core";
import { mapHybridSearchRow } from "./operations/hybrid";
import {
  createSqliteOperationStrategy,
  tableExistsFromRow,
} from "./operations/strategy";
import {
  createSqliteTables as buildSqliteTables,
  type SqliteTables,
  tables as defaultTables,
} from "./schema/sqlite";
import {
  analyzeImportedTables,
  assertTrustedImportDatabaseEmpty,
  createSqliteTrustedImportSession,
  restoreSecondaryIndexes,
  suspendSqliteSecondaryIndexes,
} from "./trusted-import";

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
   * `transactionMode: "do-sqlite"` and do not need a hint. Hosted platform
   * identity is authoritative when it conflicts with a stale hint.
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
   * or tests that need to simulate an engine-level capability gap. Overrides
   * may lower, but cannot raise, a hosted platform's hard parameter ceiling.
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
const UNIQUE_DELETE_FIXED_PARAM_COUNT = 2;
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
 * Barrel keys (contribution logical names) of the four relations that hold
 * Operational Identity state: current assertions, recorded-time assertions,
 * the derived closure, and the derived separation relation.
 * `ensureIdentityTables()` scopes its idempotent CREATE TABLE / CREATE INDEX
 * to exactly these when identity is first enabled on an existing database.
 */
const IDENTITY_TABLE_LOGICAL_NAMES: ReadonlySet<string> = new Set([
  "identityAssertions",
  "recordedIdentityAssertions",
  "identityClosure",
  "identitySeparation",
]);

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
  /** Endpoint ids per `findEdgesByKind` `fromIds` / `toIds` statement. */
  findEdgesEndpointChunkSize: number;
  getEdgesChunkSize: number;
  getNodesChunkSize: number;
  nodeInsertBatchSize: number;
  /** Node ids per uniqueness-sidecar hard delete. */
  uniqueDeleteChunkSize: number;
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
    findEdgesEndpointChunkSize: Math.max(
      1,
      maxBindParameters - FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT,
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
    uniqueDeleteChunkSize: Math.max(
      1,
      maxBindParameters - UNIQUE_DELETE_FIXED_PARAM_COUNT,
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
      {
        ...SQLITE_CAPABILITIES,
        transactions: false,
        graphAnalytics: {
          ...(SQLITE_CAPABILITIES.graphAnalytics ?? {
            mathFunctions: false,
          }),
          supported: false,
        },
      }
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

function resolveMaxBindParametersCapability(
  profile: SqliteExecutionProfile,
  override: number | undefined,
): number {
  const requested = override ?? profile.maxBindParameters;
  return profile.hardMaxBindParameters === undefined ?
      requested
    : Math.min(requested, profile.hardMaxBindParameters);
}

function resolveSqliteGraphAnalyticsCapabilities(
  profile: SqliteExecutionProfile,
  override: GraphAnalyticsCapabilities | undefined,
): GraphAnalyticsCapabilities {
  const requested = override ??
    SQLITE_CAPABILITIES.graphAnalytics ?? {
      supported: false,
      mathFunctions: false,
    };
  if (
    profile.transactionMode !== "do-sqlite" &&
    profile.transactionMode !== "none"
  ) {
    return requested;
  }
  return { ...requested, supported: false };
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
  /** Whether this operation backend is bound to an explicit transaction. */
  transactionScoped: boolean;
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
    transactionScoped,
  } = options;

  // CRUD statements route through the execution adapter's compiled path on
  // synchronous drivers so a repeated operation shape re-binds parameters
  // against a cached prepared statement instead of re-preparing through
  // drizzle's session on every call. Async drivers (remote libsql, D1)
  // have no statement cache and keep the drizzle fallback.
  const compiledExecute = executionAdapter.executeCompiled;
  const compiledRun = executionAdapter.executeCompiledRun;

  function execGet<T>(query: ExecutableSql): Promise<T | undefined> {
    // Fallback uses db.all()[0], not db.get(): drizzle-team/drizzle-orm#1049
    // — db.get() crashes with the libsql driver when no rows match
    // (normalizeRow receives undefined).
    //
    // The fallback branches use `await` unconditionally rather than
    // `instanceof Promise` because Drizzle returns SQLiteRaw thenables
    // that are NOT Promise instances (drizzle-team/drizzle-orm#2275).
    return runWithSerializedQueue(serializedQueue, async () => {
      if (compiledExecute === undefined) {
        const rows = await executionAdapter.execute<T>(query);
        return rows[0];
      }
      const rows = await compiledExecute<T>(executionAdapter.compile(query));
      return rows[0];
    });
  }

  function execAll<T>(query: ExecutableSql): Promise<T[]> {
    return runWithSerializedQueue(serializedQueue, async () => {
      if (compiledExecute === undefined) {
        return [...(await executionAdapter.execute<T>(query))];
      }
      return [...(await compiledExecute<T>(executionAdapter.compile(query)))];
    });
  }

  function execRun(query: ExecutableSql): Promise<void> {
    return runWithSerializedQueue(serializedQueue, async () => {
      if (compiledRun === undefined) {
        await db.run(
          isSqlFragment(query) ? toDrizzleSql(query, "sqlite") : query,
        );
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
    maxBindParameters:
      capabilities.maxBindParameters ?? SQLITE_MAX_BIND_PARAMETERS,
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
        async deleteEmbeddingBatch(
          params: Omit<DeleteEmbeddingParams, "nodeId"> &
            Readonly<{ nodeIds: readonly string[] }>,
        ): Promise<void> {
          if (params.nodeIds.length === 0) return;
          const slot = vectorSlotFromParams(params);
          await contributionMaterializer.assertVectorSlot(slot);
          for (const nodeIds of chunkArray(
            [...new Set(params.nodeIds)],
            batchConfig.embeddingUpsertBatchSize,
          )) {
            const statements = vectorStrategy.buildDeleteBatch(slot, {
              ...params,
              nodeIds,
            });
            for (const statement of statements) await execRun(statement);
          }
        },
        async vectorSearch(
          params: VectorSearchParams,
        ): Promise<readonly VectorSearchResult[]> {
          assertVectorSearchLimit(params.limit);
          // Apply-or-refuse for the per-search ANN frontier. No SQLite engine
          // TypeGraph bundles has one (sqlite-vec's vec0 takes only `k`;
          // libSQL's `vector_top_k` takes only (index, query, k)), so the
          // shared predicate refuses `efSearch` here with the engine's own
          // reason instead of accepting it and searching as if it were never
          // passed. `undefined` — the overwhelmingly common case — returns
          // without touching anything.
          resolveEfSearchOverride({
            efSearch: params.efSearch,
            indexType: params.indexType,
            tuning: vectorSearchFrontierTuning(vectorStrategy),
            transactions: capabilities.transactions,
            dialect: "SQLite",
            engine: vectorStrategy.name,
          });
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
              buildLiveNodeCandidates(
                tableNames.nodes,
                params.graphId,
                params.nodeKind,
                nowIso(),
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
              // The hybrid statement's vector leg carries the same option on
              // the same engine, so it takes the same refusal. This path built
              // its own `VectorSearchParams` and dropped
              // `params.vector.efSearch` while doing so — the silent ignore in
              // its second location.
              resolveEfSearchOverride({
                efSearch: params.vector.efSearch,
                indexType: params.vector.indexType,
                tuning: vectorSearchFrontierTuning(vectorStrategy),
                transactions: capabilities.transactions,
                dialect: "SQLite",
                engine: vectorStrategy.name,
              });
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
                buildLiveNodeCandidates(
                  tableNames.nodes,
                  params.graphId,
                  params.nodeKind,
                  nowIso(),
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
                portableSql.raw("SELECT node_id FROM tg_hybrid_cand"),
              );
              const statement = operationStrategy.buildHybridSearch(
                { ...params, candidates },
                toDrizzleSql(vectorSql, "sqlite"),
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
    /**
     * Transaction-scoped contribution marker stamp. Present so the
     * destructive rebuild can commit its marker with the DDL that
     * produced it; without it the stamp would land outside the
     * transaction and could survive a rolled-back drop.
     *
     * States the row outright rather than reusing the top-level upsert,
     * whose `materialized_at` COALESCE preserves an earlier success so a
     * failed re-attempt cannot erase it. A completed rebuild replaced the
     * storage, so the recorded timestamp must be the rebuild's.
     */
    async recordContributionMaterialization(
      params: RecordContributionMaterializationParams,
    ): Promise<void> {
      await execRun(
        operationStrategy.buildInsertContributionMaterialization(params),
      );
    },

    async deleteSchemaVectorSlotContribution(slot: VectorSlot): Promise<void> {
      if (vectorStrategy === undefined) return;
      for (const contribution of vectorStrategy.ownedTables(slot)) {
        await execRun(
          operationStrategy.buildDeleteContributionMaterialization({
            graphId: slot.graphId,
            logicalName: contribution.logicalName,
            owner: contribution.owner,
            tableName: contribution.tableName,
          }),
        );
      }
      contributionMaterializer.evictVectorSlot(slot);
    },
    capabilities,
    dialect: "sqlite",
    tableNames,
    fulltextStrategy,
    ...(vectorStrategy === undefined ? {} : { vectorStrategy }),

    async lockSchemaVersionForWrite(
      params: LockSchemaVersionForWriteParams,
    ): Promise<void> {
      if (!transactionScoped) {
        throw new ConfigurationError(
          "The schema write fence requires an explicit SQLite transaction.",
          {
            code: "SCHEMA_WRITE_FENCE_TRANSACTION_REQUIRED",
            graphId: params.graphId,
          },
        );
      }
      // An ordinary read suffices, unlike Postgres' `FOR SHARE` fence: SQLite
      // serializes writers through BEGIN IMMEDIATE, so no schema commit can be
      // mid-flight while this transaction holds the writer slot, and a SQLite
      // read has no post-wait row recheck that could drop the active row from
      // its own snapshot. An absent row here therefore always means the graph
      // genuinely has no active schema.
      const active = await commonBackend.getActiveSchema(params.graphId);
      assertActiveSchemaVersion(
        params.graphId,
        params.expectedVersion,
        active?.version ?? 0,
      );
    },

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

    async execute<T>(query: CompiledRowsSql): Promise<readonly T[]> {
      return runWithSerializedQueue(serializedQueue, async () =>
        executionAdapter.execute<T>(query),
      );
    },

    compileSql(
      query: SqlFragment,
    ): Readonly<{ sql: string; params: readonly unknown[] }> {
      return executionAdapter.compile(query);
    },
  };

  return operationBackend;
}

/**
 * Whether a driver client is a LOCAL `@libsql/client`: one stable connection
 * that every statement from every wrapper over it runs on, in order.
 *
 * `protocol === "file"` is the client's own answer to "am I local?" — it covers
 * `file:` paths, `:memory:` databases, and an embedded replica's local file. A
 * REMOTE client (`http` / `ws`) opens an independent stream per transaction and
 * must never be treated as one serialized resource; refusing concurrent work
 * there would refuse work that succeeds. The libsql methods are required
 * alongside the protocol so an unrelated object that happens to carry
 * `protocol: "file"` is not adopted, and none of it imports `@libsql/client`,
 * which this bundler-friendly module must not depend on.
 *
 * Single owner of the local/remote distinction: `../sqlite/libsql.ts` picks its
 * transaction framing (raw BEGIN/COMMIT on the one local connection vs Drizzle's
 * per-stream `db.transaction()`) by asking here, so the framing and the
 * serialized-resource mark cannot drift apart.
 */
export function isLocalLibsqlClient(client: unknown): boolean {
  if (typeof client !== "object" || client === null) return false;
  const candidate = client as Readonly<Record<string, unknown>>;
  return (
    candidate["protocol"] === "file" &&
    typeof candidate["execute"] === "function" &&
    typeof candidate["batch"] === "function" &&
    typeof candidate["executeMultiple"] === "function"
  );
}

/**
 * Returns the single connection a Drizzle database serializes every statement
 * onto, if its driver is one we can positively identify as such.
 *
 * Five drivers qualify, each by its own named predicate — a driver is marked on
 * evidence of WHAT IT IS, never on the absence of a disqualifier:
 *
 * - **better-sqlite3** ({@link isBetterSqlite3Client}): a single, synchronous
 *   connection, so an open transaction on one wrapper is an open transaction
 *   for all of them.
 * - **bun:sqlite** ({@link isBunSqliteClient}): the same one synchronous
 *   connection, reached through `drizzle-orm/bun-sqlite`.
 * - **sql.js** ({@link isSqlJsClient}): one in-WASM database handle; every
 *   wrapper's statements run on it in order.
 * - **Cloudflare Durable Object storage** (`drizzle(ctx.storage)`): one storage
 *   connection whose transaction frame is AMBIENT on the storage object rather
 *   than a handle passed to the callback (see `runDoSqliteStorageTransaction`:
 *   `transactionMode: "do-sqlite"` binds the OUTER `db`). A second wrapper's
 *   writes therefore land inside the first
 *   wrapper's open export snapshot, and because the DO backend reports
 *   `capabilities.transactions: true` nothing else abstains for it. Identified by
 *   {@link getDurableObjectStorageClient}, the same full-shape evidence the
 *   transaction runner requires, so the framing and the mark cannot drift apart.
 * - **a local `@libsql/client`**: also one stable connection — which is exactly
 *   why local clients frame transactions as raw BEGIN/COMMIT on it (see
 *   {@link isLocalLibsqlClient}). libsql clients expose no `prepare`, so no
 *   prepare-capable predicate can see them and the driver client is read
 *   directly here.
 *
 * Unrecognized clients stay unmarked: SEPARATE connections to the same file are
 * genuinely concurrent under WAL and must not be treated as one serialized
 * resource, and a driver whose dispatch we cannot attribute proves nothing.
 * The full classification — marked, deliberately unmarked, and the remaining
 * gaps — is the inventory in `../transaction-resource.ts`.
 */
function getSerializedSqliteConnection(
  db: AnySqliteDatabase,
): object | undefined {
  const client = (db as Readonly<{ $client?: unknown }>).$client;
  if (
    isBetterSqlite3Client(client) ||
    isBunSqliteClient(client) ||
    isSqlJsClient(client)
  ) {
    return client as object;
  }
  // The storage object IS the serialized resource: every wrapper built over the
  // same `ctx.storage` shares its one connection and its ambient transaction.
  const storageClient = getDurableObjectStorageClient(db);
  if (storageClient !== undefined) return storageClient;
  return isLocalLibsqlClient(client) ? (client as object) : undefined;
}

/**
 * Whether two backends built over `client` would be treated as one serialized
 * connection. The marking predicate itself, exposed for the driver-shape unit
 * tests (mirrors `isSerializedPostgresClient`); production code reaches it only
 * through {@link createSqliteBackend}.
 */
export function isSerializedSqliteClient(client: unknown): boolean {
  return (
    getSerializedSqliteConnection({
      $client: client,
    } as unknown as AnySqliteDatabase) !== undefined
  );
}

export function createSqliteBackend(
  db: AnySqliteDatabase,
  options: SqliteBackendOptions = {},
): AdapterBackend<AnySqliteDatabase> {
  // Resolved before the backend exists so marking below is a lookup, never
  // work that could fail after wrappers already observed an unmarked backend.
  const serializedConnection = getSerializedSqliteConnection(db);
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
  const capabilityOverrides = options.capabilities ?? {};
  const declaredCapabilities = normalizeGraphAnalyticsCapabilities({
    ...buildSqliteCapabilities({
      fulltextStrategy,
      vectorStrategy,
      transactionMode,
      maxBindParameters: executionAdapter.profile.maxBindParameters,
    }),
    ...capabilityOverrides,
    maxBindParameters: resolveMaxBindParametersCapability(
      executionAdapter.profile,
      capabilityOverrides.maxBindParameters,
    ),
    graphAnalytics: resolveSqliteGraphAnalyticsCapabilities(
      executionAdapter.profile,
      capabilityOverrides.graphAnalytics,
    ),
  });
  // Derived last and not overridable: how far up the contribution health
  // ladder this backend goes is a structural fact about the wiring below
  // (durable markers, a catalog probe, a strategy that declares teardown
  // DDL, a transactional schema fence), and a caller who declared a
  // rebuild this backend cannot perform would be advertising a lie.
  const capabilities: BackendCapabilities = {
    ...declaredCapabilities,
    contributions: {
      supported: true,
      probe: true,
      rebuild: contributionRebuildSupported(
        fulltextStrategy,
        tables.fulltextTableName,
        declaredCapabilities.transactions,
      ),
    },
  };

  const tableNames: ResolvedSqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    recordedNodes: getTableName(tables.recordedNodes),
    recordedEdges: getTableName(tables.recordedEdges),
    recordedClock: getTableName(tables.recordedClock),
    revisionOrigins: getTableName(tables.revisionOrigins),
    identityAssertions: getTableName(tables.identityAssertions),
    recordedIdentityAssertions: getTableName(tables.recordedIdentityAssertions),
    identityClosure: getTableName(tables.identityClosure),
    identitySeparation: getTableName(tables.identitySeparation),
    fulltext: tables.fulltextTableName,
    uniques: getTableName(tables.uniques),
  };
  // refreshStatistics() scopes ANALYZE to these — matching the Postgres
  // backend, which never touches unrelated tables sharing the database.
  // The recorded and identity relations are ANALYZEd separately under a
  // missing-table guard: a schema created before recorded-time history or
  // Operational Identity landed (bring-your-own-connection, no DDL re-run)
  // has no recorded_* / identity_* tables.
  const coreAnalyzeTables = [
    tableNames.nodes,
    tableNames.edges,
    tableNames.uniques,
    tableNames.fulltext,
  ];
  const guardedAnalyzeTables = [
    tableNames.recordedNodes,
    tableNames.recordedEdges,
    tableNames.recordedClock,
    tableNames.recordedIdentityAssertions,
    tableNames.identityAssertions,
    tableNames.identityClosure,
    tableNames.identitySeparation,
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

  /**
   * Uncached catalog probe backing `verifyContributions`. The shared
   * `createCachedTableExistence` wrapper is deliberately NOT used: this
   * diagnostic's whole job is to notice that a table confirmed present
   * earlier has since been dropped.
   */
  async function contributionTableExists(tableName: string): Promise<boolean> {
    const rows = await executionAdapter.execute<Record<string, unknown>>(
      operationStrategy.buildTableExists(tableName),
    );
    return tableExistsFromRow(rows[0]);
  }

  /**
   * The contribution descriptors for exactly the identity relations, under
   * caller-supplied physical names. Pure — nothing is executed here — and the
   * single owner of "which DDL belongs to the identity relations", shared by
   * `ensureIdentityTables` (which runs it) and `identityTableDdl` (which hands
   * it to a transaction).
   */
  function identityContributionsFor(
    identityTableNames: IdentityTableNames,
  ): ReturnType<typeof sqliteContributions> {
    const identityTables = buildSqliteTables({
      identityAssertions: identityTableNames.identityAssertions,
      recordedIdentityAssertions: identityTableNames.recordedIdentityAssertions,
      identityClosure: identityTableNames.identityClosure,
      identitySeparation: identityTableNames.identitySeparation,
    });
    return sqliteContributions(identityTables, fulltextStrategy).filter(
      (contribution) =>
        IDENTITY_TABLE_LOGICAL_NAMES.has(contribution.logicalName),
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
    tableExists: contributionTableExists,
    // Withheld rather than wired-and-throwing when transactions are
    // disabled: the rebuild must refuse with its own typed error naming
    // the absent fence, matching `capabilities.contributions.rebuild`.
    // The graph id the materializer passes is unused — this backend's
    // schema lock is per connection, not per graph.
    ...(capabilities.transactions ?
      {
        schemaWriteTransaction: <T>(
          _graphId: string,
          fn: (tx: SchemaWriteTransactionBackend) => Promise<T>,
        ) => runSchemaWriteTransaction((target) => fn(target)),
      }
    : {}),
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
    transactionScoped: false,
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
   * `transaction()` (business writes) and `runSchemaWriteTransaction()`.
   * Ordinary schema-version commits are data-only; administrative removal
   * cleanup may execute transaction-scoped DDL.
   */
  function runDoSqliteStorageTransaction<T>(run: () => Promise<T>): Promise<T> {
    const storage = getDurableObjectStorageClient(db);
    if (storage === undefined) {
      throwSqliteTransactionsDisabled(
        "transactionMode 'do-sqlite' requires a Drizzle Durable Objects " +
          "database (drizzle(ctx.storage)) whose `$client` exposes the SQL, " +
          "transactionSync, and async transaction runners.",
      );
    }
    return runWithSerializedQueue(serializedQueue, () =>
      storage.transaction(run),
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
   * Rolls the manually framed transaction back on the failure path WITHOUT ever
   * throwing: the caller rethrows the original error immediately after.
   *
   * SQLite rolls a transaction back by itself on some errors (SQLITE_FULL,
   * SQLITE_IOERR, SQLITE_NOMEM), so by the time this runs the frame can already
   * be gone and the ROLLBACK fails with "cannot rollback - no transaction is
   * active". A bare `await ROLLBACK; throw error` replaces the caller's
   * actionable failure ("disk image is malformed") with that secondary one and
   * never reaches its own rethrow — the masking that `closeAfterFailure` and the
   * index-materialization claim release exist to prevent, applied here too.
   *
   * A rollback failure that is NOT an already-closed frame leaves the frame open
   * on this connection; nothing here can close it (the statement that would is
   * the one that just failed), so it is reported and the next BEGIN on the
   * connection fails loudly rather than silently joining it.
   */
  async function rollbackFrameQuietly(): Promise<void> {
    try {
      await runFrameStatement(sql`ROLLBACK`);
    } catch (rollbackError) {
      console.warn(
        "typegraph: ROLLBACK failed while unwinding a failed SQLite " +
          "transaction; the original failure is the one thrown. SQLite " +
          "auto-rolls-back on SQLITE_FULL / SQLITE_IOERR / SQLITE_NOMEM, in " +
          "which case the frame was already closed and nothing is leaked.",
        rollbackError,
      );
    }
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
    fn: (tx: InternalOperationBackend) => Promise<T>,
  ): Promise<T> {
    if (transactionMode === "none") {
      throwSqliteTransactionsDisabled(
        "Schema writes and removal cleanup require atomic transactions, " +
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
          await rollbackFrameQuietly();
          throw error;
        }
      });
    }

    if (transactionMode === "do-sqlite") {
      // No interactive lock-mode control on the DO storage runner; the
      // serialized queue (always present — DO is sync) provides the
      // single-writer ordering that "immediate" gives the other paths.
      // Raw txBackend (no `gateFulltext`, unlike the business
      // `transaction()` do-sqlite branch). Schema-version commits remain
      // data-only; administrative removal cleanup may use the target's
      // transaction-scoped DDL primitive.
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

  const backend: AdapterBackend<AnySqliteDatabase> = {
    ...operations,

    ...((
      isSync &&
      transactionMode === "sql" &&
      executionAdapter.executePreparedRunBatch !== undefined
    ) ?
      {
        async trustedImport<T>(
          fn: (session: TrustedImportSession) => Promise<T>,
          options_?: TrustedImportOptions,
        ): Promise<T> {
          return backend.transaction(async (tx) => {
            if (options_?.schemaWrite !== undefined) {
              await requireDefined(tx.lockSchemaVersionForWrite)({
                ...options_.schemaWrite,
              });
            }
            await assertTrustedImportDatabaseEmpty(tx, tableNames);
            const indexDefinitions = await suspendSqliteSecondaryIndexes(
              tx,
              tableNames,
            );
            const result = await fn(
              createSqliteTrustedImportSession(executionAdapter, tableNames),
            );
            await restoreSecondaryIndexes(tx, indexDefinitions);
            await analyzeImportedTables(tx, tableNames);
            return result;
          });
        },
      }
    : {}),

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

    async ensureIdentityTables(
      identityTableNames,
      options,
    ): Promise<readonly string[]> {
      // First enablement of Operational Identity on an existing populated
      // database: createStore / createSqliteBackend run no DDL, so the four
      // identity relations the enablement preflight reads/writes may not
      // exist yet. Ensure them (and their indexes and CHECK constraints)
      // idempotently — CREATE TABLE / CREATE INDEX IF NOT EXISTS — reusing the same contribution
      // DDL bootstrapTables emits, scoped to the identity relations.
      const identityContributions =
        identityContributionsFor(identityTableNames);
      const missing = [] as string[];
      for (const contribution of identityContributions) {
        if (!(await contributionTableExists(contribution.tableName))) {
          missing.push(contribution.logicalName);
        }
      }
      // Preserve missing ledger storage on already-enabled graphs so a retry
      // cannot silently accept tables created empty by an earlier failed open.
      // First enablement opts into provisioning; when every table exists,
      // idempotent DDL still repairs missing secondary indexes.
      if (missing.length === 0 || options.provisionMissing) {
        for (const contribution of identityContributions) {
          for (const ddl of contribution.createDdl) {
            await db.run(sql.raw(ddl));
          }
        }
      }
      return missing;
    },

    identityTableDdl(identityTableNames): readonly string[] {
      return identityContributionsFor(identityTableNames).flatMap(
        (contribution) => [...contribution.createDdl],
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
          set: buildMaterializationOnConflictSet(params.materializedAt),
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

    async verifyContributions(
      graphId: string,
      vectorSlots: readonly VectorSlot[],
    ): Promise<readonly ContributionDiagnostic[]> {
      return contributionMaterializer.verifyContributions(graphId, vectorSlots);
    },

    async repairContributions(
      graphId: string,
      vectorSlots: readonly VectorSlot[],
    ): Promise<ContributionRepairResult> {
      return contributionMaterializer.repairContributions(graphId, vectorSlots);
    },

    async probeContributions(
      graphId: string,
      vectorSlots: readonly VectorSlot[],
    ): Promise<readonly ContributionProbeEntry[]> {
      return contributionMaterializer.probeContributions(graphId, vectorSlots);
    },

    async rebuildContribution(
      graphId: string,
      scope: ContributionRebuildScope,
      repopulate: (
        target: TransactionBackend,
      ) => Promise<ContributionRepopulationStats>,
    ): Promise<ContributionRebuildResult> {
      return contributionMaterializer.rebuildContribution(
        graphId,
        scope,
        repopulate,
      );
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
      try {
        await db.run(
          toDrizzleSql(
            portableSql`PRAGMA analysis_limit = ${portableSql.raw(String(SQLITE_ANALYZE_ROW_LIMIT))}`,
            "sqlite",
          ),
        );
      } catch (error) {
        // Cloudflare D1 and Durable Object SQLite reject this performance-only
        // tuning PRAGMA through their authorizer. Continue with scoped ANALYZE,
        // which workerd permits, but keep every unexpected failure loud.
        if (!isSqliteNotAuthorizedError(error)) throw error;
      }
      for (const tableName of coreAnalyzeTables) {
        await db.run(
          toDrizzleSql(
            portableSql`ANALYZE ${portableSql.identifier(tableName)}`,
            "sqlite",
          ),
        );
      }
      // The recorded and identity relations may be absent on a schema
      // created before recorded-time history or Operational Identity landed
      // (bring-your-own-connection, no DDL re-run); ANALYZE on a missing
      // table errors, so skip those.
      for (const tableName of guardedAnalyzeTables) {
        try {
          await db.run(
            toDrizzleSql(
              portableSql`ANALYZE ${portableSql.identifier(tableName)}`,
              "sqlite",
            ),
          );
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

    async commitSchemaVersionIfKindsEmpty(
      params: CommitSchemaVersionParams,
      probes: readonly SchemaKindEmptinessProbe[],
    ): Promise<CommitSchemaVersionIfKindsEmptyResult> {
      // BEGIN IMMEDIATE already owns SQLite's serialized writer slot, so the
      // counts and schema CAS below share the same ordinary-write fence.
      return runSchemaWriteTransaction((target) =>
        commitSchemaVersionIfKindsEmpty(target, params, probes),
      );
    },

    async commitSchemaVersionWithPreflight(
      params: CommitSchemaVersionParams,
      // The schema-write target, not the narrowed transaction backend: a
      // preflight may have to CREATE the storage it then fills, and that DDL
      // belongs in this transaction rather than before it.
      preflight: (target: SchemaWriteTransactionBackend) => Promise<void>,
    ): Promise<SchemaVersionRow> {
      return runSchemaWriteTransaction(async (target) => {
        await preflight(target);
        return target.commitSchemaVersion(params);
      });
    },

    async setActiveVersion(params: SetActiveVersionParams): Promise<void> {
      await runSchemaWriteTransaction((target) =>
        target.setActiveVersion(params),
      );
    },

    async schemaWriteTransaction<T>(
      _graphId: string,
      fn: (tx: SchemaWriteTransactionBackend) => Promise<T>,
    ): Promise<T> {
      return runSchemaWriteTransaction((target) => fn(target));
    },

    async transaction<T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: InternalTransactionOptions,
    ): Promise<T> {
      return backend.transactionWithNative((tx) => fn(tx), options);
    },

    async transactionWithNative<T>(
      fn: (tx: TransactionBackend, sql: AnySqliteDatabase) => Promise<T>,
      options?: InternalTransactionOptions,
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
            options?.accessMode === "read_only" || temporaryWrites ?
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
            await rollbackFrameQuietly();
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
              options?.accessMode === "read_only" || temporaryWrites ?
                "deferred"
              : "immediate",
          }) as Promise<T>,
      );
    },

    adoptTransaction(externalTx: AnySqliteDatabase): TransactionBackend {
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

  // INVARIANT: mark before any wrapper can observe this backend — see
  // transaction-resource.ts.
  if (serializedConnection !== undefined) {
    markSerializedTransactionResource(backend, serializedConnection);
  }

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
    transactionScoped: true,
  });
}

// Re-export schema utilities
export type { SqliteTableNames, SqliteTables } from "./schema/sqlite";
export { createSqliteTables, tables } from "./schema/sqlite";
