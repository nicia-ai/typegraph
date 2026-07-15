/**
 * `refreshStatistics()` scope and cost bound on the SQLite backend.
 *
 * A bare, unscoped `ANALYZE` (no table argument) does two things wrong at
 * bulk-load scale: it re-analyzes every table in the database file, not
 * just TypeGraph's own (the Postgres backend already scopes to its own
 * tables); and it does a full, unbounded table/index scan per call, unlike
 * Postgres's `ANALYZE`, which always samples a fixed-size set of rows
 * regardless of table size. A caller streaming a bulk load through
 * repeated `bulkInsert()` calls — the only practical pattern for a
 * multi-million-row load — re-triggers `refreshStatistics()` on every
 * batch once that batch's row count crosses
 * `AUTO_REFRESH_STATISTICS_ROW_THRESHOLD`; with unbounded per-call cost
 * growing with total table size, total load time integrated to O(n²)
 * (observed: a 2M-row bulk load that never finished after 4.5+ hours).
 * These tests pin the two fixes: scoping and `PRAGMA analysis_limit`.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import { SQLITE_ANALYZE_ROW_LIMIT } from "../../../src/backend/drizzle/sqlite";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../../../src/backend/sqlite/local";

const Item = defineNode("Item", {
  schema: z.object({ name: z.string() }),
});
const relates = defineEdge("relates", { schema: z.object({}) });

function buildGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: { Item: { type: Item } },
    edges: { relates: { type: relates, from: [Item], to: [Item] } },
  });
}

function rawClient(result: LocalSqliteBackendResult): Database.Database {
  // Drizzle attaches the raw better-sqlite3 handle as `$client` at runtime;
  // the published type omits it (same access pattern as
  // local-pragma-defaults.test.ts).
  return (result.db as unknown as { $client: Database.Database }).$client;
}

function analyzedTableNames(result: LocalSqliteBackendResult): string[] {
  const rows = rawClient(result)
    .prepare("SELECT DISTINCT tbl FROM sqlite_stat1")
    .all() as { tbl: string }[];
  return rows.map((row) => row.tbl);
}

describe("SQLite refreshStatistics scope and cost bound", () => {
  it("bounds ANALYZE cost via PRAGMA analysis_limit", async () => {
    const result = createLocalSqliteBackend();
    try {
      const store = createStore(buildGraph("scope_limit"), result.backend);
      await store.nodes.Item.create({ name: "seed" });

      await store.refreshStatistics();

      const analysisLimit = rawClient(result).pragma("analysis_limit", {
        simple: true,
      });
      expect(analysisLimit).toBe(SQLITE_ANALYZE_ROW_LIMIT);
    } finally {
      await result.backend.close();
    }
  });

  it("scopes ANALYZE to TypeGraph-managed tables, not the whole database file", async () => {
    const result = createLocalSqliteBackend();
    try {
      const store = createStore(buildGraph("scope_isolation"), result.backend);
      await store.nodes.Item.create({ name: "seed" });

      // An application table sharing the same SQLite file/connection — a
      // bare `ANALYZE` would have picked this up too.
      rawClient(result).exec(
        "CREATE TABLE app_unrelated_table (id INTEGER PRIMARY KEY, value TEXT)",
      );
      rawClient(result).exec(
        "INSERT INTO app_unrelated_table (value) VALUES ('x')",
      );

      await store.refreshStatistics();

      const analyzed = analyzedTableNames(result);
      expect(analyzed).toContain("typegraph_nodes");
      expect(analyzed).not.toContain("app_unrelated_table");
    } finally {
      await result.backend.close();
    }
  });

  it("does not throw when recorded-time tables are absent", async () => {
    // Plain createStore (no createStoreWithSchema, no recorded-time
    // history engaged) never creates the recorded_* relations — this is
    // the ordinary shape for most graphs, not an edge case.
    const result = createLocalSqliteBackend();
    try {
      const store = createStore(
        buildGraph("scope_no_recorded"),
        result.backend,
      );
      await store.nodes.Item.create({ name: "seed" });

      await expect(store.refreshStatistics()).resolves.toBeUndefined();
    } finally {
      await result.backend.close();
    }
  });

  it("does not throw when identity tables are absent (pre-Operational-Identity schema)", async () => {
    // A bring-your-own-connection schema created before Operational Identity
    // landed has no identity_* tables. refreshStatistics() must tolerate
    // their absence the same way it tolerates missing recorded_* tables —
    // ANALYZE of the identity relations runs under the missing-table guard,
    // not the unguarded core set. This is an upgrade regression that affects
    // identity-DISABLED graphs too, so the graph here has no identity config.
    const result = createLocalSqliteBackend();
    try {
      const store = createStore(
        buildGraph("scope_no_identity"),
        result.backend,
      );
      await store.nodes.Item.create({ name: "seed" });

      // Simulate the pre-identity schema by dropping the three identity
      // relations createLocalSqliteBackend bootstrapped.
      for (const table of [
        "typegraph_identity_assertions",
        "typegraph_recorded_identity_assertions",
        "typegraph_identity_closure",
      ]) {
        rawClient(result).exec(`DROP TABLE IF EXISTS ${table}`);
      }

      await expect(store.refreshStatistics()).resolves.toBeUndefined();
    } finally {
      await result.backend.close();
    }
  });

  it("keeps repeated large-batch bulkInsert cheap as the table grows", async () => {
    // The actual regression shape: a streaming loader batches bulkInsert
    // calls, each already over AUTO_REFRESH_STATISTICS_ROW_THRESHOLD, so
    // every batch re-triggers refreshStatistics(). Before the fix, each
    // call's unbounded ANALYZE grew with cumulative table size, so batch
    // time grew roughly linearly across the loop (observed ~5x from the
    // first batch to the 30th at 58k cumulative rows). This asserts the
    // last batch is not dramatically slower than the first — a loose
    // bound (not a strict performance assertion, which would be flaky in
    // CI) that would fail fast under the old unbounded-scan behavior.
    const result = createLocalSqliteBackend();
    try {
      const store = createStore(
        buildGraph("scope_batch_growth"),
        result.backend,
      );
      const batchSize = 1500; // over AUTO_REFRESH_STATISTICS_ROW_THRESHOLD (1000)
      const batchCount = 20;
      const batchTimesMs: number[] = [];

      for (let batch = 0; batch < batchCount; batch += 1) {
        const items = Array.from({ length: batchSize }, (_, index) => ({
          props: { name: `item-${batch}-${index}` },
        }));
        const started = performance.now();
        await store.nodes.Item.bulkInsert(items);
        batchTimesMs.push(performance.now() - started);
      }

      const first5Avg =
        batchTimesMs.slice(0, 5).reduce((sum, value) => sum + value, 0) / 5;
      const last5Avg =
        batchTimesMs.slice(-5).reduce((sum, value) => sum + value, 0) / 5;
      // Some growth is expected (B-tree depth, WAL size) — this bounds it
      // well under the ~5x-per-58k-rows trend the unscoped, unbounded
      // ANALYZE produced.
      expect(last5Avg).toBeLessThan(first5Avg * 3);
    } finally {
      await result.backend.close();
    }
  });
});
