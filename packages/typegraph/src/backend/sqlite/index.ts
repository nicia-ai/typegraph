/**
 * SQLite backend for TypeGraph.
 *
 * Re-exports from the Drizzle implementation for backwards compatibility.
 *
 * @example Quick start with in-memory database
 * ```typescript
 * import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";
 *
 * const { backend, db } = createLocalSqliteBackend();
 * const store = createStore(graph, backend);
 * ```
 *
 * @example File-based database for persistent local development
 * ```typescript
 * import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";
 *
 * const { backend, db } = createLocalSqliteBackend({ path: "./dev.db" });
 * const store = createStore(graph, backend);
 * ```
 *
 * @example Full manual configuration
 * ```typescript
 * import { drizzle } from "drizzle-orm/better-sqlite3";
 * import Database from "better-sqlite3";
 * import { createSqliteBackend, getSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";
 *
 * const sqlite = new Database("app.db");
 * sqlite.exec(getSqliteMigrationSQL());
 * const db = drizzle(sqlite);
 * const backend = createSqliteBackend(db);
 * ```
 */
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";

import { ConfigurationError } from "../../errors";
import {
  createSqliteBackend,
  type SqliteTables,
  tables as defaultTables,
} from "../drizzle/sqlite";
import { generateSqliteDDL } from "../drizzle/test-helpers";
import type { GraphBackend } from "../types";

type NodeModuleVersionMismatch = Readonly<{
  compiled: number;
  required: number;
}>;

function getUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function parseNodeModuleVersionMismatchMessage(
  message: string,
): NodeModuleVersionMismatch | undefined {
  const regexp =
    /NODE_MODULE_VERSION (?<compiled>\d+)[\s\S]*?NODE_MODULE_VERSION (?<required>\d+)/;
  const match = regexp.exec(message);
  if (!match?.groups) return undefined;

  const compiled = Number(match.groups.compiled);
  const required = Number(match.groups.required);

  if (!Number.isFinite(compiled) || !Number.isFinite(required))
    return undefined;

  return { compiled, required };
}

function createDatabase(path: string): Database.Database {
  try {
    return new Database(path);
  } catch (error) {
    const message = getUnknownErrorMessage(error);
    const mismatch = parseNodeModuleVersionMismatchMessage(message);
    if (!mismatch) throw error;

    throw new ConfigurationError(
      [
        "Failed to load better-sqlite3 native addon.",
        `It was compiled for NODE_MODULE_VERSION ${mismatch.compiled}, but this Node.js runtime requires ${mismatch.required}.`,
        "This usually happens after switching Node versions without rebuilding native dependencies.",
        "Rebuild with: pnpm rebuild better-sqlite3 (or npm rebuild better-sqlite3).",
      ].join(" "),
      {
        nodeVersion: process.version,
        nodeModuleVersion: process.versions.modules,
        compiledNodeModuleVersion: mismatch.compiled,
        requiredNodeModuleVersion: mismatch.required,
      },
      { cause: error },
    );
  }
}

// ============================================================
// Types
// ============================================================

/**
 * Options for creating a local SQLite backend.
 */
export type LocalSqliteBackendOptions = Readonly<{
  /**
   * Path to the SQLite database file.
   * Defaults to ":memory:" for an in-memory database.
   */
  path?: string;

  /**
   * Custom table definitions.
   * Defaults to standard TypeGraph table names.
   */
  tables?: SqliteTables;
}>;

/**
 * Result of creating a local SQLite backend.
 */
export type LocalSqliteBackendResult = Readonly<{
  /**
   * The GraphBackend instance for use with createStore.
   */
  backend: GraphBackend;

  /**
   * The underlying Drizzle database instance.
   * Useful for direct SQL access or cleanup.
   */
  db: BetterSQLite3Database;
}>;

// ============================================================
// Factory Function
// ============================================================

/**
 * Creates a SQLite backend with minimal configuration.
 *
 * This is a convenience function for local development and testing.
 * It handles database creation, schema migration, and backend setup.
 *
 * For production deployments or custom configurations, use createSqliteBackend
 * directly with your own Drizzle database instance.
 *
 * @param options - Configuration options
 * @returns Backend and database instances
 *
 * @example In-memory database (default)
 * ```typescript
 * const { backend } = createLocalSqliteBackend();
 * const store = createStore(graph, backend);
 * ```
 *
 * @example File-based database
 * ```typescript
 * const { backend, db } = createLocalSqliteBackend({ path: "./data.db" });
 * const store = createStore(graph, backend);
 * ```
 */
export function createLocalSqliteBackend(
  options: LocalSqliteBackendOptions = {},
): LocalSqliteBackendResult {
  const path = options.path ?? ":memory:";
  const tables = options.tables ?? defaultTables;

  const sqlite = createDatabase(path);
  const db = drizzle(sqlite);

  // Generate and execute DDL from schema
  const ddlStatements = generateSqliteDDL(tables);
  for (const statement of ddlStatements) {
    sqlite.exec(statement);
  }

  const backend = createSqliteBackend(db, {
    executionProfile: {
      isD1: false,
      isSync: true,
    },
    tables,
  });
  let isClosed = false;

  function close(): Promise<void> {
    if (isClosed) return Promise.resolve();
    isClosed = true;
    sqlite.close();
    return Promise.resolve();
  }

  const managedBackend: GraphBackend = { ...backend, close };

  return { backend: managedBackend, db };
}

// ============================================================
// Re-exports
// ============================================================

// Re-export everything from the Drizzle SQLite implementation
export {
  createSqliteBackend,
  createSqliteTables,
  type SqliteBackendOptions,
  type SqliteTableNames,
  type SqliteTables,
  tables,
} from "../drizzle/sqlite";

// Re-export individual tables for schema usage
export {
  edges,
  nodes,
  schemaVersions,
  uniques,
} from "../drizzle/schema/sqlite";

// Re-export migration SQL generation
export {
  generateSqliteDDL,
  getSqliteMigrationSQL,
} from "../drizzle/test-helpers";
