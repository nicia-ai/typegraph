/**
 * Automatic planner-statistics refresh after bulk maintenance verbs.
 *
 * Fresh bulk loads and freshly created indexes run against stale planner
 * statistics until ANALYZE runs (documented regressions: 0.5ms → 5ms
 * traversals on Postgres, 0.9ms → 23ms fulltext on SQLite), so
 * `importGraph` and `materializeIndexes` refresh statistics by default.
 *
 * On SQLite, ANALYZE creates the `sqlite_stat1` table on first run — its
 * existence is the observable "statistics were refreshed" signal, since
 * backend bootstrap never runs ANALYZE on its own.
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../src/backend/sqlite/local";
import { defineNodeIndex } from "../src/indexes";
import {
  exportGraph,
  importGraph,
  ImportOptionsSchema,
} from "../src/interchange";
import { createStore, createStoreWithSchema } from "../src/store/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

function buildGraph() {
  return defineGraph({
    id: "stats-refresh",
    nodes: { Person: { type: Person } },
    edges: {},
  });
}

function buildIndexedGraph() {
  const personEmail = defineNodeIndex(Person, { fields: ["email"] });
  return defineGraph({
    id: "stats-refresh-indexed",
    nodes: { Person: { type: Person } },
    edges: {},
    indexes: [personEmail],
  });
}

function hasStatisticsTable(result: LocalSqliteBackendResult): boolean {
  const rows = result.db.all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'`,
  );
  return rows.length > 0;
}

async function buildExportedData() {
  const source = createLocalSqliteBackend();
  try {
    const sourceStore = createStore(buildGraph(), source.backend);
    await sourceStore.nodes.Person.create({
      name: "Ada",
      email: "ada@example.com",
    });
    await sourceStore.nodes.Person.create({
      name: "Grace",
      email: "grace@example.com",
    });
    return await exportGraph(sourceStore);
  } finally {
    await source.backend.close();
  }
}

describe("importGraph statistics refresh", () => {
  it("refreshes statistics by default after a mutating import", async () => {
    const target = createLocalSqliteBackend();
    try {
      const store = createStore(buildGraph(), target.backend);
      const data = await buildExportedData();

      const result = await importGraph(
        store,
        data,
        ImportOptionsSchema.parse({ onConflict: "skip" }),
      );

      expect(result.nodes.created).toBe(2);
      expect(hasStatisticsTable(target)).toBe(true);
    } finally {
      await target.backend.close();
    }
  });

  it("skips the refresh with refreshStatistics: false", async () => {
    const target = createLocalSqliteBackend();
    try {
      const store = createStore(buildGraph(), target.backend);
      const data = await buildExportedData();

      const result = await importGraph(store, data, {
        ...ImportOptionsSchema.parse({ onConflict: "skip" }),
        refreshStatistics: false,
      });

      expect(result.nodes.created).toBe(2);
      expect(hasStatisticsTable(target)).toBe(false);
    } finally {
      await target.backend.close();
    }
  });

  it("skips the refresh when the import mutated nothing", async () => {
    const empty = createLocalSqliteBackend();
    const target = createLocalSqliteBackend();
    try {
      const emptyExport = await exportGraph(
        createStore(buildGraph(), empty.backend),
      );
      const store = createStore(buildGraph(), target.backend);

      const result = await importGraph(
        store,
        emptyExport,
        ImportOptionsSchema.parse({ onConflict: "skip" }),
      );

      expect(result.nodes.created).toBe(0);
      expect(hasStatisticsTable(target)).toBe(false);
    } finally {
      await empty.backend.close();
      await target.backend.close();
    }
  });
});

describe("materializeIndexes statistics refresh", () => {
  it("refreshes statistics by default after creating indexes", async () => {
    const target = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildIndexedGraph(),
        target.backend,
      );

      const result = await store.materializeIndexes();

      expect(result.results.some((entry) => entry.status === "created")).toBe(
        true,
      );
      expect(hasStatisticsTable(target)).toBe(true);
    } finally {
      await target.backend.close();
    }
  });

  it("skips the refresh with refreshStatistics: false", async () => {
    const target = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildIndexedGraph(),
        target.backend,
      );

      await store.materializeIndexes({ refreshStatistics: false });

      expect(hasStatisticsTable(target)).toBe(false);
    } finally {
      await target.backend.close();
    }
  });

  it("skips the refresh when nothing new was created", async () => {
    const target = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildIndexedGraph(),
        target.backend,
      );

      await store.materializeIndexes({ refreshStatistics: false });
      // Second call finds everything alreadyMaterialized — no fresh DDL, so
      // the default refresh must not fire either.
      const second = await store.materializeIndexes();

      expect(
        second.results.every((entry) => entry.status === "alreadyMaterialized"),
      ).toBe(true);
      expect(hasStatisticsTable(target)).toBe(false);
    } finally {
      await target.backend.close();
    }
  });
});
