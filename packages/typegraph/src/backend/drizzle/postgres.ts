/**
 * PostgreSQL backend adapter for TypeGraph.
 *
 * Works with any Drizzle PostgreSQL database instance:
 * - node-postgres (pg)
 * - PGlite
 * - Neon
 * - Vercel Postgres
 * - Supabase
 *
 * @example
 * ```typescript
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { Pool } from "pg";
 * import { createPostgresBackend } from "@nicia-ai/typegraph/drizzle/postgres";
 * import { tables } from "@nicia-ai/typegraph/drizzle/schema/postgres";
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = drizzle(pool);
 * const backend = createPostgresBackend(db, { tables });
 * ```
 */
import { getTableName, type SQL } from "drizzle-orm";

import type { SqlTableNames } from "../../query/compiler/schema";
import {
  type BackendCapabilities,
  type CreateVectorIndexParams,
  type DeleteEmbeddingParams,
  type DropVectorIndexParams,
  type EmbeddingRow,
  type GraphBackend,
  POSTGRES_CAPABILITIES,
  type TransactionBackend,
  type TransactionOptions,
  type UpsertEmbeddingParams,
  type VectorSearchParams,
  type VectorSearchResult,
} from "../types";
import {
  type AnyPgDatabase,
  createPostgresExecutionAdapter,
  type PostgresExecutionAdapter,
} from "./execution/postgres-execution";
import { createCommonOperationBackend } from "./operation-backend-core";
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

/**
 * PostgreSQL capabilities with vector search support.
 * Extends base POSTGRES_CAPABILITIES with vector operations.
 */
const POSTGRES_VECTOR_CAPABILITIES: BackendCapabilities = {
  ...POSTGRES_CAPABILITIES,
  vector: {
    supported: true,
    metrics: ["cosine", "l2", "inner_product"] as const,
    indexTypes: ["hnsw", "ivfflat", "none"] as const,
    maxDimensions: 16_000, // pgvector limit
  },
};

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
  const executionAdapter = createPostgresExecutionAdapter(db);
  const tableNames: SqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    embeddings: getTableName(tables.embeddings),
  };
  const operationStrategy = createPostgresOperationStrategy(tables);
  const operations = createPostgresOperationBackend({
    db,
    executionAdapter,
    operationStrategy,
    tableNames,
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
      options?: TransactionOptions,
    ): Promise<T> {
      const txConfig = options?.isolationLevel
        ? {
            isolationLevel: options.isolationLevel.replace("_", " ") as
              | "read uncommitted"
              | "read committed"
              | "repeatable read"
              | "serializable",
          }
        : undefined;

      return db.transaction(async (tx) => {
        const txBackend = createTransactionBackend({
          db: tx as AnyPgDatabase,
          operationStrategy,
          tableNames,
        });
        return fn(txBackend);
      }, txConfig);
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
}>;

type CreatePostgresTransactionBackendOptions = Readonly<{
  db: AnyPgDatabase;
  executionAdapter?: PostgresExecutionAdapter;
  operationStrategy: ReturnType<typeof createPostgresOperationStrategy>;
  tableNames: SqlTableNames;
}>;

function createPostgresOperationBackend(
  options: CreatePostgresOperationBackendOptions,
): TransactionBackend {
  const { db, executionAdapter, operationStrategy, tableNames } = options;

  async function execAll<T>(query: SQL): Promise<T[]> {
    const result = (await db.execute(query)) as Readonly<{
      rows: T[];
    }>;
    return result.rows;
  }

  async function execGet<T>(query: SQL): Promise<T | undefined> {
    const result = (await db.execute(query)) as Readonly<{
      rows: T[];
    }>;
    return result.rows[0];
  }

  async function execRun(query: SQL): Promise<void> {
    await db.execute(query);
  }

  const commonBackend = createCommonOperationBackend({
    batchConfig: {
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
    capabilities: POSTGRES_VECTOR_CAPABILITIES,
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
      };

      const result = await createPostgresVectorIndex(db, indexOptions);

      if (!result.success) {
        throw new Error(
          result.message ?? "Failed to create PostgreSQL vector index",
        );
      }
    },

    async dropVectorIndex(params: DropVectorIndexParams): Promise<void> {
      const metrics =
        POSTGRES_VECTOR_CAPABILITIES.vector?.metrics ?? (["cosine"] as const);

      for (const metric of metrics) {
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
      }
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
    options.executionAdapter ?? createPostgresExecutionAdapter(options.db);

  return createPostgresOperationBackend({
    db: options.db,
    executionAdapter: txExecutionAdapter,
    operationStrategy: options.operationStrategy,
    tableNames: options.tableNames,
  });
}

// Re-export schema utilities
export type { PostgresTableNames,PostgresTables } from "./schema/postgres";
export { createPostgresTables, tables } from "./schema/postgres";
