/**
 * Subgraph Extraction Tests
 *
 * Tests store.subgraph() — typed neighborhood extraction from a root node.
 * Covers:
 * - Core traversal behavior (depth, direction, edge filtering)
 * - Result filtering (includeKinds, excludeRoot)
 * - Edge semantics (both endpoints must be in result set)
 * - Cycle handling
 * - Soft-delete exclusion
 * - Deduplication
 * - Boundary conditions
 * - Type-level safety (@ts-expect-error)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  defineSubgraphProject,
} from "../src";
import type { GraphBackend } from "../src/backend/types";
import type { NodeId } from "../src/core/types";
import { createStore, type Store } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Run = defineNode("Run", {
  schema: z.object({ name: z.string() }),
});

const Task = defineNode("Task", {
  schema: z.object({ title: z.string(), status: z.string() }),
});

const Agent = defineNode("Agent", {
  schema: z.object({ model: z.string() }),
});

const Skill = defineNode("Skill", {
  schema: z.object({ name: z.string() }),
});

const Attempt = defineNode("Attempt", {
  schema: z.object({ index: z.number() }),
});

const ToolDef = defineNode("ToolDef", {
  schema: z.object({ name: z.string() }),
});

const Orphan = defineNode("Orphan", {
  schema: z.object({ label: z.string() }),
});

const hasTask = defineEdge("has_task", { schema: z.object({}) });
const runsAgent = defineEdge("runs_agent", { schema: z.object({}) });
const usesSkill = defineEdge("uses_skill", {
  schema: z.object({ priority: z.number() }),
});
const hasAttempt = defineEdge("has_attempt", { schema: z.object({}) });
const usedTool = defineEdge("used_tool", { schema: z.object({}) });
const dependsOn = defineEdge("depends_on", { schema: z.object({}) });

const testGraph = defineGraph({
  id: "subgraph_test",
  nodes: {
    Run: { type: Run },
    Task: { type: Task },
    Agent: { type: Agent },
    Skill: { type: Skill },
    Attempt: { type: Attempt },
    ToolDef: { type: ToolDef },
    Orphan: { type: Orphan },
  },
  edges: {
    has_task: { type: hasTask, from: [Run], to: [Task] },
    runs_agent: { type: runsAgent, from: [Run], to: [Agent] },
    uses_skill: { type: usesSkill, from: [Task], to: [Skill] },
    has_attempt: { type: hasAttempt, from: [Task], to: [Attempt] },
    used_tool: { type: usedTool, from: [Attempt], to: [ToolDef] },
    depends_on: { type: dependsOn, from: [Task], to: [Task] },
  },
});

type TestGraph = typeof testGraph;

// ============================================================
// Test Fixture
// ============================================================

type TestIds = Readonly<{
  runId: NodeId<typeof Run>;
  task1Id: NodeId<typeof Task>;
  task2Id: NodeId<typeof Task>;
  agent1Id: NodeId<typeof Agent>;
  skill1Id: NodeId<typeof Skill>;
  attempt1Id: NodeId<typeof Attempt>;
  tool1Id: NodeId<typeof ToolDef>;
}>;

/**
 * Graph structure seeded by beforeEach:
 *
 *   run
 *   ├── has_task → task1
 *   │     ├── uses_skill → skill1
 *   │     ├── has_attempt → attempt1 → used_tool → tool1
 *   │     └── depends_on → task2
 *   ├── has_task → task2
 *   │     └── uses_skill → skill1 (same skill — diamond)
 *   └── runs_agent → agent1
 */
async function seedTestGraph(store: Store<TestGraph>): Promise<TestIds> {
  const run = await store.nodes.Run.create({ name: "run-1" });
  const task1 = await store.nodes.Task.create({ title: "t1", status: "done" });
  const task2 = await store.nodes.Task.create({
    title: "t2",
    status: "pending",
  });
  const agent1 = await store.nodes.Agent.create({ model: "gpt-4" });
  const skill1 = await store.nodes.Skill.create({ name: "code" });
  const attempt1 = await store.nodes.Attempt.create({ index: 0 });
  const tool1 = await store.nodes.ToolDef.create({ name: "bash" });

  await store.edges.has_task.create(run, task1);
  await store.edges.has_task.create(run, task2);
  await store.edges.runs_agent.create(run, agent1);
  await store.edges.uses_skill.create(task1, skill1, { priority: 1 });
  await store.edges.uses_skill.create(task2, skill1, { priority: 2 });
  await store.edges.has_attempt.create(task1, attempt1);
  await store.edges.used_tool.create(attempt1, tool1);
  await store.edges.depends_on.create(task1, task2);

  return {
    runId: run.id,
    task1Id: task1.id,
    task2Id: task2.id,
    agent1Id: agent1.id,
    skill1Id: skill1.id,
    attempt1Id: attempt1.id,
    tool1Id: tool1.id,
  };
}

// ============================================================
// Tests
// ============================================================

describe("store.subgraph()", () => {
  let backend: GraphBackend;
  let store: Store<TestGraph>;
  let ids: TestIds;

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);
    ids = await seedTestGraph(store);
  });

  // ── Empty / boundary cases ──────────────────────────────────

  describe("boundary conditions", () => {
    it("returns empty result when edges array is empty", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: [],
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it("returns empty result for non-existent root", async () => {
      const result = await store.subgraph("nonexistent_id" as never, {
        edges: ["has_task"],
        maxDepth: 1,
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it("returns only the root when maxDepth is 0", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "uses_skill"],
        maxDepth: 0,
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.id).toBe(ids.runId);
    });

    it("returns empty nodes and edges when maxDepth 0 and excludeRoot", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 0,
        excludeRoot: true,
      });

      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });

    it("returns root even when no outgoing edges of the specified kind exist", async () => {
      // agent1 has no outgoing has_task edges
      const result = await store.subgraph(ids.agent1Id as never, {
        edges: ["has_task"],
        maxDepth: 5,
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.id).toBe(ids.agent1Id);
      expect(result.edges).toHaveLength(0);
    });
  });

  // ── Core traversal ──────────────────────────────────────────

  describe("traversal", () => {
    it("extracts immediate neighbors with depth 1", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "runs_agent"],
        maxDepth: 1,
      });

      const nodeKinds = result.nodes.map((n) => n.kind).toSorted();
      expect(nodeKinds).toEqual(["Agent", "Run", "Task", "Task"]);
      expect(result.nodes.some((n) => n.id === ids.runId)).toBe(true);
    });

    it("follows multi-hop paths", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "has_attempt", "used_tool"],
        maxDepth: 4,
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      expect(nodeIds.has(ids.runId as string)).toBe(true);
      expect(nodeIds.has(ids.task1Id as string)).toBe(true);
      expect(nodeIds.has(ids.attempt1Id as string)).toBe(true);
      expect(nodeIds.has(ids.tool1Id as string)).toBe(true);
      expect(nodeIds.has(ids.task2Id as string)).toBe(true);
    });

    it("only follows specified edge kinds", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 3,
      });

      const kinds = new Set(result.nodes.map((n) => n.kind));
      expect(kinds.has("Run")).toBe(true);
      expect(kinds.has("Task")).toBe(true);
      expect(kinds.has("Agent")).toBe(false);
      expect(kinds.has("Skill")).toBe(false);
    });

    it("caps maxDepth at MAX_RECURSIVE_DEPTH", async () => {
      // Should not throw even with very large maxDepth
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 999_999,
      });

      // Still works, just capped internally
      expect(result.nodes.length).toBeGreaterThan(0);
    });
  });

  // ── Direction ───────────────────────────────────────────────

  describe("direction", () => {
    it("follows outbound edges by default", async () => {
      // Starting from task1, has_task points Run→Task, so outbound from task1 yields nothing for has_task
      const result = await store.subgraph(ids.task1Id as never, {
        edges: ["has_task"],
        maxDepth: 2,
      });

      // Only task1 itself — has_task edges go FROM Run, not from Task
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]!.id).toBe(ids.task1Id);
    });

    it("follows both directions with direction: both", async () => {
      const result = await store.subgraph(ids.task1Id as never, {
        edges: ["has_task"],
        maxDepth: 2,
        direction: "both",
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      // Inbound: task1 ← has_task ← run
      expect(nodeIds.has(ids.runId as string)).toBe(true);
      // Then outbound from run: run → has_task → task2
      expect(nodeIds.has(ids.task2Id as string)).toBe(true);
    });
  });

  // ── includeKinds filtering ──────────────────────────────────

  describe("includeKinds", () => {
    it("filters result nodes by kind", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "has_attempt", "used_tool"],
        maxDepth: 4,
        includeKinds: ["Task", "ToolDef"],
      });

      for (const node of result.nodes) {
        expect(["Task", "ToolDef"]).toContain(node.kind);
      }

      const kinds = result.nodes.map((n) => n.kind as string);
      expect(kinds).not.toContain("Attempt");
      expect(kinds).not.toContain("Run");
    });

    it("traverses through excluded kinds to reach included kinds", async () => {
      // Path: Run → has_task → Task → has_attempt → Attempt → used_tool → ToolDef
      // Exclude Attempt from results but ToolDef should still be reachable
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "has_attempt", "used_tool"],
        maxDepth: 4,
        includeKinds: ["ToolDef"],
      });

      expect(result.nodes.length).toBeGreaterThan(0);
      const kinds = result.nodes.map((n) => n.kind as string);
      expect(kinds).toContain("ToolDef");
      expect(kinds).not.toContain("Attempt");
    });
  });

  // ── excludeRoot ─────────────────────────────────────────────

  describe("excludeRoot", () => {
    it("excludes root node from results", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
        excludeRoot: true,
      });

      expect(result.nodes.every((n) => n.id !== (ids.runId as string))).toBe(
        true,
      );
      expect(result.nodes).toHaveLength(2);
    });

    it("excludes root but keeps edges that connect remaining nodes", async () => {
      // depends_on connects task1→task2, both are non-root
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "depends_on"],
        maxDepth: 2,
        excludeRoot: true,
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      expect(nodeIds.has(ids.runId as string)).toBe(false);

      // depends_on edge should still appear since both task1 and task2 are in the set
      const depEdges = result.edges.filter(
        (edge) => edge.kind === "depends_on",
      );
      expect(depEdges).toHaveLength(1);
    });

    it("excludes edges connected to root when root is excluded", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
        excludeRoot: true,
      });

      // has_task edges go from Run to Task — but Run is excluded,
      // so no has_task edges should appear (from endpoint missing)
      expect(result.edges).toHaveLength(0);
    });
  });

  // ── Edge result semantics ───────────────────────────────────

  describe("edge result semantics", () => {
    it("only returns edges where both endpoints are in the result set", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "has_attempt", "used_tool"],
        maxDepth: 4,
        includeKinds: ["Task", "ToolDef"],
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      for (const edge of result.edges) {
        expect(nodeIds.has(edge.fromId as string)).toBe(true);
        expect(nodeIds.has(edge.toId as string)).toBe(true);
      }

      // has_attempt: Task→Attempt — Attempt excluded, so edge excluded
      const edgeKinds = result.edges.map((edge) => edge.kind as string);
      expect(edgeKinds).not.toContain("has_attempt");
      // used_tool: Attempt→ToolDef — Attempt excluded, so edge excluded
      expect(edgeKinds).not.toContain("used_tool");
    });

    it("returns only edges of the specified kinds", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 2,
      });

      for (const edge of result.edges) {
        expect(edge.kind).toBe("has_task");
      }

      // runs_agent, uses_skill edges exist but are not in the edge filter
      const edgeKinds = result.edges.map((edge) => edge.kind as string);
      expect(edgeKinds).not.toContain("runs_agent");
    });
  });

  // ── Cycle handling ──────────────────────────────────────────

  describe("cycle handling", () => {
    it("prevents cycles by default", async () => {
      // Create cycle: task2 → depends_on → task1 (task1 → task2 exists from setup)
      const task2Ref = { kind: "Task" as const, id: ids.task2Id };
      const task1Ref = { kind: "Task" as const, id: ids.task1Id };
      await store.edges.depends_on.create(task2Ref, task1Ref);

      const result = await store.subgraph(ids.task1Id as never, {
        edges: ["depends_on"],
        maxDepth: 10,
      });

      const taskIds = result.nodes.map((n) => n.id);
      expect(taskIds).toHaveLength(2); // task1, task2 — each visited once
    });

    it("allows revisiting with cyclePolicy: allow", async () => {
      // With "allow", the CTE may produce duplicate visits before hitting maxDepth
      // but the DISTINCT in included_ids should still deduplicate
      const task2Ref = { kind: "Task" as const, id: ids.task2Id };
      const task1Ref = { kind: "Task" as const, id: ids.task1Id };
      await store.edges.depends_on.create(task2Ref, task1Ref);

      const result = await store.subgraph(ids.task1Id as never, {
        edges: ["depends_on"],
        maxDepth: 3,
        cyclePolicy: "allow",
      });

      // Nodes are still deduplicated in the result (DISTINCT in SQL)
      const uniqueIds = new Set(result.nodes.map((n) => n.id));
      expect(uniqueIds.size).toBe(2);
    });
  });

  // ── Deduplication ───────────────────────────────────────────

  describe("deduplication", () => {
    it("deduplicates nodes reachable via multiple paths", async () => {
      // skill1 is reachable via:
      //   run → has_task → task1 → uses_skill → skill1
      //   run → has_task → task2 → uses_skill → skill1
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "uses_skill"],
        maxDepth: 3,
      });

      const skillNodes = result.nodes.filter((n) => n.kind === "Skill");
      expect(skillNodes).toHaveLength(1);
      expect(skillNodes[0]!.id).toBe(ids.skill1Id);
    });
  });

  // ── Soft delete exclusion ───────────────────────────────────

  describe("soft-delete handling", () => {
    it("excludes soft-deleted nodes from traversal", async () => {
      // Must delete connected edges first (restrict policy)
      const connectedEdges = await store.edges.has_task.findTo({
        kind: "Task",
        id: ids.task1Id,
      });
      for (const edge of connectedEdges)
        await store.edges.has_task.delete(edge.id);
      const skillEdges = await store.edges.uses_skill.findFrom({
        kind: "Task",
        id: ids.task1Id,
      });
      for (const edge of skillEdges)
        await store.edges.uses_skill.delete(edge.id);
      const attemptEdges = await store.edges.has_attempt.findFrom({
        kind: "Task",
        id: ids.task1Id,
      });
      for (const edge of attemptEdges)
        await store.edges.has_attempt.delete(edge.id);
      const depEdges = await store.edges.depends_on.findFrom({
        kind: "Task",
        id: ids.task1Id,
      });
      for (const edge of depEdges) await store.edges.depends_on.delete(edge.id);

      await store.nodes.Task.delete(ids.task1Id);

      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
      });

      const taskIds = result.nodes
        .filter((n) => n.kind === "Task")
        .map((n) => n.id);
      expect(taskIds).not.toContain(ids.task1Id);
      // task2 is still alive
      expect(taskIds).toContain(ids.task2Id as string);
    });

    it("excludes soft-deleted edges from traversal", async () => {
      // Find and delete the has_task edge to task1
      const edgesToTask1 = await store.edges.has_task.findTo({
        kind: "Task",
        id: ids.task1Id,
      });
      for (const edge of edgesToTask1) {
        await store.edges.has_task.delete(edge.id);
      }

      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "uses_skill"],
        maxDepth: 3,
      });

      // task1 should not be reachable since the edge to it is deleted
      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      expect(nodeIds.has(ids.task1Id as string)).toBe(false);
    });

    it("does not traverse through soft-deleted intermediate nodes", async () => {
      // Must delete connected edges first (restrict policy)
      const toolEdges = await store.edges.used_tool.findFrom({
        kind: "Attempt",
        id: ids.attempt1Id,
      });
      for (const edge of toolEdges) await store.edges.used_tool.delete(edge.id);
      const attemptEdges = await store.edges.has_attempt.findTo({
        kind: "Attempt",
        id: ids.attempt1Id,
      });
      for (const edge of attemptEdges)
        await store.edges.has_attempt.delete(edge.id);

      await store.nodes.Attempt.delete(ids.attempt1Id);

      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "has_attempt", "used_tool"],
        maxDepth: 4,
      });

      const nodeIds = new Set(result.nodes.map((n) => n.id as string));
      expect(nodeIds.has(ids.tool1Id as string)).toBe(false);
    });

    it("excludes soft-deleted edges from result set", async () => {
      // Soft-delete one has_task edge
      const runEdges = await store.edges.has_task.findFrom({
        kind: "Run",
        id: ids.runId,
      });
      const edgeToTask1 = runEdges.find(
        (edge) => edge.toId === (ids.task1Id as string),
      );
      if (edgeToTask1) {
        await store.edges.has_task.delete(edgeToTask1.id);
      }

      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
      });

      // The deleted edge should not appear in results
      const edgeToIds = result.edges.map((edge) => edge.toId);
      expect(edgeToIds).not.toContain(ids.task1Id);
    });

    it("excludes soft-deleted root node", async () => {
      // Must delete connected edges first (restrict policy)
      const taskEdges = await store.edges.has_task.findFrom({
        kind: "Run",
        id: ids.runId,
      });
      for (const edge of taskEdges) await store.edges.has_task.delete(edge.id);
      const agentEdges = await store.edges.runs_agent.findFrom({
        kind: "Run",
        id: ids.runId,
      });
      for (const edge of agentEdges)
        await store.edges.runs_agent.delete(edge.id);

      await store.nodes.Run.delete(ids.runId);

      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
      });

      // Root doesn't match base case (deleted_at IS NULL), so empty
      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });
  });

  // ── Hydration ───────────────────────────────────────────────

  describe("result hydration", () => {
    it("returns fully hydrated nodes with props and metadata", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
        includeKinds: ["Task"],
      });

      expect(result.nodes).toHaveLength(2);
      for (const node of result.nodes) {
        expect(node.kind).toBe("Task");
        expect(node).toHaveProperty("title");
        expect(node).toHaveProperty("status");
        expect(node.meta).toHaveProperty("createdAt");
        expect(node.meta).toHaveProperty("updatedAt");
        expect(node.meta).toHaveProperty("version");
      }
    });

    it("returns fully hydrated edges with props and metadata", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
      });

      expect(result.edges.length).toBeGreaterThan(0);
      for (const edge of result.edges) {
        expect(edge).toHaveProperty("id");
        expect(edge).toHaveProperty("kind");
        expect(edge).toHaveProperty("fromKind");
        expect(edge).toHaveProperty("fromId");
        expect(edge).toHaveProperty("toKind");
        expect(edge).toHaveProperty("toId");
        expect(edge.meta).toHaveProperty("createdAt");
      }
    });
  });

  // ── Projection ─────────────────────────────────────────────

  describe("projection", () => {
    it("applies projection to the root node when its kind is projected", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 0,
        project: {
          nodes: {
            Run: ["name"],
          },
        },
      });

      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0]).toMatchObject({
        kind: "Run",
        id: ids.runId,
        name: "run-1",
      });
      expect(result.nodes[0]).not.toHaveProperty("meta");
    });

    it("projects node props and full metadata while preserving identity", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
        includeKinds: ["Task"],
        project: {
          nodes: {
            Task: ["title", "meta"],
          },
        },
      });

      expect(result.nodes).toHaveLength(2);
      for (const node of result.nodes) {
        expect(node.kind).toBe("Task");
        expect(node).toHaveProperty("id");
        expect(node).toHaveProperty("title");
        expect(node).not.toHaveProperty("status");
        expect(node).toHaveProperty("meta.createdAt");
        expect(node).toHaveProperty("meta.updatedAt");
      }
    });

    it("keeps unprojected kinds fully hydrated", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "runs_agent"],
        maxDepth: 1,
        project: {
          nodes: {
            Task: ["title"],
          },
        },
      });

      const task = result.nodes.find((node) => node.kind === "Task");
      const agent = result.nodes.find((node) => node.kind === "Agent");

      expect(task).toBeDefined();
      expect(task).toHaveProperty("title");
      expect(task).not.toHaveProperty("status");
      expect(task).not.toHaveProperty("meta");

      expect(agent).toBeDefined();
      expect(agent).toHaveProperty("model");
      expect(agent).toHaveProperty("meta.createdAt");
      expect(agent).toHaveProperty("meta.updatedAt");
    });

    it("projects edges while preserving structural endpoint fields", async () => {
      const result = await store.subgraph(ids.task1Id as never, {
        edges: ["uses_skill"],
        maxDepth: 1,
        project: {
          edges: {
            uses_skill: ["meta"],
          },
        },
      });

      expect(result.edges).toHaveLength(1);
      const edge = result.edges[0]!;
      expect(edge.kind).toBe("uses_skill");
      expect(edge).toHaveProperty("id");
      expect(edge).toHaveProperty("fromKind");
      expect(edge).toHaveProperty("fromId");
      expect(edge).toHaveProperty("toKind");
      expect(edge).toHaveProperty("toId");
      expect(edge).toHaveProperty("meta.createdAt");
      expect(edge).toHaveProperty("meta.updatedAt");
      expect(edge).not.toHaveProperty("priority");
    });
  });

  // ── Type-level tests ────────────────────────────────────────

  describe("compile-time type safety", () => {
    it("rejects invalid edge kinds at compile time", async () => {
      // @ts-expect-error - "nonexistent_edge" is not a valid edge kind
      await store.subgraph(ids.runId as never, { edges: ["nonexistent_edge"] });
    });

    it("rejects invalid includeKinds at compile time", async () => {
      await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        // @ts-expect-error - "NonExistent" is not a valid node kind
        includeKinds: ["NonExistent"],
      });
    });

    it("accepts valid edge and node kinds", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "runs_agent"],
        includeKinds: ["Task", "Agent"],
      });

      // Type narrowing should work — these are Task | Agent nodes
      expect(result.nodes.length).toBeGreaterThan(0);
      for (const node of result.nodes) {
        expect(["Task", "Agent"]).toContain(node.kind);
      }
    });

    it("narrows projected node fields at compile time", async () => {
      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "runs_agent"],
        maxDepth: 1,
        includeKinds: ["Task", "Agent"],
        project: {
          nodes: {
            Task: ["title"],
            Agent: ["meta"],
          },
        },
      });

      for (const node of result.nodes) {
        if (node.kind === "Task") {
          const title: string = node.title;
          void title;
          // @ts-expect-error - projected Task omits status
          const status = node.status;
          void status;
        }

        if (node.kind === "Agent") {
          const createdAt: string = node.meta.createdAt;
          void createdAt;
          // @ts-expect-error - projected Agent omits model
          const model = node.model;
          void model;
        }
      }
    });

    it("narrows projected edge fields at compile time", async () => {
      const result = await store.subgraph(ids.task1Id as never, {
        edges: ["uses_skill"],
        maxDepth: 1,
        project: {
          edges: {
            uses_skill: [],
          },
        },
      });

      const edge = result.edges[0]!;
      const fromId: string = edge.fromId;
      const toId: string = edge.toId;
      void fromId;
      void toId;
      // @ts-expect-error - projected edge omits meta unless requested
      const meta = edge.meta;
      void meta;
    });

    it("rejects partial meta fields at compile time", async () => {
      await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
        project: {
          nodes: {
            // @ts-expect-error - "meta.createdAt" is not a valid projection field; use "meta" for all-or-nothing
            Task: ["title", "meta.createdAt"],
          },
        },
      });

      await store.subgraph(ids.task1Id as never, {
        edges: ["uses_skill"],
        maxDepth: 1,
        project: {
          edges: {
            // @ts-expect-error - "meta.updatedAt" is not a valid edge projection field; use "meta" for all-or-nothing
            uses_skill: ["meta.updatedAt"],
          },
        },
      });
    });

    it("rejects projection keys for kinds outside includeKinds/edges", async () => {
      await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
        includeKinds: ["Task"],
        project: {
          nodes: {
            Task: ["title"],
            // @ts-expect-error - Agent is not in includeKinds
            Agent: ["model"],
          },
        },
      });

      await store.subgraph(ids.runId as never, {
        edges: ["has_task"],
        maxDepth: 1,
        project: {
          edges: {
            // @ts-expect-error - runs_agent is not in edges
            runs_agent: [],
          },
        },
      });
    });

    it("projects correctly with very long kind and field names", async () => {
      // Alias must stay under PostgreSQL's 63-byte identifier limit.
      // This test creates a node kind with a long schema field and verifies
      // projection round-trips the value correctly (alias wasn't truncated).
      const LongKind = defineNode(
        "VeryLongNodeKindNameThatExceedsNormalLength",
        {
          schema: z.object({
            a_field_name_that_is_also_unreasonably_long_for_testing_purposes:
              z.string(),
          }),
        },
      );

      const longEdge = defineEdge("very_long_edge", {
        schema: z.object({}),
      });

      const longGraph = defineGraph({
        id: "long_test",
        nodes: {
          VeryLongNodeKindNameThatExceedsNormalLength: { type: LongKind },
        },
        edges: {
          very_long_edge: {
            type: longEdge,
            from: [LongKind],
            to: [LongKind],
          },
        },
      });

      const longBackend = createTestBackend();
      const longStore = createStore(longGraph, longBackend);

      const root =
        await longStore.nodes.VeryLongNodeKindNameThatExceedsNormalLength.create(
          {
            a_field_name_that_is_also_unreasonably_long_for_testing_purposes:
              "hello",
          },
        );

      const child =
        await longStore.nodes.VeryLongNodeKindNameThatExceedsNormalLength.create(
          {
            a_field_name_that_is_also_unreasonably_long_for_testing_purposes:
              "world",
          },
        );

      await longStore.edges.very_long_edge.create(root, child);

      const result = await longStore.subgraph(root.id, {
        edges: ["very_long_edge"],
        maxDepth: 1,
        project: {
          nodes: {
            VeryLongNodeKindNameThatExceedsNormalLength: [
              "a_field_name_that_is_also_unreasonably_long_for_testing_purposes",
            ],
          },
        },
      });

      expect(result.nodes).toHaveLength(2);
      for (const node of result.nodes) {
        expect(
          node.a_field_name_that_is_also_unreasonably_long_for_testing_purposes,
        ).toBeDefined();
      }
    });

    it("projects correctly with multibyte kind names", async () => {
      // PostgreSQL truncates identifiers at 63 bytes, not characters.
      // Multibyte kind names (e.g. emoji, CJK) can exceed the byte limit
      // even when string.length looks safe. This test verifies round-trip
      // projection works with a multibyte kind name.
      const multibyteKindName = "データノード_" + "あ".repeat(20);
      const MultibyteKind = defineNode(multibyteKindName, {
        schema: z.object({ value: z.string() }),
      });

      const mbEdge = defineEdge("mb_link", { schema: z.object({}) });

      const mbGraph = defineGraph({
        id: "mb_test",
        nodes: { [multibyteKindName]: { type: MultibyteKind } },
        edges: {
          mb_link: {
            type: mbEdge,
            from: [MultibyteKind],
            to: [MultibyteKind],
          },
        },
      });

      const mbBackend = createTestBackend();
      const mbStore = createStore(mbGraph, mbBackend);

      const collection = mbStore.nodes[multibyteKindName]!;
      const root = await collection.create({ value: "root" });
      const child = await collection.create({ value: "child" });
      await mbStore.edges.mb_link.create(root, child);

      const result = await mbStore.subgraph(root.id as never, {
        edges: ["mb_link"] as never,
        maxDepth: 1,
        project: {
          nodes: { [multibyteKindName]: ["value"] } as never,
        },
      });

      expect(result.nodes).toHaveLength(2);
      for (const node of result.nodes) {
        expect((node as Record<string, unknown>).value).toBeDefined();
      }
    });

    it("rejects reserved node keys in projection", async () => {
      // "meta" is excluded — it's a valid projection field handled separately
      const reservedNodeKeys = ["id", "kind"];
      for (const key of reservedNodeKeys) {
        await expect(
          store.subgraph(ids.runId as never, {
            edges: ["has_task"],
            maxDepth: 1,
            project: {
              nodes: {
                Task: [key] as never,
              },
            },
          }),
        ).rejects.toThrow(/reserved structural key/);
      }
    });

    it("rejects reserved edge keys in projection", async () => {
      // "meta" is excluded — it's a valid projection field handled separately
      const reservedEdgeKeys = [
        "id",
        "kind",
        "fromKind",
        "fromId",
        "toKind",
        "toId",
      ];
      for (const key of reservedEdgeKeys) {
        await expect(
          store.subgraph(ids.runId as never, {
            edges: ["has_task"],
            maxDepth: 1,
            project: {
              edges: {
                has_task: [key] as never,
              },
            },
          }),
        ).rejects.toThrow(/reserved structural key/);
      }
    });

    it("rejects prototype-pollution keys in projection", async () => {
      const dangerousKeys = ["__proto__", "constructor", "prototype"];
      for (const key of dangerousKeys) {
        await expect(
          store.subgraph(ids.runId as never, {
            edges: ["has_task"],
            maxDepth: 1,
            project: {
              nodes: {
                Task: [key] as never,
              },
            },
          }),
        ).rejects.toThrow(/not allowed/);
      }
    });

    it("narrows reusable projection configs via defineSubgraphProject", async () => {
      const project = defineSubgraphProject(testGraph)({
        nodes: {
          Task: ["title"],
        },
        edges: {
          uses_skill: ["priority"],
        },
      });

      const result = await store.subgraph(ids.runId as never, {
        edges: ["has_task", "uses_skill"],
        maxDepth: 2,
        includeKinds: ["Task", "Skill"],
        project,
      });

      for (const node of result.nodes) {
        if (node.kind === "Task") {
          const title: string = node.title;
          void title;
          // @ts-expect-error - projected Task omits status even through reusable config
          const status = node.status;
          void status;
          // @ts-expect-error - projected Task omits meta when not requested
          const meta = node.meta;
          void meta;
        }
      }

      for (const edge of result.edges) {
        if (edge.kind === "uses_skill") {
          const priority: number = edge.priority;
          void priority;
          // @ts-expect-error - projected uses_skill omits meta when not requested
          const meta = edge.meta;
          void meta;
        }
      }
    });
  });
});
