/** Run: node --import tsx packages/typegraph/scripts/measure-mutation-planning.ts */
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { createMutationPlanBuilder, unwrap } from "../src/graph-merge";
import { requireDefined } from "../src/utils/presence";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "mutation_measurement",
  nodes: { Item: { type: Item } },
  edges: {},
});

for (const size of [100, 1000, 10_000]) {
  const base = createLocalSqliteBackend().backend;
  let rowsRead = 0;
  function readMembers(
    base: Pick<
      GraphBackend,
      "getNode" | "getNodes" | "findNodesByKind" | "findNodesAcrossKinds"
    >,
  ): Pick<
    GraphBackend,
    "getNode" | "getNodes" | "findNodesByKind" | "findNodesAcrossKinds"
  > {
    return {
      async getNode(...args) {
        const row = await base.getNode(...args);
        rowsRead += row === undefined ? 0 : 1;
        return row;
      },
      async getNodes(...args) {
        const rows = await requireDefined(base.getNodes)(...args);
        rowsRead += rows.length;
        return rows;
      },
      async findNodesByKind(params) {
        const rows = await base.findNodesByKind(params);
        rowsRead += rows.length;
        return rows;
      },
      async findNodesAcrossKinds(params) {
        const rows = await requireDefined(base.findNodesAcrossKinds)(params);
        rowsRead += rows.length;
        return rows;
      },
    };
  }
  const backend = deriveBackend(base, {
    ...readMembers(base),
    transaction(callback, options) {
      return base.transaction(
        (tx) => callback(deriveBackend(tx, readMembers(tx))),
        options,
      );
    },
  });
  const [store] = await createStoreWithSchema(graph, backend, {
    history: true,
  });
  try {
    await store.nodes.Item.bulkCreate(
      Array.from({ length: size }, (_, index) => ({
        id: `item-${index}`,
        props: { name: `item-${index}` },
      })),
    );
    const builderBase = await createMutationPlanBuilder(store, "measurement");
    const builder = builderBase
      .updateNode("Item", "item-0", { name: "updated" })
      .createNode("Item", "created", { name: "created" })
      .deleteNode("Item", "item-1");
    for (const planningScope of ["candidate", "full"] as const) {
      rowsRead = 0;
      const start = performance.now();
      unwrap(
        await builder.plan({
          planningScope,
          makeBackend: () =>
            Promise.resolve(createLocalSqliteBackend().backend),
        }),
      );
      console.log(
        JSON.stringify({
          size,
          planningScope,
          rowsRead,
          milliseconds: Math.round(performance.now() - start),
        }),
      );
    }
  } finally {
    await store.close();
  }
}
