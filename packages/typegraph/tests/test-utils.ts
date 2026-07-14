/**
 * Shared test utilities for TypeGraph tests.
 *
 * Uses createLocalSqliteBackend from the public sqlite module.
 */
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach } from "vitest";

import type { GraphDef } from "../src";
import { createStoreWithSchema, type Store } from "../src";
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

/**
 * Boots a store through the canonical async path
 * (`createStoreWithSchema`) and returns just the `Store`.
 *
 * Post-#135 this is the test idiom for any suite exercising fulltext
 * (or transactions that touch it): `createStoreWithSchema` is the
 * single durable-materialization writer, so a sync `createStore`
 * against an unmaterialized in-memory backend now (correctly) throws
 * `StoreNotInitializedError` on the first fulltext op. Tests that are
 * NOT asserting the init contract use this helper to get an
 * already-initialized store with minimal call-site churn.
 */
export async function createInitializedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<Store<G>> {
  const [store] = await createStoreWithSchema(graph, backend);
  return store;
}

/**
 * Wraps a real backend so any unconditional `transaction(...)` rejects and it
 * reports `capabilities.transactions: false` — the shape of
 * `drizzle-orm/neon-http` and Cloudflare D1. Use it to exercise the
 * non-transactional sequential fall-through.
 */
export function disableTransactions(backend: GraphBackend): GraphBackend {
  return {
    ...backend,
    capabilities: { ...backend.capabilities, transactions: false },
    transaction: () =>
      Promise.reject(new Error("synthetic backend has transactions disabled")),
  };
}

export { generateSqliteDDL } from "../src/backend/drizzle/ddl";

/**
 * Flattens all edges from a subgraph adjacency map into a single array.
 */
export function collectAllEdges<E>(
  adjacency: ReadonlyMap<string, ReadonlyMap<string, readonly E[]>>,
): E[] {
  const edges: E[] = [];
  for (const kindMap of adjacency.values()) {
    for (const edgeList of kindMap.values()) {
      edges.push(...edgeList);
    }
  }
  return edges;
}

/**
 * Shared time anchors for temporal-behavior tests.
 *
 * Use these to build fixtures that exercise `temporalMode` / `asOf` across
 * the store. Spacing between anchors is intentional so individual tests can
 * assert snapshot boundaries without coordinating timestamps.
 */
export const TEMPORAL_ANCHORS = {
  PAST: "2020-01-01T00:00:00.000Z",
  BEFORE: "2021-01-01T00:00:00.000Z",
  EDGE_ENDED: "2022-01-01T00:00:00.000Z",
  FUTURE: "2030-01-01T00:00:00.000Z",
} as const;
