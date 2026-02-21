/**
 * Shared test utilities for TypeGraph tests.
 *
 * Uses createLocalSqliteBackend from the public sqlite module.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach } from "vitest";

import type { SqliteTables } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";

const backendsToClose: GraphBackend[] = [];

async function closeCreatedTestBackends(): Promise<void> {
  const current = backendsToClose.splice(0);
  await Promise.all(current.map((backend) => backend.close()));
}

afterEach(closeCreatedTestBackends);

/**
 * Creates a GraphBackend using in-memory SQLite.
 * This is the primary way to create backends for testing.
 */
export function createTestBackend(customTables?: SqliteTables): GraphBackend {
  const options = customTables ? { tables: customTables } : {};
  const { backend } = createLocalSqliteBackend(options);
  backendsToClose.push(backend);
  return backend;
}

/**
 * Creates an in-memory SQLite database with TypeGraph tables.
 * Use this when you need direct database access in tests.
 */
export function createTestDatabase(
  customTables?: SqliteTables,
): BetterSQLite3Database {
  const options = customTables ? { tables: customTables } : {};
  const { backend, db } = createLocalSqliteBackend(options);
  backendsToClose.push(backend);
  return db;
}

export { generateSqliteDDL } from "../src/backend/drizzle/ddl";
