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
import type { SqlTableNames } from "../../query/compiler/schema";
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
  POSTGRES_CAPABILITIES,
  type RecordContributionMaterializationParams,
  type RecordIndexMaterializationParams,
  type RecordKindRemovalParams,
  type SchemaVersionRow,
  type SetActiveVersionParams,
  type TransactionBackend,
  type TransactionOptions,
  type UpsertEmbeddingParams,
  type UpsertFulltextBatchParams,
  type UpsertFulltextParams,
  type VectorSearchParams,
  type VectorSearchResult,
} from "../types";
import {
  buildContributionInsertValues,
  buildContributionOnConflictSet,
  type ContributionMaterializer,
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
import { createPostgresOperationStrategy } from "./operations/strategy";
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
  mapVectorWriteError,
  vectorSlotFromCreateIndexParams,
  vectorSlotFromDropIndexParams,
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

const POSTGRES_MAX_BIND_PARAMETERS = 65_535;
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
const CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT = 3;
const POSTGRES_CHECK_UNIQUE_BATCH_CHUNK_SIZE = Math.max(
  1,
  POSTGRES_MAX_BIND_PARAMETERS - CHECK_UNIQUE_BATCH_FIXED_PARAM_COUNT,
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
  const tableNames: SqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    fulltext: tables.fulltextTableName,
    uniques: getTableName(tables.uniques),
  };
  // Pre-quote identifiers so refreshStatistics() doesn't rebuild the
  // ANALYZE statement on every call. Per-field vector tables are created
  // lazily and live outside this base set, so they are not ANALYZEd here.
  const analyzeStatement = sql`ANALYZE ${sql.join(
    [
      tableNames.nodes,
      tableNames.edges,
      getTableName(tables.uniques),
      tableNames.fulltext,
    ].map((name) => quoteIdentifier(name)),
    sql`, `,
  )}`;
  const operationStrategy = createPostgresOperationStrategy(
    tables,
    fulltextStrategy,
  );

  // Durable fulltext + vector materialization (#135): the dialect-specific
  // marker-table primitives. Orchestration (materialize / assert /
  // per-instance cache) lives once in `createContributionMaterializer`,
  // shared by the outer backend and every transaction-scoped backend so a
  // slot's marker is resolved at most once per process. Built before
  // `operations` so the operation backend's vector methods can assert/
  // ensure through it instead of issuing DDL on the hot path.
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
    dialect: "postgres",
    fulltextStrategy,
    fulltextTableName: tables.fulltextTableName,
    vectorStrategy,
    execDdl: async (statement) => {
      await db.execute(sql.raw(statement));
    },
    ensureMarkerTable: ensureContributionMaterializationsTableImpl,
    getMarker: getContributionMaterializationRow,
    recordMarker: recordContributionMaterializationRow,
    deleteMarker: deleteContributionMaterializationRow,
  });

  const operations = createPostgresOperationBackend({
    db,
    executionAdapter,
    adapterOptions,
    operationStrategy,
    tableNames,
    capabilities,
    fulltextStrategy,
    vectorStrategy,
    contributionMaterializer,
  });

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
        contributionMaterializer,
      });
      return fn(txBackend);
    });
  }

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
      contributionMaterializer,
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

    // Vector counterparts of the runtime-contribution methods. Present
    // only when a vector strategy is wired (omitted under `vector: false`,
    // mirroring the embedding/search methods), so a no-vector backend
    // doesn't advertise vector materialization it can't perform.
    ...(vectorStrategy === undefined ?
      {}
    : {
        async ensureVectorSlotContribution(
          slot: VectorSlot,
          options_?: Readonly<{ force?: boolean }>,
        ): Promise<void> {
          await contributionMaterializer.ensureVectorSlot(slot, options_);
        },

        async assertVectorSlotInitialized(slot: VectorSlot): Promise<void> {
          await contributionMaterializer.assertVectorSlot(slot);
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
      // Scoped to TypeGraph-managed tables only — we don't touch
      // unrelated tables in the same database. Without fresh stats
      // after a bulk load the planner can pick a reverse-index scan
      // with a filter (5ms forward traversal instead of 0.5ms) until
      // autovacuum catches up.
      await db.execute(analyzeStatement);
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
  tableNames: SqlTableNames;
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
}>;

type CreatePostgresTransactionBackendOptions = Readonly<{
  db: AnyPgDatabase;
  executionAdapter?: PostgresExecutionAdapter;
  adapterOptions?: PostgresExecutionAdapterOptions;
  operationStrategy: ReturnType<typeof createPostgresOperationStrategy>;
  tableNames: SqlTableNames;
  capabilities: BackendCapabilities;
  fulltextStrategy: FulltextStrategy;
  /** Active vector strategy. See {@link CreatePostgresOperationBackendOptions}. */
  vectorStrategy: VectorStrategy | undefined;
  /** Shared durable-marker materializer. See {@link CreatePostgresOperationBackendOptions}. */
  contributionMaterializer: ContributionMaterializer;
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
    contributionMaterializer,
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

  /**
   * Runs the vector SELECT, applying `hnsw.ef_search` transaction-locally
   * when requested. `SET LOCAL` only takes effect inside an explicit
   * transaction — issued in autocommit it rolls off with the statement
   * and the next pooled query (notably under transaction-mode pgbouncer)
   * sees the session default again. So when `efSearch` is set we bundle
   * `BEGIN; SET LOCAL …; SELECT …; COMMIT;` onto one connection. When
   * absent we take the unchanged single-statement fast path and open no
   * transaction.
   */
  async function runVectorSearch(
    efSearch: number | undefined,
    query: SQL,
  ): Promise<readonly VectorSearchRow[]> {
    if (efSearch === undefined) {
      return execAll<VectorSearchRow>(query);
    }
    if (!capabilities.transactions) {
      warnEfSearchUnsupported();
      return execAll<VectorSearchRow>(query);
    }
    // `SET` cannot be parameterized; `efSearch` is validated as an
    // integer in 1..MAX_HNSW_EF_SEARCH before we get here, so inlining
    // it is injection-safe.
    const setEfSearch = sql.raw(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    if (db instanceof PgTransaction) {
      // Already inside the caller's transaction (low-level
      // backend.transaction / adoptTransaction). `executionAdapter` is
      // bound to this tx client, but SET LOCAL persists to the end of the
      // caller's transaction — leaking the override into their later
      // vector searches and breaking the per-search contract. Snapshot
      // the current frontier, apply the override, then restore it once
      // the SELECT has materialized so the override stays scoped to this
      // one search.
      const [setting] = await execAll<{ ef_search: string }>(
        sql`SELECT current_setting('hnsw.ef_search') AS ef_search`,
      );
      await execRun(setEfSearch);
      const rows = await execAll<VectorSearchRow>(query);
      // Restore only on success: a failed SELECT aborts the caller's
      // transaction, so its rollback discards the SET LOCAL anyway and a
      // restore here would just fail against the aborted tx, masking the
      // real error. `set_config(_, _, true)` is the parameterizable form
      // of SET LOCAL.
      if (setting !== undefined) {
        await execRun(
          sql`SELECT set_config('hnsw.ef_search', ${setting.ef_search}, true)`,
        );
      }
      return rows;
    }
    return db.transaction(async (tx) => {
      // Bind an equivalently-configured adapter to the tx client so the
      // SELECT keeps the server-side prepared-statement fast path and the
      // driver result-shape normalization, rather than a bespoke execute.
      const txAdapter = createPostgresExecutionAdapter(tx, adapterOptions);
      await txAdapter.execute(setEfSearch);
      return txAdapter.execute<VectorSearchRow>(query);
    });
  }

  const commonBackend = createCommonOperationBackend({
    batchConfig: {
      checkUniqueBatchChunkSize: POSTGRES_CHECK_UNIQUE_BATCH_CHUNK_SIZE,
      edgeInsertBatchSize: POSTGRES_EDGE_INSERT_BATCH_SIZE,
      getEdgesChunkSize: POSTGRES_GET_EDGES_ID_CHUNK_SIZE,
      getNodesChunkSize: POSTGRES_GET_NODES_ID_CHUNK_SIZE,
      nodeInsertBatchSize: POSTGRES_NODE_INSERT_BATCH_SIZE,
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
          // Assert the slot's durable marker (SELECT, cached) — never DDL.
          // The per-field table is provisioned by the privileged migrator
          // (`createStoreWithSchema` → `materializeVectorContributions`), so
          // a least-privilege runtime role writes embeddings without CREATE.
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

        async deleteEmbedding(params: DeleteEmbeddingParams): Promise<void> {
          // Assert the slot's durable marker before deleting. A delete can
          // run before any embedding was ever written for the field (e.g. a
          // node hard-deleted having never carried one); the per-field table
          // was provisioned at boot, so the DELETE targets an existing
          // (possibly empty) table and is a clean no-op — never a DELETE
          // against a missing relation, which would abort an enclosing
          // Postgres transaction. SELECT-only assert, never DDL.
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
          // Validate `efSearch` against pgvector's `hnsw.ef_search` ceiling
          // before `runVectorSearch` inlines it into `SET LOCAL`.
          assertPgvectorEfSearch(params.efSearch);
          const slot = vectorSlotFromParams(params);
          await contributionMaterializer.assertVectorSlot(slot);
          const query = vectorStrategy.buildSearch(slot, params);
          let rows: readonly { node_id: string; score: number }[];
          try {
            rows = await runVectorSearch(params.efSearch, query);
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
    fulltextStrategy,
    ...(vectorStrategy === undefined ? {} : { vectorStrategy }),
    dialect: "postgres",
    tableNames,

    // === Vector Index Operations ===

    async createVectorIndex(params: CreateVectorIndexParams): Promise<void> {
      if (vectorStrategy === undefined) return;
      const slot = vectorSlotFromCreateIndexParams(params);
      // Ensure the per-field table + its durable marker first (privileged,
      // idempotent), then create its ANN index. pgvector's `ownedTables`
      // builds the table only — the HNSW/IVFFlat index is created here (and
      // only here) so it picks up the declared `m`/`ef_construction`/`lists`
      // from `slot.indexParams` rather than defaults.
      await contributionMaterializer.ensureVectorSlot(slot);
      // Honor the `concurrent` flag materializeIndexes passes on Postgres so the
      // ANN build doesn't take a write-blocking lock on a live table. execRun is
      // autocommit, which CONCURRENTLY requires.
      const indexStatement = vectorStrategy.buildCreateIndex?.(slot, {
        concurrent: params.concurrent === true,
      });
      if (indexStatement !== undefined) {
        await execRun(indexStatement);
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

  // The transaction-scoped backend shares the outer backend's
  // contribution materializer: the per-field vector table is provisioned
  // (DDL) only by the privileged outer backend, so a tx-scoped vector op
  // only ASSERTS the durable marker (SELECT, never DDL) and can't poison
  // anything on rollback. The shared per-instance cache means a slot
  // confirmed once stays a pure `Set.has` inside every later transaction.
  return createPostgresOperationBackend({
    db: options.db,
    executionAdapter: txExecutionAdapter,
    adapterOptions: options.adapterOptions,
    operationStrategy: options.operationStrategy,
    tableNames: options.tableNames,
    capabilities: options.capabilities,
    fulltextStrategy: options.fulltextStrategy,
    vectorStrategy: options.vectorStrategy,
    contributionMaterializer: options.contributionMaterializer,
  });
}

// Re-export schema utilities
export type { PostgresTableNames, PostgresTables } from "./schema/postgres";
export { createPostgresTables, tables } from "./schema/postgres";
