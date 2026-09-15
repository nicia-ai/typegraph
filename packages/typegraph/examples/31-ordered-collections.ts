/** Ordered scalar collections over projected relations. */
import assert from "node:assert/strict";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  expr,
} from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

const Purchase = defineNode("Purchase", {
  schema: z.object({
    customer: z.string(),
    amount: z.number(),
    sequence: z.number(),
  }),
});
const graph = defineGraph({
  id: "ordered_collections_example",
  nodes: { Purchase: { type: Purchase } },
  edges: {},
});

async function main(): Promise<void> {
  const backend = createExampleBackend();
  try {
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Purchase.bulkCreate([
      { props: { customer: "Ada", amount: 50, sequence: 2 } },
      { props: { customer: "Ada", amount: 100, sequence: 1 } },
      { props: { customer: "Ada", amount: 50, sequence: 3 } },
      { props: { customer: "Bea", amount: 80, sequence: 1 } },
    ]);
    const purchases = store
      .query()
      .from("Purchase", "purchase")
      .project((fields) => ({
        id: fields.purchase.id,
        customer: fields.purchase.customer,
        amount: fields.purchase.amount,
        sequence: fields.purchase.sequence,
      }))
      .asRelation();
    const grouped = purchases
      .groupBy((columns) => [columns.customer])
      .aggregate((columns) => ({
        customer: columns.customer,
        amounts: expr.collect(columns.amount, {
          orderBy: [
            { expression: columns.sequence },
            { expression: columns.id },
          ],
        }),
      }))
      .orderBy((columns) => columns.customer);
    // Collection order is independent of result-row order. Duplicates remain.
    assert.deepEqual(await grouped.execute(), [
      { customer: "Ada", amounts: [100, 50, 50] },
      { customer: "Bea", amounts: [80] },
    ]);
    const parameters = { minimum: expr.param("minimum", "number") };
    const prepared = purchases
      .where((columns) => expr.gte(columns.amount, parameters.minimum))
      .aggregate((columns) => ({
        amounts: expr.collect(columns.amount, {
          orderBy: [{ expression: columns.amount }, { expression: columns.id }],
        }),
      }))
      .prepare(parameters);
    const [empty, bounded] = await store.batchOnce(() => [
      prepared.bind({ minimum: 1000 }),
      prepared.bind({ minimum: 80 }),
    ]);
    assert.deepEqual(empty, [{ amounts: [] }]);
    assert.deepEqual(bounded, [{ amounts: [80, 100] }]);
    console.log(await grouped.execute());
  } finally {
    await backend.close();
  }
}

await main();
