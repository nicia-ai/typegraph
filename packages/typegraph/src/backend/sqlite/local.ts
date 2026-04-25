/**
 * Local SQLite backend using better-sqlite3.
 *
 * This module depends on the `better-sqlite3` native addon and should only
 * be imported in Node.js environments. For bundler-friendly SQLite DDL
 * generation and Drizzle backend creation, import from `@nicia-ai/typegraph/sqlite`.
 *
 * @example In-memory database (default)
 * ```typescript
 * import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
 *
 * const { backend, db } = createLocalSqliteBackend();
 * const store = createStore(graph, backend);
 * ```
 *
 * @example File-based database for persistent local development
 * ```typescript
 * import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
 *
 * const { backend, db } = createLocalSqliteBackend({ path: "./dev.db" });
 * const store = createStore(graph, backend);
 * ```
 */
import { createRequire } from "node:module";

import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";

import { ConfigurationError } from "../../errors";
import { generateSqliteDDL } from "../drizzle/ddl";
import {
  createSqliteBackend,
  type SqliteTables,
  tables as defaultTables,
} from "../drizzle/sqlite";
import { type GraphBackend, wrapWithManagedClose } from "../types";

const nodeRequire = createRequire(import.meta.url);

// ============================================================
// Native Addon Helpers
// ============================================================

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

  // Best-effort: load sqlite-vec so embedding fields are persisted to the
  // embeddings table. Without it, nodes with `embedding()` fields validate
  // and insert but their vectors are silently dropped. When the user has
  // installed sqlite-vec as a peer dep we load it; otherwise we proceed
  // without vector support.
  const hasVectorEmbeddings = tryLoadSqliteVec(sqlite);

  const db = drizzle(sqlite);

  // Generate and execute DDL from schema
  const ddlStatements = generateSqliteDDL(tables);
  for (const statement of ddlStatements) {
    sqlite.exec(statement);
  }

  const backend = createSqliteBackend(db, {
    executionProfile: {
      isSync: true,
    },
    tables,
    hasVectorEmbeddings,
  });
  const managedBackend = wrapWithManagedClose(backend, () => {
    sqlite.close();
  });

  return { backend: managedBackend, db };
}

function tryLoadSqliteVec(sqlite: Database.Database): boolean {
  try {
    // `sqlite-vec` is an optional peer dep; resolved via createRequire so
    // bundlers don't mark it as a hard import. Node resolves the package
    // only when it's actually installed.
    const module_: unknown = nodeRequire("sqlite-vec");
    if (
      typeof module_ === "object" &&
      module_ !== null &&
      "load" in module_ &&
      typeof module_.load === "function"
    ) {
      (module_ as { load: (db: Database.Database) => void }).load(sqlite);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
