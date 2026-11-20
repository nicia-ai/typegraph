/** SQL set operations, derived aggregates, typed preparation, and bounded streaming. */
import { createStoreWithSchema, defineGraph, defineNode, expr } from "@nicia-ai/typegraph";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

const Purchase = defineNode("Purchase", { schema: z.object({ customer: z.string(), amount: z.number() }) });
const graph = defineGraph({ id: "relation_example", nodes: { Purchase: { type: Purchase } }, edges: {} });

async function main(): Promise<void> {
  const backend = createExampleBackend();
  try {
    const [store] = await createStoreWithSchema(graph, backend);
    for (const purchase of [{ customer: "Ada", amount: 100 }, { customer: "Ada", amount: 50 }, { customer: "Bea", amount: 80 }])
      await store.nodes.Purchase.create(purchase);

    const totals = store.query().from("Purchase", "purchase")
      .groupBy((fields) => [fields.purchase.customer])
      .aggregate((fields) => ({ customer: fields.purchase.customer, total: expr.sum(fields.purchase.amount) }))
      .asRelation();
    const parameters = { minimum: expr.param("minimum", "number") };
    const prepared = totals.where((columns) => expr.gt(columns.total, parameters.minimum)).prepare(parameters);
    const [largeCustomers, grandTotal] = await store.batchOnce(() => [
      prepared.bind({ minimum: 100 }),
      totals.aggregate((columns) => ({ total: expr.sum(columns.total) })),
    ] as const);
    console.log("Large customers:", largeCustomers);
    console.log("Grand total:", grandTotal);

    const names = store.query().from("Purchase", "purchase")
      .project((fields) => ({ customer: fields.purchase.customer })).asRelation();
    console.log("Distinct union:", await names.union(names).orderBy((columns) => columns.customer).execute());
    for await (const row of names.distinct().orderBy((columns) => columns.customer).stream({ pageSize: 1 }))
      console.log("Customer:", row.customer);
  } finally {
    await backend.close();
  }
}

await main();
