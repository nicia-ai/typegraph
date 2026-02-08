---
title: Workflow Engine
description: State machines with approvals, assignments, and escalations
---

This example builds a workflow engine with:

- **State machine definitions** as graph schemas
- **Approval chains** with multiple approvers
- **Task assignment** and delegation
- **Escalation rules** based on time
- **Audit trail** of all state changes

## Schema Definition

```typescript
import { z } from "zod";
import { defineNode, defineEdge, defineGraph, implies } from "@nicia-ai/typegraph";

// Workflow definition (template)
const WorkflowDefinition = defineNode("WorkflowDefinition", {
  schema: z.object({
    name: z.string(),
    description: z.string().optional(),
    version: z.number().int().positive(),
    isActive: z.boolean().default(true),
  }),
});

// States within a workflow
const State = defineNode("State", {
  schema: z.object({
    name: z.string(),
    type: z.enum(["initial", "intermediate", "terminal", "approval"]),
    config: z.record(z.unknown()).optional(), // State-specific config
  }),
});

// Transitions between states
const Transition = defineNode("Transition", {
  schema: z.object({
    name: z.string(),
    condition: z.string().optional(), // Expression to evaluate
    requiredRole: z.string().optional(),
  }),
});

// Workflow instances
const WorkflowInstance = defineNode("WorkflowInstance", {
  schema: z.object({
    referenceId: z.string(), // ID of the entity being processed
    referenceType: z.string(), // Type of entity (e.g., "PurchaseOrder")
    status: z.enum(["active", "completed", "cancelled", "failed"]).default("active"),
    data: z.record(z.unknown()).optional(), // Instance-specific data
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  }),
});

// Tasks assigned to users
const Task = defineNode("Task", {
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    type: z.enum(["action", "approval", "review", "notification"]),
    status: z.enum(["pending", "in_progress", "completed", "rejected", "escalated"]).default("pending"),
    dueDate: z.string().datetime().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
    result: z.record(z.unknown()).optional(),
    completedAt: z.string().datetime().optional(),
  }),
});

// Users
const User = defineNode("User", {
  schema: z.object({
    email: z.string().email(),
    name: z.string(),
    role: z.string(),
    department: z.string().optional(),
  }),
});

// Comments on tasks
const Comment = defineNode("Comment", {
  schema: z.object({
    content: z.string(),
    createdAt: z.string().datetime(),
  }),
});

// Edges
const hasState = defineEdge("hasState");
const hasTransition = defineEdge("hasTransition");
const fromState = defineEdge("fromState");
const toState = defineEdge("toState");
const usesDefinition = defineEdge("usesDefinition");
const currentState = defineEdge("currentState");
const hasTask = defineEdge("hasTask");
const assignedTo = defineEdge("assignedTo");
const createdBy = defineEdge("createdBy");
const hasComment = defineEdge("hasComment");
const reportsTo = defineEdge("reportsTo"); // For escalation chain

// Graph
const graph = defineGraph({
  id: "workflow_engine",
  nodes: {
    WorkflowDefinition: { type: WorkflowDefinition },
    State: { type: State },
    Transition: { type: Transition },
    WorkflowInstance: { type: WorkflowInstance },
    Task: { type: Task },
    User: { type: User },
    Comment: { type: Comment },
  },
  edges: {
    hasState: { type: hasState, from: [WorkflowDefinition], to: [State] },
    hasTransition: { type: hasTransition, from: [WorkflowDefinition], to: [Transition] },
    fromState: { type: fromState, from: [Transition], to: [State] },
    toState: { type: toState, from: [Transition], to: [State] },
    usesDefinition: { type: usesDefinition, from: [WorkflowInstance], to: [WorkflowDefinition] },
    currentState: { type: currentState, from: [WorkflowInstance], to: [State] },
    hasTask: { type: hasTask, from: [WorkflowInstance], to: [Task] },
    assignedTo: { type: assignedTo, from: [Task], to: [User] },
    createdBy: { type: createdBy, from: [Task, Comment, WorkflowInstance], to: [User] },
    hasComment: { type: hasComment, from: [Task], to: [Comment] },
    reportsTo: { type: reportsTo, from: [User], to: [User] },
  },
  ontology: [
    // Escalation implies assignment
    implies(reportsTo, assignedTo),
  ],
});
```

## Workflow Definition

### Create Approval Workflow

```typescript
async function createApprovalWorkflow(): Promise<Node<typeof WorkflowDefinition>> {
  return store.transaction(async (tx) => {
    // Create workflow definition
    const workflow = await tx.nodes.WorkflowDefinition.create({
      name: "Purchase Order Approval",
      description: "Multi-level approval for purchase orders",
      version: 1,
      isActive: true,
    });

    // Create states
    const states = {
      draft: await tx.nodes.State.create({
        name: "Draft",
        type: "initial",
      }),
      pendingManagerApproval: await tx.nodes.State.create({
        name: "Pending Manager Approval",
        type: "approval",
        config: { approverRole: "manager", timeout: "48h" },
      }),
      pendingFinanceApproval: await tx.nodes.State.create({
        name: "Pending Finance Approval",
        type: "approval",
        config: { approverRole: "finance", timeout: "24h" },
      }),
      approved: await tx.nodes.State.create({
        name: "Approved",
        type: "terminal",
      }),
      rejected: await tx.nodes.State.create({
        name: "Rejected",
        type: "terminal",
      }),
    };

    // Link states to workflow
    for (const state of Object.values(states)) {
      await tx.edges.hasState.create(workflow, state, {});
    }

    // Create transitions
    const transitions = [
      {
        from: states.draft,
        to: states.pendingManagerApproval,
        name: "Submit",
        requiredRole: "requester",
      },
      {
        from: states.pendingManagerApproval,
        to: states.pendingFinanceApproval,
        name: "Approve",
        requiredRole: "manager",
        condition: "amount > 1000",
      },
      {
        from: states.pendingManagerApproval,
        to: states.approved,
        name: "Approve",
        requiredRole: "manager",
        condition: "amount <= 1000",
      },
      {
        from: states.pendingManagerApproval,
        to: states.rejected,
        name: "Reject",
        requiredRole: "manager",
      },
      {
        from: states.pendingFinanceApproval,
        to: states.approved,
        name: "Approve",
        requiredRole: "finance",
      },
      {
        from: states.pendingFinanceApproval,
        to: states.rejected,
        name: "Reject",
        requiredRole: "finance",
      },
    ];

    for (const t of transitions) {
      const transition = await tx.nodes.Transition.create({
        name: t.name,
        requiredRole: t.requiredRole,
        condition: t.condition,
      });

      await tx.edges.hasTransition.create(workflow, transition, {});
      await tx.edges.fromState.create(transition, t.from, {});
      await tx.edges.toState.create(transition, t.to, {});
    }

    return workflow;
  });
}
```

## Workflow Instances

### Start Workflow

```typescript
interface StartWorkflowInput {
  workflowName: string;
  referenceId: string;
  referenceType: string;
  data?: Record<string, unknown>;
  createdByUserId: string;
}

async function startWorkflow(input: StartWorkflowInput): Promise<Node<typeof WorkflowInstance>> {
  return store.transaction(async (tx) => {
    // Find workflow definition
    const workflow = await tx
      .query()
      .from("WorkflowDefinition", "w")
      .whereNode("w", (w) => w.name.eq(input.workflowName).and(w.isActive.eq(true)))
      .select((ctx) => ctx.w)
      .first();

    if (!workflow) {
      throw new Error(`Workflow '${input.workflowName}' not found`);
    }

    // Find initial state
    const initialState = await tx
      .query()
      .from("WorkflowDefinition", "w")
      .whereNode("w", (w) => w.id.eq(workflow.id))
      .traverse("hasState", "e")
      .to("State", "s")
      .whereNode("s", (s) => s.type.eq("initial"))
      .select((ctx) => ctx.s)
      .first();

    if (!initialState) {
      throw new Error("Workflow has no initial state");
    }

    // Create instance
    const instance = await tx.nodes.WorkflowInstance.create({
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      status: "active",
      data: input.data,
      createdAt: new Date().toISOString(),
    });

    // Link to definition and state
    await tx.edges.usesDefinition.create(instance, workflow, {});
    await tx.edges.currentState.create(instance, initialState, {});

    // Link to creator
    const creator = await tx.nodes.User.getById(input.createdByUserId);
    if (!creator) throw new Error(`User not found: ${input.createdByUserId}`);
    await tx.edges.createdBy.create(instance, creator, {});

    return instance;
  });
}
```

### Get Available Transitions

```typescript
interface AvailableTransition {
  id: string;
  name: string;
  targetState: string;
  requiredRole?: string;
  condition?: string;
}

async function getAvailableTransitions(
  instanceId: string,
  userId: string
): Promise<AvailableTransition[]> {
  // Get user's role
  const user = await store.nodes.User.getById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);
  const userRole = user.role;

  // Get current state
  const currentState = await store
    .query()
    .from("WorkflowInstance", "i")
    .whereNode("i", (i) => i.id.eq(instanceId))
    .traverse("currentState", "e")
    .to("State", "s")
    .select((ctx) => ctx.s)
    .first();

  if (!currentState) {
    throw new Error("Instance has no current state");
  }

  // Get transitions from current state
  const transitions = await store
    .query()
    .from("State", "s")
    .whereNode("s", (s) => s.id.eq(currentState.id))
    .traverse("fromState", "e1", { direction: "in" })
    .to("Transition", "t")
    .traverse("toState", "e2")
    .to("State", "target")
    .select((ctx) => ({
      id: ctx.t.id,
      name: ctx.t.name,
      targetState: ctx.target.name,
      requiredRole: ctx.t.requiredRole,
      condition: ctx.t.condition,
    }))
    .execute();

  // Filter by role
  return transitions.filter(
    (t) => !t.requiredRole || t.requiredRole === userRole || userRole === "admin"
  );
}
```

### Execute Transition

```typescript
async function executeTransition(
  instanceId: string,
  transitionId: string,
  userId: string,
  result?: Record<string, unknown>
): Promise<void> {
  await store.transaction(async (tx) => {
    const instance = await tx.nodes.WorkflowInstance.getById(instanceId);
    if (!instance) throw new Error(`WorkflowInstance not found: ${instanceId}`);

    if (instance.status !== "active") {
      throw new Error("Workflow is not active");
    }

    // Verify transition is valid
    const available = await getAvailableTransitions(instanceId, userId);
    const transition = available.find((t) => t.id === transitionId);

    if (!transition) {
      throw new Error("Transition not available");
    }

    // Get target state
    const targetState = await tx
      .query()
      .from("Transition", "t")
      .whereNode("t", (t) => t.id.eq(transitionId))
      .traverse("toState", "e")
      .to("State", "s")
      .select((ctx) => ctx.s)
      .first();

    // Remove current state edge
    const currentStateEdge = await tx
      .query()
      .from("WorkflowInstance", "i")
      .whereNode("i", (i) => i.id.eq(instanceId))
      .traverse("currentState", "e")
      .to("State", "s")
      .select((ctx) => ctx.e.id)
      .first();

    if (currentStateEdge) {
      await tx.edges.currentState.delete(currentStateEdge);
    }

    // Add new state edge
    await tx.edges.currentState.create(instance, targetState!, {});

    // Update instance data
    const updatedData = { ...instance.data, lastTransition: transition.name, ...result };
    const updates: Partial<WorkflowInstanceProps> = { data: updatedData };

    // Check if terminal state
    if (targetState!.type === "terminal") {
      updates.status = "completed";
      updates.completedAt = new Date().toISOString();
    }

    await tx.nodes.WorkflowInstance.update(instanceId, updates);

    // Complete any pending tasks
    const pendingTasks = await tx
      .query()
      .from("WorkflowInstance", "i")
      .whereNode("i", (i) => i.id.eq(instanceId))
      .traverse("hasTask", "e")
      .to("Task", "t")
      .whereNode("t", (t) => t.status.in(["pending", "in_progress"]))
      .select((ctx) => ctx.t.id)
      .execute();

    for (const taskId of pendingTasks) {
      await tx.nodes.Task.update(taskId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
    }

    // Create tasks for new state if needed
    if (targetState!.type === "approval") {
      await createApprovalTask(tx, instanceId, targetState!, userId);
    }
  });
}
```

## Task Management

### Create Approval Task

```typescript
async function createApprovalTask(
  tx: Transaction,
  instanceId: string,
  state: Node<typeof State>,
  requesterId: string
): Promise<void> {
  const config = state.config as { approverRole: string; timeout: string } | undefined;
  if (!config) return;

  // Find approver (first user with matching role, or requester's manager)
  let approver = await tx
    .query()
    .from("User", "u")
    .whereNode("u", (u) => u.role.eq(config.approverRole))
    .select((ctx) => ctx.u)
    .first();

  // If no direct match, find in reporting chain
  if (!approver) {
    approver = await tx
      .query()
      .from("User", "requester")
      .whereNode("requester", (u) => u.id.eq(requesterId))
      .traverse("reportsTo", "e")
      .recursive()
      .to("User", "manager")
      .whereNode("manager", (u) => u.role.eq(config.approverRole))
      .select((ctx) => ctx.manager)
      .first();
  }

  if (!approver) {
    throw new Error(`No approver found with role '${config.approverRole}'`);
  }

  // Calculate due date
  const dueDate = calculateDueDate(config.timeout);

  // Create task
  const task = await tx.nodes.Task.create({
    title: `Approval Required: ${state.name}`,
    description: `Please review and approve or reject.`,
    type: "approval",
    status: "pending",
    priority: "medium",
    dueDate: dueDate.toISOString(),
  });

  // Link task to instance and approver
  const instance = await tx.nodes.WorkflowInstance.getById(instanceId);
  if (!instance) throw new Error(`WorkflowInstance not found: ${instanceId}`);
  await tx.edges.hasTask.create(instance, task, {});
  await tx.edges.assignedTo.create(task, approver, {});
}

function calculateDueDate(timeout: string): Date {
  const now = new Date();
  const match = timeout.match(/^(\d+)(h|d)$/);

  if (!match) return new Date(now.getTime() + 24 * 60 * 60 * 1000); // Default 24h

  const value = parseInt(match[1], 10);
  const unit = match[2];

  if (unit === "h") {
    return new Date(now.getTime() + value * 60 * 60 * 1000);
  } else {
    return new Date(now.getTime() + value * 24 * 60 * 60 * 1000);
  }
}
```

### Get User's Tasks

```typescript
interface TaskWithContext {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  dueDate?: string;
  workflowName: string;
  referenceId: string;
  referenceType: string;
}

async function getUserTasks(
  userId: string,
  status?: "pending" | "in_progress"
): Promise<TaskWithContext[]> {
  let query = store
    .query()
    .from("User", "u")
    .whereNode("u", (u) => u.id.eq(userId))
    .traverse("assignedTo", "e", { direction: "in" })
    .to("Task", "t");

  if (status) {
    query = query.whereNode("t", (t) => t.status.eq(status));
  } else {
    query = query.whereNode("t", (t) => t.status.in(["pending", "in_progress"]));
  }

  return query
    .traverse("hasTask", "e2", { direction: "in" })
    .to("WorkflowInstance", "i")
    .traverse("usesDefinition", "e3")
    .to("WorkflowDefinition", "w")
    .select((ctx) => ({
      id: ctx.t.id,
      title: ctx.t.title,
      type: ctx.t.type,
      status: ctx.t.status,
      priority: ctx.t.priority,
      dueDate: ctx.t.dueDate,
      workflowName: ctx.w.name,
      referenceId: ctx.i.referenceId,
      referenceType: ctx.i.referenceType,
    }))
    .orderBy((ctx) => ctx.t.dueDate, "asc")
    .execute();
}
```

### Complete Task

```typescript
async function completeTask(
  taskId: string,
  userId: string,
  decision: "approve" | "reject",
  comment?: string
): Promise<void> {
  await store.transaction(async (tx) => {
    const task = await tx.nodes.Task.getById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    // Verify user is assigned
    const assignee = await tx
      .query()
      .from("Task", "t")
      .whereNode("t", (t) => t.id.eq(taskId))
      .traverse("assignedTo", "e")
      .to("User", "u")
      .select((ctx) => ctx.u.id)
      .first();

    if (assignee !== userId) {
      throw new Error("User is not assigned to this task");
    }

    // Update task
    await tx.nodes.Task.update(taskId, {
      status: decision === "approve" ? "completed" : "rejected",
      completedAt: new Date().toISOString(),
      result: { decision },
    });

    // Add comment if provided
    if (comment) {
      const commentNode = await tx.nodes.Comment.create({
        content: comment,
        createdAt: new Date().toISOString(),
      });
      await tx.edges.hasComment.create(task, commentNode, {});

      const user = await tx.nodes.User.getById(userId);
      if (!user) throw new Error(`User not found: ${userId}`);
      await tx.edges.createdBy.create(commentNode, user, {});
    }

    // Get workflow instance
    const instance = await tx
      .query()
      .from("Task", "t")
      .whereNode("t", (t) => t.id.eq(taskId))
      .traverse("hasTask", "e", { direction: "in" })
      .to("WorkflowInstance", "i")
      .select((ctx) => ctx.i)
      .first();

    // Find and execute the appropriate transition
    const transitions = await getAvailableTransitions(instance!.id, userId);
    const transition = transitions.find((t) =>
      decision === "approve" ? t.name === "Approve" : t.name === "Reject"
    );

    if (transition) {
      await executeTransition(instance!.id, transition.id, userId, { decision });
    }
  });
}
```

## Escalation

### Check Overdue Tasks

```typescript
async function getOverdueTasks(): Promise<Array<{ task: TaskProps; assignee: UserProps }>> {
  const now = new Date().toISOString();

  return store
    .query()
    .from("Task", "t")
    .whereNode("t", (t) =>
      t.status
        .in(["pending", "in_progress"])
        .and(t.dueDate.isNotNull())
        .and(t.dueDate.lt(now))
    )
    .traverse("assignedTo", "e")
    .to("User", "u")
    .select((ctx) => ({
      task: ctx.t,
      assignee: ctx.u,
    }))
    .execute();
}
```

### Escalate Task

```typescript
async function escalateTask(taskId: string): Promise<void> {
  await store.transaction(async (tx) => {
    // Get current assignee
    const currentAssignment = await tx
      .query()
      .from("Task", "t")
      .whereNode("t", (t) => t.id.eq(taskId))
      .traverse("assignedTo", "e")
      .to("User", "u")
      .select((ctx) => ({ edgeId: ctx.e.id, user: ctx.u }))
      .first();

    if (!currentAssignment) {
      throw new Error("Task has no assignee");
    }

    // Find manager in reporting chain
    const manager = await tx
      .query()
      .from("User", "u")
      .whereNode("u", (u) => u.id.eq(currentAssignment.user.id))
      .traverse("reportsTo", "e")
      .to("User", "manager")
      .select((ctx) => ctx.manager)
      .first();

    if (!manager) {
      throw new Error("No manager found for escalation");
    }

    // Update task
    await tx.nodes.Task.update(taskId, {
      status: "escalated",
      priority: "urgent",
    });

    // Reassign to manager
    await tx.edges.assignedTo.delete(currentAssignment.edgeId);
    const task = await tx.nodes.Task.getById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    await tx.edges.assignedTo.create(task, manager, {});

    // Add escalation comment
    const comment = await tx.nodes.Comment.create({
      content: `Task escalated from ${currentAssignment.user.name} due to timeout`,
      createdAt: new Date().toISOString(),
    });
    await tx.edges.hasComment.create(task, comment, {});
  });
}
```

### Run Escalation Job

```typescript
async function runEscalationJob(): Promise<{ escalated: number }> {
  const overdueTasks = await getOverdueTasks();
  let escalated = 0;

  for (const { task } of overdueTasks) {
    try {
      await escalateTask(task.id);
      escalated++;
    } catch (error) {
      console.error(`Failed to escalate task ${task.id}:`, error);
    }
  }

  return { escalated };
}
```

## Workflow History

### Get Instance Timeline

```typescript
interface TimelineEvent {
  timestamp: string;
  type: "state_change" | "task_created" | "task_completed" | "comment";
  description: string;
  actor?: string;
}

async function getInstanceTimeline(instanceId: string): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = [];

  // Get state change history using temporal queries
  const stateHistory = await store
    .query()
    .from("WorkflowInstance", "i")
    .temporal("includeEnded")
    .whereNode("i", (i) => i.id.eq(instanceId))
    .traverse("currentState", "e")
    .to("State", "s")
    .orderBy((ctx) => ctx.e.validFrom, "asc")
    .select((ctx) => ({
      stateName: ctx.s.name,
      timestamp: ctx.e.validFrom,
    }))
    .execute();

  for (const state of stateHistory) {
    events.push({
      timestamp: state.timestamp,
      type: "state_change",
      description: `Entered state: ${state.stateName}`,
    });
  }

  // Get task events
  const tasks = await store
    .query()
    .from("WorkflowInstance", "i")
    .whereNode("i", (i) => i.id.eq(instanceId))
    .traverse("hasTask", "e")
    .to("Task", "t")
    .optionalTraverse("assignedTo", "a")
    .to("User", "u")
    .select((ctx) => ({
      title: ctx.t.title,
      status: ctx.t.status,
      createdAt: ctx.t.createdAt,
      completedAt: ctx.t.completedAt,
      assignee: ctx.u?.name,
    }))
    .execute();

  for (const task of tasks) {
    events.push({
      timestamp: task.createdAt.toISOString(),
      type: "task_created",
      description: `Task created: ${task.title}`,
      actor: task.assignee,
    });

    if (task.completedAt) {
      events.push({
        timestamp: task.completedAt,
        type: "task_completed",
        description: `Task ${task.status}: ${task.title}`,
        actor: task.assignee,
      });
    }
  }

  // Sort by timestamp
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
```

## Next Steps

- [Document Management](/examples/document-management) - CMS with semantic search
- [Product Catalog](/examples/product-catalog) - Categories, variants, inventory
- [Audit Trail](/examples/audit-trail) - Complete change tracking
