/** Ordered and filtered scalar collections over optional child rows. */
import assert from "node:assert/strict";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  expr,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

const Project = defineNode("Project", {
  schema: z.object({ name: z.string() }),
});
const Task = defineNode("Task", {
  schema: z.object({
    title: z.string(),
    priority: z.number(),
    completed: z.boolean(),
  }),
});
const hasTask = defineEdge("hasTask", { schema: z.object({}) });
const graph = defineGraph({
  id: "ordered_collections_example",
  nodes: { Project: { type: Project }, Task: { type: Task } },
  edges: { hasTask: { type: hasTask, from: [Project], to: [Task] } },
});

async function main(): Promise<void> {
  const backend = createExampleBackend();
  try {
    const [store] = await createStoreWithSchema(graph, backend);
    const launch = await store.nodes.Project.create({ name: "Launch" });
    await store.nodes.Project.create({ name: "Research" });
    const tasks = await store.nodes.Task.bulkCreate([
      { props: { title: "Write announcement", priority: 3, completed: false } },
      { props: { title: "Fix blocker", priority: 1, completed: true } },
      { props: { title: "Run rehearsal", priority: 2, completed: false } },
    ]);
    for (const task of tasks)
      await store.edges.hasTask.create(launch, task, {});

    const projectTasks = store
      .query()
      .from("Project", "project")
      .optionalTraverse("hasTask", "assignment")
      .to("Task", "task")
      .project((fields) => ({
        projectName: fields.project.name,
        taskId: fields.task.id,
        title: fields.task.title,
        priority: fields.task.priority,
        completed: fields.task.completed,
      }))
      .asRelation();

    const parameters = {
      includeCompleted: expr.param("includeCompleted", "boolean"),
    };
    const prepared = projectTasks
      .groupBy((columns) => [columns.projectName])
      .aggregate((columns) => ({
        project: columns.projectName,
        tasks: expr.collect(columns.title, {
          orderBy: [
            { expression: columns.priority },
            { expression: columns.taskId },
          ],
          filter: expr.and(
            expr.isNotNull(columns.taskId),
            expr.or(
              expr.eq(parameters.includeCompleted, expr.literal(true)),
              expr.eq(columns.completed, expr.literal(false)),
            ),
          ),
        }),
      }))
      .orderBy((columns) => columns.project)
      .prepare(parameters);

    const [openTasks, allTasks] = await store.batchOnce(() => [
      prepared.bind({ includeCompleted: false }),
      prepared.bind({ includeCompleted: true }),
    ]);
    assert.deepEqual(openTasks, [
      { project: "Launch", tasks: ["Run rehearsal", "Write announcement"] },
      { project: "Research", tasks: [] },
    ]);
    assert.deepEqual(allTasks, [
      {
        project: "Launch",
        tasks: ["Fix blocker", "Run rehearsal", "Write announcement"],
      },
      { project: "Research", tasks: [] },
    ]);
    console.log(openTasks);
  } finally {
    await backend.close();
  }
}

await main();
