/**
 * Per-transaction overhead bench: the fixed cost `store.transaction` adds
 * around the work it runs, isolated from the work itself.
 *
 * Two loops on an in-memory better-sqlite3 store:
 *
 * - `transaction-overhead:empty` — `TRANSACTIONS` empty transactions, one
 *   after another: what opening, binding and committing a transaction costs.
 * - `transaction-overhead:single-insert` — `TRANSACTIONS` transactions that
 *   each create one node: the same cost on the most common write shape.
 *
 * Each loop runs `WARMUP_ITERATIONS` unmeasured rounds and then
 * `SAMPLE_ITERATIONS` measured ones, each on a fresh store, and reports the
 * median and the fastest round in milliseconds per loop.
 *
 * Run:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:transaction-overhead
 */
import { createStore, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { z } from "zod";

import { formatMs, median, nowMs } from "./utils";

const TRANSACTIONS = 5000;
const WARMUP_ITERATIONS = 2;
const SAMPLE_ITERATIONS = 9;

const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});

const overheadGraph = defineGraph({
  id: "transaction_overhead",
  nodes: { Item: { type: Item } },
  edges: {},
});

type OverheadStore = ReturnType<typeof createStore<typeof overheadGraph>>;

type Loop = Readonly<{
  label: string;
  run: (store: OverheadStore) => Promise<void>;
}>;

const LOOPS: readonly Loop[] = [
  {
    label: "transaction-overhead:empty",
    async run(store) {
      for (let index = 0; index < TRANSACTIONS; index += 1) {
        await store.transaction(async () => {
          // Nothing: the loop measures the transaction alone.
        });
      }
    },
  },
  {
    label: "transaction-overhead:single-insert",
    async run(store) {
      for (let index = 0; index < TRANSACTIONS; index += 1) {
        await store.transaction(async (tx) => {
          await tx.nodes.Item.create({ label: `item-${index}` });
        });
      }
    },
  },
];

async function measureOnce(loop: Loop): Promise<number> {
  const { backend } = createLocalSqliteBackend();
  try {
    const store = createStore(overheadGraph, backend);
    // The first write provisions what the graph needs; keep it out of the
    // measured loop.
    await store.transaction(async () => {
      // Warms the transaction path once.
    });
    const started = nowMs();
    await loop.run(store);
    return nowMs() - started;
  } finally {
    await backend.close();
  }
}

async function main(): Promise<void> {
  for (const loop of LOOPS) {
    for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
      await measureOnce(loop);
    }
    const samples: number[] = [];
    for (let index = 0; index < SAMPLE_ITERATIONS; index += 1) {
      samples.push(await measureOnce(loop));
    }
    console.log(
      `${loop.label} (${TRANSACTIONS} transactions): median ${formatMs(median(samples))}, fastest ${formatMs(Math.min(...samples))}`,
    );
  }
}

await main();
