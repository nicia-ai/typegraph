import { performance } from "node:perf_hooks";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";

const GRAPH_ID = "identity_class_page_cost";
const SELECTED_COUNT = 1188;
const OTHER_COUNT = 6521;
const CLUSTERED_SELECTED_COUNT = 1032;
const CLUSTER_COUNT = 8;
const MAX_PAGE_MS = 1500;

const Selected = defineNode("Selected", {
  schema: z.object({}),
});
const Other = defineNode("Other", { schema: z.object({}) });
const graph = defineGraph({
  id: GRAPH_ID,
  nodes: {
    Selected: { type: Selected },
    Other: { type: Other },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

function selectedId(index: number): string {
  return `selected-${String(index).padStart(4, "0")}`;
}

describe("SQLite identity class page cost", () => {
  it("pages a selected kind without repeatedly scanning unrelated nodes", async () => {
    const { backend, db } = createLocalSqliteBackend();
    try {
      const client = (db as unknown as { $client: Database.Database }).$client;
      const insertNode = client.prepare(`
        INSERT INTO typegraph_nodes
          (graph_id, kind, id, props, version, created_at, updated_at)
        VALUES (?, ?, ?, '{}', 1, ?, ?)
      `);
      const insertClosure = client.prepare(`
        INSERT INTO typegraph_identity_closure
          (graph_id, member_kind, member_id, class_kind, class_id)
        VALUES (?, 'Selected', ?, 'Selected', ?)
      `);
      const instant = new Date().toISOString();
      client.transaction(() => {
        for (let index = 0; index < SELECTED_COUNT; index += 1)
          insertNode.run(
            GRAPH_ID,
            "Selected",
            selectedId(index),
            instant,
            instant,
          );
        for (let index = 0; index < OTHER_COUNT; index += 1)
          insertNode.run(GRAPH_ID, "Other", `other-${index}`, instant, instant);
        for (let index = 0; index < CLUSTERED_SELECTED_COUNT; index += 1)
          insertClosure.run(
            GRAPH_ID,
            selectedId(index),
            selectedId(index % CLUSTER_COUNT),
          );
      })();

      const store = createStore(graph, backend);
      const startedAt = performance.now();
      const page = await store.identity.classes({
        kinds: ["Selected"],
        limit: 1000,
      });
      const elapsedMs = performance.now() - startedAt;

      expect(page.classes).toHaveLength(
        CLUSTER_COUNT + SELECTED_COUNT - CLUSTERED_SELECTED_COUNT,
      );
      expect(page.classes[0]?.representative).toEqual({
        kind: "Selected",
        id: selectedId(0),
      });
      expect(page.classes[0]?.members).toContainEqual({
        kind: "Selected",
        id: selectedId(0),
      });
      expect(page.classes[0]?.members).toContainEqual({
        kind: "Selected",
        id: selectedId(CLUSTER_COUNT),
      });
      expect(page.classes[0]?.members).toHaveLength(
        CLUSTERED_SELECTED_COUNT / CLUSTER_COUNT,
      );
      expect(
        page.classes.reduce(
          (count, identityClass) => count + identityClass.members.length,
          0,
        ),
      ).toBe(SELECTED_COUNT);
      expect(page.nextCursor).toBeUndefined();
      expect(elapsedMs).toBeLessThan(MAX_PAGE_MS);
    } finally {
      await backend.close();
    }
  });
});
