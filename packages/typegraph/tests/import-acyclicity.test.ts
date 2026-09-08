/**
 * Item D.2's import wiring (§10.1): the validating-import path checks
 * acyclicity per row, sequentially, for an acyclic edge kind — never
 * batched, since the in-batch overlay that lets cardinality/endpoint checks
 * see earlier rows in the same slice cannot account for a recursive
 * reachability walk. A backend with no transactions refuses the whole
 * import up front, before the first row, because acyclicity's fence is
 * `lockOnly` and import's claim-row substitute for the per-graph lock does
 * not exist for it.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import type { GraphBackend } from "../src/backend/types";
import {
  type GraphData,
  importGraph,
  ImportOptionsSchema,
} from "../src/interchange";
import { createTestBackend } from "./test-utils";

const Task = defineNode("Task", { schema: z.object({}) });
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "import_acyclicity_test",
  nodes: { Task: { type: Task } },
  edges: {
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      acyclic: true,
    },
  },
});

function payload(edges: GraphData["edges"]): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "external", description: "acyclicity import test" },
    nodes: [
      { kind: "Task", id: "a", properties: {} },
      { kind: "Task", id: "b", properties: {} },
      { kind: "Task", id: "c", properties: {} },
    ],
    edges,
  };
}

const importOptions = ImportOptionsSchema.parse({
  onConflict: "error",
  refreshStatistics: false,
});

describe("import: edge acyclicity", () => {
  it("records a per-row error for an in-batch closing edge and commits the rest", async () => {
    const backend = createTestBackend();
    const store = createStore(graph, backend);

    const result = await importGraph(
      store,
      payload([
        {
          kind: "dependsOn",
          id: "e1",
          from: { kind: "Task", id: "a" },
          to: { kind: "Task", id: "b" },
          properties: {},
        },
        {
          kind: "dependsOn",
          id: "e2",
          from: { kind: "Task", id: "b" },
          to: { kind: "Task", id: "c" },
          properties: {},
        },
        {
          kind: "dependsOn",
          id: "e3",
          from: { kind: "Task", id: "c" },
          to: { kind: "Task", id: "a" },
          properties: {},
        },
      ]),
      importOptions,
    );

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toMatch(/cycle|acyclic/i);

    const remaining = await store.edges.dependsOn.find({});
    expect(remaining.map((edge) => edge.id).toSorted()).toEqual(["e1", "e2"]);
  });

  it("refuses the whole import up front on a backend with no transactions", async () => {
    const sqlite = new Database(":memory:");
    try {
      const db = drizzle(sqlite);
      for (const statement of generateSqliteDDL()) sqlite.exec(statement);
      const backend: GraphBackend = createSqliteBackend(db, {
        executionProfile: { transactionMode: "none", isSync: true },
      });
      const store = createStore(graph, backend);

      await expect(
        importGraph(
          store,
          payload([
            {
              kind: "dependsOn",
              id: "e1",
              from: { kind: "Task", id: "a" },
              to: { kind: "Task", id: "b" },
              properties: {},
            },
          ]),
          importOptions,
        ),
      ).rejects.toMatchObject({
        details: {
          code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
          constraint: "edgeAcyclicity",
        },
      });

      const remaining = await store.edges.dependsOn.find({});
      expect(remaining).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
