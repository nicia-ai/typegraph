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
 *   `createLocalPgliteBackend` in `@nicia-ai/typegraph/postgres/pglite`.
 *
 * Other pg-protocol Drizzle adapters (Vercel Postgres, Supabase via pg)
 * work unchanged because they all expose a compatible `db.execute()` /
 * `db.transaction()` surface.
 *
 * @example
 * ```typescript
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { Pool } from "pg";
 * import { createPostgresBackend, tables } from "@nicia-ai/typegraph/postgres";
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
  type SQL,
  sql,
} from "drizzle-orm";
import { PgDatabase, PgTransaction } from "drizzle-orm/pg-core";

import { ConfigurationError } from "../../errors";
import type { ResolvedSqlTableNames } from "../../query/compiler/schema";
import { quoteIdentifier } from "../../query/compiler/utils";
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
  type VectorSlot,
  type VectorStrategy,
} from "../../query/dialect/vector-strategy";
import { annIndexScanTypes } from "../../query/sql-intent";
import { chunk as chunkArray } from "../../utils/array";
import {
  isInsufficientResourcesError,
  isMissingTableError,
} from "../../utils/sql-errors";
import {
  type AdoptedTransaction,
  type BackendCapabilities,
  type ClaimIndexMaterializationParams,
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
  type KindRemovalRow,
  POSTGRES_CAPABILITIES,
  POSTGRES_MAX_BIND_PARAMETERS,
  type RecordContributionMaterializationParams,
  type RecordIndexMaterializationParams,
  type RecordKindRemovalParams,
  type ReleaseIndexMaterializationClaimParams,
  type SchemaVersionRow,
  type SetActiveVersionParams,
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
  buildContributionInsertValues,
  buildContributionOnConflictSet,
  createContributionMaterializer,
  gateFulltext,
  gateFulltextMethods,
  mapContributionMaterializationRow,
  POSTGRES_CONTRIBUTION_MAT_TIMESTAMPS,
} from "./contribution-materializations";
import { generatePgCreateTableSQL, generatePostgresDDL } from "./ddl";
import {
  type AnyPgDatabase,
  createPostgresExecutionAdapter,
  isNeonHttpClient,
  type PostgresExecutionAdapter,
  type PostgresExecutionAdapterOptions,
} from "./execution/postgres-execution";
import {
  buildMaterializationInsertValues,
  buildMaterializationOnConflictSet,
  mapMaterializationRow,
  POSTGRES_INDEX_MAT_TIMESTAMPS,
} from "./index-materializations";
import {
  buildKindRemovalInsertValues,
  buildKindRemovalOnConflictSet,
  mapKindRemovalRow,
  POSTGRES_KIND_REMOVAL_TIMESTAMPS,
} from "./kind-removals";
import {
  assertAdoptedDialect,
  type CommonOperationBackend,
  createCommonOperationBackend,
  type InternalOperationBackend,
} from "./operation-backend-core";
import {
  hybridCandidatesRef,
  mapHybridSearchRow,
} from "./operations/hybrid";
import {
  createCachedTableExistence,
  createPostgresOperationStrategy,
} from "./operations/strategy";
import {
  coerceNumericScore,
  createEdgeRowMapper,
  createNodeRowMapper,
  createSchemaVersionRowMapper,
  createUniqueRowMapper,
  nowIso,
  POSTGRES_ROW_MAPPER_CONFIG,
} from "./row-mappers";
import {
  type PostgresTables,
  tables as defaultTables,
} from "./schema/postgres";
import {
  createVectorSlotLatch,
  EMBEDDING_UPSERT_PARAM_COUNT,
  mapVectorWriteError,
  vectorSlotFromCreateIndexParams,
  vectorSlotFromDropIndexParams,
  vectorSlotFromParams,
  type VectorSlotLatch,
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
   * across statements would need `{ transactions: false }` so
   * TypeGraph falls through to non-transactional execution paths.
   *
   * `drizzle-orm/neon-http` is auto-detected and has `transactions`
   * disabled without an explicit override; this option exists for
   * other HTTP-style drivers and for tests that need to simulate a
   * capability gap.
   */
  capabilities?: Partial<BackendCapabilities>;
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
   * Cap on the number of distinct SQL strings tracked for
   * prepared-statement naming. Defaults to 256. The cache is LRU-
   * bounded so high-cardinality SQL text (variable-length IN-lists,
   * generated aliases, `backend.execute()` calls with one-off SQL)
   * doesn't grow unbounded in either the Node process or in
   * PostgreSQL's per-session prepared-statement memory. Worst-case
   * server-side footprint is roughly `cap × pool size` statements
   * across all pooled connections. Ignored when
   * `prepareStatements` is `false`.
   */
  preparedStatementCacheMax?: number;
}>;

const NODE_INSERT_PARAM_COUNT = 9;
const EDGE_INSERT_PARAM_COUNT = 12;
const POSTGRES_NODE_INSERT_BATCH_SIZE = Math.max(
  1,
  Math.floor(POSTGRES_MAX_BIND_PARAMETERS / NODE_INSERT_PARAM_COUNT),
);
const POSTGRES_EDGE_INSERT_BATCH_SIZE = Math.max(
  1,
  Math.floor(POSTGRES_MAX_BIND_PARAMETERS / EDGE_INSERT_PARAM_COUNT),
);
const POSTGRES_GET_NODES_ID_CHUNK_SIZE = Math.max(
  1,
  POSTGRES_MAX_BIND_PARAMETERS - 2,
);
const POSTGRES_GET_EDGES_ID_CHUNK_SIZE = Math.max(
  1,
  POSTGRES_MAX_BIND_PARAMETERS - 1,
);
const FULLTEXT_UPSERT_PARAM_COUNT = 6;
const FULLTEXT_DELETE_FIXED_PARAM_COUNT = 2;
const POSTGRES_FULLTEXT_UPSERT_BATCH_SIZE = Math.max(
  1,
  Math.floor(POSTGRES_MAX_BIND_PARAMETERS / FULLTEXT_UPSERT_PARAM_COUNT),
);
const POSTGRES_FULLTEXT_DELETE_CHUNK_SIZE = Math.max(
  1,
  POSTGRES_MAX_BIND_PARAMETERS - FULLTEXT_DELETE_FIXED_PARAM_COUNT,
);
const CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT = 3;
const POSTGRES_CHECK_UNIQUE_BATCH_CHUNK_SIZE = Math.max(
  1,
  POSTGRES_MAX_BIND_PARAMETERS - CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT,
);
const UNIQUE_INSERT_PARAM_COUNT = 6;
const POSTGRES_UNIQUE_INSERT_BATCH_SIZE = Math.max(
  1,
  Math.floor(POSTGRES_MAX_BIND_PARAMETERS / UNIQUE_INSERT_PARAM_COUNT),
);

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
): GraphBackend {
  const tables = options.tables ?? defaultTables;
  const fulltextStrategy = options.fulltext ?? tsvectorStrategy;
  // pgvector is compiled into a standalone Postgres server, so it is wired
  // unconditionally by default (overridable for alternate Postgres vector
  // stacks). `vector: false` disables it — required for an in-process
  // Postgres (PGlite) built without the pgvector extension, where the
  // default strategy's `vector(N)` DDL would hard-fail.
  const vectorStrategy =
    options.vector === false ? undefined : (options.vector ?? pgvectorStrategy);
  // One latch per backend instance, shared with every transaction-scoped
  // backend so a slot's per-field table is created at most once per process.
  // Absent when vector support is disabled.
  const vectorSlotLatch =
    vectorStrategy === undefined ? undefined : createVectorSlotLatch();
  const baseCapabilities = buildPostgresCapabilities(
    fulltextStrategy,
    vectorStrategy,
  );
  // HTTP-only drivers (notably `drizzle-orm/neon-http`) can't hold a
  // session across statements, so multi-statement transactions are
  // unavailable regardless of what we declare. Auto-detect and downgrade
  // the capability so callers get correct fallback behavior without
  // having to remember to override it themselves.
  const httpOnlyOverrides = isNeonHttpClient(db) ? { transactions: false } : {};
  const capabilities: BackendCapabilities = {
    ...baseCapabilities,
    ...httpOnlyOverrides,
    ...options.capabilities,
  };
  const adapterOptions: PostgresExecutionAdapterOptions = {
    ...(options.prepareStatements === undefined ?
      {}
    : { prepareStatements: options.prepareStatements }),
    ...(options.preparedStatementCacheMax === undefined ?
      {}
    : { preparedStatementCacheMax: options.preparedStatementCacheMax }),
  };
  const executionAdapter = createPostgresExecutionAdapter(db, adapterOptions);
  const tableNames: ResolvedSqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    recordedNodes: getTableName(tables.recordedNodes),
    recordedEdges: getTableName(tables.recordedEdges),
    recordedClock: getTableName(tables.recordedClock),
    fulltext: tables.fulltextTableName,
    uniques: getTableName(tables.uniques),
  };
  // Pre-quote identifiers so refreshStatistics() doesn't rebuild the
  // ANALYZE statements on every call. The recorded relations are ANALYZEd
  // separately under an existence guard (see refreshStatistics): a schema
  // created before recorded-time history landed (bring-your-own-pool, no DDL
  // re-run) has no recorded tables, and Postgres fails the whole ANALYZE if any
  // named relation is missing. Per-field vector tables are created lazily and
  // live outside this base set, so they are not ANALYZEd here.
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
  ].map((name) => sql`ANALYZE (SKIP_LOCKED) ${quoteIdentifier(name)}`);
  const recordedAnalyzeTables = [
    tableNames.recordedNodes,
    tableNames.recordedEdges,
    tableNames.recordedClock,
  ] as const;
  const operationStrategy = createPostgresOperationStrategy(
    tables,
    fulltextStrategy,
  );
  const operations = createPostgresOperationBackend({
    db,
    executionAdapter,
    adapterOptions,
    operationStrategy,
    tableNames,
    capabilities,
    fulltextStrategy,
    vectorStrategy,
    vectorSlotLatch,
  });

  // Whether `tableName` currently exists, via the same catalog probe `clear()`
  // uses — so refreshStatistics() never ANALYZEs a recorded relation that a
  // bring-your-own-pool schema has not yet created. The Postgres probe is
  // search_path-aware, so positive results are deliberately not cached by bare
  // table name.
  const recordedTableExists = createCachedTableExistence(
    async (tableName) => {
      const rows = await executionAdapter.execute<Record<string, unknown>>(
        operationStrategy.buildTableExists(tableName),
      );
      return rows[0];
    },
    { cacheExisting: false },
  );

  /**
   * Runs `fn` inside a Postgres transaction, holding an
   * `pg_advisory_xact_lock` keyed on the graph id. The advisory lock
   * serializes all schema commits per-graph: the read-then-write CAS in
   * `commitSchemaVersion` is safe even for the initial-commit case
   * where there is no row yet to `SELECT ... FOR UPDATE`.
   *
   * Refuses on backends that don't support transactions
   * (`drizzle-orm/neon-http`). The orphan-row crash window cannot be
   * eliminated without atomicity, so silent best-effort degradation is
   * worse than a typed error.
   */
  function runSchemaWriteTransaction<T>(
    graphId: string,
    fn: (tx: CommonOperationBackend) => Promise<T>,
  ): Promise<T> {
    if (!capabilities.transactions) {
      throw new ConfigurationError(
        "commitSchemaVersion and setActiveVersion require atomic transactions, " +
          "but this Postgres backend does not provide them. The drizzle-orm/neon-http " +
          "driver communicates over HTTP and cannot hold a session across statements; " +
          "use drizzle-orm/neon-serverless (websocket) for transactional writes.",
        {
          backend: "postgres",
          capability: "transactions",
          supportsTransactions: false,
        },
      );
    }

    return db.transaction(async (tx) => {
      // Advisory lock: hashtext($graphId) is collision-tolerant for the
      // size of an active graph set; collisions just serialize unrelated
      // graphs which is harmless. Held until the transaction commits.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${graphId}))`);
      // Advisory lock is held here, so the schema-write-capable
      // InternalOperationBackend is used intentionally (see its type).
      const txBackend = createTransactionBackend({
        db: tx,
        adapterOptions,
        operationStrategy,
        tableNames,
        capabilities,
        fulltextStrategy,
        vectorStrategy,
        vectorSlotLatch,
      });
      return fn(txBackend);
    });
  }

  // Durable fulltext materialization (#135): the dialect-specific
  // marker-table primitives. Orchestration (materialize / assert /
  // per-instance cache) lives once in `createContributionMaterializer`.
  const matTable = tables.contributionMaterializations;

  async function ensureContributionMaterializationsTableImpl(): Promise<void> {
    await db.execute(sql.raw(generatePgCreateTableSQL(matTable)));
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
      POSTGRES_CONTRIBUTION_MAT_TIMESTAMPS.decode,
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
  }

  const contributionMaterializer = createContributionMaterializer({
    dialect: "postgres",
    fulltextStrategy,
    fulltextTableName: tables.fulltextTableName,
    execDdl: async (statement) => {
      await db.execute(sql.raw(statement));
    },
    ensureMarkerTable: ensureContributionMaterializationsTableImpl,
    getMarker: getContributionMaterializationRow,
    recordMarker: recordContributionMaterializationRow,
  });

  // Shared by `transaction()` (TypeGraph opens the tx) and
  // `adoptTransaction()` (#134 — the caller already opened it): bind a
  // tx-scoped backend to the *literal* `tx` client and gate fulltext on
  // the durable marker (a cached SELECT, never DDL).
  function bindTransactionBackend(tx: AnyPgDatabase): TransactionBackend {
    const txBackend = createTransactionBackend({
      db: tx,
      adapterOptions,
      operationStrategy,
      tableNames,
      capabilities,
      fulltextStrategy,
      vectorStrategy,
      vectorSlotLatch,
    });
    return gateFulltext(txBackend, contributionMaterializer.assertInitialized);
  }

  const backend: GraphBackend = {
    ...operations,

    async bootstrapTables(): Promise<void> {
      const statements = generatePostgresDDL(tables, fulltextStrategy);
      for (const statement of statements) {
        await db.execute(sql.raw(statement));
      }
    },

    // Every fulltext-touching method asserts the durable marker instead
    // of lazily emitting DDL. Steady state performs zero ensure; an
    // uninitialized database throws `StoreNotInitializedError` loudly
    // rather than self-healing on a read/write path (#135). Shared
    // verbatim with the tx-scoped gate via `gateFulltextMethods`.
    ...gateFulltextMethods(
      operations,
      contributionMaterializer.assertInitialized,
    ),

    async executeDdl(ddl: string): Promise<void> {
      await db.execute(sql.raw(ddl));
    },

    async ensureIndexMaterializationsTable(): Promise<void> {
      await db.execute(
        sql.raw(generatePgCreateTableSQL(tables.indexMaterializations)),
      );
      // Deployments created before the build-claim columns existed get
      // them additively; fresh installs already have them from the
      // CREATE TABLE above.
      const tableName = getTableName(tables.indexMaterializations);
      await db.execute(
        sql.raw(
          `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "building_since" timestamptz;`,
        ),
      );
      await db.execute(
        sql.raw(
          `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "claim_token" text;`,
        ),
      );
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

    async getIndexMaterialization(
      indexName: string,
    ): Promise<IndexMaterializationRow | undefined> {
      const t = tables.indexMaterializations;
      const rows = await db.select().from(t).where(eq(t.indexName, indexName));
      const row = rows[0];
      if (row === undefined) return undefined;
      return mapMaterializationRow(row, POSTGRES_INDEX_MAT_TIMESTAMPS.decode);
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
        mapMaterializationRow(row, POSTGRES_INDEX_MAT_TIMESTAMPS.decode),
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
            POSTGRES_INDEX_MAT_TIMESTAMPS.encode,
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
      await db.execute(sql.raw(generatePgCreateTableSQL(tables.kindRemovals)));
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
        mapKindRemovalRow(row, POSTGRES_KIND_REMOVAL_TIMESTAMPS.decode),
      );
    },

    async getAllKindRemovals(
      graphId: string,
    ): Promise<readonly KindRemovalRow[]> {
      const t = tables.kindRemovals;
      const rows = await db.select().from(t).where(eq(t.graphId, graphId));
      return rows.map((row) =>
        mapKindRemovalRow(row, POSTGRES_KIND_REMOVAL_TIMESTAMPS.decode),
      );
    },

    async recordKindRemoval(params: RecordKindRemovalParams): Promise<void> {
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

    async ensureReconciliationMarkersTable(): Promise<void> {
      await db.execute(
        sql.raw(generatePgCreateTableSQL(tables.reconciliationMarkers)),
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
      // Scoped to TypeGraph-managed tables only — we don't touch
      // unrelated tables in the same database. Without fresh stats
      // after a bulk load the planner can pick a reverse-index scan
      // with a filter (5ms forward traversal instead of 0.5ms) until
      // autovacuum catches up. Sequential per-table statements — see
      // coreAnalyzeStatements for why they are never combined.
      for (const statement of coreAnalyzeStatements) {
        await db.execute(statement);
      }
      // The recorded relations may be absent on a schema created before
      // recorded-time history landed (bring-your-own-pool, no DDL re-run).
      // Postgres fails an ANALYZE naming a missing relation, so ANALYZE
      // only the recorded tables that exist.
      const tablePresence = await Promise.all(
        recordedAnalyzeTables.map(async (tableName) => ({
          tableName,
          exists: await recordedTableExists(tableName),
        })),
      );
      const presentRecordedTables = tablePresence
        .filter((entry) => entry.exists)
        .map((entry) => entry.tableName);
      for (const tableName of presentRecordedTables) {
        await db.execute(
          sql`ANALYZE (SKIP_LOCKED) ${quoteIdentifier(tableName)}`,
        );
      }
    },

    async commitSchemaVersion(
      params: CommitSchemaVersionParams,
    ): Promise<SchemaVersionRow> {
      return runSchemaWriteTransaction(params.graphId, (target) =>
        target.commitSchemaVersion(params),
      );
    },

    async setActiveVersion(params: SetActiveVersionParams): Promise<void> {
      await runSchemaWriteTransaction(params.graphId, (target) =>
        target.setActiveVersion(params),
      );
    },

    async transaction<T>(
      fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      // #134/#135: NO DDL or ensure here. The tx-scoped backend's
      // fulltext-touching methods assert the durable contribution
      // marker (one cached SELECT — never DDL) at point of use, exactly
      // like the non-tx wrappers. A transaction that never touches
      // fulltext never asserts; one that does runs pure DML against an
      // already-materialized table, with the "no DDL in the business
      // transaction" guarantee backed by the durable fact.
      const txConfig =
        options?.isolationLevel ?
          {
            isolationLevel: options.isolationLevel.replace("_", " ") as
              | "read uncommitted"
              | "read committed"
              | "repeatable read"
              | "serializable",
          }
        : undefined;

      return db.transaction(
        async (tx) => fn(bindTransactionBackend(tx), tx),
        txConfig,
      );
    },

    adoptTransaction(externalTx: AdoptedTransaction): TransactionBackend {
      // #134: cross-store atomicity is unsafe without real rollback —
      // the caller's relational write on `externalTx` *would* still
      // commit even though the graph write could not be undone. Refuse
      // loudly rather than silently degrade.
      if (!capabilities.transactions) {
        throw new ConfigurationError(
          "Cross-store atomicity is unavailable on this Postgres backend: " +
            "its driver does not support transactions (drizzle-orm/neon-http, " +
            "Cloudflare D1). Adopting an external transaction here would let " +
            "the caller's relational write commit with no way to roll back " +
            "the graph write. Use a node-postgres or neon-serverless " +
            "(Pool/WebSocket) connection for cross-store transactions.",
          {
            backend: "postgres",
            capability: "transactions",
            supportsTransactions: false,
          },
        );
      }
      assertAdoptedDialect<AnyPgDatabase>(externalTx, PgDatabase, "postgres");
      // The caller owns BEGIN/COMMIT/ROLLBACK via its own
      // `db.transaction(...)`. We adopt the literal `tx` client and run
      // pure DML on it — no transaction is opened or closed here, and no
      // DDL is emitted inside the caller's business transaction.
      return bindTransactionBackend(externalTx);
    },

    async close(): Promise<void> {
      // Drizzle doesn't expose a close method
      // Users manage connection lifecycle themselves
    },
  };

  return backend;
}

type CreatePostgresOperationBackendOptions = Readonly<{
  db: AnyPgDatabase;
  executionAdapter: PostgresExecutionAdapter;
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
   * Shared per-`(kind, field)` storage-ensure latch. Paired with
   * `vectorStrategy`: both present, or both `undefined`.
   */
  vectorSlotLatch: VectorSlotLatch | undefined;
}>;

type CreatePostgresTransactionBackendOptions = Readonly<{
  db: AnyPgDatabase;
  executionAdapter?: PostgresExecutionAdapter;
  adapterOptions?: PostgresExecutionAdapterOptions;
  operationStrategy: ReturnType<typeof createPostgresOperationStrategy>;
  tableNames: ResolvedSqlTableNames;
  capabilities: BackendCapabilities;
  fulltextStrategy: FulltextStrategy;
  /** Active vector strategy. See {@link CreatePostgresOperationBackendOptions}. */
  vectorStrategy: VectorStrategy | undefined;
  /** Shared storage-ensure latch. See {@link CreatePostgresOperationBackendOptions}. */
  vectorSlotLatch: VectorSlotLatch | undefined;
}>;

function createPostgresOperationBackend(
  options: CreatePostgresOperationBackendOptions,
): InternalOperationBackend {
  const {
    db,
    executionAdapter,
    adapterOptions,
    operationStrategy,
    tableNames,
    capabilities,
    fulltextStrategy,
    vectorStrategy,
    vectorSlotLatch,
  } = options;

  // Route through the execution adapter so driver-specific result shapes
  // (`{rows}` for node-postgres / neon-serverless; bare array for
  // postgres-js) are normalized in one place.
  async function execAll<T>(query: SQL): Promise<readonly T[]> {
    return executionAdapter.execute<T>(query);
  }

  async function execGet<T>(query: SQL): Promise<T | undefined> {
    const rows = await executionAdapter.execute<T>(query);
    return rows[0];
  }

  async function execRun(query: SQL): Promise<void> {
    await executionAdapter.execute(query);
  }

  type VectorSearchRow = Readonly<{ node_id: string; score: number }>;

  // One warning per backend instance when `efSearch` is supplied but the
  // driver can't hold a transaction to scope `SET LOCAL` to.
  let efSearchUnsupportedWarned = false;
  function warnEfSearchUnsupported(): void {
    if (efSearchUnsupportedWarned) return;
    efSearchUnsupportedWarned = true;
    if (typeof console === "undefined" || typeof console.warn !== "function") {
      return;
    }
    console.warn(
      "[typegraph] efSearch (hnsw.ef_search override) was ignored: this " +
        "Postgres backend has transactions disabled (e.g. drizzle-orm/neon-http), " +
        "and SET LOCAL needs a transaction to scope the override. Use a " +
        "transactional driver (node-postgres / neon-serverless / postgres-js) " +
        "to apply efSearch.",
    );
  }

  /** One transaction-local GUC override applied around a vector SELECT. */
  type SearchGucOverride = Readonly<{ name: string; value: string }>;

  // Probed once per backend instance: `hnsw.iterative_scan` exists on
  // pgvector >= 0.8. Probing the GUC directly is unreliable — extension
  // GUCs register only once the extension library has loaded into the
  // session, so a fresh pooled connection reports NULL even on 0.8+.
  // `pg_extension.extversion` is connection-independent truth.
  let pgvectorIterativeScanProbe: Promise<boolean> | undefined;
  function pgvectorIterativeScanSupported(): Promise<boolean> {
    pgvectorIterativeScanProbe ??= (async () => {
      try {
        const [row] = await execAll<{ v: string | null }>(
          sql`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`,
        );
        if (typeof row?.v !== "string") return false;
        const [major = 0, minor = 0] = row.v
          .split(".")
          .map((part) => Number.parseInt(part, 10));
        return major > 0 || (major === 0 && minor >= 8);
      } catch {
        return false;
      }
    })();
    return pgvectorIterativeScanProbe;
  }

  /**
   * The transaction-local GUC overrides for one vector search:
   *
   * - `hnsw.ef_search` when the caller supplied `efSearch` (validated
   *   upstream; warned-and-skipped on transactionless drivers, where
   *   `SET LOCAL` cannot be scoped).
   * - `hnsw.iterative_scan = strict_order` on HNSW slots (pgvector >= 0.8):
   *   the search SQL constrains results to live candidate nodes (and
   *   optionally `minScore`), and a plain HNSW scan yields only `ef_search`
   *   candidates BEFORE those filters — so a filter-heavy neighborhood can
   *   under-fill top-k. The iterative scan keeps yielding until `LIMIT`
   *   rows pass, making the filtered search exact. `strict_order`
   *   preserves the distance ordering the plan relies on (`relaxed_order`
   *   may emit slightly out of order beneath our LIMIT). On older pgvector
   *   the search stays `ef_search`-bounded — documented caveat.
   * - `ivfflat.iterative_scan = relaxed_order` on IVFFlat slots (same
   *   pgvector floor): IVFFlat has no strict_order mode, so the strategy's
   *   IVFFlat search SQL re-sorts the relaxed candidate set inside a
   *   MATERIALIZED wrapper (see `buildSearch`) to restore exact ordering.
   */
  async function vectorSearchGucOverrides(
    params: Pick<VectorSearchParams, "efSearch" | "indexType">,
  ): Promise<readonly SearchGucOverride[]> {
    const overrides: SearchGucOverride[] = [];
    if (params.efSearch !== undefined) {
      if (capabilities.transactions) {
        overrides.push({
          name: "hnsw.ef_search",
          value: String(params.efSearch),
        });
      } else {
        warnEfSearchUnsupported();
      }
    }
    if (
      params.indexType === "hnsw" &&
      capabilities.transactions &&
      (await pgvectorIterativeScanSupported())
    ) {
      overrides.push({ name: "hnsw.iterative_scan", value: "strict_order" });
    }
    if (
      params.indexType === "ivfflat" &&
      capabilities.transactions &&
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
  async function runVectorSearch<Row = VectorSearchRow>(
    overrides: readonly SearchGucOverride[],
    query: SQL,
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
      const snapshots: SearchGucOverride[] = [];
      for (const override of overrides) {
        const [setting] = await execAll<{ v: string }>(
          sql`SELECT current_setting(${override.name}) AS v`,
        );
        if (setting !== undefined) {
          snapshots.push({ name: override.name, value: setting.v });
        }
        await execRun(
          sql`SELECT set_config(${override.name}, ${override.value}, true)`,
        );
      }
      const rows = await execAll<Row>(query);
      // Restore only on success: a failed SELECT aborts the caller's
      // transaction, so its rollback discards the overrides anyway and a
      // restore here would just fail against the aborted tx, masking the
      // real error.
      for (const snapshot of snapshots) {
        await execRun(
          sql`SELECT set_config(${snapshot.name}, ${snapshot.value}, true)`,
        );
      }
      return rows;
    }
    return db.transaction(async (tx) => {
      // Bind an equivalently-configured adapter to the tx client so the
      // SELECT keeps the server-side prepared-statement fast path and the
      // driver result-shape normalization, rather than a bespoke execute.
      const txAdapter = createPostgresExecutionAdapter(tx, adapterOptions);
      for (const override of overrides) {
        await txAdapter.execute(
          sql`SELECT set_config(${override.name}, ${override.value}, true)`,
        );
      }
      return txAdapter.execute<Row>(query);
    });
  }

  // Runs the strategy's per-field DDL on this backend's connection (the tx
  // client for a transaction-scoped backend) so a slot's table exists
  // before the first write/search hits it.
  async function ensureVectorSlotStorage(slot: VectorSlot): Promise<void> {
    if (vectorStrategy === undefined || vectorSlotLatch === undefined) return;
    await vectorSlotLatch.ensure(vectorStrategy, slot, async (statement) => {
      await execRun(sql.raw(statement));
    });
  }

  const batchConfig = {
    checkUniqueBatchChunkSize: POSTGRES_CHECK_UNIQUE_BATCH_CHUNK_SIZE,
    edgeInsertBatchSize: POSTGRES_EDGE_INSERT_BATCH_SIZE,
    // Unlike the static siblings, the embedding upsert honors a runtime
    // `maxBindParameters` override so its chunk size tracks the connection's
    // actual bind budget.
    embeddingUpsertBatchSize: Math.max(
      1,
      Math.floor(
        (capabilities.maxBindParameters ?? POSTGRES_MAX_BIND_PARAMETERS) /
          EMBEDDING_UPSERT_PARAM_COUNT,
      ),
    ),
    getEdgesChunkSize: POSTGRES_GET_EDGES_ID_CHUNK_SIZE,
    getNodesChunkSize: POSTGRES_GET_NODES_ID_CHUNK_SIZE,
    nodeInsertBatchSize: POSTGRES_NODE_INSERT_BATCH_SIZE,
    uniqueInsertBatchSize: POSTGRES_UNIQUE_INSERT_BATCH_SIZE,
  };
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
    tableExistenceCache: { cacheExisting: false },
  });

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

  // Embedding write/search methods are present only when a vector strategy
  // is wired. With `vector: false` (e.g. PGlite without pgvector) they are
  // omitted, so `capabilities.vector` is absent and the store never routes
  // embedding work here — mirroring a SQLite connection without sqlite-vec.
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

        async upsertEmbeddingBatch(
          params: UpsertEmbeddingBatchParams,
        ): Promise<void> {
          if (params.rows.length === 0) return;
          const slot = vectorSlotFromParams(params);
          await ensureVectorSlotStorage(slot);
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
          // Ensure the per-field table exists before deleting. A delete can
          // run before any embedding was ever written for the field (e.g. a
          // node hard-deleted having never carried one), and on Postgres a
          // DELETE against a missing relation INSIDE a transaction aborts the
          // whole transaction — swallowing the JS error can't un-abort it.
          // The idempotent ensure makes the DELETE target an existing
          // (possibly empty) table, so it's always a clean no-op.
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
          // Validate `efSearch` against pgvector's `hnsw.ef_search` ceiling
          // before `runVectorSearch` applies it via `set_config`.
          assertPgvectorEfSearch(params.efSearch);
          const slot = vectorSlotFromParams(params);
          await ensureVectorSlotStorage(slot);
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
          const gucOverrides = await vectorSearchGucOverrides(params);
          let rows: readonly { node_id: string; score: number }[];
          try {
            rows = await runVectorSearch(gucOverrides, query);
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
              await ensureVectorSlotStorage(slot);
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

  const operationBackend: InternalOperationBackend = {
    ...commonBackend,
    ...executeRawMethod,
    ...vectorEmbeddingMethods,
    capabilities,
    fulltextStrategy,
    ...(vectorStrategy === undefined ? {} : { vectorStrategy }),
    dialect: "postgres",
    tableNames,

    // === Vector Index Operations ===

    async createVectorIndex(params: CreateVectorIndexParams): Promise<void> {
      if (vectorStrategy === undefined) return;
      const slot = vectorSlotFromCreateIndexParams(params);
      // Ensure the per-field table exists first (idempotent), then create its
      // ANN index. pgvector's `ownedTables` builds the table only — the HNSW/
      // IVFFlat index is created here (and only here) so it picks up the
      // declared `m`/`ef_construction`/`lists` from `slot.indexParams` rather
      // than defaults.
      await ensureVectorSlotStorage(slot);
      // Honor the `concurrent` flag materializeIndexes passes on Postgres so the
      // ANN build doesn't take a write-blocking lock on a live table. execRun is
      // autocommit, which CONCURRENTLY requires.
      const indexStatement = vectorStrategy.buildCreateIndex?.(slot, {
        concurrent: params.concurrent === true,
      });
      if (indexStatement !== undefined) {
        try {
          await execRun(indexStatement);
        } catch (error) {
          if (!isInsufficientResourcesError(error)) throw error;
          // Parallel HNSW/IVFFlat builds stage the build graph in dynamic
          // shared memory, and resource-constrained hosts reject the
          // allocation (SQLSTATE class 53 — e.g. containers with the 64MB
          // /dev/shm default fail a 50k x 384-dim HNSW build with 53100
          // from dsm_impl_posix). Retry serially: drop the INVALID
          // leftover the failed CONCURRENTLY build leaves behind (its
          // IF NOT EXISTS would otherwise mask the retry), pin the
          // strategy table to parallel_workers = 0 (maintenance builds
          // take min(storage parameter, max_parallel_maintenance_workers)),
          // rebuild in local memory, and restore the setting.
          const dropStatement = vectorStrategy.buildDropIndex?.(slot);
          if (dropStatement !== undefined) {
            await execRun(dropStatement);
          }
          const table = quoteIdentifier(
            vectorStrategy.tableName(
              slot.graphId,
              slot.nodeKind,
              slot.fieldPath,
            ),
          );
          await execRun(
            sql`ALTER TABLE ${table} SET (parallel_workers = 0)`,
          );
          try {
            await execRun(indexStatement);
          } finally {
            await execRun(sql`ALTER TABLE ${table} RESET (parallel_workers)`);
          }
        }
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
        POSTGRES_FULLTEXT_UPSERT_BATCH_SIZE,
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
        POSTGRES_FULLTEXT_DELETE_CHUNK_SIZE,
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
      // pg returns `numeric` as a string to preserve precision; coerce at the
      // backend boundary so FulltextSearchResult.score is always `number`.
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

    async dropVectorIndex(params: DropVectorIndexParams): Promise<void> {
      if (vectorStrategy === undefined) return;
      const slot = vectorSlotFromDropIndexParams(params);
      const dropStatement = vectorStrategy.buildDropIndex?.(slot);
      if (dropStatement === undefined) return;
      try {
        await execRun(dropStatement);
      } catch (error) {
        // The per-field table (and thus its index) may never have been
        // materialized; treat a missing relation as already-dropped.
        if (!isMissingTableError(error)) throw error;
      }
    },

    // === Query Execution ===

    async execute<T>(query: SQL): Promise<readonly T[]> {
      // Statements the compiler branded as containing an ANN index scan
      // (inline `approximate: true`) get the same pgvector GUC wrapping
      // the search facade applies — most importantly
      // `hnsw.iterative_scan = strict_order`, without which a filtered
      // approximate query starves at the default ef_search frontier.
      // On pgvector < 0.8 the override list is empty and this falls
      // through to the plain fast path.
      const annTypes = annIndexScanTypes(query);
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

    compileSql(
      query: SQL,
    ): Readonly<{ sql: string; params: readonly unknown[] }> {
      return executionAdapter.compile(query);
    },
  };

  return operationBackend;
}

function createTransactionBackend(
  options: CreatePostgresTransactionBackendOptions,
): InternalOperationBackend {
  const txExecutionAdapter =
    options.executionAdapter ??
    createPostgresExecutionAdapter(options.db, options.adapterOptions);

  // A transaction-scoped backend gets its OWN per-field ensure-latch, never
  // the outer process-global one: a `CREATE TABLE/INDEX` that runs inside the
  // caller's transaction and then rolls back must not leave the shared latch
  // marking the slot "ensured" (which would skip the re-CREATE and make every
  // later write fail with "relation does not exist"). The fresh latch is
  // discarded with the transaction, so the next write re-ensures idempotently.
  // No latch when vector support is disabled (`vector: false`).
  return createPostgresOperationBackend({
    db: options.db,
    executionAdapter: txExecutionAdapter,
    adapterOptions: options.adapterOptions,
    operationStrategy: options.operationStrategy,
    tableNames: options.tableNames,
    capabilities: options.capabilities,
    fulltextStrategy: options.fulltextStrategy,
    vectorStrategy: options.vectorStrategy,
    vectorSlotLatch:
      options.vectorStrategy === undefined ? undefined : createVectorSlotLatch(),
  });
}

// Re-export schema utilities
export type { PostgresTableNames, PostgresTables } from "./schema/postgres";
export { createPostgresTables, tables } from "./schema/postgres";
