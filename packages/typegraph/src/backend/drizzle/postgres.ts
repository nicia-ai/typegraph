/**
 * PostgreSQL backend adapter for TypeGraph.
 *
 * Works with any Drizzle PostgreSQL database instance. Tested against:
 * - `drizzle-orm/node-postgres` (pg Pool / Client)
 * - `drizzle-orm/postgres-js` (postgres-js tagged-template client)
 * - `drizzle-orm/neon-serverless` (@neondatabase/serverless Pool / Client)
 * - `drizzle-orm/neon-http` (@neondatabase/serverless `neon(url)`) —
 *   transactions are auto-disabled because HTTP can't hold a session;
 *   use `drizzle-orm/neon-serverless` if you need transactional writes.
 *
 * - `drizzle-orm/pglite` (PGlite, Postgres-in-WASM) — the execution
 *   fast path detects PGlite and routes it correctly (its `.query` has no
 *   named-statement form). For a batteries-included in-process setup, see
 *   `createLocalPgliteBackend` in `@nicia-ai/typegraph/adapters/drizzle/postgres/pglite`.
 *
 * Other pg-protocol Drizzle adapters (Vercel Postgres, Supabase via pg)
 * work unchanged because they all expose a compatible `db.execute()` /
 * `db.transaction()` surface.
 *
 * @example
 * ```typescript
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { Pool } from "pg";
 * import { createPostgresBackend, tables } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = drizzle(pool);
 * const backend = createPostgresBackend(db, { tables });
 * ```
 */
import {
  and,
  eq,
  getTableName,
  inArray,
  isNull,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";

import {
  CompilerInvariantError,
  ConfigurationError,
  StaleVersionError,
} from "../../errors";
import type { ResolvedSqlTableNames } from "../../query/compiler/schema";
import {
  buildFulltextCapabilities,
  type FulltextStrategy,
  tsvectorStrategy,
} from "../../query/dialect/fulltext-strategy";
import {
  assertPgvectorEfSearch,
  pgvectorStrategy,
} from "../../query/dialect/vector/pgvector-strategy";
import {
  assertVectorSearchLimit,
  buildVectorCapabilities,
  resolveEfSearchOverride,
  vectorSearchFrontierTuning,
  type VectorSlot,
  type VectorStrategy,
} from "../../query/dialect/vector-strategy";
import { isSqlFragment, sql as portableSql } from "../../query/sql-fragment";
import {
  annIndexScanTypes,
  type CompiledRowsSql,
} from "../../query/sql-intent";
import { requireDefined } from "../../utils/presence";
import {
  isInsufficientResourcesError,
  isMissingTableError,
  isPostgresConcurrentDdlRaceError,
} from "../../utils/sql-errors";
import { RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE } from "../advisory-lock-namespaces";
import {
  type AtomicEdgeConvergenceInput,
  type AtomicEdgeConvergenceResult,
  type AtomicEdgeMutationProgramExecutor,
  type AtomicEdgeResolvedMutationSetInput,
  type AtomicEdgeResolvedMutationSetResult,
  carryAtomicMutationSessionRegistration,
  registerAtomicMutationPrograms,
} from "../capabilities/atomic-mutation-program";
import {
  type AtomicSqlProgramExecutor,
  createAtomicSqlProgramExecutor,
  registerAtomicSqlProgram,
} from "../capabilities/atomic-sql-program";
import { assertNoLegacyTransactionCapability } from "../capabilities/declarations";
import { scopeAtomicBatchToSession } from "../capabilities/execution";
import { markSchemaFencedInsertEligible } from "../capabilities/schema-fenced-insert";
import {
  markFirstPartyFactory,
  requireWriteFence,
  resolveWriteFencePlan,
  type WriteFenceTarget,
} from "../capabilities/write-fence";
import { deriveBackend } from "../derive-backend";
import { FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT } from "../edge-endpoint-sets";
import { buildLiveNodeCandidates } from "../live-node-candidates";
import {
  createEdgeRowMapper,
  createNodeRowMapper,
  createSchemaVersionRowMapper,
  createUniqueRowMapper,
  nowIso,
  POSTGRES_ROW_MAPPER_CONFIG,
} from "../row-mappers";
import {
  resolveDeclaredBackendResource,
  type SerializedResourceDeclaration,
} from "../transaction-resource";
import {
  type AdapterBackend,
  type BackendCapabilities,
  type BundledBackendCapabilityOverrides,
  type ClaimIndexMaterializationParams,
  DATABASE_EXTENSION_NAMES,
  type DatabaseExtensionName,
  type HybridSearchParams,
  type HybridSearchRow,
  type InsertNodeParams,
  INTERNAL_TEMPORARY_WRITES,
  type InternalTransactionOptions,
  type LockSchemaVersionForWriteParams,
  type ManagedNodeCreatePlan,
  normalizeGraphAnalyticsCapabilities,
  POSTGRES_CAPABILITIES,
  POSTGRES_MAX_BIND_PARAMETERS,
  type RecordKindRemovalParams,
  type ReleaseIndexMaterializationClaimParams,
  type SchemaWriteTransactionBackend,
  type TransactionBackend,
  type TrustedImportOptions,
  type TrustedImportSession,
  type VectorSearchParams,
} from "../types";
import {
  buildContributionInsertValues,
  buildContributionOnConflictSet,
  type ContributionMaterializer,
  gateFulltext,
  POSTGRES_CONTRIBUTION_MAT_TIMESTAMPS,
} from "./contribution-materializations";
import {
  edgeMatchIdentityPairCheckName,
  edgeMatchIdentityUniqueIndexName,
  generatePgCreateTableSQL,
  generatePostgresDDL,
  generatePostgresEdgeMatchIdentityUpgradeDDL,
  postgresContributions,
  postgresIdentifierRegclassName,
} from "./ddl";
import {
  type BaseSchemaRuntime,
  type ContributionRuntime,
  createSqlBackend,
  type EngineAssemblyContext,
  type EngineLateMembers,
  type EngineProvisioning,
  type GraphTemplateRuntime,
  type IdentityRuntime,
  type IndexMaterializationRuntime,
  type KindRemovalRuntime,
  type SqlEngineProfile,
} from "./engine";
import { finalizeEngineCapabilities } from "./engine/capabilities";
import { createContributionOperationMembers } from "./engine/members/contribution-members";
import { createFulltextMembers } from "./engine/members/fulltext-members";
import { createVectorMembers } from "./engine/members/vector-members";
import {
  buildCommonOperationOptions,
  createEngineOperationBackend,
} from "./engine/operation-layer";
import {
  type AnyPgDatabase,
  type AnyPgTransaction,
  createPostgresExecutionAdapter,
  getPgliteClient,
  hasFunctionProperty,
  isNeonHttpClient,
  isPgliteDatabase,
  isPostgresJsClient,
  PGLITE_MAX_BIND_PARAMETERS,
  type PostgresExecutionAdapter,
  type PostgresExecutionAdapterOptions,
} from "./execution/postgres-execution";
import { createSessionAtomicBatchAdapter } from "./execution/session-atomic-batch";
import { createSerialExecutionAdapter } from "./execution/statement-queue";
import { type ExecutableSql, toDrizzleSql } from "./execution/types";
import {
  buildMaterializationInsertValues,
  buildMaterializationOnConflictSet,
  POSTGRES_INDEX_MAT_TIMESTAMPS,
} from "./index-materializations";
import {
  buildKindRemovalInsertValues,
  buildKindRemovalOnConflictSet,
  POSTGRES_KIND_REMOVAL_TIMESTAMPS,
} from "./kind-removals";
import {
  assertActiveSchemaVersion,
  assertAdoptedDialect,
  createCommonOperationBackend,
  type InternalOperationBackend,
  type OperationBackendRowMappers,
} from "./operation-backend-core";
import { mapHybridSearchRow } from "./operations/hybrid";
import {
  createCachedTableExistence,
  createPostgresOperationStrategy,
} from "./operations/strategy";
import {
  createPostgresTables as buildPostgresTables,
  type PostgresTables,
  tables as defaultTables,
} from "./schema/postgres";
import {
  analyzeImportedTables,
  assertTrustedImportDatabaseEmpty,
  createPostgresTrustedImportSession,
  lockPostgresTrustedImportTables,
  restoreSecondaryIndexes,
  suspendPostgresSecondaryIndexes,
} from "./trusted-import";
import {
  EMBEDDING_UPSERT_PARAM_COUNT,
  mapVectorWriteError,
  vectorSlotFromParams,
} from "./vector-runtime";

// ============================================================
// Types
// ============================================================

/**
 * Options for creating a PostgreSQL backend.
 */
export type PostgresBackendOptions = Readonly<{
  /**
   * Custom table definitions. Use createPostgresTables() to customize table names.
   * Defaults to standard TypeGraph table names.
   */
  tables?: PostgresTables;
  /**
   * Fulltext strategy override. Defaults to `tsvectorStrategy`
   * (Postgres built-in `tsvector` + GIN). Pass a custom strategy here to
   * swap the entire fulltext stack — DDL, MATCH condition, rank
   * expression, and snippet generation — for alternate Postgres
   * backends like ParadeDB (`pg_search`), pg_trgm similarity, or
   * pgroonga without forking TypeGraph.
   */
  fulltext?: FulltextStrategy;
  /**
   * Vector strategy override. Defaults to `pgvectorStrategy` (pgvector's
   * `vector(N)` columns + HNSW/IVFFlat). The strategy owns per-`(kind,
   * field)` typed storage — DDL, upsert, delete, similarity search, and
   * ANN index lifecycle — and advertises `strategy.capabilities` as
   * `capabilities.vector`. Pass a custom strategy to swap the entire
   * vector stack for an alternate Postgres extension without forking
   * TypeGraph.
   *
   * Pass `false` to disable vector support entirely. The backend then
   * advertises no `capabilities.vector` and omits the embedding/search
   * methods, mirroring a SQLite connection without sqlite-vec. Required
   * for an in-process Postgres (e.g. PGlite) built without the pgvector
   * extension: the default `pgvectorStrategy` assumes `vector(N)` exists,
   * so any embedding write or `CREATE EXTENSION vector` would otherwise
   * hard-fail at runtime.
   */
  vector?: VectorStrategy | false;
  /**
   * Override specific backend capabilities. Useful when the underlying
   * driver doesn't support a feature TypeGraph would otherwise assume —
   * for example, an HTTP-only Postgres driver that can't hold a session
   * across statements would need
   * `{ execution: { interactiveTransactions: false } }` so TypeGraph refuses
   * paths that require an interactive transaction. Root atomic-batch support
   * is transport-derived and cannot be overridden here.
   *
   * `drizzle-orm/neon-http` is auto-detected and has interactive transactions
   * disabled without an explicit override; this option exists for
   * other HTTP-style drivers and for tests that need to simulate a
   * capability gap.
   */
  capabilities?: BundledBackendCapabilityOverrides;
  /**
   * Use server-side prepared statements (named statements cached per
   * pg connection) on the node-postgres / neon-serverless fast path.
   * Defaults to `true`. Set to `false` when pooling through pgbouncer
   * in transaction-pool mode — pgbouncer routes successive statements
   * over different backend connections, and a `name` registered on one
   * is invisible on the next.
   *
   * No effect on `drizzle-orm/postgres-js` (handles preparation
   * internally) or `drizzle-orm/neon-http` (no fast path).
   */
  prepareStatements?: boolean;
  /**
   * Cap on the number of distinct SQL strings retained in TypeGraph's
   * in-process SQL-to-statement-name lookup. Defaults to 256. Eviction never
   * reuses a name, so this does not deallocate or bound prepared statements
   * retained on live PostgreSQL connections. Set `prepareStatements: false`
   * for high-cardinality SQL text when server-side statement retention is not
   * acceptable. Ignored when `prepareStatements` is `false`.
   */
  preparedStatementCacheMax?: number;
  /**
   * Declare the connection this backend serializes every statement onto, when
   * TypeGraph's driver predicates cannot see it (Bun `SQL` at `{ max: 1 }`,
   * `pg-proxy`, a postgres-js client capped through a non-numeric string the
   * driver does not coerce) — or declare that it serializes on nothing, when
   * detection is wrong for your topology.
   *
   * Defaults to `{ mode: "detect" }`. See
   * {@link SerializedResourceDeclaration} for what each mode means and for the
   * one refusal it cannot lift (`same-sqlite-backend`, which is SQLite-only and
   * therefore never reached from here).
   */
  serializedResource?: SerializedResourceDeclaration;
}>;

const NODE_INSERT_PARAM_COUNT = 9;
const SCHEMA_FENCE_PARAM_COUNT = 2;
// Durable edge rows bind match-identity name and key in addition to the
// ordinary edge shape. Budget for the widest supported row so native batches
// never cross the driver's parameter ceiling.
const EDGE_INSERT_PARAM_COUNT = 14;
const GET_NODES_FIXED_PARAM_COUNT = 2;
const GET_EDGES_FIXED_PARAM_COUNT = 1;
const FULLTEXT_UPSERT_PARAM_COUNT = 6;
const FULLTEXT_DELETE_FIXED_PARAM_COUNT = 2;
const CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT = 3;
const UNIQUE_DELETE_FIXED_PARAM_COUNT = 2;
const UNIQUE_INSERT_PARAM_COUNT = 6;

type PostgresBatchChunkSizes = Readonly<{
  checkUniqueBatchChunkSize: number;
  edgeInsertBatchSize: number;
  edgeSchemaFencedInsertBatchSize: number;
  embeddingUpsertBatchSize: number;
  findEdgesEndpointChunkSize: number;
  fulltextDeleteChunkSize: number;
  fulltextUpsertBatchSize: number;
  getEdgesChunkSize: number;
  getNodesChunkSize: number;
  nodeInsertBatchSize: number;
  nodeSchemaFencedInsertBatchSize: number;
  uniqueDeleteChunkSize: number;
  uniqueInsertBatchSize: number;
}>;

function vectorSlotsFromManagedNodeCreatePlan(
  params: InsertNodeParams,
  plan: ManagedNodeCreatePlan,
): readonly VectorSlot[] {
  return plan.projections.flatMap((projection) =>
    projection.kind === "embedding" ?
      [
        {
          graphId: params.graphId,
          nodeKind: params.kind,
          fieldPath: projection.fieldPath,
          dimensions: projection.dimensions,
          metric: projection.metric,
          indexType: projection.indexType,
        },
      ]
    : [],
  );
}

function computePostgresBatchChunkSizes(
  maxBindParameters: number,
): PostgresBatchChunkSizes {
  return {
    checkUniqueBatchChunkSize: Math.max(
      1,
      maxBindParameters - CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT,
    ),
    edgeInsertBatchSize: Math.max(
      1,
      Math.floor(maxBindParameters / EDGE_INSERT_PARAM_COUNT),
    ),
    edgeSchemaFencedInsertBatchSize: Math.max(
      1,
      Math.floor(
        (maxBindParameters - SCHEMA_FENCE_PARAM_COUNT) /
          EDGE_INSERT_PARAM_COUNT,
      ),
    ),
    embeddingUpsertBatchSize: Math.max(
      1,
      Math.floor(maxBindParameters / EMBEDDING_UPSERT_PARAM_COUNT),
    ),
    findEdgesEndpointChunkSize: Math.max(
      1,
      maxBindParameters - FIND_EDGES_ENDPOINT_FIXED_PARAM_COUNT,
    ),
    fulltextDeleteChunkSize: Math.max(
      1,
      maxBindParameters - FULLTEXT_DELETE_FIXED_PARAM_COUNT,
    ),
    fulltextUpsertBatchSize: Math.max(
      1,
      Math.floor(maxBindParameters / FULLTEXT_UPSERT_PARAM_COUNT),
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
    nodeSchemaFencedInsertBatchSize: Math.max(
      1,
      Math.floor(
        (maxBindParameters - SCHEMA_FENCE_PARAM_COUNT) /
          NODE_INSERT_PARAM_COUNT,
      ),
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

/**
 * THE one-shot retry every idempotent catalog write in this backend shares.
 *
 * PostgreSQL's IF NOT EXISTS check cannot see another session's uncommitted
 * catalog row. The loser waits for the winner and is then handed the winner's
 * conflict instead of a harmless notice; retrying after that wait observes the
 * committed object. Which failures mean that is
 * {@link isPostgresConcurrentDdlRaceError}'s single decision — anything else
 * (and anything the retry cannot clear) stays loud.
 *
 * Takes a thunk rather than a statement because one caller — the extension
 * install — runs its statement inside its own transaction, and the retry
 * decision must be the same one whether the unit of work is one statement or a
 * locked pair.
 */
async function withConcurrentCreateRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isPostgresConcurrentDdlRaceError(error)) throw error;
    return await run();
  }
}

/**
 * The advisory-lock key an extension install serializes on.
 *
 * Per extension rather than one global key: the fence exists to stop two
 * installers of the SAME catalog row from colliding, and a shared key would
 * additionally queue `vector` behind `pg_trgm` at boot for no benefit. The
 * names it interpolates are allowlisted before they reach here.
 */
function extensionDdlLockKey(extension: DatabaseExtensionName): string {
  return `typegraph:extension-ddl:${extension}`;
}

type ExecutePostgresStatement = (statement: ExecutableSql) => Promise<void>;

function parallelWorkerResetSql(tableName: string): string {
  return `ALTER TABLE "${tableName.replaceAll('"', '""')}" RESET (parallel_workers);`;
}

function parallelWorkerResetError(
  tableName: string,
  resetError: unknown,
): Error {
  return new Error(
    `PostgreSQL did not restore the durable parallel_workers setting on vector table ${JSON.stringify(tableName)}. Run ${parallelWorkerResetSql(tableName)} before retrying index materialization.`,
    { cause: resetError },
  );
}

function vectorSerialFallbackPreparationError(
  step: "drop-index" | "disable-parallel-workers",
  parallelBuildError: unknown,
  preparationError: unknown,
): AggregateError {
  const action =
    step === "drop-index" ?
      "drop the partial vector index"
    : "disable parallel workers for the serial retry";
  return new AggregateError(
    [preparationError],
    `PostgreSQL could not ${action} after the parallel vector index build exhausted resources.`,
    { cause: parallelBuildError },
  );
}

function reportParallelWorkerResetFailure(
  tableName: string,
  resetError: unknown,
): void {
  try {
    if (typeof console === "undefined" || typeof console.error !== "function") {
      return;
    }
    const reported = (
      console.error as (...data: readonly unknown[]) => unknown
    )(
      `[typegraph] The serial vector index rebuild failed and cleanup also failed. ${parallelWorkerResetError(tableName, resetError).message}`,
      resetError,
    );
    void Promise.resolve(reported).catch(() => {
      // Reporting must not displace the index-build failure.
    });
  } catch {
    // A hostile or replaced logger cannot displace the index-build failure.
  }
}

async function resetVectorParallelWorkers(
  execute: ExecutePostgresStatement,
  tableName: string,
): Promise<void> {
  try {
    await execute(
      portableSql`ALTER TABLE ${portableSql.identifier(tableName)} RESET (parallel_workers)`,
    );
  } catch (resetError) {
    throw parallelWorkerResetError(tableName, resetError);
  }
}

/** @internal */
export async function runVectorIndexBuildWithSerialFallback(
  execute: ExecutePostgresStatement,
  tableName: string,
  indexStatement: ExecutableSql,
  dropStatement?: ExecutableSql,
): Promise<void> {
  // The strategy table is TypeGraph-owned, and parallel_workers is only set
  // temporarily by the fallback below. Reset it before every materialization
  // attempt so cleanup survives backend and process recreation. Keep this
  // outside the resource-failure catch: a cleanup error must never be
  // mistaken for a failed parallel build whose valid index should be dropped.
  await resetVectorParallelWorkers(execute, tableName);
  try {
    await execute(indexStatement);
  } catch (error) {
    if (!isInsufficientResourcesError(error)) throw error;
    if (dropStatement !== undefined) {
      try {
        await execute(dropStatement);
      } catch (dropError) {
        throw vectorSerialFallbackPreparationError(
          "drop-index",
          error,
          dropError,
        );
      }
    }
    await runSerialVectorIndexBuild(execute, tableName, indexStatement, error);
  }
}

/** @internal */
export async function runPostgresVectorIndexBuild(
  vectorStrategy: VectorStrategy,
  execute: ExecutePostgresStatement,
  tableName: string,
  indexStatement: ExecutableSql,
  dropStatement?: ExecutableSql,
): Promise<void> {
  if (vectorStrategy !== pgvectorStrategy) {
    await execute(indexStatement);
    return;
  }
  await runVectorIndexBuildWithSerialFallback(
    execute,
    tableName,
    indexStatement,
    dropStatement,
  );
}

/** @internal */
export async function runSerialVectorIndexBuild(
  execute: ExecutePostgresStatement,
  tableName: string,
  indexStatement: ExecutableSql,
  parallelBuildError?: unknown,
): Promise<void> {
  const table = portableSql.identifier(tableName);
  try {
    await execute(portableSql`ALTER TABLE ${table} SET (parallel_workers = 0)`);
  } catch (setError) {
    if (parallelBuildError === undefined) throw setError;
    throw vectorSerialFallbackPreparationError(
      "disable-parallel-workers",
      parallelBuildError,
      setError,
    );
  }

  let buildFailure: Readonly<{ error: unknown }> | undefined;
  try {
    await execute(indexStatement);
  } catch (error) {
    buildFailure = { error };
  }

  try {
    await execute(portableSql`ALTER TABLE ${table} RESET (parallel_workers)`);
  } catch (resetError) {
    if (buildFailure === undefined) {
      throw parallelWorkerResetError(tableName, resetError);
    }
    reportParallelWorkerResetFailure(tableName, resetError);
  }

  if (buildFailure !== undefined) throw buildFailure.error;
}

// ============================================================
// Utilities
// ============================================================

const toNodeRow = createNodeRowMapper(POSTGRES_ROW_MAPPER_CONFIG);
const toEdgeRow = createEdgeRowMapper(POSTGRES_ROW_MAPPER_CONFIG);
const toUniqueRow = createUniqueRowMapper(POSTGRES_ROW_MAPPER_CONFIG);
const toSchemaVersionRow = createSchemaVersionRowMapper(
  POSTGRES_ROW_MAPPER_CONFIG,
);

function buildPostgresCapabilities(
  fulltextStrategy: FulltextStrategy,
  vectorStrategy: VectorStrategy | undefined,
): BackendCapabilities {
  return {
    ...POSTGRES_CAPABILITIES,
    ...(vectorStrategy === undefined ?
      {}
    : { vector: buildVectorCapabilities(vectorStrategy) }),
    fulltext: buildFulltextCapabilities(fulltextStrategy),
  };
}

// ============================================================
// Backend Factory
// ============================================================

/**
 * Creates a TypeGraph backend for PostgreSQL databases.
 *
 * Works with any Drizzle PostgreSQL instance regardless of the underlying driver.
 *
 * @param db - A Drizzle PostgreSQL database instance
 * @param options - Backend configuration
 * @returns A GraphBackend implementation
 */
export function createPostgresBackend(
  db: AnyPgDatabase,
  options: PostgresBackendOptions = {},
): AdapterBackend<AnyPgTransaction> {
  return createSqlBackend(buildPostgresEngineProfile(db, options));
}

/**
 * Builds the PostgreSQL {@link SqlEngineProfile} `createSqlBackend` (from
 * `./engine`) assembles into a backend. Everything below is today's
 * PostgreSQL backend construction, unchanged, reorganized into the
 * profile's head data and its dialect-owned late members (`transactions`,
 * `fence`, `rawSql`, `maintenance`, `trustedImport`, `extensions`) — every
 * mirrored member group has been extracted into `members/*.ts` and is
 * assembled by `createSqlBackend` itself from head-data runtime deps this
 * profile supplies (`contributionRuntime`, `identityRuntime`,
 * `graphTemplateRuntime`, `baseSchemaRuntime`,
 * `indexMaterializationRuntime`, `kindRemovalRuntime`).
 */
function buildPostgresEngineProfile(
  db: AnyPgDatabase,
  options: PostgresBackendOptions = {},
): SqlEngineProfile<AnyPgTransaction> {
  assertNoLegacyTransactionCapability(options.capabilities);
  // Resolved before the backend exists so marking it below is a lookup, never
  // work that could fail after a wrapper already observed an unmarked backend.
  // A `serializedResource` declaration that contradicts detection is refused
  // here too, before any object a caller could hold has been built.
  const resourceAudit = resolveDeclaredBackendResource(
    getSerializedPostgresClient(db),
    options.serializedResource,
  );
  const tables = options.tables ?? defaultTables;
  const fulltextStrategy = options.fulltext ?? tsvectorStrategy;
  // pgvector is compiled into a standalone Postgres server, so it is wired
  // unconditionally by default (overridable for alternate Postgres vector
  // stacks). `vector: false` disables it — required for an in-process
  // Postgres (PGlite) built without the pgvector extension, where the
  // default strategy's `vector(N)` DDL would hard-fail.
  const vectorStrategy =
    options.vector === false ? undefined : (options.vector ?? pgvectorStrategy);
  // One probe per backend instance, shared with every transaction-scoped
  // backend so the pgvector version check runs — and its pre-0.8 warning
  // fires — at most once per backend, not once per `store.transaction()`.
  const iterativeScanProbe = createIterativeScanProbe();
  const baseCapabilities = buildPostgresCapabilities(
    fulltextStrategy,
    vectorStrategy,
  );
  // HTTP-only drivers (notably `drizzle-orm/neon-http`) can't hold a
  // session across statements, so multi-statement transactions are
  // unavailable regardless of what we declare. Auto-detect and downgrade
  // the capability so callers get correct fallback behavior without
  // having to remember to override it themselves.
  const httpOnlyOverrides =
    isNeonHttpClient(db) ?
      {
        execution: {
          ...POSTGRES_CAPABILITIES.execution,
          interactiveTransactions: false,
          atomicBatch: "root" as const,
        },
        graphAnalytics: {
          ...(baseCapabilities.graphAnalytics ?? { mathFunctions: true }),
          supported: false,
        },
      }
    : {};
  const configuredMaxBindParameters =
    options.capabilities?.maxBindParameters ?? POSTGRES_MAX_BIND_PARAMETERS;
  const driverBindParameterOverrides =
    isPgliteDatabase(db) ?
      {
        maxBindParameters: Math.min(
          configuredMaxBindParameters,
          PGLITE_MAX_BIND_PARAMETERS,
        ),
      }
    : {};
  const requestedPessimisticLocks = options.capabilities?.pessimisticLocks;
  if (requestedPessimisticLocks?.serializedWriters === true) {
    throw new ConfigurationError(
      "PostgreSQL backend capability overrides cannot claim serialized writers.",
      { requestedPessimisticLocks },
      {
        suggestion:
          "Keep serializedWriters: false. A PostgreSQL pool requires its advisory-lock fence; use a custom backend only when the underlying engine really provides a single writer slot.",
      },
    );
  }
  const pessimisticLocks =
    requestedPessimisticLocks === undefined ?
      POSTGRES_CAPABILITIES.pessimisticLocks
    : {
        advisoryLocks: requestedPessimisticLocks.advisoryLocks,
        tableLocks: requestedPessimisticLocks.tableLocks,
        serializedWriters: false,
      };
  const declaredCapabilities = normalizeGraphAnalyticsCapabilities({
    ...baseCapabilities,
    ...httpOnlyOverrides,
    ...options.capabilities,
    execution: {
      ...baseCapabilities.execution,
      ...httpOnlyOverrides.execution,
      ...options.capabilities?.execution,
    },
    ...driverBindParameterOverrides,
    pessimisticLocks,
  });
  // Derived last and not overridable: how far up the contribution health
  // ladder this backend goes is a structural fact about the wiring below
  // (durable markers, a catalog probe, a strategy that declares teardown
  // DDL, a transactional schema fence), and a caller who declared a
  // rebuild this backend cannot perform would be advertising a lie. The
  // HTTP-only drivers land on `rebuild: false` here because they cannot
  // hold a session across statements, so there is no fence to run under.
  const adapterOptions: PostgresExecutionAdapterOptions = {
    ...(options.prepareStatements === undefined ?
      {}
    : { prepareStatements: options.prepareStatements }),
    ...(options.preparedStatementCacheMax === undefined ?
      {}
    : { preparedStatementCacheMax: options.preparedStatementCacheMax }),
    maxBindParameters:
      declaredCapabilities.maxBindParameters ?? POSTGRES_MAX_BIND_PARAMETERS,
    interactiveAtomicBatch:
      declaredCapabilities.execution.interactiveTransactions &&
      (resourceAudit.kind === "independent" || isPgliteDatabase(db)),
  };
  const executionAdapter = createPostgresExecutionAdapter(db, adapterOptions);
  const atomicSqlProgramExecutor =
    createAtomicSqlProgramExecutor(executionAdapter);
  // The capability tail (`finalizeEngineCapabilities`, `./engine/capabilities`)
  // runs here as well as inside `createSqlBackend`, since `capabilities`
  // below feeds the fence target and the operation backend this factory
  // still builds inline. `createSqlBackend` calls it again with
  // `profile.declaredCapabilities` to resolve `ctx.capabilities` — a profile
  // variant built by overriding `declaredCapabilities` (as the refusal tests
  // do) is re-derived correctly only because that function stays pure in its
  // arguments rather than a cached value; the resulting duplicated
  // derivation is a known, harmless-today identity gap between
  // `ctx.capabilities` and the `capabilities` object already baked into
  // `operations` below.
  const capabilities: BackendCapabilities = finalizeEngineCapabilities(
    declaredCapabilities,
    {
      execution: executionAdapter,
      fulltextStrategy,
      fulltextTableName: tables.fulltextTableName,
    },
  );
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
    edgeClaims: getTableName(tables.edgeClaims),
  };
  // Pre-quote identifiers so refreshStatistics() doesn't rebuild the
  // ANALYZE statements on every call. The recorded and identity relations
  // are ANALYZEd separately under an existence guard (see refreshStatistics):
  // a schema created before recorded-time history or Operational Identity
  // landed (bring-your-own-pool, no DDL re-run) has no recorded_* / identity_*
  // tables, and Postgres fails the whole ANALYZE if any named relation is
  // missing. Per-field vector tables are created lazily and live outside this
  // base set, so they are not ANALYZEd here.
  //
  // ONE statement per table with SKIP_LOCKED, never `ANALYZE a, b, c`:
  // ANALYZE takes a ShareUpdateExclusive lock, the same class CREATE INDEX
  // CONCURRENTLY holds for its whole build — and a CIC in another session
  // waits on every regular transaction's snapshot, ANALYZE's included. An
  // ANALYZE that queues on a CIC's table lock while that CIC waits on the
  // ANALYZE's snapshot is a two-node deadlock (observed when two
  // materializeIndexes callers race). SKIP_LOCKED makes ANALYZE skip a
  // locked table instead of queuing, so it can never join a wait cycle;
  // a skipped table is covered by the next refresh or autovacuum.
  const coreAnalyzeStatements = [
    tableNames.nodes,
    tableNames.edges,
    getTableName(tables.uniques),
    tableNames.fulltext,
  ].map((name) =>
    toDrizzleSql(
      portableSql`ANALYZE (SKIP_LOCKED) ${portableSql.identifier(name)}`,
      "postgres",
    ),
  );
  const guardedAnalyzeTables = [
    tableNames.recordedNodes,
    tableNames.recordedEdges,
    tableNames.recordedClock,
    tableNames.recordedIdentityAssertions,
    tableNames.identityAssertions,
    tableNames.identityClosure,
    tableNames.identitySeparation,
  ] as const;
  const operationStrategy = createPostgresOperationStrategy(
    tables,
    fulltextStrategy,
    vectorStrategy,
  );

  // Whether `tableName` currently exists, via the same catalog probe `clear()`
  // uses — so refreshStatistics() never ANALYZEs a recorded or identity
  // relation that a bring-your-own-pool schema has not yet created. The
  // Postgres probe is search_path-aware, so positive results are deliberately
  // not cached by bare table name.
  const guardedTableExists = createCachedTableExistence(
    async (tableName) => {
      const rows = await executionAdapter.execute<Record<string, unknown>>(
        operationStrategy.buildTableExists(tableName),
      );
      return rows[0];
    },
    { cacheExisting: false },
  );

  // Durable fulltext + vector materialization (#135): the dialect-specific
  // marker-table primitives. Orchestration (materialize / assert /
  // per-instance cache) lives once in `createContributionMaterializer`,
  // shared by the outer backend and every transaction-scoped backend so a
  // slot's marker is resolved at most once per process. Built before
  // `operations` so the operation backend's vector methods can assert/
  // ensure through it instead of issuing DDL on the hot path.
  const matTable = tables.contributionMaterializations;

  /**
   * Runs one IDEMPOTENT DDL statement — `CREATE ... IF NOT EXISTS` or
   * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — with the one-shot retry a
   * concurrent boot needs.
   */
  async function executeConcurrentCreateDdl(ddl: string): Promise<void> {
    const statement = sql.raw(ddl);
    await withConcurrentCreateRetry(async () => {
      await db.execute(statement);
    });
  }

  /**
   * THE one place this backend installs a database extension, for every
   * extension and every caller.
   *
   * An extension is database-global while the claims that reach it are not (an
   * index-materialization claim is per index), so two callers wanting different
   * objects still race on `pg_extension_name_index`. Two fences answer that,
   * and both are here because they answer different halves of it:
   *
   *  - the advisory lock serializes same-key installers inside this process
   *    group so the common case never raises at all (#475). It is keyed on the
   *    extension so installing `vector` does not queue behind `pg_trgm`;
   *  - {@link withConcurrentCreateRetry} clears the 23505 an installer that did
   *    NOT take this lock can still hand us — a peer on an older version, whose
   *    lock key differs, or a `capabilities.execution.interactiveTransactions: false` backend which
   *    has no transaction to hang a `pg_advisory_xact_lock` on (#446).
   *
   * The lock runs in its own transaction on purpose: a 23505 poisons an
   * enclosing transaction (the next statement fails `25P02`), so the retry is
   * sound only when the failed unit of work is one this function owns
   * end-to-end.
   */
  async function ensureDatabaseExtension(
    name: DatabaseExtensionName,
  ): Promise<void> {
    // The name reaches DDL by interpolation, so the allowlist — not the
    // caller's type — is what makes the identifier trustworthy at runtime.
    const validated = DATABASE_EXTENSION_NAMES.find(
      (candidate) => candidate === name,
    );
    if (validated === undefined) {
      throw new ConfigurationError(
        `Unsupported database extension "${name}".`,
        { extension: name, supported: DATABASE_EXTENSION_NAMES },
        {
          suggestion: `Request one of: ${DATABASE_EXTENSION_NAMES.join(", ")}.`,
        },
      );
    }
    const ddl = `CREATE EXTENSION IF NOT EXISTS "${validated}";`;
    if (!capabilities.execution.interactiveTransactions) {
      await executeConcurrentCreateDdl(ddl);
      return;
    }
    await withConcurrentCreateRetry(async () => {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${extensionDdlLockKey(validated)}), 0)`,
        );
        await tx.execute(sql.raw(ddl));
      });
    });
  }

  // ONE fence target for the whole factory, shared by the contribution
  // materializer's two lock sites and by the schema fence's two below, so
  // every lock this backend can take resolves the SAME plan. Marked
  // first-party because both are, and because `capabilities` here is the
  // object the factory assembled — a caller who blanked `pessimisticLocks`
  // out of it must still resolve the dialect-derived plan, not `unfenced`.
  const fenceTarget: WriteFenceTarget = markFirstPartyFactory({
    dialect: "postgres",
    capabilities,
  });

  // Deps for `createContributionMembers` (`./engine/members/contribution-members`),
  // beyond what `createSqlBackend` supplies itself: `dialect`/`fulltextStrategy`/
  // `vectorStrategy` (the profile head), `fenceTarget` above, `ensureTable`/
  // `execute`/`operationStrategy` (`provisioning`/`execution`/`strategy`), and
  // `schemaWriteTransaction` (the fence's own late member, once it exists).
  const contributionRuntime: ContributionRuntime = {
    fulltextTableName: tables.fulltextTableName,
    contributionTableDdl: generatePgCreateTableSQL(matTable),
    reconciliationMarkersTableDdl: generatePgCreateTableSQL(
      tables.reconciliationMarkers,
    ),
    timestamps: POSTGRES_CONTRIBUTION_MAT_TIMESTAMPS,
    contributionMarkerColumns: matTable,
    contributionMarkerRows: {
      selectWhere: (condition) => db.select().from(matTable).where(condition),
      async upsert(params) {
        await db
          .insert(matTable)
          .values(
            buildContributionInsertValues(
              params,
              POSTGRES_CONTRIBUTION_MAT_TIMESTAMPS.encode,
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
      },
      async deleteWhere(condition) {
        await db.delete(matTable).where(condition);
      },
    },
    reconciliationMarkerColumns: tables.reconciliationMarkers,
    reconciliationMarkerRows: {
      selectWhere: (condition) =>
        db.select().from(tables.reconciliationMarkers).where(condition),
      async upsert(graphId, version) {
        await db
          .insert(tables.reconciliationMarkers)
          .values({ graphId, reconciledToVersion: version })
          .onConflictDoUpdate({
            target: tables.reconciliationMarkers.graphId,
            set: { reconciledToVersion: version },
          });
      },
    },
  };

  // Deps for `createIdentityMembers`, beyond `ensureTable` (`provisioning`)
  // and `contributionTableExists` (from the contribution member group
  // `createSqlBackend` builds first).
  const identityRuntime: IdentityRuntime = {
    revisionOriginsTableDdl: generatePgCreateTableSQL(tables.revisionOrigins),
    contributionsForTableNames: (overrides) =>
      postgresContributions(buildPostgresTables(overrides), fulltextStrategy),
    primaryKeyConstraintNameFor: (tableName) => `${tableName}_pkey`,
  };

  /**
   * Builds this profile's top-level `InternalOperationBackend`, deferred
   * until `createSqlBackend` has built the contribution materializer (its
   * `buildCommonOperationOptions` assembly needs it for the projection-
   * evidence callbacks) — everything else here is a plain closure capture,
   * unchanged from when this call site built `operations` directly.
   */
  function buildOperations(
    contributionMaterializer: ContributionMaterializer,
  ): InternalOperationBackend {
    return createPostgresOperationBackend({
      db,
      executionAdapter,
      ...(atomicSqlProgramExecutor === undefined ?
        {}
      : { atomicSqlProgramExecutor }),
      adapterOptions,
      operationStrategy,
      tableNames,
      capabilities,
      fulltextStrategy,
      vectorStrategy,
      contributionMaterializer,
      iterativeScanProbe,
      schemaVersionsTable: tables.schemaVersions,
      fenceTarget,
      transactionScoped: false,
    });
  }

  async function ensureEdgeMatchIdentityStorage(): Promise<void> {
    const edgeTableName = getTableName(tables.edges);
    const [storage] = await executionAdapter.execute<{
      has_check?: unknown;
      has_index?: unknown;
      has_key?: unknown;
      has_name?: unknown;
      table_name?: unknown;
    }>(
      portableSql`SELECT
        to_regclass(${postgresIdentifierRegclassName(edgeTableName)}) AS table_name,
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass(${postgresIdentifierRegclassName(edgeTableName)})
            AND attname = 'match_identity_name' AND NOT attisdropped
        ) AS has_name,
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass(${postgresIdentifierRegclassName(edgeTableName)})
            AND attname = 'match_identity_key' AND NOT attisdropped
        ) AS has_key,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = to_regclass(${postgresIdentifierRegclassName(edgeTableName)})
            AND conname = ${edgeMatchIdentityPairCheckName(edgeTableName)}
        ) AS has_check,
        to_regclass(${postgresIdentifierRegclassName(edgeMatchIdentityUniqueIndexName(edgeTableName))}) IS NOT NULL AS has_index`,
    );
    if (typeof storage?.table_name !== "string") return;
    const statements =
      generatePostgresEdgeMatchIdentityUpgradeDDL(edgeTableName);
    const missingStatements = [
      storage.has_name === true ? undefined : statements[0],
      storage.has_key === true ? undefined : statements[1],
      storage.has_check === true ? undefined : statements[2],
      storage.has_index === true ? undefined : statements[3],
    ].filter((statement): statement is string => statement !== undefined);
    for (const statement of missingStatements) {
      await executeConcurrentCreateDdl(statement);
    }
  }

  async function readBaseSchemaVersion(): Promise<number | undefined> {
    try {
      const rows = await db
        .select({ version: tables.baseSchemaVersions.version })
        .from(tables.baseSchemaVersions)
        .where(eq(tables.baseSchemaVersions.installation, 1));
      return rows.at(0)?.version;
    } catch (error) {
      if (isMissingTableError(error)) return undefined;
      throw error;
    }
  }

  async function writeBaseSchemaVersion(
    version: number,
  ): Promise<number | undefined> {
    const marker = tables.baseSchemaVersions;
    const timestamp = new Date();
    await db
      .insert(marker)
      .values({ installation: 1, version, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: marker.installation,
        set: { version, updatedAt: timestamp },
        setWhere: lte(marker.version, version),
      });
    // Read back on this backend's primary connection: remote adapters do not
    // all support RETURNING. The monotonic upsert plus same-primary read makes
    // this two-statement observation safe when a concurrent adopter is ahead.
    return readBaseSchemaVersion();
  }

  /**
   * PostgreSQL's additive-column migration for an index-materializations
   * table created before the build-claim columns existed; fresh installs
   * already have them from `ensureIndexMaterializationsTable`'s CREATE
   * TABLE. These take the concurrent-DDL retry for the same reason the
   * CREATE does, and it is the same loop two replicas run at boot: ADD
   * COLUMN IF NOT EXISTS cannot see another session's uncommitted
   * pg_attribute row, so the loser waits and is then handed 42701 (or
   * `tuple concurrently updated`) instead of the notice — a spuriously
   * failed boot (#445).
   */
  async function ensureIndexMaterializationColumns(
    tableName: string,
  ): Promise<void> {
    await executeConcurrentCreateDdl(
      `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "building_since" timestamptz;`,
    );
    await executeConcurrentCreateDdl(
      `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "claim_token" text;`,
    );
  }

  const provisioning: EngineProvisioning = {
    async executeDdl(ddl: string): Promise<void> {
      await db.execute(sql.raw(ddl));
    },
    ensureTable: executeConcurrentCreateDdl,
    generateDdl: () => generatePostgresDDL(tables, fulltextStrategy),
    ensureIndexMaterializationColumns,
    ensureExtension: ensureDatabaseExtension,
    ensureTrigramExtension: () => ensureDatabaseExtension("pg_trgm"),
  };

  // Deps for `createGraphTemplateMembers`, beyond `dialect` (the profile
  // head), `ensureTable` (`provisioning`), and `execute` (the operation
  // layer's own `execute`, built once `createSqlBackend` has a contribution
  // materializer to hand `buildOperations`).
  const graphTemplateRuntime: GraphTemplateRuntime = {
    graphTemplatesTableDdl: generatePgCreateTableSQL(tables.graphTemplates),
    tableNames: {
      schemaVersions: getTableName(tables.schemaVersions),
      graphTemplates: getTableName(tables.graphTemplates),
      contributionMaterializations: getTableName(
        tables.contributionMaterializations,
      ),
    },
    toSchemaVersionRow,
    rowAccess: {
      async insertIgnoringConflict(params) {
        const t = tables.graphTemplates;
        await db
          .insert(t)
          .values({
            templateId: params.templateId,
            schemaHash: params.schemaHash,
            schemaDoc: params.schemaDoc,
            createdAt: new Date(),
          })
          .onConflictDoNothing();
      },
      async selectByTemplateId(templateId) {
        const t = tables.graphTemplates;
        const templateRows = await db
          .select()
          .from(t)
          .where(eq(t.templateId, templateId));
        const row = templateRows.at(0);
        if (row === undefined) return;
        return {
          templateId: row.templateId,
          schemaHash: row.schemaHash,
          schemaDoc: JSON.stringify(row.schemaDoc),
          createdAt: row.createdAt.toISOString(),
        };
      },
    },
    // PostgreSQL's own statement already copies the template's
    // contribution markers inside its CTE (see `graph-template-sql.ts`),
    // so this profile supplies no `copyContributionMarkers` dep.
  };

  // Deps for `createBaseSchemaMembers`, beyond `ensureTable`/`executeDdl`/
  // `generateDdl` (`provisioning`) and `ensureGraphTemplatesTable` (from the
  // graph-template member group `createSqlBackend` builds first).
  const baseSchemaRuntime: BaseSchemaRuntime = {
    baseSchemaVersionsTableDdl: generatePgCreateTableSQL(
      tables.baseSchemaVersions,
    ),
    readVersion: readBaseSchemaVersion,
    writeVersion: writeBaseSchemaVersion,
    ensureEdgeMatchIdentityStorage,
  };

  const limits = {
    maxBindParameters:
      capabilities.maxBindParameters ?? POSTGRES_MAX_BIND_PARAMETERS,
    batchConfig: computePostgresBatchChunkSizes(
      capabilities.maxBindParameters ?? POSTGRES_MAX_BIND_PARAMETERS,
    ),
  };
  const rowMappers: OperationBackendRowMappers = {
    toEdgeRow,
    toNodeRow,
    toSchemaVersionRow,
    toUniqueRow,
  };

  // Deps for `createIndexMaterializationMembers`, beyond `ensureTable` /
  // `ensureIndexMaterializationColumns` (both `provisioning`).
  const indexMaterializationRuntime: IndexMaterializationRuntime = {
    indexMaterializationsTableDdl: generatePgCreateTableSQL(
      tables.indexMaterializations,
    ),
    tableName: getTableName(tables.indexMaterializations),
    timestamps: POSTGRES_INDEX_MAT_TIMESTAMPS,
    rowAccess: {
      async selectByIndexName(indexName) {
        const t = tables.indexMaterializations;
        return db.select().from(t).where(eq(t.indexName, indexName));
      },
      async selectByIndexNames(indexNames) {
        const t = tables.indexMaterializations;
        return db
          .select()
          .from(t)
          .where(inArray(t.indexName, [...indexNames]));
      },
      async upsert(params) {
        const t = tables.indexMaterializations;
        await db
          .insert(t)
          .values(
            buildMaterializationInsertValues(
              params,
              POSTGRES_INDEX_MAT_TIMESTAMPS.encode,
            ),
          )
          .onConflictDoUpdate({
            target: t.indexName,
            set: buildMaterializationOnConflictSet(params.materializedAt),
          });
      },
    },
  };

  // Deps for `createKindRemovalMembers`, beyond `ensureTable` (`provisioning`).
  const kindRemovalRuntime: KindRemovalRuntime = {
    kindRemovalsTableDdl: generatePgCreateTableSQL(tables.kindRemovals),
    timestamps: POSTGRES_KIND_REMOVAL_TIMESTAMPS,
    rowAccess: {
      async selectPending(graphId) {
        const t = tables.kindRemovals;
        return db
          .select()
          .from(t)
          .where(and(eq(t.graphId, graphId), isNull(t.removedAt)));
      },
      async selectAll(graphId) {
        const t = tables.kindRemovals;
        return db.select().from(t).where(eq(t.graphId, graphId));
      },
      async upsert(params: RecordKindRemovalParams) {
        const t = tables.kindRemovals;
        await db
          .insert(t)
          .values(
            buildKindRemovalInsertValues(
              params,
              POSTGRES_KIND_REMOVAL_TIMESTAMPS.encode,
            ),
          )
          .onConflictDoUpdate({
            target: [t.graphId, t.kindName, t.entity, t.schemaVersion],
            set: buildKindRemovalOnConflictSet(t.removedAt, params.removedAt),
          });
      },
    },
  };

  function lateMembers(
    ctx: EngineAssemblyContext<AnyPgTransaction>,
  ): EngineLateMembers<AnyPgTransaction> {
    /**
     * The per-graph schema-commit fence.
     *
     * Resolves a {@link resolveWriteFencePlan} rather than emitting the lock
     * unconditionally, so the decision has the same one owner every other lock
     * site reads — and then REFUSES, like every other fence that guards a
     * read-then-write spanning statements, rather than degrading.
     *
     * It fences a read-then-write sequence that spans STATEMENTS, not a
     * predicate carried inside one. `commitSchemaVersion` reads the row for the
     * incoming version, reads the active version, and only then runs the
     * `deactivateAll` / `activateVersion` pair — and its own comment names this
     * fence as what serializes that ("BEGIN IMMEDIATE on SQLite,
     * pg_advisory_xact_lock on Postgres"). Skipping the lock does not leave a
     * slower-but-correct path, it leaves a check-then-write window in which a
     * concurrent commit lands between the read and the flip. The partial unique
     * index on `(graph_id) WHERE is_active` still refuses a SECOND active row,
     * but it cannot order two commits that each read a version the other is
     * about to replace.
     *
     * `engine-serialized` is the exception `requireWriteFence` already encodes:
     * the writer slot IS the fence, so there is no concurrent commit to order.
     *
     * The row-locking clause rides the `lock` arm rather than a fact of its
     * own: it is never taken without the advisory lock above it, so no shipped
     * or plausible engine distinguishes them. An engine that implements
     * `pg_advisory_xact_lock` but not `FOR UPDATE` is where a `rowLocks`
     * member of `PessimisticLockCapabilities` would earn its place.
     */
    async function acquireSchemaWriteFence(
      tx: AnyPgTransaction,
      graphId: string,
    ): Promise<void> {
      const plan = requireWriteFence(
        resolveWriteFencePlan(fenceTarget),
        "The PostgreSQL schema-commit fence",
        "advisory-lock",
      );
      switch (plan.kind) {
        case "lock": {
          // Advisory lock: hashtext($graphId) is collision-tolerant for the
          // size of an active graph set; collisions just serialize unrelated
          // graphs which is harmless. Held until the transaction commits.
          //
          // The ONE-ARGUMENT (bigint) form is deliberate and load-bearing: it
          // occupies a different lock space than the two-argument (int4, int4)
          // form every namespaced TypeGraph lock uses (`typegraph:identity`,
          // `typegraph:identity-ddl`, the recorded-write clock). PostgreSQL
          // stores the two forms with different locktag field4 values, so a
          // bigint key can never collide with an (int4, int4) key however the
          // hashes land — the schema fence is therefore independent of every
          // lock taken INSIDE it. Normalizing this to the two-argument form
          // would merge the spaces and put that independence at the mercy of
          // `hashtext` collisions.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${graphId}))`,
          );
          // Managed entity writers lock this row FOR SHARE. Locking it FOR
          // UPDATE before any emptiness probe makes a writer-first commit
          // wait; a schema-first snapshot-isolated writer gets PostgreSQL's
          // native serialization failure instead of validating a stale row
          // version.
          // eslint-disable-next-line unicorn/template-indent -- this SQL text is snapshot-asserted verbatim (tests/engine-profile-parity.test.ts); autofix would reindent it to this closure's nesting depth and change the captured statement text.
          await tx.execute(sql`
          SELECT ${tables.schemaVersions.version}
          FROM ${tables.schemaVersions}
          WHERE ${tables.schemaVersions.graphId} = ${graphId}
            AND ${tables.schemaVersions.isActive} = TRUE
          FOR UPDATE
        `);
          return;
        }
        case "engine-serialized": {
          // The writer slot IS the fence; the commit already runs alone, which
          // is the guarantee `commitSchemaVersion`'s own comment names
          // ("BEGIN IMMEDIATE on SQLite"). Nothing to take.
          return;
        }
        default: {
          plan satisfies never;
        }
      }
    }

    /**
     * Runs `fn` inside a Postgres transaction, under whatever fence
     * {@link acquireSchemaWriteFence} resolves. On a `lock` backend that is an
     * `pg_advisory_xact_lock` keyed on the graph id, which serializes all
     * schema commits per-graph: the read-then-write CAS in
     * `commitSchemaVersion` is safe even for the initial-commit case where
     * there is no row yet to `SELECT ... FOR UPDATE`. On an `unfenced` one
     * that initial-commit case falls back to the storage layer — the partial
     * unique index on `(graph_id) WHERE is_active` fails the loser of a
     * concurrent first commit rather than admitting two active rows.
     *
     * Refuses on backends that don't support transactions
     * (`drizzle-orm/neon-http`). The orphan-row crash window cannot be
     * eliminated without atomicity, so silent best-effort degradation is
     * worse than a typed error.
     */
    function runSchemaWriteTransaction<T>(
      graphId: string,
      fn: (tx: InternalOperationBackend) => Promise<T>,
    ): Promise<T> {
      if (!capabilities.execution.interactiveTransactions) {
        throw new ConfigurationError(
          "Schema writes and removal cleanup require atomic transactions, " +
            "but this Postgres backend does not provide them. The drizzle-orm/neon-http " +
            "driver communicates over HTTP and cannot hold a session across statements; " +
            "use drizzle-orm/neon-serverless (websocket) for transactional writes.",
          {
            backend: "postgres",
            capability: "execution.interactiveTransactions",
            supportsInteractiveTransactions: false,
          },
        );
      }

      return db.transaction(async (tx) => {
        await acquireSchemaWriteFence(tx, graphId);
        // The fence resolved above is held here, so the schema-write-capable
        // InternalOperationBackend is used intentionally (see its type).
        const { backend: txBackend, drainAndClose } = createTransactionBackend({
          db: tx,
          adapterOptions,
          operationStrategy,
          tableNames,
          capabilities,
          fulltextStrategy,
          vectorStrategy,
          contributionMaterializer: ctx.contributionMaterializer,
          iterativeScanProbe,
          schemaVersionsTable: tables.schemaVersions,
          fenceTarget,
        });
        try {
          return await fn(txBackend);
        } finally {
          await drainAndClose();
        }
      });
    }

    // Shared by `transaction()` (TypeGraph opens the tx) and
    // `adoptTransaction()` (#134 — the caller already opened it): bind a
    // tx-scoped backend to the *literal* `tx` client and gate fulltext on
    // the durable marker (a cached SELECT, never DDL).
    function bindTransactionBackend(tx: AnyPgTransaction): Readonly<{
      backend: TransactionBackend;
      drainAndClose: () => Promise<void>;
    }> {
      const { backend, drainAndClose } = createTransactionBackend({
        db: tx,
        adapterOptions,
        operationStrategy,
        tableNames,
        capabilities,
        fulltextStrategy,
        vectorStrategy,
        contributionMaterializer: ctx.contributionMaterializer,
        iterativeScanProbe,
        schemaVersionsTable: tables.schemaVersions,
        fenceTarget,
      });
      const gatedBackend = carryAtomicMutationSessionRegistration(
        backend,
        gateFulltext(
          backend,
          ctx.contributionMaterializer.assertInitialized,
          ctx.contributionMaterializer.refuseUnavailableFulltext,
        ),
      );
      return {
        backend: gatedBackend,
        drainAndClose,
      };
    }

    return {
      transactions: {
        async transaction<T>(
          fn: (tx: TransactionBackend) => Promise<T>,
          options?: InternalTransactionOptions,
        ): Promise<T> {
          return ctx.self().transactionWithNative((tx) => fn(tx), options);
        },

        async transactionWithNative<T>(
          fn: (tx: TransactionBackend, sql: AnyPgTransaction) => Promise<T>,
          options?: InternalTransactionOptions,
        ): Promise<T> {
          // #134/#135: NO DDL or ensure here. The tx-scoped backend's
          // fulltext-touching methods assert the durable contribution
          // marker (one cached SELECT — never DDL) at point of use, exactly
          // like the non-tx wrappers. A transaction that never touches
          // fulltext never asserts; one that does runs pure DML against an
          // already-materialized table, with the "no DDL in the business
          // transaction" guarantee backed by the durable fact.
          const temporaryWrites =
            options?.temporaryWrites === INTERNAL_TEMPORARY_WRITES;
          if (temporaryWrites && options.accessMode !== "read_only") {
            throw new ConfigurationError(
              "Temporary-write transactions must be semantically read-only.",
              { dialect: "postgres" },
            );
          }
          const txConfig =
            (
              options?.isolationLevel !== undefined ||
              options?.accessMode !== undefined ||
              temporaryWrites
            ) ?
              {
                ...(options.isolationLevel === undefined ?
                  {}
                : {
                    isolationLevel: options.isolationLevel.replace("_", " ") as
                      | "read uncommitted"
                      | "read committed"
                      | "repeatable read"
                      | "serializable",
                  }),
                ...(options.accessMode === undefined && !temporaryWrites ?
                  {}
                : {
                    accessMode:
                      temporaryWrites ?
                        ("read write" as const)
                      : (requireDefined(options.accessMode).replace(
                          "_",
                          " ",
                        ) as "read only" | "read write"),
                  }),
              }
            : undefined;

          return db.transaction(async (tx) => {
            const { backend: txBackend, drainAndClose } =
              bindTransactionBackend(tx);
            try {
              return await fn(markSchemaFencedInsertEligible(txBackend), tx);
            } finally {
              // Drizzle emits COMMIT / ROLLBACK on this same pinned connection the
              // instant the callback settles, and those control statements do not
              // travel through the backend's statement queue. Wait for whatever is
              // on the wire, and refuse anything the callback left running — a
              // `Promise.all` that rejects orphans its siblings, whose statements
              // would otherwise overlap the ROLLBACK and then land on a connection
              // the pool had already handed to somebody else.
              await drainAndClose();
            }
          }, txConfig);
        },

        adoptTransaction(externalTx: AnyPgTransaction): TransactionBackend {
          // #134: cross-store atomicity is unsafe without real rollback —
          // the caller's relational write on `externalTx` *would* still
          // commit even though the graph write could not be undone. Refuse
          // loudly rather than silently degrade.
          if (!capabilities.execution.interactiveTransactions) {
            throw new ConfigurationError(
              "Cross-store atomicity is unavailable on this Postgres backend: " +
                "its driver does not support transactions (drizzle-orm/neon-http, " +
                "Cloudflare D1). Adopting an external transaction here would let " +
                "the caller's relational write commit with no way to roll back " +
                "the graph write. Use a node-postgres or neon-serverless " +
                "(Pool/WebSocket) connection for cross-store transactions.",
              {
                backend: "postgres",
                capability: "execution.interactiveTransactions",
                supportsInteractiveTransactions: false,
              },
            );
          }
          assertAdoptedDialect<AnyPgTransaction>(
            externalTx,
            PgTransaction,
            "postgres",
          );
          // The caller owns BEGIN/COMMIT/ROLLBACK via its own
          // `db.transaction(...)`. We adopt the literal `tx` client and run
          // pure DML on it — no transaction is opened or closed here, and no
          // DDL is emitted inside the caller's business transaction.
          //
          // Statements still serialize onto the pinned connection, but the queue
          // is never closed: only the caller knows when their transaction ends,
          // so it is on them to await every graph write before committing.
          return bindTransactionBackend(externalTx).backend;
        },

        async schemaWriteTransaction<T>(
          graphId: string,
          fn: (tx: SchemaWriteTransactionBackend) => Promise<T>,
        ): Promise<T> {
          return runSchemaWriteTransaction(graphId, (target) => fn(target));
        },
      },

      fence: {
        runSchemaWriteTransaction,
      },

      rawSql: {
        execute: ctx.operations.execute,
        ...(ctx.operations.executeRaw === undefined ?
          {}
        : { executeRaw: ctx.operations.executeRaw }),
      },

      maintenance: {
        async refreshStatistics(): Promise<void> {
          // Scoped to TypeGraph-managed tables only — we don't touch
          // unrelated tables in the same database. Without fresh stats
          // after a bulk load the planner can pick a reverse-index scan
          // with a filter (5ms forward traversal instead of 0.5ms) until
          // autovacuum catches up. Sequential per-table statements — see
          // coreAnalyzeStatements for why they are never combined.
          for (const statement of coreAnalyzeStatements) {
            await db.execute(statement);
          }
          // The recorded and identity relations may be absent on a schema created
          // before recorded-time history or Operational Identity landed
          // (bring-your-own-pool, no DDL re-run). Postgres fails an ANALYZE naming
          // a missing relation, so ANALYZE only the guarded tables that exist.
          const tablePresence = await Promise.all(
            guardedAnalyzeTables.map(async (tableName) => ({
              tableName,
              exists: await guardedTableExists(tableName),
            })),
          );
          const presentGuardedTables = tablePresence
            .filter((entry) => entry.exists)
            .map((entry) => entry.tableName);
          for (const tableName of presentGuardedTables) {
            await db.execute(
              toDrizzleSql(
                portableSql`ANALYZE (SKIP_LOCKED) ${portableSql.identifier(tableName)}`,
                "postgres",
              ),
            );
          }
        },
      },

      ...((
        capabilities.execution.interactiveTransactions &&
        executionAdapter.executeCompiled !== undefined
      ) ?
        {
          async trustedImport<T>(
            fn: (session: TrustedImportSession) => Promise<T>,
            options_?: TrustedImportOptions,
          ): Promise<T> {
            return ctx.self().transactionWithNative(async (tx, rawSql) => {
              if (options_?.schemaWrite !== undefined) {
                await requireDefined(tx.lockSchemaVersionForWrite)({
                  ...options_.schemaWrite,
                });
              }
              const trustedExecutionAdapter = createPostgresExecutionAdapter(
                rawSql,
                { ...adapterOptions, useTransactionClient: true },
              );
              const executeCompiled = trustedExecutionAdapter.executeCompiled;
              if (executeCompiled === undefined) {
                throw new ConfigurationError(
                  "Trusted import could not bind raw execution to the PostgreSQL transaction.",
                  { capability: "trustedImport", dialect: "postgres" },
                );
              }
              const trustedTx = deriveBackend(tx, {
                executeRaw<T>(
                  sqlText: string,
                  params: readonly unknown[],
                ): Promise<readonly T[]> {
                  return executeCompiled<T>({ params, sql: sqlText });
                },
              });
              await lockPostgresTrustedImportTables(trustedTx, tableNames);
              await assertTrustedImportDatabaseEmpty(trustedTx, tableNames);
              const indexDefinitions = await suspendPostgresSecondaryIndexes(
                trustedTx,
                tableNames,
              );
              const result = await fn(
                createPostgresTrustedImportSession(trustedTx, tableNames),
              );
              await restoreSecondaryIndexes(trustedTx, indexDefinitions);
              await analyzeImportedTables(trustedTx, tableNames);
              return result;
            });
          },
        }
      : {}),

      extensions: {
        ensureExtension: ensureDatabaseExtension,
        ensureTrigramExtension(): Promise<void> {
          return ensureDatabaseExtension("pg_trgm");
        },
        async claimIndexMaterialization(
          params: ClaimIndexMaterializationParams,
        ): Promise<boolean> {
          const t = tables.indexMaterializations;
          // Atomic claim: insert a fresh claim row, or take over an existing
          // row only when no live claim is on it (NULL or lease-expired
          // building_since). The WHERE on the conflict update makes losing
          // racers see zero returned rows — the row's own atomicity is the
          // mutex, so this works identically through pools and across
          // processes (unlike session advisory locks, which pin a
          // connection).
          const rows = await db.execute(sql`
            INSERT INTO ${t} (
              "index_name", "graph_id", "entity", "kind", "signature",
              "schema_version", "last_attempted_at", "building_since",
              "claim_token"
            )
            VALUES (
              ${params.indexName}, ${params.graphId}, ${params.entity},
              ${params.kind}, ${params.signature}, ${params.schemaVersion},
              now(), now(), ${params.token}
            )
            ON CONFLICT ("index_name") DO UPDATE SET
              "building_since" = now(),
              "claim_token" = EXCLUDED."claim_token"
            WHERE ${t}."building_since" IS NULL
               OR ${t}."building_since" < now() - (${params.leaseMs} * interval '1 millisecond')
            RETURNING "index_name"
          `);
          const result = rows;
          const returned =
            Array.isArray(result) ? result : (
              ((result as Readonly<{ rows?: readonly unknown[] }>).rows ?? [])
            );
          return returned.length > 0;
        },

        async releaseIndexMaterializationClaim(
          params: ReleaseIndexMaterializationClaimParams,
        ): Promise<void> {
          const t = tables.indexMaterializations;
          // Token-guarded: a lease-expired claim taken over by another
          // materializer must not be released by the original holder.
          await db.execute(sql`
            UPDATE ${t}
            SET "building_since" = NULL, "claim_token" = NULL
            WHERE "index_name" = ${params.indexName}
              AND "claim_token" = ${params.token}
          `);
        },

        ensureEdgeMatchIdentityStorage,
      },
    };
  }

  return {
    dialect: "postgres",
    tableNames,
    execution: executionAdapter,
    strategy: operationStrategy,
    fulltext: fulltextStrategy,
    vector: vectorStrategy,
    declaredCapabilities,
    limits,
    rowMappers,
    resourceAudit,
    autocommit: { singleStatementDurable: true },
    nowIso,
    provisioning,
    fusion: { atomicProgramsAtTransactionScope: true },
    fenceTarget,
    contributionRuntime,
    identityRuntime,
    graphTemplateRuntime,
    baseSchemaRuntime,
    indexMaterializationRuntime,
    kindRemovalRuntime,
    buildOperations,
    async close(): Promise<void> {
      // Drizzle doesn't expose a close method
      // Users manage connection lifecycle themselves
    },
    lateMembers,
  };
}

/**
 * Returns the client object a Drizzle Postgres database serializes ALL of its
 * statements onto, or `undefined` when statements can run on independent
 * connections.
 *
 * Marked (single connection — an open transaction on one wrapper blocks or
 * captures every other wrapper's statements):
 *
 * - **PGlite** — one in-process WASM Postgres connection.
 * - **A bare `pg` / `@neondatabase/serverless` `Client`** — one owned socket.
 *   An export's `BEGIN ... READ ONLY` stays open across the whole stream, so a
 *   concurrent import's INSERT lands inside it ("cannot execute INSERT in a
 *   read-only transaction").
 * - **A `Pool` whose resolved cap is one connection** — the export checks out the
 *   pool's only connection for the duration, so a concurrent import waits for a
 *   connection that is never released. Every spelling pg-pool resolves into that
 *   cap counts; {@link isSingleConnectionPgPoolCap} owns which ones those are.
 * - **A postgres-js client whose resolved cap is one connection** — the same cap
 *   on a CALLABLE client. postgres-js's `begin` reserves a connection from its
 *   own pool for the transaction, so with a pool of one an export snapshot holds
 *   the only connection every other wrapper's statement needs.
 *   {@link isSingleConnectionPostgresJsCap} owns that driver's reading of a cap,
 *   which is NOT the same decision as pg-pool's.
 *
 * Deliberately NOT marked: a default pool (independent connection per
 * checkout), a postgres-js client at default size (`max` defaults to 10), a
 * neon-http tagged template (session-less HTTP), and anything unrecognized. A
 * false positive refuses legitimate concurrent work, so the predicate requires
 * positive evidence and abstains otherwise. A pool capped at one connection by
 * means other than the cap pg-pool resolves (a global `pg.defaults.max`, a
 * `pg` connection string's `?max=1` — neither of which pg honors, so neither
 * caps anything) is therefore not detected, and a serialized-connection import
 * there still fails the way it did before this guard existed.
 */
function getSerializedPostgresClient(db: AnyPgDatabase): object | undefined {
  const pgliteClient = getPgliteClient(db);
  if (pgliteClient !== undefined) return pgliteClient;
  const client: unknown = (db as Readonly<{ $client?: unknown }>).$client;
  // Callable clients are examined before the object arms: a tagged-template
  // client is a FUNCTION, so `typeof client !== "object"` would drop it before
  // its connection cap was ever read.
  if (typeof client === "function") {
    return isSingleConnectionCallablePgClient(client) ? client : undefined;
  }
  if (typeof client !== "object" || client === null) return undefined;
  const candidate = client as Readonly<Record<string, unknown>>;
  if (!hasFunctionProperty(candidate, "query")) return undefined;
  if (isSingleConnectionPgPool(candidate)) return client;
  return isBarePgClient(candidate) ? client : undefined;
}

/** Whether a `pg`-shaped client is a pool whose only connection is shared. */
function isSingleConnectionPgPool(
  candidate: Readonly<Record<string, unknown>>,
): boolean {
  // `options` is a pg.Pool member (pg.Client has none), and holds the resolved
  // pool configuration. The default is 10, so an absent/other `max` says
  // nothing; what a cap of one looks like is the cap predicate's decision.
  const options: unknown = candidate["options"];
  if (typeof options !== "object" || options === null) return false;
  return isSingleConnectionPgPoolCap(
    (options as Readonly<Record<string, unknown>>)["max"],
  );
}

/**
 * Whether a pg-pool `options.max` means ONE connection.
 *
 * Numeric 1 is the obvious form. A STRING `"1"` is not a typo: pg-pool's
 * `options.max = options.max || options.poolSize || 10` (pg-pool 3.x
 * `index.js:89`) never coerces, so `new Pool({ max: process.env.PG_MAX })` —
 * and the legacy `new Pool({ poolSize: "1" })`, which lands in the same
 * `options.max` — keeps a string that its own `this._clients.length >=
 * this.options.max` comparison (`index.js:120`) then coerces. The pool really
 * is capped at one.
 *
 * `"5"` is NOT evidence: `1 >= "5"` is false, so that pool genuinely opens five
 * connections. This is the whole reason the decision is per driver — postgres-js
 * reads the identical value differently, and
 * {@link isSingleConnectionPostgresJsCap} owns that reading.
 */
function isSingleConnectionPgPoolCap(value: unknown): boolean {
  return value === 1 || (typeof value === "string" && Number(value) === 1);
}

/**
 * Whether a CALLABLE Postgres client (a tagged-template `Sql`) is capped at one
 * connection, and is therefore one serialized resource for every wrapper over it.
 *
 * Two pieces of positive evidence, both required:
 *
 * - {@link isPostgresJsClient} — the driver identity, owned by the execution
 *   adapter that already discriminates postgres-js from the other callable
 *   client (neon-http). Without it, `options.max` on an unknown callable means
 *   nothing we can act on.
 * - {@link isSingleConnectionPostgresJsCap} — postgres-js exposes its RESOLVED
 *   options on the callable, and its `max` defaults to 10, so only a cap of one
 *   says "every statement lands on the same connection". An absent or larger
 *   `max` abstains: postgres-js at default size hands each `begin` its own
 *   connection and marking it would refuse concurrent work that succeeds.
 *
 * NOT covered: Bun's `SQL`. Nothing in this package positively identifies that
 * driver (the SQLite side recognizes `BunSQLiteSession`; there is no Postgres
 * equivalent), and a cap we cannot attribute to a known driver is not evidence.
 * A `Bun.SQL` capped at one connection remains a known gap (#434).
 */
function isSingleConnectionCallablePgClient(client: unknown): boolean {
  if (client === undefined || client === null) return false;
  // Read before the driver check narrows the type: postgres-js's `Sql` type
  // declares no `options` member, so the property is reached through the
  // untyped client rather than the narrowed one.
  const options: unknown = (client as Readonly<Record<string, unknown>>)[
    "options"
  ];
  if (!isPostgresJsClient(client)) return false;
  if (typeof options !== "object" || options === null) return false;
  return isSingleConnectionPostgresJsCap(
    (options as Readonly<Record<string, unknown>>)["max"],
  );
}

/**
 * Whether a postgres-js `options.max` means ONE connection.
 *
 * postgres-js resolves `max` from the options object, the URL query string and
 * the `PGMAX` environment variable, and does not coerce it (`max` is absent from
 * its `ints` list, postgres@3.4.9 `src/index.js:447`). So `postgres(url +
 * "?max=1")` and `PGMAX=1` both yield the STRING `"1"`, which is one connection
 * and is marked, exactly as the numeric `postgres(url, { max: 1 })` is.
 *
 * KNOWN, DELIBERATE GAP: `[...Array(options.max)]` (`src/index.js:65`) yields
 * length 1 for ANY non-numeric string, so `postgres(url + "?max=5")` also opens
 * exactly one connection today and can genuinely wedge a stream pair. It is NOT
 * marked, because marking on it means marking on an upstream bug: the moment
 * postgres-js coerces `max`, that configuration becomes a five-connection pool
 * and the mark would refuse legitimate concurrent work. This is why the decision
 * is separate from {@link isSingleConnectionPgPoolCap} — the two predicates read
 * the same value with two justifications, and it is those justifications, not
 * the bodies, that will diverge as either driver changes.
 */
function isSingleConnectionPostgresJsCap(value: unknown): boolean {
  return value === 1 || (typeof value === "string" && Number(value) === 1);
}

/** Whether a `pg`-shaped client owns exactly one connection (Client, not Pool). */
function isBarePgClient(candidate: Readonly<Record<string, unknown>>): boolean {
  // Refuse every pool marker first: `Pool` exposes checkout accounting and its
  // resolved `options`; `Client` exposes none of them.
  if (
    candidate["options"] !== undefined ||
    candidate["totalCount"] !== undefined ||
    candidate["idleCount"] !== undefined ||
    candidate["waitingCount"] !== undefined
  ) {
    return false;
  }
  // Positive `pg.Client` evidence: the connection lifecycle pair plus
  // `escapeIdentifier`, which pg defines on Client and not on Pool.
  return (
    hasFunctionProperty(candidate, "connect") &&
    hasFunctionProperty(candidate, "end") &&
    hasFunctionProperty(candidate, "escapeIdentifier")
  );
}

/**
 * Exported for unit tests that assert the marking predicate directly against
 * real `pg` `Client` / `Pool` instances; production code reaches it only
 * through {@link createPostgresBackend}.
 *
 * @internal
 */
export function isSerializedPostgresClient(client: unknown): boolean {
  return (
    getSerializedPostgresClient({
      $client: client,
    } as unknown as AnyPgDatabase) !== undefined
  );
}

/**
 * Memoized "does this server's pgvector support the iterative scan (>= 0.8)?"
 * probe, plus a one-shot warning when it does not.
 *
 * Created once per {@link createPostgresBackend} and shared with every
 * transaction-scoped operation backend, so the probe query runs once and the
 * pre-0.8 warning fires once per backend instance rather than once per
 * `store.transaction()`. The answer is connection-independent
 * (`pg_extension.extversion`), so caching it across connections is sound.
 */
export type IterativeScanProbe = Readonly<{
  isSupported: (
    execAll: <T>(query: SQL) => Promise<readonly T[]>,
  ) => Promise<boolean>;
}>;

/**
 * Exported for unit testing the memoization / warn-once behavior in isolation;
 * production code reaches it only through {@link createPostgresBackend}.
 */
export function createIterativeScanProbe(): IterativeScanProbe {
  let probe: Promise<boolean> | undefined;
  let warned = false;

  function warnUnavailable(version: string): void {
    if (warned) return;
    warned = true;
    if (typeof console === "undefined" || typeof console.warn !== "function") {
      return;
    }
    console.warn(
      `[typegraph] pgvector ${version} has no iterative scan (added in 0.8), ` +
        "so a filtered approximate vector search stays ef_search-bounded and " +
        "can return fewer rows than `limit` while more matches exist. Upgrade " +
        "pgvector to >= 0.8, or use an exact search (`approximate: false`) " +
        "where a full page matters.",
    );
  }

  return {
    isSupported(execAll) {
      // Probing the GUC directly is unreliable — extension GUCs register only
      // once the extension library has loaded into the session, so a fresh
      // pooled connection reports NULL even on 0.8+. `extversion` is truth.
      probe ??= (async () => {
        try {
          const [row] = await execAll<{ v: string | null }>(
            sql`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`,
          );
          if (typeof row?.v !== "string") return false;
          const [major = 0, minor = 0] = row.v
            .split(".")
            .map((part) => Number.parseInt(part, 10));
          const supported = major > 0 || (major === 0 && minor >= 8);
          if (!supported) warnUnavailable(row.v);
          return supported;
        } catch {
          return false;
        }
      })();
      return probe;
    },
  };
}

type CreatePostgresOperationBackendOptions = Readonly<{
  db: AnyPgDatabase;
  executionAdapter: PostgresExecutionAdapter;
  atomicSqlProgramExecutor?: AtomicSqlProgramExecutor;
  /**
   * Adapter tuning (prepared-statement cache settings). Used to bind a
   * fresh, equivalently-configured adapter to a transaction client when
   * a per-search `efSearch` override opens its own transaction.
   */
  adapterOptions?: PostgresExecutionAdapterOptions | undefined;
  operationStrategy: ReturnType<typeof createPostgresOperationStrategy>;
  tableNames: ResolvedSqlTableNames;
  capabilities: BackendCapabilities;
  fulltextStrategy: FulltextStrategy;
  /**
   * Active vector strategy (`pgvectorStrategy` unless overridden), or
   * `undefined` when vector support is disabled (`vector: false`).
   */
  vectorStrategy: VectorStrategy | undefined;
  /**
   * Shared durable-marker materializer. The vector methods assert a
   * slot's marker (SELECT, never DDL) on the hot path and `createVectorIndex`
   * ensures it (privileged) — replacing the old in-process ensure-latch.
   * Shared across the outer backend and every transaction-scoped backend
   * so a slot's marker is resolved at most once per process.
   */
  contributionMaterializer: ContributionMaterializer;
  /**
   * Shared pgvector iterative-scan probe (memoized version check + one-shot
   * pre-0.8 warning). Owned by the top-level backend and reused by every
   * transaction backend so the warning fires once per backend instance.
   */
  iterativeScanProbe: IterativeScanProbe;
  schemaVersionsTable: PostgresTables["schemaVersions"];
  /**
   * The factory's shared write-fence target. `lockSchemaVersionForWrite`
   * resolves its plan instead of taking `FOR SHARE` unconditionally,
   * so a managed write and the schema commit it fences against read the
   * same decision.
   */
  fenceTarget: WriteFenceTarget;
  /** Whether this operation backend is bound to an explicit transaction. */
  transactionScoped: boolean;
}>;

type CreatePostgresTransactionBackendOptions = Readonly<{
  db: AnyPgDatabase;
  adapterOptions?: PostgresExecutionAdapterOptions;
  operationStrategy: ReturnType<typeof createPostgresOperationStrategy>;
  tableNames: ResolvedSqlTableNames;
  capabilities: BackendCapabilities;
  fulltextStrategy: FulltextStrategy;
  /** Active vector strategy. See {@link CreatePostgresOperationBackendOptions}. */
  vectorStrategy: VectorStrategy | undefined;
  /** Shared durable-marker materializer. See {@link CreatePostgresOperationBackendOptions}. */
  contributionMaterializer: ContributionMaterializer;
  /** Shared iterative-scan probe. See {@link CreatePostgresOperationBackendOptions}. */
  iterativeScanProbe: IterativeScanProbe;
  schemaVersionsTable: PostgresTables["schemaVersions"];
  /** Shared write-fence target. See {@link CreatePostgresOperationBackendOptions}. */
  fenceTarget: WriteFenceTarget;
}>;

function createPostgresOperationBackend(
  options: CreatePostgresOperationBackendOptions,
): InternalOperationBackend {
  const {
    db,
    executionAdapter,
    atomicSqlProgramExecutor,
    adapterOptions,
    operationStrategy,
    tableNames,
    capabilities,
    fulltextStrategy,
    vectorStrategy,
    contributionMaterializer,
    iterativeScanProbe,
    schemaVersionsTable,
    fenceTarget,
    transactionScoped,
  } = options;
  // Route through the execution adapter so driver-specific result shapes
  // (`{rows}` for node-postgres / neon-serverless; bare array for
  // postgres-js) are normalized in one place.
  async function execAll<T>(query: ExecutableSql): Promise<readonly T[]> {
    return executionAdapter.execute<T>(query);
  }

  async function execGet<T>(query: ExecutableSql): Promise<T | undefined> {
    const rows = await executionAdapter.execute<T>(query);
    return rows[0];
  }

  async function execRun(query: ExecutableSql): Promise<void> {
    await executionAdapter.execute(query);
  }

  type VectorSearchRow = Readonly<{ node_id: string; score: number }>;

  /** One transaction-local GUC override applied around a vector SELECT. */
  type SearchGucOverride = Readonly<{ name: string; value: string }>;

  // `hnsw.iterative_scan` exists on pgvector >= 0.8. The probe + "warn once"
  // state lives on the top-level backend and is SHARED with every
  // transaction-scoped operation backend (see `iterativeScanProbe` in the
  // options), so a pre-0.8 server is probed and warned about once per backend
  // instance — not once per `store.transaction()`.
  function pgvectorIterativeScanSupported(): Promise<boolean> {
    return iterativeScanProbe.isSupported(execAll);
  }

  /**
   * The transaction-local GUC overrides for one vector search:
   *
   * - `hnsw.ef_search` when the caller supplied `efSearch` (validated
   *   upstream; whether it may be applied at all — and under which parameter
   *   name — is {@link resolveEfSearchOverride}, the predicate the SQLite
   *   backend reads too, which refuses a non-HNSW slot and a transactionless
   *   driver where `SET LOCAL` cannot be scoped).
   * - `hnsw.iterative_scan = strict_order` on HNSW slots (pgvector >= 0.8):
   *   the search SQL constrains results to live candidate nodes (and
   *   optionally `minScore`), and a plain HNSW scan yields only `ef_search`
   *   candidates BEFORE those filters — so a filter-heavy neighborhood can
   *   under-fill top-k. The iterative scan keeps yielding until `LIMIT`
   *   rows pass or it hits `hnsw.max_scan_tuples` — better recall, not a
   *   full-page guarantee. `strict_order` preserves the distance ordering the
   *   plan relies on (`relaxed_order` may emit slightly out of order beneath
   *   our LIMIT). On pgvector < 0.8 the search stays `ef_search`-bounded and
   *   the backend warns once (see `warnIterativeScanUnavailable`).
   * - `ivfflat.iterative_scan = relaxed_order` on IVFFlat slots (same
   *   pgvector floor): IVFFlat has no strict_order mode, so the strategy's
   *   IVFFlat search SQL re-sorts the relaxed candidate set inside a
   *   MATERIALIZED wrapper (see `buildSearch`) to restore exact ordering.
   */
  async function vectorSearchGucOverrides(
    params: Pick<VectorSearchParams, "efSearch" | "indexType">,
  ): Promise<readonly SearchGucOverride[]> {
    const overrides: SearchGucOverride[] = [];
    const efSearchParameter = resolveEfSearchOverride({
      efSearch: params.efSearch,
      indexType: params.indexType,
      tuning: vectorSearchFrontierTuning(vectorStrategy),
      interactiveTransactions: capabilities.execution.interactiveTransactions,
      dialect: "PostgreSQL",
      engine: vectorStrategy?.name ?? "this backend",
    });
    if (efSearchParameter !== undefined) {
      overrides.push({
        name: efSearchParameter,
        value: String(params.efSearch),
      });
    }
    if (
      params.indexType === "hnsw" &&
      capabilities.execution.interactiveTransactions &&
      (await pgvectorIterativeScanSupported())
    ) {
      overrides.push({ name: "hnsw.iterative_scan", value: "strict_order" });
    }
    if (
      params.indexType === "ivfflat" &&
      capabilities.execution.interactiveTransactions &&
      (await pgvectorIterativeScanSupported())
    ) {
      overrides.push({
        name: "ivfflat.iterative_scan",
        value: "relaxed_order",
      });
    }
    return overrides;
  }

  /**
   * Runs the vector SELECT, applying the given GUC overrides
   * transaction-locally. `SET LOCAL` semantics (via
   * `set_config(name, value, is_local => true)`, the parameterizable form)
   * only take effect inside an explicit transaction — issued in autocommit
   * they roll off with the statement and the next pooled query (notably
   * under transaction-mode pgbouncer) sees the session default again. So
   * with overrides present we bundle `BEGIN; SET …; SELECT …; COMMIT;`
   * onto one connection. With none we take the unchanged single-statement
   * fast path and open no transaction.
   */
  /**
   * The `SET LOCAL`-scoped vector SELECT, run as one exclusive group on the
   * transaction's connection. See {@link runVectorSearch}.
   */
  async function runVectorSearchGucGroup<Row>(
    overrides: readonly SearchGucOverride[],
    query: ExecutableSql,
  ): Promise<readonly Row[]> {
    const runExclusive = executionAdapter.runExclusive;
    if (runExclusive === undefined) {
      throw new CompilerInvariantError(
        "A transaction-scoped Postgres backend must expose runExclusive; " +
          "its execution adapter was not wrapped by createSerialExecutionAdapter.",
      );
    }
    return runExclusive(async (connection) => {
      const snapshots: SearchGucOverride[] = [];
      for (const override of overrides) {
        const [setting] = await connection.execute<{ v: string }>(
          sql`SELECT current_setting(${override.name}) AS v`,
        );
        if (setting !== undefined) {
          snapshots.push({ name: override.name, value: setting.v });
        }
        await connection.execute(
          sql`SELECT set_config(${override.name}, ${override.value}, true)`,
        );
      }
      const rows = await connection.execute<Row>(query);
      // Restore only on success: a failed SELECT aborts the caller's
      // transaction, so its rollback discards the overrides anyway and a
      // restore here would just fail against the aborted tx, masking the
      // real error.
      for (const snapshot of snapshots) {
        await connection.execute(
          sql`SELECT set_config(${snapshot.name}, ${snapshot.value}, true)`,
        );
      }
      return rows;
    });
  }

  async function runVectorSearch<Row = VectorSearchRow>(
    overrides: readonly SearchGucOverride[],
    query: ExecutableSql,
  ): Promise<readonly Row[]> {
    if (overrides.length === 0) {
      return execAll<Row>(query);
    }
    if (db instanceof PgTransaction) {
      // Already inside the caller's transaction (low-level
      // backend.transaction / adoptTransaction). `executionAdapter` is
      // bound to this tx client, but SET LOCAL persists to the end of the
      // caller's transaction — leaking the override into their later
      // vector searches and breaking the per-search contract. Snapshot
      // the current values, apply the overrides, then restore them once
      // the SELECT has materialized so the overrides stay scoped to this
      // one search.
      //
      // The four steps are ONE critical section, not four serialized
      // statements. A transaction has a single GUC namespace, so two searches
      // that merely take turns interleave as `A snapshot → B snapshot → A set
      // → B set → A select` and `A` runs under `B`'s efSearch. `runExclusive`
      // holds the connection for the whole group; it is always present on a
      // transaction-scoped adapter (see `createTransactionBackend`).
      return runVectorSearchGucGroup(overrides, query);
    }
    return db.transaction(async (tx) => {
      // Bind an equivalently-configured adapter to the tx client so the
      // SELECT keeps the driver result-shape normalization rather than a
      // bespoke execute. A Drizzle transaction carries no `$client`, so this
      // adapter routes through Drizzle's session (no server-side prepared
      // statement) — correct either way, and the statements below are
      // sequential, so they need no serializing wrapper.
      const txAdapter = createPostgresExecutionAdapter(tx, adapterOptions);
      for (const override of overrides) {
        await txAdapter.execute(
          sql`SELECT set_config(${override.name}, ${override.value}, true)`,
        );
      }
      return txAdapter.execute<Row>(query);
    });
  }

  const batchConfig = computePostgresBatchChunkSizes(
    capabilities.maxBindParameters ?? POSTGRES_MAX_BIND_PARAMETERS,
  );

  const fulltextMembers = createFulltextMembers({
    strategy: operationStrategy,
    execution: { execAll, execRun },
    batchConfig,
  });

  const contributionOperationMembers = createContributionOperationMembers({
    execRun,
    operationStrategy,
  });

  /**
   * The third consumer of the schema fence's `FOR SHARE`, and the
   * writer-side half that managed entity inserts carry INSIDE their own
   * statement rather than taking beforehand.
   *
   * `buildInsertNodeWithSchemaFence` (and its edge and projection siblings)
   * fold the fence into the INSERT as a subquery that both ASSERTS the
   * expected active version and locks the row it matched. Only the lock
   * needs the engine's cooperation: with an empty clause the subquery still
   * yields no row when the expected version is no longer active, so the
   * INSERT still writes nothing — which is exactly the posture SQLite has
   * always run in, where this clause is `sql.raw("")`.
   *
   * So it resolves the SAME {@link resolveWriteFencePlan} the two fences
   * above do — one `FOR UPDATE`/`FOR SHARE` contract, one decision, three
   * consumers — but it is the ONE that may degrade, and the reason is
   * structural: those two fence sequences that span statements, where
   * dropping the lock opens a check-then-write window, while this predicate
   * is evaluated INSIDE the INSERT that depends on it. One statement cannot
   * race itself. With an
   * empty clause the subquery still yields no row when the expected version
   * is no longer active, so the INSERT still writes nothing — which is why
   * SQLite has always run this path with `sql.raw("")`.
   *
   * It reads the plan directly rather than calling `requireWriteFence`
   * because it is a construction-time constant on a backend that may never
   * open a schema-managed store at all; the refusal an `unfenced` backend
   * earns is owed by the two fences above, at the moment such a store is
   * actually built.
   *
   * `sql.raw("")` and not `undefined`: `undefined` means "this backend has
   * no schema-fenced insert program at all", which sends the Store down the
   * unfused fallback path. The fused program is still correct here; it is
   * the lock inside it that is not available.
   */
  const schemaFenceInsertLockClause = ((): SQL => {
    const plan = resolveWriteFencePlan(fenceTarget);
    return plan.kind === "lock" ? sql.raw("FOR SHARE") : sql.raw("");
  })();

  const commonOperationMembers = createCommonOperationBackend(
    buildCommonOperationOptions({
      batchConfig,
      commandSession: transactionScoped ? "transaction" : "root",
      execution: {
        compile: executionAdapter.compile,
        execAll,
        execGet,
        execRun,
      },
      atomicSqlProgramExecutor,
      nowIso,
      maxBindParameters:
        capabilities.maxBindParameters ?? POSTGRES_MAX_BIND_PARAMETERS,
      operationStrategy,
      rowMappers: {
        toEdgeRow,
        toNodeRow,
        toSchemaVersionRow,
        toUniqueRow,
      },
      schemaFenceLockClause: schemaFenceInsertLockClause,
      contributionMaterializer,
      fusion: {
        atomicProgramsAtTransactionScope: true,
        nodeProjectionInsertFusion: true,
        async beforeNodeProjectionInsert(params, plan): Promise<void> {
          const vectorSlots = vectorSlotsFromManagedNodeCreatePlan(
            params,
            plan,
          );
          await contributionMaterializer.assertNodeInsertProjections(
            params.graphId,
            {
              fulltext: plan.projections.some(
                (projection) => projection.kind === "fulltext",
              ),
              vectorSlots,
            },
          );
        },
        async refuseNodeProjectionError(params, plan, error): Promise<never> {
          const embeddingProjections = plan.projections.filter(
            (projection) => projection.kind === "embedding",
          );
          const dimensionProjection =
            embeddingProjections.find(
              (projection) =>
                projection.embedding.length !== projection.dimensions,
            ) ??
            (embeddingProjections.length === 1 ?
              embeddingProjections[0]
            : undefined);
          if (dimensionProjection !== undefined) {
            const mapped = mapVectorWriteError(error, {
              nodeKind: params.kind,
              fieldPath: dimensionProjection.fieldPath,
            });
            if (mapped !== error) throw mapped;
          }
          return contributionMaterializer.refuseUnavailableNodeInsertProjections(
            params.graphId,
            {
              fulltext: plan.projections.some(
                (projection) => projection.kind === "fulltext",
              ),
              vectorSlots: vectorSlotsFromManagedNodeCreatePlan(params, plan),
            },
            error,
          );
        },
        ...(transactionScoped ?
          {
            schemaGraphWriteLockNamespace:
              RECORDED_GRAPH_WRITE_ADVISORY_LOCK_NAMESPACE,
            edgeCardinalityInsertFusion: true,
            nodeClaimInsertFusion: true,
          }
        : {}),
        tableExistenceCache: { cacheExisting: false },
      },
    }),
  );

  const executeCompiled = executionAdapter.executeCompiled;
  const executeRawMethod: Pick<TransactionBackend, "executeRaw"> =
    executeCompiled === undefined ?
      {}
    : {
        async executeRaw<T>(
          sqlText: string,
          params: readonly unknown[],
        ): Promise<readonly T[]> {
          return executeCompiled<T>({ params, sql: sqlText });
        },
      };

  // Embedding write/search/index methods are present only when a vector
  // strategy is wired. With `vector: false` (e.g. PGlite without pgvector)
  // they are omitted, so `capabilities.vector` is absent and the store never
  // routes embedding work here — mirroring a SQLite connection without
  // sqlite-vec. Shared verbatim with the SQLite backend via
  // `createVectorMembers`; the two genuine per-engine differences (the
  // GUC-wrapped, ceiling-validated search override and the serial-fallback
  // index build) are threaded through as `applySearchOverrides` and
  // `runIndexBuild`.
  const vectorMembers =
    vectorStrategy === undefined ?
      createVectorMembers({ vectorStrategy: undefined })
    : createVectorMembers({
        vectorStrategy,
        execution: { execRun },
        batchConfig,
        tableNames,
        contributionMaterializer,
        operationStrategy,
        async applySearchOverrides(query, params) {
          // Validate `efSearch` against pgvector's `hnsw.ef_search` ceiling
          // before `runVectorSearch` applies it via `set_config`.
          assertPgvectorEfSearch(params.efSearch);
          const gucOverrides = await vectorSearchGucOverrides(params);
          return runVectorSearch(gucOverrides, query);
        },
        async runIndexBuild({ slot, indexStatement }) {
          // Honor the `concurrent` flag materializeIndexes passes on Postgres
          // so the ANN build doesn't take a write-blocking lock on a live
          // table. execRun is autocommit, which CONCURRENTLY requires.
          // Built-in pgvector HNSW/IVFFlat builds stage the build graph in
          // dynamic shared memory, and resource-constrained hosts reject the
          // allocation (SQLSTATE class 53 — e.g. containers with the 64MB
          // /dev/shm default fail a 50k x 384-dim HNSW build with 53100
          // from dsm_impl_posix). Retry serially: drop the INVALID
          // leftover the failed CONCURRENTLY build leaves behind (its
          // IF NOT EXISTS would otherwise mask the retry), pin the
          // strategy table to parallel_workers = 0 (maintenance builds
          // take min(storage parameter, max_parallel_maintenance_workers)),
          // rebuild in local memory, and restore the setting.
          const strategyTableName = vectorStrategy.tableName(
            slot.graphId,
            slot.nodeKind,
            slot.fieldPath,
          );
          await runPostgresVectorIndexBuild(
            vectorStrategy,
            execRun,
            strategyTableName,
            indexStatement,
            vectorStrategy.buildDropIndex?.(slot),
          );
        },
      });

  // `hybridSearch` is the one embedding-adjacent member NOT shared with
  // SQLite (it composes the vector leg with `operationStrategy`'s
  // single-statement hybrid SQL, which is dialect-owned) — kept inline,
  // gated the same way `vectorEmbeddingMethods` always has been.
  const vectorEmbeddingMethods =
    vectorStrategy === undefined ?
      {}
    : {
        // Single-statement hybrid needs ROW_NUMBER(); a capability
        // profile that disables window functions keeps the store's
        // multi-statement fallback by simply not exposing the member.
        ...(capabilities.windowFunctions ?
          {
            async hybridSearch(
              params: HybridSearchParams,
            ): Promise<readonly HybridSearchRow[]> {
              assertVectorSearchLimit(params.limit);
              // Source depths get the same boundary validation the fallback
              // path applies (vectorSearch validates its limit; the fulltext
              // depth is validated inside buildFulltextSearch).
              assertVectorSearchLimit(params.vector.k);
              assertPgvectorEfSearch(params.vector.efSearch);
              const slot = vectorSlotFromParams({
                graphId: params.graphId,
                nodeKind: params.nodeKind,
                fieldPath: params.vector.fieldPath,
                dimensions: params.vector.dimensions,
                metric: params.vector.metric,
                indexType: params.vector.indexType,
              });
              // Read-only, not marker-gated — see
              // `createVectorMembers`'s vectorSearch
              // (engine/members/vector-members.ts) for why.
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
                toDrizzleSql(vectorSql, "postgres"),
                params.vector.metric === "cosine",
              );
              const gucOverrides = await vectorSearchGucOverrides({
                indexType: params.vector.indexType,
                ...(params.vector.efSearch === undefined ?
                  {}
                : { efSearch: params.vector.efSearch }),
              });
              let raw: readonly Record<string, unknown>[];
              try {
                raw = await runVectorSearch<Record<string, unknown>>(
                  gucOverrides,
                  statement,
                );
              } catch (error) {
                throw mapVectorWriteError(error, vectorParams);
              }
              return raw.map((row) => mapHybridSearchRow(row, toNodeRow));
            },
          }
        : {}),
      };

  /**
   * The managed writer's side of the schema fence: takes the
   * transaction-scoped share lock on the graph's active schema row,
   * returning the version it locked — or `undefined` when the statement found
   * no active row to lock, which at `read committed` does not by itself mean the
   * graph has no active version — see the fence that calls this.
   *
   * Resolves the SAME {@link resolveWriteFencePlan} the schema-commit fence
   * does, and refuses
   * with it: the two halves of one `FOR UPDATE`/`FOR SHARE` contract must
   * never disagree about whether the engine honors row locks.
   *
   * The `FOR SHARE` is not merely a WAIT. This transaction HOLDS it for its
   * remainder, which is what makes the version it just asserted binding
   * through to the writes that follow — a concurrent schema commit's
   * `FOR UPDATE` blocks on it and cannot deactivate the row underneath
   * an in-flight write. Reading the version without the lock would still
   * ASSERT it, and then let the very flip the assertion was checking for
   * land before the write. That is a check-then-write race, not a degraded
   * fence, so `unfenced` is refused here.
   *
   * `engine-serialized` skips the clause instead, and correctly: SQLite's
   * `lockSchemaVersionForWrite` already runs exactly this way, on the
   * strength of the writer slot no concurrent commit can hold.
   */
  async function lockActiveSchemaVersion(
    graphId: string,
  ): Promise<number | undefined> {
    const plan = requireWriteFence(
      resolveWriteFencePlan(fenceTarget),
      "The PostgreSQL schema write fence",
      "advisory-lock",
    );
    const shareLock = plan.kind === "lock" ? sql`FOR SHARE` : sql``;
    const active = await execGet<{ version: number }>(sql`
      SELECT ${schemaVersionsTable.version} AS version
      FROM ${schemaVersionsTable}
      WHERE ${schemaVersionsTable.graphId} = ${graphId}
        AND ${schemaVersionsTable.isActive} = TRUE
      ${shareLock}
    `);
    return active?.version;
  }

  /**
   * The write-fence half of a managed write on PostgreSQL: locks the active
   * schema row (or refuses, per the resolved fence plan) and asserts the
   * version it holds. An empty locked read is not evidence of an absent
   * active version — see `lockActiveSchemaVersion`'s own comment — so the
   * settled-version read below is a fresh, unlocked read naming the version
   * honestly rather than a retry of the locked one.
   */
  async function lockSchemaVersionForWrite(
    params: LockSchemaVersionForWriteParams,
  ): Promise<void> {
    if (!transactionScoped) {
      throw new ConfigurationError(
        "The schema write fence requires an explicit PostgreSQL transaction.",
        {
          code: "SCHEMA_WRITE_FENCE_TRANSACTION_REQUIRED",
          graphId: params.graphId,
        },
      );
    }
    const locked = await lockActiveSchemaVersion(params.graphId);
    if (locked !== undefined) {
      assertActiveSchemaVersion(params.graphId, params.expectedVersion, locked);
      return;
    }

    // An empty locked read is not evidence of an absent active version. At
    // `read committed`, a `FOR SHARE` read that blocks behind an in-flight
    // schema commit rechecks only the row versions its own statement snapshot
    // saw: once that commit lands, the row this statement waited on no longer
    // satisfies `is_active = TRUE`, and the winner's freshly inserted active
    // row was never in the snapshot to be substituted in.
    //
    // Either way this transaction holds no share lock on an active row, so the
    // write is rejected. That is why the version reported below needs no lock
    // of its own — and why the fence must NOT retry the locked read: the
    // dropped row keeps the share lock the first read took on it, so a second
    // `FOR SHARE` waits on the row the *next* schema commit has already taken
    // `FOR UPDATE` while that commit waits on the dropped row in its
    // deactivate-all. PostgreSQL breaks the cycle by killing one of the two,
    // and the schema commit — waiting first, so timing out first — is the one
    // that dies.
    //
    // A non-locking read names the version honestly: a schema commit's
    // deactivate-then-insert pair is atomic, so no committed state has zero
    // active rows for a graph that has one, and an ordinary read never waits
    // and so has no recheck to be fooled by. It yields `0` only for a graph
    // that genuinely has no active version. A rollback landing back on
    // `expectedVersion` reports `expected === actual`; the rejection stands,
    // because nothing is holding the fence.
    const settled = await commonOperationMembers.getActiveSchema(
      params.graphId,
    );
    throw new StaleVersionError({
      graphId: params.graphId,
      expected: params.expectedVersion,
      actual: settled?.version ?? 0,
    });
  }

  const operations = createEngineOperationBackend({
    commonOperationMembers,
    contributionOperationMembers,
    vectorMembers,
    fulltextMembers,
    rawSqlMembers: {
      ...executeRawMethod,
      async execute<T>(query: CompiledRowsSql): Promise<readonly T[]> {
        // Statements the compiler branded as containing an ANN index scan
        // (inline `approximate: true`) get the same pgvector GUC wrapping
        // the search facade applies — most importantly
        // `hnsw.iterative_scan = strict_order`, without which a filtered
        // approximate query starves at the default ef_search frontier.
        // On pgvector < 0.8 the override list is empty and this falls
        // through to the plain fast path.
        const annTypes =
          isSqlFragment(query) ? annIndexScanTypes(query) : undefined;
        if (annTypes !== undefined && vectorStrategy !== undefined) {
          const overrides: SearchGucOverride[] = [];
          for (const indexType of annTypes) {
            if (indexType !== "hnsw" && indexType !== "ivfflat") continue;
            overrides.push(
              ...(await vectorSearchGucOverrides({ indexType })),
            );
          }
          return runVectorSearch<T>(overrides, query);
        }
        return executionAdapter.execute<T>(query);
      },
    },
    lockSchemaVersionForWrite,
    compile: executionAdapter.compile,
    capabilities,
    fulltextStrategy,
    ...(vectorStrategy === undefined ? {} : { vectorStrategy }),
    dialect: "postgres",
    tableNames,
  });

  // `hybridSearch` is not part of the shared assembly — see
  // `vectorEmbeddingMethods`'s own comment above.
  return { ...operations, ...vectorEmbeddingMethods };
}

/**
 * A transaction-scoped backend plus the hook that shuts its statement queue
 * at the transaction boundary. See {@link SerialExecutionAdapter.drainAndClose}.
 */
type BoundTransactionBackend = Readonly<{
  backend: InternalOperationBackend;
  drainAndClose: () => Promise<void>;
}>;

function resolvedSetOnlyEdgeMutationProgram(
  executor: AtomicEdgeMutationProgramExecutor,
): AtomicEdgeMutationProgramExecutor {
  function execute(
    input: AtomicEdgeResolvedMutationSetInput,
  ): Promise<AtomicEdgeResolvedMutationSetResult>;
  function execute(
    input: AtomicEdgeConvergenceInput,
  ): Promise<readonly AtomicEdgeConvergenceResult[]>;
  function execute(
    input: AtomicEdgeResolvedMutationSetInput | AtomicEdgeConvergenceInput,
  ):
    | Promise<AtomicEdgeResolvedMutationSetResult>
    | Promise<readonly AtomicEdgeConvergenceResult[]> {
    if (input.kind === "resolved-set") return executor(input);
    return Promise.reject<readonly AtomicEdgeConvergenceResult[]>(
      new CompilerInvariantError(
        "A transaction-session edge mutation profile received durable convergence outside its declared envelope.",
      ),
    );
  }

  return Object.assign(execute, {
    maxEntries: Object.freeze({
      resolvedSet: executor.maxEntries.resolvedSet,
      durableConvergence: 0,
    }),
  });
}

function createTransactionBackend(
  options: CreatePostgresTransactionBackendOptions,
): BoundTransactionBackend {
  // Every statement this backend issues rides one pinned connection, which
  // can carry exactly one query at a time. Serialize them here rather than
  // relying on the driver's own queue: node-postgres deprecated
  // `client.query()` on a busy client in 8.22 and removes the queue in pg@9.
  // The wrap is unconditional because the overlap is created inside TypeGraph
  // (the node write pipeline syncs embeddings and fulltext concurrently), not
  // only by user code.
  const operationExecutionAdapter = createPostgresExecutionAdapter(
    options.db,
    options.adapterOptions,
  );
  const compiledExecutionAdapter = createPostgresExecutionAdapter(options.db, {
    ...options.adapterOptions,
    useTransactionClient: true,
  });
  const executeCompiled = compiledExecutionAdapter.executeCompiled;
  // Preserve the established Drizzle-routed execution surface for ordinary
  // transaction work. Only a closed atomic program needs the pinned client's
  // compiled-text seam; changing every statement to that seam would also
  // bypass driver logging and other Drizzle session behavior merely because
  // this transaction can execute programs.
  const txExecutionAdapter = createSerialExecutionAdapter(
    operationExecutionAdapter,
  );
  const runExclusive = txExecutionAdapter.runExclusive;
  const sessionAtomicBatchAdapter =
    executeCompiled === undefined ? undefined : (
      createSessionAtomicBatchAdapter({ executeCompiled, runExclusive })
    );
  const sessionAtomicSqlProgramExecutor =
    sessionAtomicBatchAdapter === undefined ? undefined : (
      createAtomicSqlProgramExecutor(sessionAtomicBatchAdapter)
    );
  const sessionCapabilities = scopeAtomicBatchToSession(
    options.capabilities,
    sessionAtomicSqlProgramExecutor !== undefined,
  );

  // The transaction-scoped backend shares the outer backend's
  // contribution materializer: the per-field vector table is provisioned
  // (DDL) only by the privileged outer backend, so a tx-scoped vector op
  // only ASSERTS the durable marker (SELECT, never DDL) and can't poison
  // anything on rollback. The shared per-instance cache means a slot
  // confirmed once stays a pure `Set.has` inside every later transaction.
  const backend = markFirstPartyFactory(
    createPostgresOperationBackend({
      db: options.db,
      executionAdapter: txExecutionAdapter,
      ...(sessionAtomicSqlProgramExecutor === undefined ?
        {}
      : { atomicSqlProgramExecutor: sessionAtomicSqlProgramExecutor }),
      adapterOptions: options.adapterOptions,
      operationStrategy: options.operationStrategy,
      tableNames: options.tableNames,
      capabilities: sessionCapabilities,
      fulltextStrategy: options.fulltextStrategy,
      vectorStrategy: options.vectorStrategy,
      contributionMaterializer: options.contributionMaterializer,
      // The probe is process-wide truth, so the outer instance's is reused
      // rather than a fresh one per transaction.
      iterativeScanProbe: options.iterativeScanProbe,
      schemaVersionsTable: options.schemaVersionsTable,
      fenceTarget: options.fenceTarget,
      transactionScoped: true,
    }),
  );

  if (sessionAtomicBatchAdapter !== undefined) {
    registerAtomicSqlProgram(backend, sessionAtomicBatchAdapter);
    const mutateEdges = requireDefined(
      backend.executeAtomicEdgeMutationProgram,
    );
    registerAtomicMutationPrograms(backend, {
      mutateNodes: requireDefined(backend.executeAtomicNodeResolvedMutationSet),
      mutateEdges: resolvedSetOnlyEdgeMutationProgram(mutateEdges),
      replaceNodes: requireDefined(backend.executeAtomicNodeReplacementBatch),
    });
  }

  return { backend, drainAndClose: txExecutionAdapter.drainAndClose };
}

// Re-export schema utilities
export type { PostgresTableNames, PostgresTables } from "./schema/postgres";
export { createPostgresTables, tables } from "./schema/postgres";
