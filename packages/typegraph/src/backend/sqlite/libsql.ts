/**
 * libsql backend for TypeGraph.
 *
 * This module wraps `@libsql/client` with the correct execution profile
 * for use with TypeGraph. It is compatible with any `@libsql/client`
 * instance (local file, remote Turso, embedded replicas).
 *
 * @example In-memory database
 * ```typescript
 * import { createClient } from "@libsql/client";
 * import { createLibsqlBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql";
 *
 * const client = createClient({ url: "file::memory:" });
 * const { backend } = await createLibsqlBackend(client);
 * const store = createStore(graph, backend);
 * ```
 *
 * @example Remote Turso database
 * ```typescript
 * import { createClient } from "@libsql/client";
 * import { createLibsqlBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql";
 *
 * const client = createClient({ url: "libsql://my-db.turso.io", authToken: "..." });
 * const { backend } = await createLibsqlBackend(client);
 * const store = createStore(graph, backend);
 * ```
 */
import type { Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import { BaseSchemaMigrationError } from "../../errors";
import { libsqlVectorStrategy } from "../../query/dialect/vector/libsql-strategy";
import { requireDefined } from "../../utils/presence";
import { isSqliteMissingEdgeMatchIdentityColumnError } from "../../utils/sql-errors";
import { generateSqliteMigrationSQL } from "../drizzle/ddl";
import { type AnySqliteDatabase } from "../drizzle/execution";
export type { AnySqliteDatabase } from "../drizzle/execution";
import {
  createSqliteBackend,
  isLocalLibsqlClient,
  type SqliteTables,
  tables as defaultTables,
} from "../drizzle/sqlite";
import type { AdapterBackend } from "../types";

export type {
  ContributionDiagnostic,
  ContributionDiagnosticState,
  ContributionRepairEntry,
  ContributionRepairResult,
} from "../types";

async function installLibsqlBaseSchema(
  client: Client,
  tables: SqliteTables,
  backend: AdapterBackend<AnySqliteDatabase>,
): Promise<void> {
  const installationSql = generateSqliteMigrationSQL(tables);
  try {
    await client.executeMultiple(installationSql);
    await requireDefined(backend.assertBaseSchemaCurrent)();
  } catch (error) {
    const requiresLifecycleAdoption =
      isSqliteMissingEdgeMatchIdentityColumnError(error) ||
      (error instanceof BaseSchemaMigrationError &&
        error.details.reason !== "newer");
    if (!requiresLifecycleAdoption) throw error;
    // The fast script is fresh-installation DDL, not an upgrade planner. A
    // legacy or stale database must re-enter the numbered lifecycle so future
    // releases cannot be stamped without every missing adoption step. The
    // marker-error arm is intentionally dormant at v1: it becomes reachable
    // when a later release can observe a missing or stale older marker.
    await requireDefined(backend.bootstrapTables)();
  }
}

// ============================================================
// Types
// ============================================================

/**
 * Options for creating a libsql backend.
 */
export type LibsqlBackendOptions = Readonly<{
  /**
   * Custom table definitions.
   * Defaults to standard TypeGraph table names.
   */
  tables?: SqliteTables;
}>;

/**
 * Result of creating a libsql backend.
 */
export type LibsqlBackendResult = Readonly<{
  /**
   * The GraphBackend instance for use with createStore.
   */
  backend: AdapterBackend<AnySqliteDatabase>;

  /**
   * The underlying Drizzle database instance.
   * Useful for direct SQL access or sharing the connection.
   */
  db: LibSQLDatabase;
}>;

// ============================================================
// Factory Function
// ============================================================

/**
 * Creates a TypeGraph backend backed by `@libsql/client`.
 *
 * Handles DDL execution and configures the correct execution profile.
 * Local clients (`client.protocol === "file"`, covering `file:` paths and
 * `:memory:` databases — see `isLocalLibsqlClient`) run transactions as raw
 * BEGIN/COMMIT statements on the client's single stable connection
 * (`transactionMode: "sql"`): `client.transaction()` permanently hands that
 * connection to the transaction and lazily opens a fresh one afterwards, which
 * for an in-memory database is a fresh, empty database. Remote clients (`http` /
 * `ws`) run each transaction on its own stream via Drizzle's
 * `db.transaction()` (`transactionMode: "drizzle"`). The caller retains
 * ownership of the client and is responsible for closing it.
 *
 * Because that single local connection is also what makes a snapshot export and
 * a concurrent write mutually exclusive, `createSqliteBackend` marks the backend
 * with a local client as its serialized transaction resource — so two backends
 * over ONE local client are recognized as one connection by the streaming
 * import guard and the working-copy cloner. Remote clients are deliberately not
 * marked.
 *
 * @param client - An `@libsql/client` Client instance
 * @param options - Configuration options
 * @returns Backend and Drizzle database instances
 *
 * @example
 * ```typescript
 * import { createClient } from "@libsql/client";
 * import { createLibsqlBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/libsql";
 *
 * const client = createClient({ url: "file::memory:" });
 * const { backend } = await createLibsqlBackend(client);
 * ```
 */
export async function createLibsqlBackend(
  client: Client,
  options: LibsqlBackendOptions = {},
): Promise<LibsqlBackendResult> {
  const tables = options.tables ?? defaultTables;
  const db = drizzle(client);
  const backend = createSqliteBackend(db, {
    executionProfile: {
      isSync: false,
      transactionMode: isLocalLibsqlClient(client) ? "sql" : "drizzle",
    },
    tables,
    // libSQL ships native vector search in core — no extension to load —
    // so the strategy is wired unconditionally.
    vector: libsqlVectorStrategy,
  });

  await installLibsqlBaseSchema(client, tables, backend);

  return { backend, db };
}
export type { GraphIdentityConfig } from "../../core/define-graph";
