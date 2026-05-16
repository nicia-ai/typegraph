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
 * Other pg-protocol Drizzle adapters (PGlite, Vercel Postgres, Supabase
 * via pg) should work unchanged because they all expose a compatible
 * `db.execute()` / `db.transaction()` surface.
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

import { ConfigurationError } from "../../errors";
import type { SqlTableNames } from "../../query/compiler/schema";
import { quoteIdentifier } from "../../query/compiler/utils";
import {
  buildFulltextCapabilities,
  type FulltextStrategy,
  tsvectorStrategy,
} from "../../query/dialect/fulltext-strategy";
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
  type EmbeddingRow,
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
  createContributionMaterializer,
  gateFulltext,
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
  type CommonOperationBackend,
  createCommonOperationBackend,
} from "./operation-backend-core";
import { createPostgresOperationStrategy } from "./operations/strategy";
import {
  createEdgeRowMapper,
  createNodeRowMapper,
  createSchemaVersionRowMapper,
  createUniqueRowMapper,
  formatPostgresTimestamp,
  nowIso,
  POSTGRES_ROW_MAPPER_CONFIG,
} from "./row-mappers";
import {
  type PostgresTables,
  tables as defaultTables,
} from "./schema/postgres";
import {
  createPostgresVectorIndex,
  dropPostgresVectorIndex,
  generateVectorIndexName,
  type VectorIndexOptions,
} from "./vector-index";

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
const toSchemaVersionRow = createSchemaVersionRowMapper(POSTGRES_ROW_MAPPER_CONFIG);

/**
 * Converts a database row to EmbeddingRow type.
 * Raw SQL returns snake_case column names.
 */
function toEmbeddingRow(row: Record<string, unknown>): EmbeddingRow {
  // pgvector returns embedding as a string '[1,2,3]' or as parsed array
  let embedding: readonly number[];
  if (typeof row.embedding === "string") {
    const content = row.embedding.slice(1, -1);
    embedding = content === "" ? [] : content.split(",").map((s) => Number.parseFloat(s.trim()));
  } else if (Array.isArray(row.embedding)) {
    embedding = row.embedding as number[];
  } else {
    embedding = [];
  }

  return {
    graph_id: row.graph_id as string,
    node_kind: row.node_kind as string,
    node_id: row.node_id as string,
    field_path: row.field_path as string,
    embedding,
    dimensions: row.dimensions as number,
    created_at: formatPostgresTimestamp(row.created_at) ?? "",
    updated_at: formatPostgresTimestamp(row.updated_at) ?? "",
  };
}

function coerceNumericScore(value: number | string): number {
  if (typeof value === "number") return value;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new TypeError(
      `Backend returned non-numeric fulltext score: ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

function buildPostgresCapabilities(
  strategy: FulltextStrategy,
): BackendCapabilities {
  return {
    ...POSTGRES_CAPABILITIES,
    vector: {
      supported: true,
      metrics: ["cosine", "l2", "inner_product"] as const,
      indexTypes: ["hnsw", "ivfflat", "none"] as const,
      maxDimensions: 16_000, // pgvector limit
    },
    fulltext: buildFulltextCapabilities(strategy),
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
  const baseCapabilities = buildPostgresCapabilities(fulltextStrategy);
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
    ...(options.prepareStatements === undefined
      ? {}
      : { prepareStatements: options.prepareStatements }),
    ...(options.preparedStatementCacheMax === undefined
      ? {}
      : { preparedStatementCacheMax: options.preparedStatementCacheMax }),
  };
  const executionAdapter = createPostgresExecutionAdapter(db, adapterOptions);
  const tableNames: SqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    embeddings: getTableName(tables.embeddings),
    fulltext: tables.fulltextTableName,
    uniques: getTableName(tables.uniques),
  };
  // Pre-quote identifiers so refreshStatistics() doesn't rebuild the
  // ANALYZE statement on every call.
  const analyzeStatement = sql`ANALYZE ${sql.join(
    [
      tableNames.nodes,
      tableNames.edges,
      getTableName(tables.uniques),
      tableNames.embeddings,
      tableNames.fulltext,
    ].map((name) => quoteIdentifier(name)),
    sql`, `,
  )}`;
  const operationStrategy = createPostgresOperationStrategy(
    tables,
    fulltextStrategy,
  );
  const operations = createPostgresOperationBackend({
    db,
    executionAdapter,
    operationStrategy,
    tableNames,
    capabilities,
    fulltextStrategy,
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
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${graphId}))`,
      );
      // The runtime object always implements commitSchemaVersion /
      // setActiveVersion (they live in operation-backend-core); the
      // public TransactionBackend type omits them so user-supplied
      // transaction() callbacks can't bypass the advisory lock. Cast
      // back to the wider internal shape here, where the lock IS held.
      const txBackend = createTransactionBackend({
        db: tx,
        adapterOptions,
        operationStrategy,
        tableNames,
        capabilities,
        fulltextStrategy,
      }) as unknown as CommonOperationBackend;
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

    // Every fulltext-touching method now asserts the durable marker
    // instead of lazily emitting DDL. Steady state performs zero
    // ensure; an uninitialized database throws `StoreNotInitializedError`
    // loudly rather than self-healing on a read/write path (#135).
    async upsertFulltext(params): Promise<void> {
      await contributionMaterializer.assertInitialized(params.graphId);
      await operations.upsertFulltext!(params);
    },
    async deleteFulltext(params): Promise<void> {
      await contributionMaterializer.assertInitialized(params.graphId);
      await operations.deleteFulltext!(params);
    },
    async upsertFulltextBatch(params): Promise<void> {
      // A genuine no-op call asserts nothing — preserves the prior
      // "empty input on any backend is harmless" contract.
      if (params.rows.length === 0) return;
      await contributionMaterializer.assertInitialized(params.graphId);
      await operations.upsertFulltextBatch!(params);
    },
    async deleteFulltextBatch(params): Promise<void> {
      if (params.nodeIds.length === 0) return;
      await contributionMaterializer.assertInitialized(params.graphId);
      await operations.deleteFulltextBatch!(params);
    },
    async fulltextSearch(params) {
      await contributionMaterializer.assertInitialized(params.graphId);
      return operations.fulltextSearch!(params);
    },
    // hardDeleteNode is wrapped because the operation-backend-core
    // cascade unconditionally deletes from the fulltext table — it
    // would fail even on graphs that declare no searchable() fields.
    async hardDeleteNode(params): Promise<void> {
      await contributionMaterializer.assertInitialized(params.graphId);
      await operations.hardDeleteNode(params);
    },

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
      await db.execute(
        sql.raw(generatePgCreateTableSQL(tables.kindRemovals)),
      );
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

    async ensureContribution(
      logicalName: string,
      graphId: string,
    ): Promise<void> {
      await contributionMaterializer.ensureContribution(logicalName, graphId);
    },

    async ensureRuntimeContributions(graphId: string): Promise<void> {
      await contributionMaterializer.ensureRuntimeContributions(graphId);
    },

    /**
     * Superseded by `ensureContribution("fulltext", graphId)` /
     * `ensureRuntimeContributions(graphId)` (#129). Retained as a thin
     * back-compat wrapper for callers predating #129; #135 routed it
     * through the durable-marker writer.
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
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      // #134/#135: NO DDL or ensure here. The tx-scoped backend's
      // fulltext-touching methods assert the durable contribution
      // marker (one cached SELECT — never DDL) at point of use, exactly
      // like the non-tx wrappers. A transaction that never touches
      // fulltext never asserts; one that does runs pure DML against an
      // already-materialized table, with the "no DDL in the business
      // transaction" guarantee backed by the durable fact.
      const txConfig = options?.isolationLevel
        ? {
            isolationLevel: options.isolationLevel.replace("_", " ") as
              | "read uncommitted"
              | "read committed"
              | "repeatable read"
              | "serializable",
          }
        : undefined;

      return db.transaction(
        async (tx) => fn(bindTransactionBackend(tx)),
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
      // The caller owns BEGIN/COMMIT/ROLLBACK via its own
      // `db.transaction(...)`. We adopt the literal `tx` client and run
      // pure DML on it — no transaction is opened or closed here, and no
      // DDL is emitted inside the caller's business transaction.
      return bindTransactionBackend(externalTx as AnyPgDatabase);
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
  operationStrategy: ReturnType<typeof createPostgresOperationStrategy>;
  tableNames: SqlTableNames;
  capabilities: BackendCapabilities;
  fulltextStrategy: FulltextStrategy;
}>;

type CreatePostgresTransactionBackendOptions = Readonly<{
  db: AnyPgDatabase;
  executionAdapter?: PostgresExecutionAdapter;
  adapterOptions?: PostgresExecutionAdapterOptions;
  operationStrategy: ReturnType<typeof createPostgresOperationStrategy>;
  tableNames: SqlTableNames;
  capabilities: BackendCapabilities;
  fulltextStrategy: FulltextStrategy;
}>;

function createPostgresOperationBackend(
  options: CreatePostgresOperationBackendOptions,
): TransactionBackend {
  const {
    db,
    executionAdapter,
    operationStrategy,
    tableNames,
    capabilities,
    fulltextStrategy,
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

  const operationBackend: TransactionBackend = {
    ...commonBackend,
    ...executeRawMethod,
    capabilities,
    fulltextStrategy,
    dialect: "postgres",
    tableNames,

    // === Embedding Operations ===

    async upsertEmbedding(params: UpsertEmbeddingParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpsertEmbedding(params, timestamp);
      await execRun(query);
    },

    async deleteEmbedding(params: DeleteEmbeddingParams): Promise<void> {
      const query = operationStrategy.buildDeleteEmbedding(params);
      await execRun(query);
    },

    async getEmbedding(
      graphId: string,
      nodeKind: string,
      nodeId: string,
      fieldPath: string,
    ): Promise<EmbeddingRow | undefined> {
      const query = operationStrategy.buildGetEmbedding(
        graphId,
        nodeKind,
        nodeId,
        fieldPath,
      );
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toEmbeddingRow(row) : undefined;
    },

    async vectorSearch(
      params: VectorSearchParams,
    ): Promise<readonly VectorSearchResult[]> {
      const query = operationStrategy.buildVectorSearch(params);
      const rows = await execAll<{ node_id: string; score: number }>(query);
      return rows.map((row) => ({
        nodeId: row.node_id,
        score: row.score,
      }));
    },

    async createVectorIndex(params: CreateVectorIndexParams): Promise<void> {
      const indexOptions: VectorIndexOptions = {
        graphId: params.graphId,
        nodeKind: params.nodeKind,
        fieldPath: params.fieldPath,
        dimensions: params.dimensions,
        embeddingsTableName: tableNames.embeddings,
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
        ...(params.concurrent === true ? { concurrent: true } : {}),
      };

      const result = await createPostgresVectorIndex(db, indexOptions);

      if (!result.success) {
        throw new Error(
          result.message ?? "Failed to create PostgreSQL vector index",
        );
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
      const metrics = capabilities.vector?.metrics ?? (["cosine"] as const);

      // Per-metric DROP statements are independent; run them concurrently.
      await Promise.all(
        metrics.map(async (metric) => {
          const indexName = generateVectorIndexName(
            params.graphId,
            params.nodeKind,
            params.fieldPath,
            metric,
          );
          const result = await dropPostgresVectorIndex(db, indexName);
          if (!result.success) {
            throw new Error(
              result.message ?? "Failed to drop PostgreSQL vector index",
            );
          }
        }),
      );
    },

    // === Query Execution ===

    async execute<T>(query: SQL): Promise<readonly T[]> {
      return executionAdapter.execute<T>(query);
    },

    compileSql(query: SQL): Readonly<{ sql: string; params: readonly unknown[] }> {
      return executionAdapter.compile(query);
    },
  };

  return operationBackend;
}

function createTransactionBackend(
  options: CreatePostgresTransactionBackendOptions,
): TransactionBackend {
  const txExecutionAdapter =
    options.executionAdapter ??
    createPostgresExecutionAdapter(options.db, options.adapterOptions);

  return createPostgresOperationBackend({
    db: options.db,
    executionAdapter: txExecutionAdapter,
    operationStrategy: options.operationStrategy,
    tableNames: options.tableNames,
    capabilities: options.capabilities,
    fulltextStrategy: options.fulltextStrategy,
  });
}

// Re-export schema utilities
export type { PostgresTableNames,PostgresTables } from "./schema/postgres";
export { createPostgresTables, tables } from "./schema/postgres";
