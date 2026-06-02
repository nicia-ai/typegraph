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
import type { SqlTableNames } from "../../query/compiler/schema";
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
  type IndexMaterializationRow,
  type KindRemovalRow,
  type RecordContributionMaterializationParams,
  type RecordIndexMaterializationParams,
  type RecordKindRemovalParams,
  type SchemaVersionRow,
  type SetActiveVersionParams,
  SQLITE_CAPABILITIES,
  type TransactionBackend,
  type TransactionOptions,
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
  createVectorSlotLatch,
  mapVectorWriteError,
  vectorSlotFromCreateIndexParams,
  vectorSlotFromDropIndexParams,
  vectorSlotFromParams,
  type VectorSlotLatch,
} from "./vector-runtime";
export type { SqliteTransactionMode } from "./execution/sqlite-execution";
import {
  buildContributionInsertValues,
  buildContributionOnConflictSet,
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
  }>,
): BackendCapabilities {
  const base =
    options.transactionMode === "none" ?
      { ...SQLITE_CAPABILITIES, transactions: false }
    : SQLITE_CAPABILITIES;
  return {
    ...base,
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
  tableNames: SqlTableNames;
  fulltextStrategy: FulltextStrategy;
  /**
   * Active vector strategy, or `undefined` when the connection has no
   * vector extension. When present, the backend exposes upsertEmbedding /
   * deleteEmbedding / vectorSearch / createVectorIndex / dropVectorIndex,
   * all routed through this strategy's per-`(kind, field)` storage.
   */
  vectorStrategy?: VectorStrategy | undefined;
  /**
   * Per-`(kind, field)` storage-ensure latch shared across the outer
   * backend and every transaction-scoped backend (see
   * {@link createVectorSlotLatch}). Required whenever `vectorStrategy` is
   * set so writes never hit a missing per-field table.
   */
  vectorSlotLatch?: VectorSlotLatch | undefined;
}>;

type CreateSqliteTransactionBackendOptions = Readonly<{
  capabilities: GraphBackend["capabilities"];
  db: AnySqliteDatabase;
  executionAdapter?: SqliteExecutionAdapter;
  operationStrategy: ReturnType<typeof createSqliteOperationStrategy>;
  profileHints: SqliteExecutionProfileHints;
  tableNames: SqlTableNames;
  fulltextStrategy: FulltextStrategy;
  /** Active vector strategy. See {@link CreateSqliteOperationBackendOptions}. */
  vectorStrategy?: VectorStrategy | undefined;
  /** Shared storage-ensure latch. See {@link CreateSqliteOperationBackendOptions}. */
  vectorSlotLatch?: VectorSlotLatch | undefined;
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
    vectorSlotLatch,
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

  // The latch runs per-field DDL on the same connection a write/search
  // executes on, so a transaction-scoped write materializes its slot inside
  // the caller's transaction.
  async function ensureVectorSlotStorage(slot: VectorSlot): Promise<void> {
    if (vectorStrategy === undefined || vectorSlotLatch === undefined) return;
    await vectorSlotLatch.ensure(vectorStrategy, slot, async (statement) => {
      await execRun(sql.raw(statement));
    });
  }

  const vectorEmbeddingMethods =
    vectorStrategy === undefined ?
      {}
    : {
        async upsertEmbedding(params: UpsertEmbeddingParams): Promise<void> {
          const slot = vectorSlotFromParams(params);
          await ensureVectorSlotStorage(slot);
          const statements = vectorStrategy.buildUpsert(slot, params, nowIso());
          try {
            for (const statement of statements) {
              await execRun(statement);
            }
          } catch (error) {
            throw mapVectorWriteError(error, params);
          }
        },
        async deleteEmbedding(params: DeleteEmbeddingParams): Promise<void> {
          // Ensure the per-field table exists before deleting. A delete
          // can run before any embedding was ever written for the field
          // (e.g. a node hard-deleted having never carried one); the
          // idempotent ensure makes the DELETE a clean no-op against an
          // existing (possibly empty) table, matching the Postgres path
          // (where a DELETE on a missing relation would abort an
          // enclosing transaction).
          const slot = vectorSlotFromParams(params);
          await ensureVectorSlotStorage(slot);
          const statements = vectorStrategy.buildDelete(slot, params);
          for (const statement of statements) {
            await execRun(statement);
          }
        },
        async vectorSearch(
          params: VectorSearchParams,
        ): Promise<readonly VectorSearchResult[]> {
          assertVectorSearchLimit(params.limit);
          const slot = vectorSlotFromParams(params);
          await ensureVectorSlotStorage(slot);
          const query = vectorStrategy.buildSearch(slot, params);
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
      // Ensure the per-field table exists first (idempotent), then create
      // its ANN index. `ownedTables` already folds the index DDL in, so the
      // explicit `buildCreateIndex` step is belt-and-suspenders for slots
      // whose index intent changed after the table was first materialized.
      await ensureVectorSlotStorage(slot);
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
  // One latch per backend instance, shared with every transaction-scoped
  // backend so a slot's per-field table is created at most once per process.
  const vectorSlotLatch =
    vectorStrategy === undefined ? undefined : createVectorSlotLatch();
  const capabilities: BackendCapabilities = buildSqliteCapabilities({
    fulltextStrategy,
    vectorStrategy,
    transactionMode,
  });

  const tableNames: SqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    fulltext: tables.fulltextTableName,
    uniques: getTableName(tables.uniques),
  };
  const operationStrategy = createSqliteOperationStrategy(
    tables,
    fulltextStrategy,
  );
  const serializedQueue = isSync ? createSerializedExecutionQueue() : undefined;
  const operations = createSqliteOperationBackend({
    capabilities,
    db,
    executionAdapter,
    operationStrategy,
    tableNames,
    fulltextStrategy,
    vectorStrategy,
    vectorSlotLatch,
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
          profileHints: { isSync: true },
          tableNames,
          fulltextStrategy,
          vectorStrategy,
          vectorSlotLatch,
        });
        db.run(sql`BEGIN IMMEDIATE`);
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
          vectorSlotLatch,
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
              vectorSlotLatch,
            });
            return fn(txBackend);
          },
          { behavior: "immediate" },
        ) as Promise<T>,
    );
  }

  // Durable fulltext materialization (#135): the dialect-specific
  // marker-table primitives. Orchestration (materialize / assert /
  // per-instance cache) lives once in `createContributionMaterializer`.
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

  const contributionMaterializer = createContributionMaterializer({
    dialect: "sqlite",
    fulltextStrategy,
    fulltextTableName: tables.fulltextTableName,
    execDdl: async (statement) => {
      await db.run(sql.raw(statement));
    },
    ensureMarkerTable: ensureContributionMaterializationsTableImpl,
    getMarker: getContributionMaterializationRow,
    recordMarker: recordContributionMaterializationRow,
  });

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
      vectorSlotLatch,
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
      await db.run(sql`ANALYZE`);
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
      _options?: TransactionOptions,
    ): Promise<T> {
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
          const txBackend = createTransactionBackend({
            capabilities,
            db,
            executionAdapter,
            operationStrategy,
            profileHints: { isSync: true },
            tableNames,
            fulltextStrategy,
            vectorStrategy,
            vectorSlotLatch,
          });
          db.run(sql`BEGIN`);

          try {
            const result = await fn(
              gateFulltext(
                txBackend,
                contributionMaterializer.assertInitialized,
              ),
              db,
            );
            db.run(sql`COMMIT`);
            return result;
          } catch (error) {
            db.run(sql`ROLLBACK`);
            throw error;
          }
        });
      }

      if (transactionMode === "do-sqlite") {
        return runDoSqliteStorageTransaction(async () =>
          fn(bindTransactionBackend(db), db),
        );
      }

      // transactionMode === "drizzle"
      return runWithSerializedQueue(
        serializedQueue,
        async () =>
          db.transaction(async (tx) =>
            fn(bindTransactionBackend(tx), tx),
          ) as Promise<T>,
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

  // A transaction-scoped backend gets its OWN per-field ensure-latch, never
  // the outer process-global one. A `CREATE TABLE/INDEX` that runs inside the
  // caller's transaction and then rolls back must not leave the shared latch
  // marking the slot "ensured" — that would skip the re-CREATE and make every
  // later write fail with "no such table". The fresh latch is discarded with
  // the transaction, so the next write re-ensures idempotently.
  return createSqliteOperationBackend({
    capabilities: options.capabilities,
    db: options.db,
    executionAdapter: txExecutionAdapter,
    operationStrategy: options.operationStrategy,
    tableNames: options.tableNames,
    fulltextStrategy: options.fulltextStrategy,
    vectorStrategy: options.vectorStrategy,
    ...(options.vectorStrategy === undefined
      ? {}
      : { vectorSlotLatch: createVectorSlotLatch() }),
  });
}

// Re-export schema utilities
export type { SqliteTableNames, SqliteTables } from "./schema/sqlite";
export { createSqliteTables, tables } from "./schema/sqlite";
