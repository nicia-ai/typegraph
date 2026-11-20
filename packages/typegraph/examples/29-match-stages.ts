/** Demonstrates optional match constraints, completed filters, and recursive stopping. */
import assert from "node:assert/strict";

import { createStoreWithSchema, defineEdge, defineGraph, defineNode, expr } from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows");
const graph = defineGraph({
  id: "match_stages_example",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

async function main(): Promise<void> {
  const backend = createExampleBackend();
  try {
    const [store] = await createStoreWithSchema(graph, backend);
    const ada = await store.nodes.Person.create({ name: "Ada" });
    const bea = await store.nodes.Person.create({ name: "Bea" });
    const cara = await store.nodes.Person.create({ name: "Cara" });
    await store.edges.knows.create(ada, bea, {});
    await store.edges.knows.create(bea, cara, {});

    const optional = store.query().from("Person", "root")
      .optionalTraverse("knows", "edge", { expand: "none" }).to("Person", "friend");
    const constrained = optional.whereNode("friend", (friend) => friend.name.eq("Cara"));
    const completed = optional.where((fields) => expr.eq(fields.friend.name, expr.literal("Cara")));
    // Match constraints retain every root; completed comparisons remove absent/nonmatching rows.
    assert.equal(await constrained.count(), 3);
    assert.equal(await completed.count(), 1);

    const recursive = store.query().from("Person", "root")
      .whereNode("root", (root) => root.id.eq(ada.id))
      .traverse("knows", "edge", { expand: "none" }).recursive({ maxHops: 3 })
      .to("Person", "friend");
    const endpoints = await recursive.where((fields) => expr.eq(fields.friend.name, expr.literal("Cara")))
      .select((row) => row.friend.name).execute();
    const stopped = await recursive.stopExpansion("friend", (friend) => friend.name.eq("Bea"))
      .select((row) => row.friend.name).execute();
    assert.deepEqual(endpoints, ["Cara"]);
    assert.deepEqual(stopped, ["Bea"]);
    console.log({ endpoints, stopped });
  } finally {
    await backend.close();
  }
}

await main();
