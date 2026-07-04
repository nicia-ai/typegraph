/**
 * Auto-refresh of planner statistics after large autocommit bulk writes.
 *
 * Stale statistics after a bulk load are a whole class of planner
 * cliffs (25-200x observed): the planner keeps zero-row estimates until
 * ANALYZE runs. Collections therefore refresh statistics automatically
 * when a single autocommit bulkCreate writes at least
 * AUTO_REFRESH_STATISTICS_ROW_THRESHOLD rows. Counted through a backend
 * overlay spying on refreshStatistics.
 *
 * Deliberately NOT auto-refreshed: bulk writes inside a caller-provided
 * transaction (statistics would be collected against a snapshot that
 * cannot see the uncommitted rows; callers refresh after commit).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";

const THRESHOLD = 1000;

const Item = defineNode("Item", {
  schema: z.object({ name: z.string() }),
});
const relates = defineEdge("relates", { schema: z.object({}) });

function buildGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: { Item: { type: Item } },
    edges: {
      relates: { type: relates, from: [Item], to: [Item] },
    },
  });
}

function withRefreshSpy(backend: GraphBackend): {
  backend: GraphBackend;
  refreshCount: () => number;
} {
  let count = 0;
  const spied: GraphBackend = {
    ...backend,
    refreshStatistics: async () => {
      count += 1;
      await backend.refreshStatistics();
    },
  };
  return { backend: spied, refreshCount: () => count };
}

function nodeItems(count: number): { props: { name: string } }[] {
  return Array.from({ length: count }, (_, index) => ({
    props: { name: `item-${index}` },
  }));
}

describe("auto-refresh statistics after bulk writes", () => {
  it("refreshes once after an autocommit bulkCreate at the threshold", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, refreshCount } = withRefreshSpy(rawBackend);
      const [store] = await createStoreWithSchema(
        buildGraph("stats_threshold"),
        backend,
      );

      await store.nodes.Item.bulkCreate(nodeItems(THRESHOLD));
      expect(refreshCount()).toBe(1);
    } finally {
      await rawBackend.close();
    }
  });

  it("does not refresh below the threshold", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, refreshCount } = withRefreshSpy(rawBackend);
      const [store] = await createStoreWithSchema(
        buildGraph("stats_below"),
        backend,
      );

      await store.nodes.Item.bulkCreate(nodeItems(THRESHOLD - 1));
      expect(refreshCount()).toBe(0);
    } finally {
      await rawBackend.close();
    }
  });

  it("refreshes after a bulk edge create at the threshold", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, refreshCount } = withRefreshSpy(rawBackend);
      const [store] = await createStoreWithSchema(
        buildGraph("stats_edges"),
        backend,
      );

      const nodes = await store.nodes.Item.bulkCreate(nodeItems(THRESHOLD));
      expect(refreshCount()).toBe(1);

      const hub = nodes[0];
      if (hub === undefined) throw new Error("seed failed");
      await store.edges.relates.bulkCreate(
        nodes.map((node) => ({
          from: { kind: "Item", id: hub.id },
          to: { kind: "Item", id: node.id },
          props: {},
        })),
      );
      expect(refreshCount()).toBe(2);
    } finally {
      await rawBackend.close();
    }
  });

  it("does not refresh inside a caller-provided transaction", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, refreshCount } = withRefreshSpy(rawBackend);
      const [store] = await createStoreWithSchema(
        buildGraph("stats_txn"),
        backend,
      );

      await store.transaction(async (tx) => {
        await tx.nodes.Item.bulkCreate(nodeItems(THRESHOLD));
      });
      expect(refreshCount()).toBe(0);
    } finally {
      await rawBackend.close();
    }
  });

  it("honors a custom threshold", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, refreshCount } = withRefreshSpy(rawBackend);
      const [store] = await createStoreWithSchema(
        buildGraph("stats_custom"),
        backend,
        { autoRefreshStatistics: 10 },
      );

      await store.nodes.Item.bulkCreate(nodeItems(10));
      expect(refreshCount()).toBe(1);
      await store.nodes.Item.bulkCreate(nodeItems(9));
      expect(refreshCount()).toBe(1);
    } finally {
      await rawBackend.close();
    }
  });

  it("can be disabled entirely", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, refreshCount } = withRefreshSpy(rawBackend);
      const [store] = await createStoreWithSchema(
        buildGraph("stats_off"),
        backend,
        { autoRefreshStatistics: false },
      );

      await store.nodes.Item.bulkCreate(nodeItems(THRESHOLD * 2));
      expect(refreshCount()).toBe(0);
    } finally {
      await rawBackend.close();
    }
  });

  it("a refresh failure does not fail the bulk write", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const failing: GraphBackend = {
        ...rawBackend,
        refreshStatistics: () => Promise.reject(new Error("refresh exploded")),
      };
      const [store] = await createStoreWithSchema(
        buildGraph("stats_failure"),
        failing,
      );

      const created = await store.nodes.Item.bulkCreate(nodeItems(THRESHOLD));
      expect(created).toHaveLength(THRESHOLD);
    } finally {
      await rawBackend.close();
    }
  });
});
