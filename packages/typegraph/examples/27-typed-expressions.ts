/**
 * Example 27: Typed Database Expressions
 *
 * Demonstrates database-side filtering, arithmetic, projection, aggregation,
 * and post-execution mapping with schema-checked expression callbacks.
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  expr,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    department: z.string(),
    age: z.number(),
    score: z.number().optional(),
  }),
});

const graph = defineGraph({
  id: "typed_expression_example",
  nodes: { Person: { type: Person } },
  edges: {},
});

async function main(): Promise<void> {
  const backend = createExampleBackend();

  try {
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Person.create({
      age: 36,
      department: "Engineering",
      name: "Ada",
      score: 94,
    });
    await store.nodes.Person.create({
      age: 29,
      department: "Engineering",
      name: "Grace",
    });
    await store.nodes.Person.create({
      age: 17,
      department: "Research",
      name: "Linus",
      score: 88,
    });

    const labels = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (_person, expressions) =>
        expr.gte(expressions.p.age, expr.literal(18)),
      )
      .project((expressions) => ({
        ageNextYear: expr.add(expressions.p.age, expr.literal(1)),
        name: expressions.p.name,
        score: expr.coalesce(expressions.p.score, expr.literal(0)),
      }))
      .orderBy((expressions) => expressions.p.age, "desc")
      .map(
        (row) =>
          `${row.name}: age ${row.ageNextYear}, score ${row.score}`,
      )
      .execute();

    console.log("Adults:");
    for (const label of labels) console.log(`  ${label}`);

    const departments = await store
      .query()
      .from("Person", "p")
      .groupBy((expressions) => [expressions.p.department])
      .aggregate((expressions) => ({
        averageAge: expr.avg(expressions.p.age),
        department: expressions.p.department,
        people: expr.count(expressions.p.id),
      }))
      .execute();

    console.log("Departments:", departments);
  } finally {
    await backend.close();
  }
}

await main();
