/**
 * Runtime Discriminated Union Type Tests (Issue #32)
 *
 * Verifies that AnyNode<G>, AnyEdge<G>, SubsetNode<G, K>, and SubsetEdge<G, K>
 * produce correct discriminated unions that narrow via `kind`.
 *
 * Tests split into two sections:
 * - Compile-time: type assignability and @ts-expect-error checks (no runtime setup)
 * - Runtime: kind-based narrowing with actual store data
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AnyEdge,
  type AnyNode,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type Edge,
  type Node,
  type Store,
  type SubsetEdge,
  type SubsetNode,
} from "../src";
import type { GraphBackend } from "../src/backend/types";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Graph
// ============================================================

const Task = defineNode("Task", {
  schema: z.object({
    name: z.string(),
    status: z.enum(["pending", "done"]),
  }),
});

const Agent = defineNode("Agent", {
  schema: z.object({
    name: z.string(),
    model: z.string(),
  }),
});

const Skill = defineNode("Skill", {
  schema: z.object({
    name: z.string(),
    version: z.number(),
  }),
});

const assignedTo = defineEdge("assignedTo", {
  schema: z.object({ priority: z.number() }),
});

const hasSkill = defineEdge("hasSkill");

const graph = defineGraph({
  id: "union_type_test",
  nodes: {
    Task: { type: Task },
    Agent: { type: Agent },
    Skill: { type: Skill },
  },
  edges: {
    assignedTo: { type: assignedTo, from: [Task], to: [Agent] },
    hasSkill: { type: hasSkill, from: [Agent], to: [Skill] },
  },
});

type G = typeof graph;

// ============================================================
// Compile-time type assignability
// ============================================================

describe("AnyNode<G> (compile-time)", () => {
  it("accepts any individual Node type", () => {
    void ({} as Node<typeof Task> satisfies AnyNode<G>);
    void ({} as Node<typeof Agent> satisfies AnyNode<G>);
    void ({} as Node<typeof Skill> satisfies AnyNode<G>);

    // @ts-expect-error — AnyNode cannot be assigned to a specific Node without narrowing
    void ({} as AnyNode<G> satisfies Node<typeof Task>);

    expect(true).toBe(true);
  });
});

describe("AnyEdge<G> (compile-time)", () => {
  it("accepts any individual Edge type", () => {
    void ({} as Edge<typeof assignedTo> satisfies AnyEdge<G>);
    void ({} as Edge<typeof hasSkill> satisfies AnyEdge<G>);

    // @ts-expect-error — AnyEdge cannot be assigned to a specific Edge without narrowing
    void ({} as AnyEdge<G> satisfies Edge<typeof assignedTo>);

    expect(true).toBe(true);
  });
});

describe("SubsetNode<G, K> (compile-time)", () => {
  it("single-kind subset is equivalent to Node<T>", () => {
    type JustTask = SubsetNode<G, "Task">;
    type TaskNode = Node<typeof Task>;

    void ({} as JustTask satisfies TaskNode);
    void ({} as TaskNode satisfies JustTask);

    expect(true).toBe(true);
  });

  it("rejects node kinds not in the subset", () => {
    type TaskOrAgent = SubsetNode<G, "Task" | "Agent">;

    // @ts-expect-error — Skill is not in the subset
    void ({} as Node<typeof Skill> satisfies TaskOrAgent);

    expect(true).toBe(true);
  });
});

describe("SubsetEdge<G, K> (compile-time)", () => {
  it("rejects edge kinds not in the subset", () => {
    type JustAssigned = SubsetEdge<G, "assignedTo">;

    // @ts-expect-error — hasSkill is not in the subset
    void ({} as Edge<typeof hasSkill> satisfies JustAssigned);

    expect(true).toBe(true);
  });
});

// ============================================================
// Runtime narrowing with store data
// ============================================================

describe("runtime narrowing", () => {
  let backend: GraphBackend;
  let store: Store<typeof graph>;

  beforeEach(() => {
    backend = createTestBackend();
    store = createStore(graph, backend);
  });

  it("AnyNode narrows to exact node type via kind discriminant", async () => {
    const task = await store.nodes.Task.create({
      name: "Ship feature",
      status: "pending",
    });
    const agent = await store.nodes.Agent.create({
      name: "Coordinator",
      model: "gpt-4",
    });
    const skill = await store.nodes.Skill.create({
      name: "coding",
      version: 2,
    });

    // All three are assignable to AnyNode<G>
    const nodes: AnyNode<G>[] = [task, agent, skill];
    expect(nodes).toHaveLength(3);

    // Narrowing via kind gives access to schema-specific properties
    expect(task.kind).toBe("Task");
    expect(task.status satisfies "pending" | "done").toBe("pending");
    expect(task.name).toBe("Ship feature");

    expect(agent.kind).toBe("Agent");
    expect(agent.model satisfies string).toBe("gpt-4");

    expect(skill.kind).toBe("Skill");
    expect(skill.version satisfies number).toBe(2);
  });

  it("AnyEdge narrows to exact edge type via kind discriminant", async () => {
    const task = await store.nodes.Task.create({
      name: "Deploy",
      status: "pending",
    });
    const agent = await store.nodes.Agent.create({
      name: "Runner",
      model: "gpt-4",
    });
    const skill = await store.nodes.Skill.create({
      name: "ops",
      version: 1,
    });

    const assigned = await store.edges.assignedTo.create(task, agent, {
      priority: 5,
    });
    const skilled = await store.edges.hasSkill.create(agent, skill);

    // Both are assignable to AnyEdge<G>
    const edges: AnyEdge<G>[] = [assigned, skilled];
    expect(edges).toHaveLength(2);

    expect(assigned.kind).toBe("assignedTo");
    expect(assigned.priority satisfies number).toBe(5);

    expect(skilled.kind).toBe("hasSkill");
  });

  it("SubsetNode restricts union to specified kinds", async () => {
    const task = await store.nodes.Task.create({
      name: "Review PR",
      status: "done",
    });
    const agent = await store.nodes.Agent.create({
      name: "Reviewer",
      model: "claude",
    });

    type TaskOrAgent = SubsetNode<G, "Task" | "Agent">;

    const subset: TaskOrAgent[] = [task, agent];
    expect(subset).toHaveLength(2);

    expect(task.status satisfies "pending" | "done").toBe("done");
    expect(agent.model satisfies string).toBe("claude");
  });

  it("SubsetEdge restricts union to specified edge kinds", async () => {
    const task = await store.nodes.Task.create({
      name: "Write tests",
      status: "pending",
    });
    const agent = await store.nodes.Agent.create({
      name: "Tester",
      model: "gpt-4",
    });

    const assigned = await store.edges.assignedTo.create(task, agent, {
      priority: 1,
    });

    type JustAssigned = SubsetEdge<G, "assignedTo">;
    const subset: JustAssigned[] = [assigned];

    expect(subset).toHaveLength(1);
    expect(assigned.priority).toBe(1);
  });
});
