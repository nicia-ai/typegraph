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

import { UniquenessError } from "../../errors";
import type { SqlTableNames } from "../../query/compiler/schema";
import {
  type BackendCapabilities,
  type CheckUniqueParams,
  type CountEdgesByKindParams,
  type CountEdgesFromParams,
  type CountNodesByKindParams,
  type CreateVectorIndexParams,
  type DeleteEdgeParams,
  type DeleteEmbeddingParams,
  type DeleteNodeParams,
  type DeleteUniqueParams,
  type DropVectorIndexParams,
  type EdgeExistsBetweenParams,
  type EdgeRow,
  type EmbeddingRow,
  type FindEdgesByKindParams,
  type FindEdgesConnectedToParams,
  type FindNodesByKindParams,
  type GraphBackend,
  type HardDeleteEdgeParams,
  type HardDeleteNodeParams,
  type InsertEdgeParams,
  type InsertNodeParams,
  type InsertSchemaParams,
  type InsertUniqueParams,
  type NodeRow,
  POSTGRES_CAPABILITIES,
  type SchemaVersionRow,
  type TransactionBackend,
  type TransactionOptions,
  type UniqueRow,
  type UpdateEdgeParams,
  type UpdateNodeParams,
  type UpsertEmbeddingParams,
  type VectorSearchParams,
  type VectorSearchResult,
} from "../types";
import {
  type AnyPgDatabase,
  createPostgresExecutionAdapter,
  type PostgresExecutionAdapter,
} from "./execution/postgres-execution";
import { createPostgresOperationStrategy } from "./operations/strategy";
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

function chunkArray<T>(
  values: readonly T[],
  size: number,
): readonly (readonly T[])[] {
  if (values.length <= size) return [values];

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

// ============================================================
// Utilities
// ============================================================

/**
 * Gets the current timestamp in ISO format.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Converts null to undefined.
 */
function nullToUndefined<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

/**
 * Formats a timestamp value to ISO string.
 * PostgreSQL returns Date objects or timestamp strings, need to normalize to ISO format.
 */
function formatTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    // If already in ISO format, return as-is
    if (value.includes("T")) return value;
    // Parse PostgreSQL timestamp format and convert to ISO
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return value;
  }
  return undefined;
}

/**
 * Converts a database row to NodeRow type.
 * PostgreSQL returns dates as Date objects and JSONB as objects.
 * Raw SQL returns snake_case column names.
 */
function toNodeRow(row: Record<string, unknown>): NodeRow {
  return {
    graph_id: row.graph_id as string,
    kind: row.kind as string,
    id: row.id as string,
    // PostgreSQL JSONB is already parsed, stringify for consistency
    props:
      typeof row.props === "string"
        ? row.props
        : JSON.stringify(row.props ?? {}),
    version: row.version as number,
    valid_from: nullToUndefined(formatTimestamp(row.valid_from)),
    valid_to: nullToUndefined(formatTimestamp(row.valid_to)),
    created_at: formatTimestamp(row.created_at) ?? "",
    updated_at: formatTimestamp(row.updated_at) ?? "",
    deleted_at: nullToUndefined(formatTimestamp(row.deleted_at)),
  };
}

/**
 * Converts a database row to EdgeRow type.
 * Raw SQL returns snake_case column names.
 */
function toEdgeRow(row: Record<string, unknown>): EdgeRow {
  return {
    graph_id: row.graph_id as string,
    id: row.id as string,
    kind: row.kind as string,
    from_kind: row.from_kind as string,
    from_id: row.from_id as string,
    to_kind: row.to_kind as string,
    to_id: row.to_id as string,
    props:
      typeof row.props === "string"
        ? row.props
        : JSON.stringify(row.props ?? {}),
    valid_from: nullToUndefined(formatTimestamp(row.valid_from)),
    valid_to: nullToUndefined(formatTimestamp(row.valid_to)),
    created_at: formatTimestamp(row.created_at) ?? "",
    updated_at: formatTimestamp(row.updated_at) ?? "",
    deleted_at: nullToUndefined(formatTimestamp(row.deleted_at)),
  };
}

/**
 * Converts a database row to UniqueRow type.
 * Raw SQL returns snake_case column names.
 */
function toUniqueRow(row: Record<string, unknown>): UniqueRow {
  return {
    graph_id: row.graph_id as string,
    node_kind: row.node_kind as string,
    constraint_name: row.constraint_name as string,
    key: row.key as string,
    node_id: row.node_id as string,
    concrete_kind: row.concrete_kind as string,
    deleted_at: nullToUndefined(formatTimestamp(row.deleted_at)),
  };
}

/**
 * Converts a database row to SchemaVersionRow type.
 * Raw SQL returns snake_case column names.
 */
function toSchemaVersionRow(row: Record<string, unknown>): SchemaVersionRow {
  // PostgreSQL may return is_active as boolean or number/string depending on driver
  const isActiveValue = row.is_active;
  const isActive = isActiveValue === true || isActiveValue === 1 || isActiveValue === "1";

  return {
    graph_id: row.graph_id as string,
    version: row.version as number,
    schema_hash: row.schema_hash as string,
    schema_doc:
      typeof row.schema_doc === "string"
        ? row.schema_doc
        : JSON.stringify(row.schema_doc ?? {}),
    created_at: formatTimestamp(row.created_at) ?? "",
    is_active: isActive,
  };
}

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
    created_at: formatTimestamp(row.created_at) ?? "",
    updated_at: formatTimestamp(row.updated_at) ?? "",
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
          db: tx as unknown as AnyPgDatabase,
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: { rows: T[] } = await db.execute(query);
    return result.rows;
  }

  async function execGet<T>(query: SQL): Promise<T | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result: { rows: T[] } = await db.execute(query);
    return result.rows[0];
  }

  async function execRun(query: SQL): Promise<void> {
    await db.execute(query);
  }

  const operationBackend: TransactionBackend = {
    dialect: "postgres",
    capabilities: POSTGRES_VECTOR_CAPABILITIES,
    tableNames,

    // === Node Operations ===

    async insertNode(params: InsertNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNode(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert node failed: no row returned");
      return toNodeRow(row);
    },

    async insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertNodeNoReturn(params, timestamp);
      await execRun(query);
    },

    async insertNodesBatch(
      params: readonly InsertNodeParams[],
    ): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, POSTGRES_NODE_INSERT_BATCH_SIZE)) {
        const query = operationStrategy.buildInsertNodesBatch(chunk, timestamp);
        await execRun(query);
      }
    },

    async insertNodesBatchReturning(
      params: readonly InsertNodeParams[],
    ): Promise<readonly NodeRow[]> {
      if (params.length === 0) {
        return [];
      }
      const timestamp = nowIso();
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(params, POSTGRES_NODE_INSERT_BATCH_SIZE)) {
        const query =
          operationStrategy.buildInsertNodesBatchReturning(chunk, timestamp);
        const rows = await execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => toNodeRow(row)));
      }
      return allRows;
    },

    async getNode(
      graphId: string,
      kind: string,
      id: string,
    ): Promise<NodeRow | undefined> {
      const query = operationStrategy.buildGetNode(graphId, kind, id);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toNodeRow(row) : undefined;
    },

    async getNodes(
      graphId: string,
      kind: string,
      ids: readonly string[],
    ): Promise<readonly NodeRow[]> {
      if (ids.length === 0) return [];
      const allRows: NodeRow[] = [];
      for (const chunk of chunkArray(ids, POSTGRES_GET_NODES_ID_CHUNK_SIZE)) {
        const query = operationStrategy.buildGetNodes(graphId, kind, chunk);
        const rows = await execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => toNodeRow(row)));
      }
      return allRows;
    },

    async updateNode(params: UpdateNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateNode(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Update node failed: no row returned");
      return toNodeRow(row);
    },

    async deleteNode(params: DeleteNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteNode(params, timestamp);
      await execRun(query);
    },

    async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
      const deleteUniquesQuery = operationStrategy.buildHardDeleteUniquesByNode(
        params.graphId,
        params.id,
      );
      await execRun(deleteUniquesQuery);

      const deleteEmbeddingsQuery =
        operationStrategy.buildHardDeleteEmbeddingsByNode(
          params.graphId,
          params.kind,
          params.id,
        );
      await execRun(deleteEmbeddingsQuery);

      const query = operationStrategy.buildHardDeleteNode(params);
      await execRun(query);
    },

    // === Edge Operations ===

    async insertEdge(params: InsertEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdge(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert edge failed: no row returned");
      return toEdgeRow(row);
    },

    async insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertEdgeNoReturn(params, timestamp);
      await execRun(query);
    },

    async insertEdgesBatch(
      params: readonly InsertEdgeParams[],
    ): Promise<void> {
      if (params.length === 0) {
        return;
      }
      const timestamp = nowIso();
      for (const chunk of chunkArray(params, POSTGRES_EDGE_INSERT_BATCH_SIZE)) {
        const query = operationStrategy.buildInsertEdgesBatch(chunk, timestamp);
        await execRun(query);
      }
    },

    async insertEdgesBatchReturning(
      params: readonly InsertEdgeParams[],
    ): Promise<readonly EdgeRow[]> {
      if (params.length === 0) {
        return [];
      }
      const timestamp = nowIso();
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(params, POSTGRES_EDGE_INSERT_BATCH_SIZE)) {
        const query =
          operationStrategy.buildInsertEdgesBatchReturning(chunk, timestamp);
        const rows = await execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => toEdgeRow(row)));
      }
      return allRows;
    },

    async getEdge(graphId: string, id: string): Promise<EdgeRow | undefined> {
      const query = operationStrategy.buildGetEdge(graphId, id);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toEdgeRow(row) : undefined;
    },

    async getEdges(
      graphId: string,
      ids: readonly string[],
    ): Promise<readonly EdgeRow[]> {
      if (ids.length === 0) return [];
      const allRows: EdgeRow[] = [];
      for (const chunk of chunkArray(ids, POSTGRES_GET_EDGES_ID_CHUNK_SIZE)) {
        const query = operationStrategy.buildGetEdges(graphId, chunk);
        const rows = await execAll<Record<string, unknown>>(query);
        allRows.push(...rows.map((row) => toEdgeRow(row)));
      }
      return allRows;
    },

    async updateEdge(params: UpdateEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildUpdateEdge(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Update edge failed: no row returned");
      return toEdgeRow(row);
    },

    async deleteEdge(params: DeleteEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteEdge(params, timestamp);
      await execRun(query);
    },

    async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<void> {
      const query = operationStrategy.buildHardDeleteEdge(params);
      await execRun(query);
    },

    // === Edge Cardinality Operations ===

    async countEdgesFrom(params: CountEdgesFromParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesFrom(params);
      const row = await execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async edgeExistsBetween(params: EdgeExistsBetweenParams): Promise<boolean> {
      const query = operationStrategy.buildEdgeExistsBetween(params);
      const row = await execGet<Record<string, unknown>>(query);
      return row !== undefined;
    },

    // === Edge Query Operations ===

    async findEdgesConnectedTo(
      params: FindEdgesConnectedToParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesConnectedTo(params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toEdgeRow(row));
    },

    // === Collection Query Operations ===

    async findNodesByKind(
      params: FindNodesByKindParams,
    ): Promise<readonly NodeRow[]> {
      const query = operationStrategy.buildFindNodesByKind(params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toNodeRow(row));
    },

    async countNodesByKind(params: CountNodesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountNodesByKind(params);
      const row = await execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    async findEdgesByKind(
      params: FindEdgesByKindParams,
    ): Promise<readonly EdgeRow[]> {
      const query = operationStrategy.buildFindEdgesByKind(params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toEdgeRow(row));
    },

    async countEdgesByKind(params: CountEdgesByKindParams): Promise<number> {
      const query = operationStrategy.buildCountEdgesByKind(params);
      const row = await execGet<{ count: string | number }>(query);
      return Number(row?.count ?? 0);
    },

    // === Unique Constraint Operations ===

    async insertUnique(params: InsertUniqueParams): Promise<void> {
      const query = operationStrategy.buildInsertUnique(params);
      const result = await execGet<{ node_id: string }>(query);

      if (result && result.node_id !== params.nodeId) {
        throw new UniquenessError({
          constraintName: params.constraintName,
          kind: params.nodeKind,
          existingId: result.node_id,
          newId: params.nodeId,
          fields: [],
        });
      }
    },

    async deleteUnique(params: DeleteUniqueParams): Promise<void> {
      const timestamp = nowIso();
      const query = operationStrategy.buildDeleteUnique(params, timestamp);
      await execRun(query);
    },

    async checkUnique(
      params: CheckUniqueParams,
    ): Promise<UniqueRow | undefined> {
      const query = operationStrategy.buildCheckUnique(params);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toUniqueRow(row) : undefined;
    },

    // === Schema Operations ===

    async getActiveSchema(
      graphId: string,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetActiveSchema(graphId);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toSchemaVersionRow(row) : undefined;
    },

    async insertSchema(params: InsertSchemaParams): Promise<SchemaVersionRow> {
      const timestamp = nowIso();
      const query = operationStrategy.buildInsertSchema(params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert schema failed: no row returned");
      return toSchemaVersionRow(row);
    },

    async getSchemaVersion(
      graphId: string,
      version: number,
    ): Promise<SchemaVersionRow | undefined> {
      const query = operationStrategy.buildGetSchemaVersion(graphId, version);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toSchemaVersionRow(row) : undefined;
    },

    async setActiveSchema(graphId: string, version: number): Promise<void> {
      const queries = operationStrategy.buildSetActiveSchema(graphId, version);
      await execRun(queries.deactivateAll);
      await execRun(queries.activateVersion);
    },

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

  const executeCompiled = executionAdapter.executeCompiled;
  if (executeCompiled !== undefined) {
    (operationBackend as { executeRaw?: TransactionBackend["executeRaw"] }).executeRaw = async function <T>(
      sqlText: string,
      params: readonly unknown[],
    ): Promise<readonly T[]> {
      return executeCompiled<T>({ params, sql: sqlText });
    };
  }

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
export type { PostgresTables, TableNames } from "./schema/postgres";
export { createPostgresTables, tables } from "./schema/postgres";
