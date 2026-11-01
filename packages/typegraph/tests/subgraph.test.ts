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
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  defineSubgraphProject,
  type Edge,
  type GraphNodeReference,
  indexSubgraph,
  MAX_EXPLICIT_RECURSIVE_DEPTH,
  type Node,
  partOf,
} from "../src";
import type { GraphBackend } from "../src/backend/types";
import type { NodeId } from "../src/core/types";
import { KindNotFoundError, ValidationError } from "../src/errors";
import { createStore, type Store } from "../src/store";
import { type SubgraphResult } from "../src/store/subgraph";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend, TEMPORAL_ANCHORS } from "./test-utils";

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
// Composition widens the subgraph result's edge-kind type
// ============================================================
//
// Type-only fixtures: `compositionStore` is never a real store and none of
// the `subgraph*` helpers below is ever CALLED — each exists so a test can
// read its return type. The runtime behavior of `composition: true` lives
// in the cross-backend composition-navigation suite.

const CompositionWhole = defineNode("CompositionWhole", {
  schema: z.object({ title: z.string() }),
});
const CompositionPart = defineNode("CompositionPart", {
  schema: z.object({ title: z.string() }),
});
const partOfWhole = defineEdge("part_of_whole", { schema: z.object({}) });
const mentions = defineEdge("mentions", { schema: z.object({}) });

const compositionGraph = defineGraph({
  id: "subgraph_composition_typing",
  nodes: {
    CompositionWhole: { type: CompositionWhole },
    CompositionPart: { type: CompositionPart },
  },
  edges: {
    part_of_whole: {
      type: partOfWhole,
      from: [CompositionPart],
      to: [CompositionWhole],
      cardinality: "one",
    },
    mentions: {
      type: mentions,
      from: [CompositionWhole],
      to: [CompositionWhole],
    },
  },
  ontology: [partOf(CompositionPart, CompositionWhole, { via: partOfWhole })],
});

declare const compositionStore: Store<typeof compositionGraph>;
declare const compositionRoot: Readonly<{
  kind: "CompositionWhole";
  id: NodeId<typeof CompositionWhole>;
}>;

type ResultEdgeKindOf<R extends { edges: readonly { kind: string }[] }> =
  R["edges"][number]["kind"];

function subgraphWithoutComposition() {
  return compositionStore.subgraph(compositionRoot, { edges: ["mentions"] });
}

function subgraphWithCompositionFalse() {
  return compositionStore.subgraph(compositionRoot, {
    edges: ["mentions"],
    composition: false,
  });
}

function subgraphWithCompositionTrue() {
  return compositionStore.subgraph(compositionRoot, {
    edges: ["mentions"],
    composition: true,
  });
}

function subgraphWithUnknownComposition(composition: boolean) {
  return compositionStore.subgraph(compositionRoot, {
    edges: ["mentions"],
    composition,
  });
}

// A `composition: true` call receives composition edge rows, so it must be
// able to project them: the option that widened the result's edge-kind type
// widens the matching projection input through the same owner
// (`SubgraphProjectFor`).
function subgraphProjectingCompositionEdges() {
  return compositionStore.subgraph(compositionRoot, {
    edges: ["mentions"],
    composition: true,
    project: { edges: { part_of_whole: ["meta"] } },
  });
}

function subgraphProjectingAnUntraversedEdge() {
  return compositionStore.subgraph(compositionRoot, {
    edges: ["mentions"],
    // @ts-expect-error - without `composition: true` the traversal never
    // produces `part_of_whole` rows, so projecting that kind stays refused.
    project: { edges: { part_of_whole: ["meta"] } },
  });
}

/** A projection over the edge kinds the result carries is a valid `P`. */
type ProjectedCompositionSubgraph = SubgraphResult<
  typeof compositionGraph,
  "CompositionWhole",
  "mentions" | "part_of_whole",
  { edges: { part_of_whole: readonly ["meta"] } }
>;

type NonProjectionSubgraphResult = SubgraphResult<
  typeof compositionGraph,
  "CompositionWhole",
  "mentions",
  // @ts-expect-error - the fourth argument is a projection for this graph, not
  // an arbitrary object; without the constraint the selection silently
  // resolves to `undefined` and every row comes back fully hydrated.
  { nonsense: true }
>;

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
    it("returns only root when edges array is empty", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: [],
        },
      );

      expect(result.root).toBeDefined();
      expect(requireDefined(result.root).id).toBe(ids.runId);
      expect(result.nodes.length).toBe(1);
      expect(result.edges).toEqual([]);
    });

    it("returns empty result for non-existent root", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: "nonexistent_id" as NodeId<typeof Run> },
        {
          edges: ["has_task"],
          maxDepth: 1,
        },
      );

      expect(result.root).toBeUndefined();
      expect(result.nodes.length).toBe(0);
    });

    it("returns only the root when maxDepth is 0", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "uses_skill"],
          maxDepth: 0,
        },
      );

      expect(result.nodes.length).toBe(1);
      expect(result.root).toBeDefined();
      expect(requireDefined(result.root).id).toBe(ids.runId);
    });

    it("returns empty result when maxDepth 0 and excludeRoot", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 0,
          excludeRoot: true,
        },
      );

      expect(result.root).toBeUndefined();
      expect(result.nodes.length).toBe(0);
      expect(result.edges).toEqual([]);
    });

    it("returns root even when no outgoing edges of the specified kind exist", async () => {
      // agent1 has no outgoing has_task edges
      const result = await store.subgraph(
        { kind: "Agent", id: ids.agent1Id },
        {
          edges: ["has_task"],
          maxDepth: 5,
        },
      );

      expect(result.nodes.length).toBe(1);
      expect(result.root).toBeDefined();
      expect(requireDefined(result.root).id).toBe(ids.agent1Id);
      expect(result.edges).toEqual([]);
    });
  });

  // ── Core traversal ──────────────────────────────────────────

  describe("traversal", () => {
    it("extracts immediate neighbors with depth 1", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "runs_agent"],
          maxDepth: 1,
        },
      );
      const index = indexSubgraph(result);

      const nodeKinds = result.nodes.map((n) => n.kind).toSorted();
      expect(nodeKinds).toEqual(["Agent", "Run", "Task", "Task"]);
      expect(index.node({ kind: "Run", id: ids.runId })).toBeDefined();
    });

    it("follows multi-hop paths", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "has_attempt", "used_tool"],
          maxDepth: 4,
        },
      );
      const index = indexSubgraph(result);

      expect(index.node({ kind: "Run", id: ids.runId })).toBeDefined();
      expect(index.node({ kind: "Task", id: ids.task1Id })).toBeDefined();
      expect(index.node({ kind: "Attempt", id: ids.attempt1Id })).toBeDefined();
      expect(index.node({ kind: "ToolDef", id: ids.tool1Id })).toBeDefined();
      expect(index.node({ kind: "Task", id: ids.task2Id })).toBeDefined();
    });

    it("only follows specified edge kinds", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 3,
        },
      );

      const kinds = new Set(result.nodes.map((n) => n.kind));
      expect(kinds.has("Run")).toBe(true);
      expect(kinds.has("Task")).toBe(true);
      expect(kinds.has("Agent")).toBe(false);
      expect(kinds.has("Skill")).toBe(false);
    });

    it("refuses maxDepth above MAX_EXPLICIT_RECURSIVE_DEPTH", async () => {
      await expect(
        store.subgraph(
          { kind: "Run", id: ids.runId },
          {
            edges: ["has_task"],
            maxDepth: MAX_EXPLICIT_RECURSIVE_DEPTH + 1,
          },
        ),
      ).rejects.toThrow(
        `maxDepth must be an integer from 0 through ${MAX_EXPLICIT_RECURSIVE_DEPTH}`,
      );
    });
  });

  // ── Direction ───────────────────────────────────────────────

  describe("direction", () => {
    it("follows outbound edges by default", async () => {
      // Starting from task1, has_task points Run→Task, so outbound from task1 yields nothing for has_task
      const result = await store.subgraph(
        { kind: "Task", id: ids.task1Id },
        {
          edges: ["has_task"],
          maxDepth: 2,
        },
      );

      // Only task1 itself — has_task edges go FROM Run, not from Task
      expect(result.nodes.length).toBe(1);
      expect(requireDefined(result.root).id).toBe(ids.task1Id);
    });

    it("follows both directions with direction: both", async () => {
      const result = await store.subgraph(
        { kind: "Task", id: ids.task1Id },
        {
          edges: ["has_task"],
          maxDepth: 2,
          direction: "both",
        },
      );
      const index = indexSubgraph(result);

      // Inbound: task1 ← has_task ← run
      expect(index.node({ kind: "Run", id: ids.runId })).toBeDefined();
      // Then outbound from run: run → has_task → task2
      expect(index.node({ kind: "Task", id: ids.task2Id })).toBeDefined();
    });
  });

  // ── includeKinds filtering ──────────────────────────────────

  describe("includeKinds", () => {
    it("filters result nodes by kind", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "has_attempt", "used_tool"],
          maxDepth: 4,
          includeKinds: ["Task", "ToolDef"],
        },
      );

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
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "has_attempt", "used_tool"],
          maxDepth: 4,
          includeKinds: ["ToolDef"],
        },
      );

      expect(result.nodes.length).toBeGreaterThan(0);
      const kinds = result.nodes.map((n) => n.kind as string);
      expect(kinds).toContain("ToolDef");
      expect(kinds).not.toContain("Attempt");
    });
  });

  // ── excludeRoot ─────────────────────────────────────────────

  describe("excludeRoot", () => {
    it("excludes root node from results", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
          excludeRoot: true,
        },
      );
      const index = indexSubgraph(result);

      expect(result.root).toBeUndefined();
      expect(index.node({ kind: "Run", id: ids.runId })).toBeUndefined();
      expect(result.nodes.length).toBe(2);
    });

    it("excludes root but keeps edges that connect remaining nodes", async () => {
      // depends_on connects task1→task2, both are non-root
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "depends_on"],
          maxDepth: 2,
          excludeRoot: true,
        },
      );
      const index = indexSubgraph(result);

      expect(index.node({ kind: "Run", id: ids.runId })).toBeUndefined();

      // depends_on edge should still appear since both task1 and task2 are in the set
      const depEdges = index.outgoing(
        { kind: "Task", id: ids.task1Id },
        "depends_on",
      );
      expect(depEdges).toHaveLength(1);
    });

    it("excludes edges connected to root when root is excluded", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
          excludeRoot: true,
        },
      );

      // has_task edges go from Run to Task — but Run is excluded,
      // so no has_task edges should appear (from endpoint missing)
      expect(result.edges).toEqual([]);
    });
  });

  // ── Edge result semantics ───────────────────────────────────

  describe("edge result semantics", () => {
    it("only returns edges where both endpoints are in the result set", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "has_attempt", "used_tool"],
          maxDepth: 4,
          includeKinds: ["Task", "ToolDef"],
        },
      );
      const index = indexSubgraph(result);

      const allEdges = result.edges;
      for (const edge of allEdges) {
        expect(
          index.node({ kind: edge.fromKind, id: edge.fromId }),
        ).toBeDefined();
        expect(index.node({ kind: edge.toKind, id: edge.toId })).toBeDefined();
      }

      // has_attempt: Task→Attempt — Attempt excluded, so edge excluded
      const edgeKinds = allEdges.map((edge) => edge.kind as string);
      expect(edgeKinds).not.toContain("has_attempt");
      // used_tool: Attempt→ToolDef — Attempt excluded, so edge excluded
      expect(edgeKinds).not.toContain("used_tool");
    });

    it("returns only edges of the specified kinds", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 2,
        },
      );

      const allEdges = result.edges;
      for (const edge of allEdges) {
        expect(edge.kind).toBe("has_task");
      }

      // runs_agent, uses_skill edges exist but are not in the edge filter
      const edgeKinds = allEdges.map((edge) => edge.kind as string);
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

      const result = await store.subgraph(
        { kind: "Task", id: ids.task1Id },
        {
          edges: ["depends_on"],
          maxDepth: 10,
        },
      );

      expect(result.nodes.length).toBe(2); // task1, task2 — each visited once
    });

    it("allows revisiting with cyclePolicy: allow", async () => {
      // With "allow", the CTE may produce duplicate visits before hitting maxDepth
      // but the DISTINCT in included_ids should still deduplicate
      const task2Ref = { kind: "Task" as const, id: ids.task2Id };
      const task1Ref = { kind: "Task" as const, id: ids.task1Id };
      await store.edges.depends_on.create(task2Ref, task1Ref);

      const result = await store.subgraph(
        { kind: "Task", id: ids.task1Id },
        {
          edges: ["depends_on"],
          maxDepth: 3,
          cyclePolicy: "allow",
        },
      );

      // Nodes are still deduplicated in the result (DISTINCT in SQL)
      expect(result.nodes.length).toBe(2);
    });
  });

  // ── Deduplication ───────────────────────────────────────────

  describe("deduplication", () => {
    it("deduplicates nodes reachable via multiple paths", async () => {
      // skill1 is reachable via:
      //   run → has_task → task1 → uses_skill → skill1
      //   run → has_task → task2 → uses_skill → skill1
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "uses_skill"],
          maxDepth: 3,
        },
      );

      const skillNodes = result.nodes.filter((n) => n.kind === "Skill");
      expect(skillNodes).toHaveLength(1);
      expect(requireDefined(skillNodes[0]).id).toBe(ids.skill1Id);
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

      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
        },
      );
      const index = indexSubgraph(result);

      expect(index.node({ kind: "Task", id: ids.task1Id })).toBeUndefined();
      // task2 is still alive
      expect(index.node({ kind: "Task", id: ids.task2Id })).toBeDefined();
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

      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "uses_skill"],
          maxDepth: 3,
        },
      );
      const index = indexSubgraph(result);

      // task1 should not be reachable since the edge to it is deleted
      expect(index.node({ kind: "Task", id: ids.task1Id })).toBeUndefined();
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

      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "has_attempt", "used_tool"],
          maxDepth: 4,
        },
      );
      const index = indexSubgraph(result);

      expect(index.node({ kind: "ToolDef", id: ids.tool1Id })).toBeUndefined();
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

      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
        },
      );

      // The deleted edge should not appear in results
      const allEdges = result.edges;
      const edgeToIds = allEdges.map((edge) => edge.toId);
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

      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
        },
      );

      // Root doesn't match base case (deleted_at IS NULL), so empty
      expect(result.root).toBeUndefined();
      expect(result.nodes.length).toBe(0);
      expect(result.edges).toEqual([]);
    });
  });

  // ── Hydration ───────────────────────────────────────────────

  describe("result hydration", () => {
    it("returns fully hydrated nodes with props and metadata", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
          includeKinds: ["Task"],
        },
      );

      expect(result.nodes.length).toBe(2);
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
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
        },
      );

      const allEdges = result.edges;
      expect(allEdges.length).toBeGreaterThan(0);
      for (const edge of allEdges) {
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
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 0,
          project: {
            nodes: {
              Run: ["name"],
            },
          },
        },
      );

      expect(result.nodes.length).toBe(1);
      expect(result.root).toMatchObject({
        kind: "Run",
        id: ids.runId,
        name: "run-1",
      });
      expect(result.root).not.toHaveProperty("meta");
    });

    it("projects node props and full metadata while preserving identity", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
          includeKinds: ["Task"],
          project: {
            nodes: {
              Task: ["title", "meta"],
            },
          },
        },
      );

      expect(result.nodes.length).toBe(2);
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
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "runs_agent"],
          maxDepth: 1,
          project: {
            nodes: {
              Task: ["title"],
            },
          },
        },
      );

      const nodes = result.nodes;
      const task = nodes.find((node) => node.kind === "Task");
      const agent = nodes.find((node) => node.kind === "Agent");

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
      const result = await store.subgraph(
        { kind: "Task", id: ids.task1Id },
        {
          edges: ["uses_skill"],
          maxDepth: 1,
          project: {
            edges: {
              uses_skill: ["meta"],
            },
          },
        },
      );

      const allEdges = result.edges;
      expect(allEdges).toHaveLength(1);
      const edge = requireDefined(allEdges[0]);
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

  describe("composition widens the result's edge-kind type", () => {
    it("keeps the declared edges list when composition is absent or false", () => {
      expectTypeOf<
        ResultEdgeKindOf<Awaited<ReturnType<typeof subgraphWithoutComposition>>>
      >().toEqualTypeOf<"mentions">();
      expectTypeOf<
        ResultEdgeKindOf<
          Awaited<ReturnType<typeof subgraphWithCompositionFalse>>
        >
      >().toEqualTypeOf<"mentions">();
      void subgraphWithoutComposition;
      void subgraphWithCompositionFalse;
      expect(compositionGraph.id).toBe("subgraph_composition_typing");
    });

    it("widens to the graph's whole edge-kind union under composition: true", () => {
      // `part_of_whole` is never named in `edges`, but the composition
      // closure can put its rows in `edges`, so the kind type must admit
      // it.
      expectTypeOf<
        ResultEdgeKindOf<
          Awaited<ReturnType<typeof subgraphWithCompositionTrue>>
        >
      >().toEqualTypeOf<"mentions" | "part_of_whole">();
      void subgraphWithCompositionTrue;
      expect(compositionGraph.id).toBe("subgraph_composition_typing");
    });

    it("widens the matching projection input, not only the result", () => {
      // Compiling IS the assertion: `project.edges.part_of_whole` is outside
      // the declared `edges` list, and is admissible only because
      // `composition: true` widened the projection's key set too.
      expectTypeOf<
        ResultEdgeKindOf<
          Awaited<ReturnType<typeof subgraphProjectingCompositionEdges>>
        >
      >().toEqualTypeOf<"mentions" | "part_of_whole">();
      void subgraphProjectingCompositionEdges;
      void subgraphProjectingAnUntraversedEdge;
      expect(compositionGraph.id).toBe("subgraph_composition_typing");
    });

    it("keeps SubgraphResult's projection argument constrained", () => {
      expectTypeOf<
        ProjectedCompositionSubgraph["root"]
      >().not.toEqualTypeOf<never>();
      expectTypeOf<
        NonProjectionSubgraphResult["root"]
      >().not.toEqualTypeOf<never>();
      expect(compositionGraph.id).toBe("subgraph_composition_typing");
    });

    it("widens for a composition flag that is only known to be a boolean", () => {
      expectTypeOf<
        ResultEdgeKindOf<
          Awaited<ReturnType<typeof subgraphWithUnknownComposition>>
        >
      >().toEqualTypeOf<"mentions" | "part_of_whole">();
      void subgraphWithUnknownComposition;
      expect(compositionGraph.id).toBe("subgraph_composition_typing");
    });
  });

  describe("indexSubgraph lookup typing", () => {
    type WideNode = Readonly<{ kind: string; id: string; name: string }>;
    type WideEdge = Readonly<{
      id: string;
      kind: string;
      fromKind: string;
      fromId: string;
      toKind: string;
      toId: string;
      weight: number;
    }>;
    type ShowNode = Readonly<{ kind: "Show"; id: string; title: string }>;
    type ClipNode = Readonly<{ kind: "Clip"; id: string; seconds: number }>;
    type LinkedEdge = Readonly<{
      id: string;
      kind: "linked";
      fromKind: string;
      fromId: string;
      toKind: string;
      toId: string;
      since: string;
    }>;
    type CitesEdge = Readonly<{
      id: string;
      kind: "cites";
      fromKind: string;
      fromId: string;
      toKind: string;
      toId: string;
      page: number;
    }>;
    const showKey = { kind: "Show", id: "a" } as const;

    it("keeps members whose kind is widened to string on literal-kind lookups", () => {
      const nodes: readonly WideNode[] = [
        { kind: "Show", id: "a", name: "Pilot" },
      ];
      const edges: readonly WideEdge[] = [
        {
          id: "e1",
          kind: "linked",
          fromKind: "Show",
          fromId: "a",
          toKind: "Show",
          toId: "a",
          weight: 2,
        },
      ];
      const { node, outgoing, incoming } = indexSubgraph({ nodes, edges });

      const show = node(showKey);
      expectTypeOf(show).toEqualTypeOf<WideNode | undefined>();
      expect(show?.name).toBe("Pilot");

      const linkedOut = outgoing(showKey, "linked");
      expectTypeOf(linkedOut).toEqualTypeOf<readonly WideEdge[]>();
      expect(linkedOut[0]?.weight).toBe(2);
      expect(incoming(showKey, "linked")[0]?.weight).toBe(2);
    });

    it("narrows members with literal kinds and rejects a kind typo", () => {
      const nodes: readonly (ClipNode | ShowNode)[] = [
        { kind: "Show", id: "a", title: "Pilot" },
        { kind: "Clip", id: "a", seconds: 30 },
      ];
      const edges: readonly (CitesEdge | LinkedEdge)[] = [
        {
          id: "e1",
          kind: "cites",
          fromKind: "Show",
          fromId: "a",
          toKind: "Clip",
          toId: "a",
          page: 4,
        },
      ];
      const { node, outgoing } = indexSubgraph({ nodes, edges });

      const show = node(showKey);
      expectTypeOf(show).toEqualTypeOf<ShowNode | undefined>();
      expect(show?.title).toBe("Pilot");
      expect(node({ kind: "Clip", id: "a" })?.seconds).toBe(30);
      expectTypeOf(outgoing(showKey, "cites")).toEqualTypeOf<
        readonly CitesEdge[]
      >();
      expect(outgoing(showKey, "cites")[0]?.page).toBe(4);
      // @ts-expect-error - "Shwo" is not a kind these nodes can hold
      node({ kind: "Shwo", id: "a" });
      // @ts-expect-error - "cite" is not an edge kind of these edges
      outgoing(showKey, "cite");
    });

    it("keeps widened members alongside matching literal members in a mixed union", () => {
      const nodes: readonly (ShowNode | WideNode)[] = [
        { kind: "Show", id: "a", title: "Pilot" },
        { kind: "Clip", id: "a", name: "Trailer" },
      ];
      const edges: readonly (LinkedEdge | WideEdge)[] = [];
      const { node, outgoing } = indexSubgraph({ nodes, edges });

      expectTypeOf(node(showKey)).toEqualTypeOf<
        ShowNode | WideNode | undefined
      >();
      const clip = node({ kind: "Clip", id: "a" });
      expectTypeOf(clip).toEqualTypeOf<WideNode | undefined>();
      expect(clip?.name).toBe("Trailer");
      expectTypeOf(outgoing(showKey, "cites")).toEqualTypeOf<
        readonly WideEdge[]
      >();
    });
  });

  describe("compile-time type safety", () => {
    it("rejects invalid edge kinds at compile time and at runtime", async () => {
      await expect(
        store.subgraph(
          { kind: "Run", id: ids.runId },
          // @ts-expect-error - "nonexistent_edge" is not a valid edge kind
          { edges: ["nonexistent_edge"] },
        ),
      ).rejects.toBeInstanceOf(KindNotFoundError);
    });

    it("rejects invalid includeKinds at compile time and at runtime", async () => {
      await expect(
        store.subgraph(
          { kind: "Run", id: ids.runId },
          {
            edges: ["has_task"],
            // @ts-expect-error - "NonExistent" is not a valid node kind
            includeKinds: ["NonExistent"],
          },
        ),
      ).rejects.toBeInstanceOf(KindNotFoundError);
    });

    it("accepts a { kind, id } reference root on every subgraph surface", async () => {
      const root = { kind: "Run", id: ids.runId } as const;
      const options = { edges: ["has_task"], maxDepth: 1 } as const;

      const direct = await store.subgraph(root, options);
      const transactional = await store.transaction((tx) =>
        tx.subgraph(root, options),
      );
      const [batched] = await store.batchOnce(
        (read) => [read.subgraph(root, options)] as const,
      );
      const pinned = await store.asOf(new Date().toISOString()).subgraph(root, {
        edges: ["has_task"],
        maxDepth: 1,
      });

      expectTypeOf(transactional).toEqualTypeOf(direct);
      expectTypeOf(batched).toEqualTypeOf(direct);
      expectTypeOf(pinned).toEqualTypeOf(direct);
      expect(direct.root?.id).toBe(ids.runId);
      expect(transactional.root?.id).toBe(ids.runId);
      expect(batched.root?.id).toBe(ids.runId);
      expect(pinned.root?.id).toBe(ids.runId);
      expectTypeOf<Parameters<typeof store.subgraph>[0]>().toEqualTypeOf<
        GraphNodeReference<TestGraph>
      >();
    });

    it("accepts a node as the subgraph root", async () => {
      const run = await store.nodes.Run.create({ name: "run-2" });

      const result = await store.subgraph(run, { edges: ["has_task"] });

      expect(result.root?.id).toBe(run.id);
    });

    it("rejects a bare id root at compile time and at runtime", async () => {
      await expect(
        // @ts-expect-error - a bare id is not a subgraph root
        store.subgraph(ids.runId, { edges: ["has_task"] }),
      ).rejects.toThrow(ValidationError);
    });

    it("looks up nodes by kind with a narrowed type", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        { edges: ["has_task"], maxDepth: 1 },
      );
      const index = indexSubgraph(result);

      const task = index.node({ kind: "Task", id: ids.task1Id });
      expectTypeOf(task).toEqualTypeOf<Node<typeof Task> | undefined>();
      expect(task?.title).toBe("t1");

      for (const edge of result.edges) {
        const target = index.node({ kind: edge.toKind, id: edge.toId });
        expect(target).toBeDefined();
      }
      if (result.root !== undefined) {
        expectTypeOf(index.node(result.root)).toEqualTypeOf<
          (typeof result.nodes)[number] | undefined
        >();
      }
      // @ts-expect-error - "Tsak" is not a kind this result can hold
      index.node({ kind: "Tsak", id: ids.task1Id });

      expectTypeOf(
        index.outgoing({ kind: "Run", id: ids.runId }, "has_task"),
      ).toEqualTypeOf<readonly Edge<typeof hasTask>[]>();
      const optionalKind = undefined as "has_task" | undefined;
      expect(
        index.outgoing({ kind: "Run", id: ids.runId }, optionalKind),
      ).toEqual(index.outgoing({ kind: "Run", id: ids.runId }));
      // @ts-expect-error - "runs_agent" is not an edge kind of this result
      index.outgoing({ kind: "Run", id: ids.runId }, "runs_agent");

      expect(structuredClone(result)).toEqual(result);
      expect(
        Object.isFrozen(index.outgoing({ kind: "Run", id: ids.runId })),
      ).toBe(true);
    });

    it("rejects a reference root whose kind and id disagree at compile time", async () => {
      await expect(
        store.subgraph(
          // @ts-expect-error - a Run id cannot be referenced as a Task
          { kind: "Task", id: ids.runId },
          { edges: ["has_task"] },
        ),
      ).resolves.toBeDefined();
      await expect(
        store.subgraph(
          // @ts-expect-error - "Episode" is not a node kind of this graph
          { kind: "Episode", id: ids.runId },
          { edges: ["has_task"] },
        ),
      ).rejects.toThrow(KindNotFoundError);
    });

    it("accepts valid edge and node kinds", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "runs_agent"],
          includeKinds: ["Task", "Agent"],
        },
      );

      // Type narrowing should work — these are Task | Agent nodes
      expect(result.nodes.length).toBeGreaterThan(0);
      for (const node of result.nodes) {
        expect(["Task", "Agent"]).toContain(node.kind);
      }
    });

    it("narrows projected node fields at compile time", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "runs_agent"],
          maxDepth: 1,
          includeKinds: ["Task", "Agent"],
          project: {
            nodes: {
              Task: ["title"],
              Agent: ["meta"],
            },
          },
        },
      );

      for (const node of result.nodes) {
        if (node.kind === "Task") {
          const title: string = node.title;
          void title;
          expectTypeOf(node).not.toHaveProperty("status");
        }

        if (node.kind === "Agent") {
          const createdAt: string = node.meta.createdAt;
          void createdAt;
          expectTypeOf(node).not.toHaveProperty("model");
        }
      }
    });

    it("narrows projected edge fields at compile time", async () => {
      const result = await store.subgraph(
        { kind: "Task", id: ids.task1Id },
        {
          edges: ["uses_skill"],
          maxDepth: 1,
          project: {
            edges: {
              uses_skill: [],
            },
          },
        },
      );

      const allEdges = result.edges;
      const edge = requireDefined(allEdges[0]);
      const fromId: string = edge.fromId;
      const toId: string = edge.toId;
      void fromId;
      void toId;
      expectTypeOf(edge).not.toHaveProperty("meta");
    });

    it("narrows root type with kind discrimination", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "runs_agent"],
          maxDepth: 1,
          includeKinds: ["Run", "Task"],
        },
      );
      const index = indexSubgraph(result);

      // root is Run | Task | undefined — narrows via kind check
      if (result.root?.kind === "Run") {
        const name: string = result.root.name;
        void name;
      }

      // a string-kind key returns Run | Task | undefined; a literal kind narrows
      const key: { kind: string; id: string } = { kind: "Run", id: ids.runId };
      const node = index.node(key);
      if (node?.kind === "Task") {
        const title: string = node.title;
        void title;
      }
    });

    it("narrows edge types via outgoing and incoming lookups", async () => {
      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "uses_skill"],
          maxDepth: 2,
          project: {
            edges: {
              uses_skill: ["priority"],
            },
          },
        },
      );
      const index = indexSubgraph(result);

      const edges = index.outgoing(
        { kind: "Task", id: ids.task1Id },
        "uses_skill",
      );
      for (const edge of edges) {
        // Structural fields are always present
        const fromId: string = edge.fromId;
        void fromId;
        // The edge-kind argument narrows each edge to uses_skill
        const priority: number = edge.priority;
        void priority;
        expectTypeOf(edge).not.toHaveProperty("meta");
      }

      // incoming has the same type
      const reverseEdges = index.incoming(
        { kind: "Skill", id: ids.skill1Id },
        "uses_skill",
      );
      for (const edge of reverseEdges) {
        const toId: string = edge.toId;
        void toId;
      }
    });

    it("rejects partial meta fields at compile time", async () => {
      await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
          project: {
            nodes: {
              // @ts-expect-error - "meta.createdAt" is not a valid projection field; use "meta" for all-or-nothing
              Task: ["title", "meta.createdAt"],
            },
          },
        },
      );

      await store.subgraph(
        { kind: "Task", id: ids.task1Id },
        {
          edges: ["uses_skill"],
          maxDepth: 1,
          project: {
            edges: {
              // @ts-expect-error - "meta.updatedAt" is not a valid edge projection field; use "meta" for all-or-nothing
              uses_skill: ["meta.updatedAt"],
            },
          },
        },
      );
    });

    it("rejects projection keys for kinds outside includeKinds/edges", async () => {
      await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
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
        },
      );

      await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
          project: {
            edges: {
              // @ts-expect-error - runs_agent is not in edges
              runs_agent: [],
            },
          },
        },
      );
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

      const result = await longStore.subgraph(root, {
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

      expect(result.nodes.length).toBe(2);
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

      const collection = requireDefined(mbStore.nodes[multibyteKindName]);
      const root = await collection.create({ value: "root" });
      const child = await collection.create({ value: "child" });
      await mbStore.edges.mb_link.create(root, child);

      const result = await mbStore.subgraph(root, {
        edges: ["mb_link"] as never,
        maxDepth: 1,
        project: {
          nodes: { [multibyteKindName]: ["value"] } as never,
        },
      });

      expect(result.nodes.length).toBe(2);
      for (const node of result.nodes) {
        expect((node as Record<string, unknown>)["value"]).toBeDefined();
      }
    });

    it("rejects reserved node keys in projection", async () => {
      // "meta" is excluded — it's a valid projection field handled separately
      const reservedNodeKeys = ["id", "kind"];
      for (const key of reservedNodeKeys) {
        await expect(
          store.subgraph(
            { kind: "Run", id: ids.runId },
            {
              edges: ["has_task"],
              maxDepth: 1,
              project: {
                nodes: {
                  Task: [key] as never,
                },
              },
            },
          ),
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
          store.subgraph(
            { kind: "Run", id: ids.runId },
            {
              edges: ["has_task"],
              maxDepth: 1,
              project: {
                edges: {
                  has_task: [key] as never,
                },
              },
            },
          ),
        ).rejects.toThrow(/reserved structural key/);
      }
    });

    it("rejects prototype-pollution keys in projection", async () => {
      const dangerousKeys = ["__proto__", "constructor", "prototype"];
      for (const key of dangerousKeys) {
        await expect(
          store.subgraph(
            { kind: "Run", id: ids.runId },
            {
              edges: ["has_task"],
              maxDepth: 1,
              project: {
                nodes: {
                  Task: [key] as never,
                },
              },
            },
          ),
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

      const result = await store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task", "uses_skill"],
          maxDepth: 2,
          includeKinds: ["Task", "Skill"],
          project,
        },
      );

      for (const node of result.nodes) {
        if (node.kind === "Task") {
          const title: string = node.title;
          void title;
          expectTypeOf(node).not.toHaveProperty("status");
          expectTypeOf(node).not.toHaveProperty("meta");
        }
      }

      const allEdges = result.edges;
      for (const edge of allEdges) {
        if (edge.kind === "uses_skill") {
          const priority: number = edge.priority;
          void priority;
          expectTypeOf(edge).not.toHaveProperty("meta");
        }
      }
    });
  });
});

// ============================================================
// Temporal Behavior
// ============================================================
//
// subgraph() honors graph.defaults.temporalMode with per-call overrides.

describe("store.subgraph temporal behavior", () => {
  const { PAST, BEFORE, EDGE_ENDED, FUTURE } = TEMPORAL_ANCHORS;

  type TemporalFixture = Readonly<{
    runId: NodeId<typeof Run>;
    activeTaskId: NodeId<typeof Task>;
    endedTaskId: NodeId<typeof Task>;
    futureTaskId: NodeId<typeof Task>;
    tombstoneTaskId: NodeId<typeof Task>;
    futureEdgeTargetId: NodeId<typeof Task>;
  }>;

  let backend: GraphBackend;
  let store: Store<TestGraph>;
  let ids: TemporalFixture;

  beforeEach(async () => {
    backend = createTestBackend();
    store = createStore(testGraph, backend);

    const [run, active, ended, future, tombstone, futureEdgeTarget] =
      await Promise.all([
        store.nodes.Run.create({ name: "r" }, { validFrom: PAST }),
        store.nodes.Task.create(
          { title: "active", status: "ok" },
          { validFrom: PAST },
        ),
        store.nodes.Task.create(
          { title: "ended", status: "done" },
          { validFrom: PAST, validTo: EDGE_ENDED },
        ),
        store.nodes.Task.create(
          { title: "future", status: "pending" },
          { validFrom: FUTURE },
        ),
        store.nodes.Task.create(
          { title: "tombstone", status: "done" },
          { validFrom: PAST },
        ),
        // Currently-valid target node; we'll attach a future-only edge to it
        // below to exercise the edge-validity path independent of node validity.
        store.nodes.Task.create(
          { title: "futureEdgeTarget", status: "ok" },
          { validFrom: PAST },
        ),
      ]);

    // Always-valid, ended, and node-future-only edges.
    await Promise.all([
      store.edges.has_task.create(run, active, {}, { validFrom: PAST }),
      store.edges.has_task.create(
        run,
        ended,
        {},
        { validFrom: PAST, validTo: EDGE_ENDED },
      ),
      store.edges.has_task.create(run, future, {}),
      // Edge has validFrom = FUTURE but target node is currently valid.
      // Distinguishes edge-level validity from node-level validity.
      store.edges.has_task.create(
        run,
        futureEdgeTarget,
        {},
        { validFrom: FUTURE },
      ),
    ]);

    // Tombstone setup: create edge → delete edge → delete node so both
    // the edge and the target surface only under includeTombstones.
    const tombstoneEdge = await store.edges.has_task.create(
      run,
      tombstone,
      {},
      { validFrom: PAST },
    );
    await store.edges.has_task.delete(tombstoneEdge.id);
    await store.nodes.Task.delete(tombstone.id);

    ids = {
      runId: run.id,
      activeTaskId: active.id,
      endedTaskId: ended.id,
      futureTaskId: future.id,
      tombstoneTaskId: tombstone.id,
      futureEdgeTargetId: futureEdgeTarget.id,
    };
  });

  it("defaults to current mode — excludes ended and future entities", async () => {
    const result = await store.subgraph(
      { kind: "Run", id: ids.runId },
      {
        edges: ["has_task"],
        maxDepth: 1,
      },
    );
    const index = indexSubgraph(result);

    expect(index.node({ kind: "Task", id: ids.activeTaskId })).toBeDefined();
    expect(index.node({ kind: "Task", id: ids.endedTaskId })).toBeUndefined();
    expect(index.node({ kind: "Task", id: ids.futureTaskId })).toBeUndefined();
  });

  it("asOf = BEFORE surfaces the historically-valid task and edge", async () => {
    const result = await store.subgraph(
      { kind: "Run", id: ids.runId },
      {
        edges: ["has_task"],
        maxDepth: 1,
        temporalMode: "asOf",
        asOf: BEFORE,
      },
    );
    const index = indexSubgraph(result);

    // Active and ended were both valid at BEFORE; future was not.
    expect(index.node({ kind: "Task", id: ids.activeTaskId })).toBeDefined();
    expect(index.node({ kind: "Task", id: ids.endedTaskId })).toBeDefined();
    expect(index.node({ kind: "Task", id: ids.futureTaskId })).toBeUndefined();
  });

  it("rejects non-canonical asOf timestamps", async () => {
    await expect(
      store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
          temporalMode: "asOf",
          asOf: "2021-01-01T00:00:00Z",
        },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects current + asOf instead of pinning the instant", async () => {
    // Pinning an instant is only meaningful in asOf mode; the subgraph CTE
    // resolves current via the DB clock and would drop the pin. Reject it so
    // the contract matches collection, query(), algorithms, and StoreView.
    await expect(
      store.subgraph(
        { kind: "Run", id: ids.runId },
        {
          edges: ["has_task"],
          maxDepth: 1,
          temporalMode: "current",
          asOf: BEFORE,
        },
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("includeEnded traverses through validity-ended rows", async () => {
    const result = await store.subgraph(
      { kind: "Run", id: ids.runId },
      {
        edges: ["has_task"],
        maxDepth: 1,
        temporalMode: "includeEnded",
      },
    );
    const index = indexSubgraph(result);

    // Ended rows surface; deleted tombstone does not.
    expect(index.node({ kind: "Task", id: ids.activeTaskId })).toBeDefined();
    expect(index.node({ kind: "Task", id: ids.endedTaskId })).toBeDefined();
    expect(index.node({ kind: "Task", id: ids.futureTaskId })).toBeDefined();
    expect(
      index.node({ kind: "Task", id: ids.tombstoneTaskId }),
    ).toBeUndefined();
  });

  it("includeTombstones surfaces soft-deleted nodes and edges", async () => {
    const result = await store.subgraph(
      { kind: "Run", id: ids.runId },
      {
        edges: ["has_task"],
        maxDepth: 1,
        temporalMode: "includeTombstones",
      },
    );
    const index = indexSubgraph(result);

    // Everything shows up under includeTombstones.
    expect(index.node({ kind: "Task", id: ids.activeTaskId })).toBeDefined();
    expect(index.node({ kind: "Task", id: ids.endedTaskId })).toBeDefined();
    expect(index.node({ kind: "Task", id: ids.futureTaskId })).toBeDefined();
    expect(index.node({ kind: "Task", id: ids.tombstoneTaskId })).toBeDefined();
    expect(
      index.node({ kind: "Task", id: ids.futureEdgeTargetId }),
    ).toBeDefined();
  });

  it("excludes edges with future validFrom under current mode", async () => {
    // The edge run→futureEdgeTarget has validFrom: FUTURE even though the
    // target node is currently valid. Under current mode, neither the edge
    // nor (therefore) the target should appear in the traversal result.
    const result = await store.subgraph(
      { kind: "Run", id: ids.runId },
      {
        edges: ["has_task"],
        maxDepth: 1,
      },
    );
    const index = indexSubgraph(result);
    expect(
      index.node({ kind: "Task", id: ids.futureEdgeTargetId }),
    ).toBeUndefined();
  });

  it("surfaces edges with future validFrom under includeEnded", async () => {
    // `includeEnded` only filters `deleted_at IS NULL` — it ignores both
    // ends of the validity window, so future-valid edges participate too.
    const result = await store.subgraph(
      { kind: "Run", id: ids.runId },
      {
        edges: ["has_task"],
        maxDepth: 1,
        temporalMode: "includeEnded",
      },
    );
    const index = indexSubgraph(result);
    expect(
      index.node({ kind: "Task", id: ids.futureEdgeTargetId }),
    ).toBeDefined();
  });

  it("respects graph.defaults.temporalMode when no per-call override", async () => {
    const endedDefaultsGraph = defineGraph({
      id: "subgraph_temporal_ended_defaults",
      nodes: { Run: { type: Run }, Task: { type: Task } },
      edges: { has_task: { type: hasTask, from: [Run], to: [Task] } },
      defaults: { temporalMode: "includeEnded" },
    });
    const altStore = createStore(endedDefaultsGraph, createTestBackend());

    const [run, ended] = await Promise.all([
      altStore.nodes.Run.create({ name: "r" }, { validFrom: PAST }),
      altStore.nodes.Task.create(
        { title: "ended", status: "done" },
        { validFrom: PAST, validTo: EDGE_ENDED },
      ),
    ]);
    await altStore.edges.has_task.create(
      run,
      ended,
      {},
      { validFrom: PAST, validTo: EDGE_ENDED },
    );

    // No per-call override — graph's includeEnded default applies.
    const result = await altStore.subgraph(run, {
      edges: ["has_task"],
      maxDepth: 1,
    });
    const index = indexSubgraph(result);
    expect(index.node(ended)).toBeDefined();
  });
});
