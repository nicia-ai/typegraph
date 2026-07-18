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

import { libsqlVectorStrategy } from "../../query/dialect/vector/libsql-strategy";
import { generateSqliteDDL } from "../drizzle/ddl";
import { type AnySqliteDatabase } from "../drizzle/execution";
export type { AnySqliteDatabase } from "../drizzle/execution";
import {
  createSqliteBackend,
  type SqliteTables,
  tables as defaultTables,
} from "../drizzle/sqlite";
import type { AdapterBackend } from "../types";

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
 * `:memory:` databases) run transactions as raw BEGIN/COMMIT statements on
 * the client's single stable connection (`transactionMode: "sql"`):
 * `client.transaction()` permanently hands that connection to the
 * transaction and lazily opens a fresh one afterwards, which for an
 * in-memory database is a fresh, empty database. Remote clients (`http` /
 * `ws`) run each transaction on its own stream via Drizzle's
 * `db.transaction()` (`transactionMode: "drizzle"`). The caller retains
 * ownership of the client and is responsible for closing it.
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

  const ddlStatements = generateSqliteDDL(tables);
  await client.executeMultiple(ddlStatements.join(";\n"));

  const backend = createSqliteBackend(db, {
    executionProfile: {
      isSync: false,
      transactionMode: client.protocol === "file" ? "sql" : "drizzle",
    },
    tables,
    // libSQL ships native vector search in core — no extension to load —
    // so the strategy is wired unconditionally.
    vector: libsqlVectorStrategy,
  });

  return { backend, db };
}
