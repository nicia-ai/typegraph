/**
 * Local SQLite backend using better-sqlite3.
 *
 * This module depends on the `better-sqlite3` native addon and should only
 * be imported in Node.js environments. For bundler-friendly SQLite DDL
 * generation and Drizzle backend creation, import from `@nicia-ai/typegraph/adapters/drizzle/sqlite`.
 *
 * @example In-memory database (default)
 * ```typescript
 * import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
 *
 * const { backend, db } = createLocalSqliteBackend();
 * const store = createStore(graph, backend);
 * ```
 *
 * @example File-based database for persistent local development
 * ```typescript
 * import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
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
import { sqliteVecStrategy } from "../../query/dialect/vector/sqlite-vec-strategy";
import { generateSqliteDDL } from "../drizzle/ddl";
import { type AnySqliteDatabase } from "../drizzle/execution";
export type { AnySqliteDatabase } from "../drizzle/execution";
import {
  createSqliteBackend,
  type SqliteTables,
  tables as defaultTables,
} from "../drizzle/sqlite";
import {
  DEFAULT_LOCAL_SQLITE_PRAGMAS,
  type LocalSqliteJournalMode,
  type LocalSqlitePragmaOptions,
  type LocalSqliteSynchronousMode,
} from "./local-options";

export {
  DEFAULT_LOCAL_SQLITE_PRAGMAS,
  type LocalSqliteJournalMode,
  type LocalSqlitePragmaOptions,
  type LocalSqliteSynchronousMode,
} from "./local-options";
import {
  type AdapterBackend,
  type BackendCapabilities,
  wrapWithManagedClose,
} from "../types";

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

  const compiled = Number(match.groups["compiled"]);
  const required = Number(match.groups["required"]);

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

const LOCAL_SQLITE_JOURNAL_MODES: readonly LocalSqliteJournalMode[] = [
  "wal",
  "delete",
  "truncate",
  "persist",
  "memory",
  "off",
];

const LOCAL_SQLITE_SYNCHRONOUS_MODES: readonly LocalSqliteSynchronousMode[] = [
  "off",
  "normal",
  "full",
  "extra",
];

const SQLITE_MAX_WAL_AUTOCHECKPOINT_PAGES = 2_147_483_647;

function applyConnectionPragmas(
  sqlite: Database.Database,
  pragmas: LocalSqlitePragmaOptions | false | undefined,
): void {
  if (pragmas === false) return;
  const resolved: Required<LocalSqlitePragmaOptions> = {
    ...DEFAULT_LOCAL_SQLITE_PRAGMAS,
    ...pragmas,
  };

  // Runtime guards mirror the compile-time unions: pragma values are spliced
  // into pragma statements, so reject anything outside the allowlists rather
  // than forwarding it to SQLite.
  if (!LOCAL_SQLITE_JOURNAL_MODES.includes(resolved.journalMode)) {
    throw new ConfigurationError(
      `Invalid journalMode pragma: ${resolved.journalMode}. ` +
        `Expected one of: ${LOCAL_SQLITE_JOURNAL_MODES.join(", ")}.`,
      { journalMode: resolved.journalMode },
    );
  }
  if (!LOCAL_SQLITE_SYNCHRONOUS_MODES.includes(resolved.synchronous)) {
    throw new ConfigurationError(
      `Invalid synchronous pragma: ${resolved.synchronous}. ` +
        `Expected one of: ${LOCAL_SQLITE_SYNCHRONOUS_MODES.join(", ")}.`,
      { synchronous: resolved.synchronous },
    );
  }
  if (
    !Number.isSafeInteger(resolved.busyTimeoutMs) ||
    resolved.busyTimeoutMs < 0
  ) {
    throw new ConfigurationError(
      `Invalid busyTimeoutMs pragma: ${String(resolved.busyTimeoutMs)}. ` +
        "Expected a non-negative integer number of milliseconds.",
      { busyTimeoutMs: resolved.busyTimeoutMs },
    );
  }
  if (
    resolved.cacheSizeKib !== undefined &&
    (!Number.isSafeInteger(resolved.cacheSizeKib) || resolved.cacheSizeKib >= 0)
  ) {
    throw new ConfigurationError(
      `Invalid cacheSizeKib pragma: ${String(resolved.cacheSizeKib)}. ` +
        "Expected a negative safe integer — SQLite's own cache_size pragma " +
        "interprets a positive value as a page count, not KiB, so a caller " +
        'who passes e.g. 131072 meaning "131072 KiB" silently gets ' +
        "131072 pages (~512MiB at the default 4KiB page size) instead.",
      { cacheSizeKib: resolved.cacheSizeKib },
    );
  }
  if (
    resolved.mmapSizeBytes !== undefined &&
    (!Number.isSafeInteger(resolved.mmapSizeBytes) ||
      resolved.mmapSizeBytes < 0)
  ) {
    throw new ConfigurationError(
      `Invalid mmapSizeBytes pragma: ${String(resolved.mmapSizeBytes)}. ` +
        "Expected a non-negative safe integer number of bytes.",
      { mmapSizeBytes: resolved.mmapSizeBytes },
    );
  }
  if (
    resolved.walAutocheckpointPages !== undefined &&
    (!Number.isSafeInteger(resolved.walAutocheckpointPages) ||
      resolved.walAutocheckpointPages < 0 ||
      resolved.walAutocheckpointPages > SQLITE_MAX_WAL_AUTOCHECKPOINT_PAGES)
  ) {
    throw new ConfigurationError(
      `Invalid walAutocheckpointPages pragma: ${String(resolved.walAutocheckpointPages)}. ` +
        `Expected an integer between 0 and ${SQLITE_MAX_WAL_AUTOCHECKPOINT_PAGES} ` +
        "WAL pages (0 disables automatic checkpointing entirely).",
      { walAutocheckpointPages: resolved.walAutocheckpointPages },
    );
  }

  // ":memory:" databases always journal in memory; SQLite answers the WAL
  // request with "memory" instead of erroring, so no special-casing needed.
  sqlite.pragma(`journal_mode = ${resolved.journalMode}`);
  sqlite.pragma(`synchronous = ${resolved.synchronous}`);
  sqlite.pragma(`busy_timeout = ${resolved.busyTimeoutMs}`);
  if (resolved.cacheSizeKib !== undefined) {
    sqlite.pragma(`cache_size = ${resolved.cacheSizeKib}`);
  }
  if (resolved.mmapSizeBytes !== undefined) {
    sqlite.pragma(`mmap_size = ${resolved.mmapSizeBytes}`);
  }
  if (resolved.walAutocheckpointPages !== undefined) {
    sqlite.pragma(`wal_autocheckpoint = ${resolved.walAutocheckpointPages}`);
  }
}

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
   * Connection pragmas applied at open. Defaults to
   * {@link DEFAULT_LOCAL_SQLITE_PRAGMAS} (WAL, `synchronous=NORMAL`, 5s busy
   * timeout, and SQLite's own tiny built-in page cache / disabled mmap
   * left untouched). Individual values merge over the defaults; pass
   * `false` to skip pragma configuration entirely and keep the driver
   * defaults (rollback journal, `synchronous=FULL`, and better-sqlite3's
   * own 5s busy timeout from its `timeout` constructor option). Set
   * `cacheSizeKib`/`mmapSizeBytes` explicitly once a database's working
   * set is known to exceed SQLite's 2MiB default cache — otherwise every
   * query pays a fresh disk read per page past that tiny working set. Set
   * `walAutocheckpointPages` explicitly for a bulk-insert-heavy workload —
   * SQLite's own default checkpoints every ~4MiB of WAL growth, which gets
   * more expensive as the database file grows over a large load.
   */
  pragmas?: LocalSqlitePragmaOptions | false;

  /**
   * Custom table definitions.
   * Defaults to standard TypeGraph table names.
   */
  tables?: SqliteTables;

  /**
   * Override specific backend capabilities — e.g. to simulate an engine-level
   * gap like missing SQL window functions in tests. Forwarded to
   * createSqliteBackend.
   */
  capabilities?: Partial<BackendCapabilities>;
}>;

/**
 * Result of creating a local SQLite backend.
 */
export type LocalSqliteBackendResult = Readonly<{
  /**
   * The GraphBackend instance for use with createStore.
   */
  backend: AdapterBackend<AnySqliteDatabase>;

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
  try {
    applyConnectionPragmas(sqlite, options.pragmas);

    // Best-effort: load sqlite-vec so embedding fields are persisted to
    // per-`(kind, field)` `vec0` storage. Without it, nodes with
    // `embedding()` fields validate and insert but their vectors are silently
    // dropped. When the user has installed sqlite-vec as a peer dep we load
    // it and wire the strategy; otherwise we proceed without vector support.
    const hasSqliteVec = tryLoadSqliteVec(sqlite);

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
      ...(hasSqliteVec ? { vector: sqliteVecStrategy } : {}),
      capabilities: {
        ...options.capabilities,
        graphAnalytics: {
          supported:
            options.capabilities?.graphAnalytics?.supported ??
            options.capabilities?.transactions !== false,
          mathFunctions:
            options.capabilities?.graphAnalytics?.mathFunctions ?? true,
        },
      },
    });
    const managedBackend = wrapWithManagedClose(backend, () => {
      sqlite.close();
    });

    return { backend: managedBackend, db };
  } catch (error) {
    try {
      sqlite.close();
    } catch {
      // Preserve the provisioning error; a cleanup failure is secondary.
    }
    throw error;
  }
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
