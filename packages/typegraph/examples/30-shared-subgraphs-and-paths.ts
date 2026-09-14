/** Overlapping subgraph batches and independently tracked recursive path stages. */
import assert from "node:assert/strict";

import { createStoreWithSchema, defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), biography: z.string() }),
});
const knows = defineEdge("knows");
const graph = defineGraph({
  id: "shared_subgraphs_and_paths_example",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

async function main(): Promise<void> {
  const backend = createExampleBackend();
  try {
    const [store] = await createStoreWithSchema(graph, backend);
    const ada = await store.nodes.Person.create({ name: "Ada", biography: "Ada's biography. ".repeat(256) });
    const bea = await store.nodes.Person.create({ name: "Bea", biography: "Bea's biography. ".repeat(256) });
    const cara = await store.nodes.Person.create({ name: "Cara", biography: "Cara's biography. ".repeat(256) });
    await store.edges.knows.create(ada, bea, {});
    await store.edges.knows.create(bea, cara, {});

    // One statement retrieves both bounded neighborhoods. Shared hydration is
    // useful here because they overlap and include substantial property data.
    // Measure your workload before opting in; disjoint roots can transfer more.
    const roots = [ada.id, bea.id];
    const subgraphs = await store.batchOnce(
      (read) => roots.map((root) => read.subgraph(root, { edges: ["knows"], maxDepth: 2 })),
      { shareSubgraphs: true },
    );
    assert.equal(subgraphs.length, 2);
    assert.equal(subgraphs[0]?.nodes.has(cara.id), true);
    assert.equal(subgraphs[1]?.nodes.has(cara.id), true);

    const paths = await store.query().from("Person", "root")
      .whereNode("root", (person) => person.id.eq(ada.id))
      .traverse("knows", "firstEdge", { expand: "none" })
      .recursive({ minHops: 1, maxHops: 1, path: { format: "qualified" }, depth: true })
      .to("Person", "middle")
      .traverse("knows", "secondEdge", { expand: "none" })
      .recursive({ minHops: 1, maxHops: 1, path: { format: "qualified" }, depth: true })
      .to("Person", "leaf")
      .select((row) => ({
        name: row.leaf.name,
        firstPath: row.middle_path,
        secondPath: row.leaf_path,
        firstDepth: row.middle_depth,
        secondDepth: row.leaf_depth,
      }))
      .execute();
    assert.equal(paths.length, 1);
    const path = paths[0];
    assert.ok(path);
    assert.equal(path.name, "Cara");
    assert.equal(path.firstDepth, 1);
    assert.equal(path.secondDepth, 1);
    assert.equal(path.firstPath.length, 3);
    assert.equal(path.secondPath.length, 3);
    // Fixed hops and recursion share one completed-match pipeline.
    const mixed = await store.query().from("Person", "root")
      .whereNode("root", (person) => person.id.eq(ada.id))
      .traverse("knows", "directEdge", { expand: "none" })
      .to("Person", "directFriend")
      .traverse("knows", "pathEdge", { expand: "none" })
      .recursive({ minHops: 1, maxHops: 2, depth: true })
      .to("Person", "friend")
      .select((row) => ({ name: row.friend.name, directEdgeId: row.directEdge.id, depth: row.friend_depth }))
      .execute();
    assert.equal(mixed.length, 1);
    assert.equal(mixed[0]?.name, "Cara");

    // Cara has no outgoing path; the optional first stage still returns her.
    const optional = await store.query().from("Person", "root")
      .whereNode("root", (person) => person.id.eq(cara.id))
      .optionalTraverse("knows", "pathEdge", { expand: "none" })
      .recursive({ minHops: 1, maxHops: 2, path: { format: "qualified" }, depth: true })
      .to("Person", "friend")
      .select((row) => ({ name: row.root.name, friend: row.friend?.name, path: row.friend_path, depth: row.friend_depth }))
      .execute();
    assert.deepEqual(optional, [{ name: "Cara", friend: undefined, path: undefined, depth: undefined }]);

    console.log({ roots: subgraphs.map((subgraph) => subgraph.root?.name), paths });
  } finally {
    await backend.close();
  }
}

await main();
