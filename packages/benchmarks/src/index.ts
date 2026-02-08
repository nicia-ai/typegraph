import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Bench } from "tinybench";
import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type NodeId,
} from "@nicia-ai/typegraph";
import {
  createSqliteBackend,
  getSqliteMigrationSQL,
} from "@nicia-ai/typegraph/sqlite";
import { z } from "zod";

// ============================================================
// Setup
// ============================================================

const NodeA = defineNode("NodeA", {
  schema: z.object({
    name: z.string(),
    value: z.number(),
  }),
});

const NodeB = defineNode("NodeB", {
  schema: z.object({
    name: z.string(),
  }),
});

const link = defineEdge("link", {
  from: [NodeA],
  to: [NodeB],
});

const graph = defineGraph({
  id: "bench_graph",
  nodes: {
    NodeA: { type: NodeA },
    NodeB: { type: NodeB },
  },
  edges: {
    link: { type: link, from: [NodeA], to: [NodeB] },
  },
});

// Setup DB
const sqlite = new Database(":memory:");
const db = drizzle(sqlite);
sqlite.exec(getSqliteMigrationSQL());

const backend = createSqliteBackend(db);
const store = createStore(graph, backend);

// Pre-populate data
const NODE_COUNT = 1000;
console.log(`Pre-populating ${NODE_COUNT} nodes...`);

const ids: NodeId<typeof NodeA>[] = [];

await store.transaction(async (tx) => {
  for (let i = 0; i < NODE_COUNT; i++) {
    const node = await tx.nodes.NodeA.create({
      name: `Node ${i}`,
      value: i,
    });
    ids.push(node.id);
  }
});

console.log("Starting benchmarks...");

const bench = new Bench({ time: 1000 });

bench
  .add("Create Node", async () => {
    await store.nodes.NodeB.create({
      name: "Bench Node",
    });
  })
  .add("Read Node by ID", async () => {
    // Read a random node
    const id = ids[Math.floor(Math.random() * ids.length)];
    await store.nodes.NodeA.getById(id!);
  })
  .add("Simple Query (Filter)", async () => {
    await store
      .query()
      .from("NodeA", "n")
      .whereNode("n", (n) => n.value.gt(500))
      .limit(10)
      .select((ctx) => ctx.n)
      .execute();
  });

await bench.run();

console.table(bench.table());
