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
 * import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";
 *
 * const client = createClient({ url: "file::memory:" });
 * const { backend } = await createLibsqlBackend(client);
 * const store = createStore(graph, backend);
 * ```
 *
 * @example Remote Turso database
 * ```typescript
 * import { createClient } from "@libsql/client";
 * import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";
 *
 * const client = createClient({ url: "libsql://my-db.turso.io", authToken: "..." });
 * const { backend } = await createLibsqlBackend(client);
 * const store = createStore(graph, backend);
 * ```
 */
import type { Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import { generateSqliteDDL } from "../drizzle/ddl";
import {
  createSqliteBackend,
  type SqliteTables,
  tables as defaultTables,
} from "../drizzle/sqlite";
import type { GraphBackend } from "../types";

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
  backend: GraphBackend;

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
 * Handles DDL execution and configures the correct execution profile
 * (`isSync: false`, `transactionMode: "drizzle"`). The caller retains
 * ownership of the client and is responsible for closing it.
 *
 * @param client - An `@libsql/client` Client instance
 * @param options - Configuration options
 * @returns Backend and Drizzle database instances
 *
 * @example
 * ```typescript
 * import { createClient } from "@libsql/client";
 * import { createLibsqlBackend } from "@nicia-ai/typegraph/sqlite/libsql";
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

  const ddlStatements = generateSqliteDDL(tables);
  await client.executeMultiple(ddlStatements.join(";\n"));

  const backend = createSqliteBackend(db, {
    executionProfile: {
      isSync: false,
      transactionMode: "drizzle",
    },
    tables,
  });

  return { backend, db };
}
