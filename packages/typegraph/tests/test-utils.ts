/**
 * Shared test utilities for TypeGraph tests.
 *
 * Uses createLocalSqliteBackend from the public sqlite module.
 */
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { afterEach, expect } from "vitest";

import type { GraphDef, Store } from "../src";
import {
  type AdapterStore,
  createAdapterStoreWithSchema,
  createStoreWithSchema,
} from "../src";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution";
import type { SqliteTables } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { AdapterBackend, GraphBackend } from "../src/backend/types";
import {
  createRecordedInstant,
  type RecordedInstant,
  recordedInstantRevision,
} from "../src/core/temporal";
import { requireDefined } from "../src/utils/presence";

const backendsToClose: GraphBackend[] = [];

export function recordedRevisionFromDriver(value: unknown): number {
  const revision =
    typeof value === "bigint" ? Number(value)
    : typeof value === "string" ? Number(value)
    : value;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision)) {
    throw new TypeError(
      `Expected a safe recorded revision, got ${String(value)}`,
    );
  }
  return revision;
}

export function recordedWallTimeFromDriver(value: unknown): string {
  const date =
    value instanceof Date ? value
    : typeof value === "string" ? new Date(value)
    : undefined;
  if (date === undefined || Number.isNaN(date.getTime())) {
    throw new Error(`Expected a recorded wall time, got ${String(value)}`);
  }
  return date.toISOString();
}

export function recordedInstantFromDriver(
  revision: unknown,
  recordedAt: unknown,
): RecordedInstant {
  return createRecordedInstant(
    recordedRevisionFromDriver(revision),
    recordedWallTimeFromDriver(recordedAt),
  );
}

async function closeCreatedTestBackends(): Promise<void> {
  const current = backendsToClose.splice(0);
  await Promise.all(current.map((backend) => backend.close()));
}

afterEach(closeCreatedTestBackends);

/**
 * Creates a GraphBackend using in-memory SQLite.
 * This is the primary way to create backends for testing.
 */
export function createTestBackend(
  customTables?: SqliteTables,
): AdapterBackend<AnySqliteDatabase> {
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
export function createInitializedStore<G extends GraphDef, TNativeTransaction>(
  graph: G,
  backend: AdapterBackend<TNativeTransaction>,
): Promise<AdapterStore<G, TNativeTransaction>>;
export function createInitializedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<Store<G>>;
export async function createInitializedStore<G extends GraphDef>(
  graph: G,
  backend: GraphBackend,
): Promise<Store<G>> {
  if (isAdapterBackend(backend)) {
    const [store] = await createAdapterStoreWithSchema(graph, backend);
    return store;
  }
  const [store] = await createStoreWithSchema(graph, backend);
  return store;
}

function isAdapterBackend(
  backend: GraphBackend,
): backend is AdapterBackend<unknown> {
  return (
    typeof Reflect.get(backend, "transactionWithNative") === "function" &&
    typeof Reflect.get(backend, "adoptTransaction") === "function"
  );
}

export type CapturedStatement = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

export type PlanCaptureHarness = Readonly<{
  /** Pass to createStore/createStoreWithSchema; auto-closed after the test. */
  backend: GraphBackend;
  /** Every executed statement, in order. Reset with `captured.length = 0`. */
  captured: CapturedStatement[];
  /** Raw better-sqlite3 client, for EXPLAIN QUERY PLAN. */
  client: Database.Database;
}>;

/**
 * An in-memory SQLite backend that captures every executed statement so a
 * test can assert its actual query plan — the "index exists but the
 * planner won't use it" failure class that DDL-presence assertions can't
 * catch. Pair with {@link explainQueryPlan}:
 *
 * ```ts
 * const { backend, captured, client } = createPlanCaptureBackend();
 * const store = createStore(graph, backend);
 * // ... seed data, refreshStatistics() ...
 * captured.length = 0;
 * await store.algorithms.degree(node.id);
 * const plan = explainQueryPlan(client, captured.at(-1)!);
 * expect(plan).toContain("my_expected_idx");
 * expect(plan).not.toContain("SCAN typegraph_nodes");
 * ```
 */
export function createPlanCaptureBackend(): PlanCaptureHarness {
  const { backend: raw, db } = createLocalSqliteBackend();
  const captured: CapturedStatement[] = [];
  const backend: GraphBackend = {
    ...raw,
    async execute(query) {
      const compiled = raw.compileSql?.(query);
      if (compiled) {
        captured.push({ sql: compiled.sql, params: compiled.params });
      }
      return raw.execute(query);
    },
    // Reads run through the cached-template fast path (executeRaw), which
    // receives SQL text with all placeholders already filled — directly
    // EXPLAIN-able.
    async executeRaw<T>(sqlText: string, params: readonly unknown[]) {
      captured.push({ sql: sqlText, params });
      return requireDefined(raw.executeRaw)<T>(sqlText, params);
    },
  };
  backendsToClose.push(raw);
  const client = (db as unknown as { $client: Database.Database }).$client;
  return { backend, captured, client };
}

/**
 * The `EXPLAIN QUERY PLAN` detail lines for a captured statement, joined
 * with newlines — assert index usage with `toContain("<index name>")` and
 * scan absence with `not.toContain("SCAN <table>")`.
 */
export function explainQueryPlan(
  client: Database.Database,
  statement: CapturedStatement,
): string {
  const rows = client
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...statement.params) as readonly { detail: string }[];
  return rows.map((row) => row.detail).join("\n");
}

/**
 * Wraps a real backend so any unconditional `transaction(...)` rejects and it
 * reports `capabilities.transactions: false` — the shape of
 * `drizzle-orm/neon-http` and Cloudflare D1. Use it to exercise the
 * non-transactional sequential fall-through.
 */
export function disableTransactions<TNativeTransaction>(
  backend: AdapterBackend<TNativeTransaction>,
): AdapterBackend<TNativeTransaction>;
export function disableTransactions(backend: GraphBackend): GraphBackend;
export function disableTransactions(backend: GraphBackend): GraphBackend {
  return {
    ...backend,
    capabilities: { ...backend.capabilities, transactions: false },
    transaction: () =>
      Promise.reject(new Error("synthetic backend has transactions disabled")),
    ...("transactionWithNative" in backend ?
      {
        transactionWithNative: () =>
          Promise.reject(
            new Error("synthetic backend has transactions disabled"),
          ),
      }
    : {}),
  };
}

export { generateSqliteDDL } from "../src/backend/drizzle/ddl";
export { storeBackend as getStoreBackend } from "../src/store/runtime-port";

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

/**
 * How many recorded revisions elapsed between two anchors. Recorded order is a
 * logical revision, independent of wall time, so a "advanced exactly once"
 * assertion needs no clock control.
 */
export function revisionsAdvanced(
  before: RecordedInstant | undefined,
  after: RecordedInstant | undefined,
): number {
  return (
    recordedInstantRevision(requireDefined(after, "after anchor")) -
    recordedInstantRevision(requireDefined(before, "before anchor"))
  );
}

/**
 * Wraps a nested asymmetric matcher so it enters an object literal as `unknown`
 * rather than `any`, keeping the surrounding assertion type-checked. Vitest
 * types `expect.objectContaining` as `any`, which would otherwise silently
 * disable checking of the whole expected shape.
 */
export function matchingObject(shape: Record<string, unknown>): unknown {
  return expect.objectContaining(shape);
}

/** Array counterpart of {@link matchingObject}. */
export function matchingArray(items: unknown[]): unknown {
  return expect.arrayContaining(items);
}
