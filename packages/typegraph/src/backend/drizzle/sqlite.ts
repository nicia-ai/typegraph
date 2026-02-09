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
 * import { createSqliteBackend } from "@nicia-ai/typegraph/drizzle/sqlite";
 * import { tables } from "@nicia-ai/typegraph/drizzle/schema/sqlite";
 *
 * const sqlite = new Database("app.db");
 * const db = drizzle(sqlite);
 * const backend = createSqliteBackend(db, { tables });
 * ```
 */
import { getTableName, type SQL, sql } from "drizzle-orm";
import { type BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import { ConfigurationError, UniquenessError } from "../../errors";
import type { SqlTableNames } from "../../query/compiler/schema";
import {
  type CheckUniqueParams,
  type CountEdgesByKindParams,
  type CountEdgesFromParams,
  type CountNodesByKindParams,
  D1_CAPABILITIES,
  type DeleteEdgeParams,
  type DeleteNodeParams,
  type DeleteUniqueParams,
  type EdgeExistsBetweenParams,
  type EdgeRow,
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
  type SchemaVersionRow,
  SQLITE_CAPABILITIES,
  type TransactionBackend,
  type TransactionOptions,
  type UniqueRow,
  type UpdateEdgeParams,
  type UpdateNodeParams,
} from "../types";
import * as ops from "./operations";
import { type SqliteTables,tables as defaultTables } from "./schema/sqlite";

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
}>;

/**
 * Any Drizzle SQLite database instance.
 */
type AnySqliteDatabase = BaseSQLiteDatabase<"sync" | "async", unknown>;

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
 * Converts a database row to NodeRow type.
 * Raw SQL returns snake_case column names.
 */
function toNodeRow(row: Record<string, unknown>): NodeRow {
  return {
    graph_id: row.graph_id as string,
    kind: row.kind as string,
    id: row.id as string,
    props: row.props as string,
    version: row.version as number,
    valid_from: nullToUndefined(row.valid_from as string | null),
    valid_to: nullToUndefined(row.valid_to as string | null),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: nullToUndefined(row.deleted_at as string | null),
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
    props: row.props as string,
    valid_from: nullToUndefined(row.valid_from as string | null),
    valid_to: nullToUndefined(row.valid_to as string | null),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    deleted_at: nullToUndefined(row.deleted_at as string | null),
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
    deleted_at: nullToUndefined(row.deleted_at as string | null),
  };
}

/**
 * Converts a database row to SchemaVersionRow type.
 * Raw SQL returns snake_case column names.
 */
function toSchemaVersionRow(row: Record<string, unknown>): SchemaVersionRow {
  // SQLite returns is_active as number (0 or 1) or string ('0' or '1')
  // Boolean('0') is true in JavaScript, so we need explicit conversion
  const isActiveValue = row.is_active;
  const isActive = isActiveValue === 1 || isActiveValue === "1" || isActiveValue === true;

  return {
    graph_id: row.graph_id as string,
    version: row.version as number,
    schema_hash: row.schema_hash as string,
    schema_doc: row.schema_doc as string,
    created_at: row.created_at as string,
    is_active: isActive,
  };
}

/**
 * Gets the session class name from a Drizzle database instance.
 */
function getSessionName(db: AnySqliteDatabase): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny: any = db;

  // Try db.session first (current Drizzle structure)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (dbAny.session?.constructor?.name) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return dbAny.session.constructor.name as string;
  }

  // Fallback to db._.session (older Drizzle structure)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (dbAny._?.session?.constructor?.name) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return dbAny._.session.constructor.name as string;
  }

  return undefined;
}

/**
 * Detects if the database is a D1 database (no transaction support).
 */
function isD1Database(db: AnySqliteDatabase): boolean {
  return getSessionName(db) === "SQLiteD1Session";
}

/**
 * Detects if the database is a synchronous SQLite database (better-sqlite3, bun:sqlite).
 * These drivers don't support async transaction callbacks.
 */
function isSyncDatabase(db: AnySqliteDatabase): boolean {
  const sessionName = getSessionName(db);
  // BetterSQLiteSession is better-sqlite3
  // BunSQLiteSession is bun:sqlite
  return sessionName === "BetterSQLiteSession" || sessionName === "BunSQLiteSession";
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
export function createSqliteBackend(
  db: AnySqliteDatabase,
  options: SqliteBackendOptions = {},
): GraphBackend {
  const tables = options.tables ?? defaultTables;
  const isD1 = isD1Database(db);
  const isSync = isSyncDatabase(db);

  const tableNames: SqlTableNames = {
    nodes: getTableName(tables.nodes),
    edges: getTableName(tables.edges),
    embeddings: getTableName(tables.embeddings),
  };

  /**
   * Helper to execute a query and handle sync/async uniformly.
   */
  async function execGet<T>(query: SQL): Promise<T | undefined> {
    const result = db.get(query);
    return (result instanceof Promise ? await result : result) as T | undefined;
  }

  async function execAll<T>(query: SQL): Promise<T[]> {
    const result = db.all(query);
    return (result instanceof Promise ? await result : result) as T[];
  }

  async function execRun(query: SQL): Promise<void> {
    const result = db.run(query);
    if (result instanceof Promise) await result;
  }

  // Create the backend operations
  const backend: GraphBackend = {
    dialect: "sqlite",
    capabilities: isD1 ? D1_CAPABILITIES : SQLITE_CAPABILITIES,
    tableNames,

    // === Node Operations ===

    async insertNode(params: InsertNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = ops.buildInsertNode(tables, params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert node failed: no row returned");
      return toNodeRow(row);
    },

    async getNode(
      graphId: string,
      kind: string,
      id: string,
    ): Promise<NodeRow | undefined> {
      const query = ops.buildGetNode(tables, graphId, kind, id);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toNodeRow(row) : undefined;
    },

    async updateNode(params: UpdateNodeParams): Promise<NodeRow> {
      const timestamp = nowIso();
      const query = ops.buildUpdateNode(tables, params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Update node failed: no row returned");
      return toNodeRow(row);
    },

    async deleteNode(params: DeleteNodeParams): Promise<void> {
      const timestamp = nowIso();
      const query = ops.buildDeleteNode(tables, params, timestamp);
      await execRun(query);
    },

    async hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
      // Delete associated uniqueness entries
      const deleteUniquesQuery = ops.buildHardDeleteUniquesByNode(
        tables,
        params.graphId,
        params.id,
      );
      await execRun(deleteUniquesQuery);

      // Delete associated embeddings (if embeddings table exists)
      const deleteEmbeddingsQuery = ops.buildHardDeleteEmbeddingsByNode(
        tables,
        params.graphId,
        params.kind,
        params.id,
      );
      await execRun(deleteEmbeddingsQuery);

      // Delete the node itself
      const query = ops.buildHardDeleteNode(tables, params);
      await execRun(query);
    },

    // === Edge Operations ===

    async insertEdge(params: InsertEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = ops.buildInsertEdge(tables, params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert edge failed: no row returned");
      return toEdgeRow(row);
    },

    async getEdge(graphId: string, id: string): Promise<EdgeRow | undefined> {
      const query = ops.buildGetEdge(tables, graphId, id);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toEdgeRow(row) : undefined;
    },

    async updateEdge(params: UpdateEdgeParams): Promise<EdgeRow> {
      const timestamp = nowIso();
      const query = ops.buildUpdateEdge(tables, params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Update edge failed: no row returned");
      return toEdgeRow(row);
    },

    async deleteEdge(params: DeleteEdgeParams): Promise<void> {
      const timestamp = nowIso();
      const query = ops.buildDeleteEdge(tables, params, timestamp);
      await execRun(query);
    },

    async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<void> {
      const query = ops.buildHardDeleteEdge(tables, params);
      await execRun(query);
    },

    // === Edge Cardinality Operations ===

    async countEdgesFrom(params: CountEdgesFromParams): Promise<number> {
      const query = ops.buildCountEdgesFrom(tables, params);
      const row = await execGet<{ count: number }>(query);
      return row?.count ?? 0;
    },

    async edgeExistsBetween(params: EdgeExistsBetweenParams): Promise<boolean> {
      const query = ops.buildEdgeExistsBetween(tables, params);
      const row = await execGet<Record<string, unknown>>(query);
      return row !== undefined;
    },

    // === Edge Query Operations ===

    async findEdgesConnectedTo(
      params: FindEdgesConnectedToParams,
    ): Promise<readonly EdgeRow[]> {
      const query = ops.buildFindEdgesConnectedTo(tables, params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toEdgeRow(row));
    },

    // === Collection Query Operations ===

    async findNodesByKind(
      params: FindNodesByKindParams,
    ): Promise<readonly NodeRow[]> {
      const query = ops.buildFindNodesByKind(tables, params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toNodeRow(row));
    },

    async countNodesByKind(params: CountNodesByKindParams): Promise<number> {
      const query = ops.buildCountNodesByKind(tables, params);
      const row = await execGet<{ count: number }>(query);
      return row?.count ?? 0;
    },

    async findEdgesByKind(
      params: FindEdgesByKindParams,
    ): Promise<readonly EdgeRow[]> {
      const query = ops.buildFindEdgesByKind(tables, params);
      const rows = await execAll<Record<string, unknown>>(query);
      return rows.map((row) => toEdgeRow(row));
    },

    async countEdgesByKind(params: CountEdgesByKindParams): Promise<number> {
      const query = ops.buildCountEdgesByKind(tables, params);
      const row = await execGet<{ count: number }>(query);
      return row?.count ?? 0;
    },

    // === Unique Constraint Operations ===

    async insertUnique(params: InsertUniqueParams): Promise<void> {
      const query = ops.buildInsertUnique(tables, "sqlite", params);
      const result = await execGet<{ node_id: string }>(query);

      // Check if the returned node_id matches our input
      // If different, another node holds this key (race condition or conflict)
      if (result && result.node_id !== params.nodeId) {
        throw new UniquenessError({
          constraintName: params.constraintName,
          kind: params.nodeKind,
          existingId: result.node_id,
          newId: params.nodeId,
          fields: [], // Fields not available at this level
        });
      }
    },

    async deleteUnique(params: DeleteUniqueParams): Promise<void> {
      const timestamp = nowIso();
      const query = ops.buildDeleteUnique(tables, params, timestamp);
      await execRun(query);
    },

    async checkUnique(
      params: CheckUniqueParams,
    ): Promise<UniqueRow | undefined> {
      const query = ops.buildCheckUnique(tables, params);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toUniqueRow(row) : undefined;
    },

    // === Schema Operations ===

    async getActiveSchema(
      graphId: string,
    ): Promise<SchemaVersionRow | undefined> {
      const query = ops.buildGetActiveSchema(tables, graphId);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toSchemaVersionRow(row) : undefined;
    },

    async insertSchema(params: InsertSchemaParams): Promise<SchemaVersionRow> {
      const timestamp = nowIso();
      const query = ops.buildInsertSchema(tables, params, timestamp);
      const row = await execGet<Record<string, unknown>>(query);
      if (!row) throw new Error("Insert schema failed: no row returned");
      return toSchemaVersionRow(row);
    },

    async getSchemaVersion(
      graphId: string,
      version: number,
    ): Promise<SchemaVersionRow | undefined> {
      const query = ops.buildGetSchemaVersion(tables, graphId, version);
      const row = await execGet<Record<string, unknown>>(query);
      return row ? toSchemaVersionRow(row) : undefined;
    },

    async setActiveSchema(graphId: string, version: number): Promise<void> {
      const queries = ops.buildSetActiveSchema(tables, graphId, version);
      await execRun(queries.deactivateAll);
      await execRun(queries.activateVersion);
    },

    // === Query Execution ===

    async execute<T>(query: SQL): Promise<readonly T[]> {
      return execAll<T>(query);
    },

    // === Transaction ===

    async transaction<T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      _options?: TransactionOptions,
    ): Promise<T> {
      if (isD1) {
        // D1 doesn't support atomic transactions - operations are auto-committed.
        // This is a critical limitation that could cause data corruption if
        // a multi-step operation fails partway through.
        throw new ConfigurationError(
          "Cloudflare D1 does not support atomic transactions. " +
            "Operations within a transaction are not rolled back on failure. " +
            "Use backend.capabilities.transactions to check for transaction support, " +
            "or use individual operations with manual error handling.",
          {
            backend: "D1",
            capability: "transactions",
            supportsTransactions: false,
          },
        );
      }

      if (isSync) {
        // Synchronous drivers (better-sqlite3, bun:sqlite) don't support
        // async transaction callbacks. Use raw SQL BEGIN/COMMIT/ROLLBACK.
        const txBackend = createTransactionBackend(db, tables);

        // Begin transaction synchronously
        db.run(sql`BEGIN`);

        try {
          const result = await fn(txBackend);
          db.run(sql`COMMIT`);
          return result;
        } catch (error) {
          db.run(sql`ROLLBACK`);
          throw error;
        }
      }

      // Use Drizzle's transaction API for async drivers (libsql, etc.)
      return db.transaction(async (tx) => {
        const txBackend = createTransactionBackend(tx as AnySqliteDatabase, tables);
        return fn(txBackend);
      }) as Promise<T>;
    },

    // === Lifecycle ===

    async close(): Promise<void> {
      // Drizzle doesn't expose a close method
      // Users manage connection lifecycle themselves
    },
  };

  return backend;
}

/**
 * Creates a transaction backend from a Drizzle transaction.
 */
function createTransactionBackend(
  tx: AnySqliteDatabase,
  tables: SqliteTables,
): TransactionBackend {
  // Create a new backend using the transaction
  const txBackend = createSqliteBackend(tx, { tables });

  // Return without transaction and close methods
  const { transaction: _tx, close: _close, ...ops } = txBackend;
  void _tx;
  void _close;
  return ops;
}

// Re-export schema utilities
export type { SqliteTables, TableNames } from "./schema/sqlite";
export { createSqliteTables, tables } from "./schema/sqlite";
