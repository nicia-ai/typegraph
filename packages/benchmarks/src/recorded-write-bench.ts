/**
 * Opt-in regression bench: the cost of `history: true` on the WRITE path.
 *
 * Not part of default CI. Run explicitly:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:recorded-write
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:recorded-write:postgres
 *
 * Isolates recorded-time capture overhead by running identical write workloads
 * against two stores per backend — one created with `{ history: true }`, one
 * without — on an otherwise minimal graph (no indexes, fulltext, or vector) so
 * the only difference measured is capture. The headline it validates: per-op
 * un-batched writes pay a real multiple under capture (per-write transaction +
 * per-graph clock lock + recorded flush), but batching them in one
 * `store.transaction(...)` amortizes that to near-nothing — the guidance the
 * recorded-time docs give, backed by these numbers.
 */
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import {
  createSqliteBackend,
  createSqliteTables,
  generateSqliteDDL,
} from "@nicia-ai/typegraph/adapters/drizzle/sqlite";

import { median, nowMs } from "./utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number() }),
});
const Knows = defineEdge("Knows", {
  schema: z.object({ since: z.number() }),
});
const graph = defineGraph({
  id: "recorded-write-bench",
  nodes: { Person: { type: Person } },
  edges: { Knows: { type: Knows, from: [Person], to: [Person] } },
});

const OPERATION_COUNT = 400;

type BenchStore = ReturnType<typeof createStore<typeof graph>>;
type PersonId = Awaited<
  ReturnType<BenchStore["nodes"]["Person"]["create"]>
>["id"];

type StoreResources = Readonly<{
  store: BenchStore;
  close: () => Promise<void>;
}>;

type Workload = Readonly<{
  label: string;
  /** Returns the representative per-op latency in milliseconds. */
  run: (store: BenchStore) => Promise<number>;
}>;

type ScenarioResult = Readonly<{
  label: string;
  off: number;
  on: number;
  ratio: number;
}>;

async function timeEachOp(
  count: number,
  op: (index: number) => Promise<void>,
): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < count; index++) {
    const start = nowMs();
    await op(index);
    samples.push(nowMs() - start);
  }
  return median(samples);
}

async function seedPeople(
  store: BenchStore,
  count: number,
  prefix: string,
): Promise<readonly PersonId[]> {
  const ids: PersonId[] = [];
  for (let index = 0; index < count; index++) {
    const node = await store.nodes.Person.create({
      name: `${prefix}${index}`,
      age: index,
    });
    ids.push(node.id);
  }
  return ids;
}

const WORKLOADS: readonly Workload[] = [
  {
    label: "create (un-batched, per-op)",
    run: (store) =>
      timeEachOp(OPERATION_COUNT, async (index) => {
        await store.nodes.Person.create({ name: `c${index}`, age: index });
      }),
  },
  {
    label: "create (batched in 1 txn, per-op)",
    run: async (store) => {
      const start = nowMs();
      await store.transaction(async (tx) => {
        for (let index = 0; index < OPERATION_COUNT; index++) {
          await tx.nodes.Person.create({ name: `b${index}`, age: index });
        }
      });
      return (nowMs() - start) / OPERATION_COUNT;
    },
  },
  {
    label: "update (un-batched, per-op)",
    run: async (store) => {
      const ids = await seedPeople(store, OPERATION_COUNT, "u");
      return timeEachOp(OPERATION_COUNT, async (index) => {
        await store.nodes.Person.update(ids[index]!, { age: index + 1000 });
      });
    },
  },
  {
    label: "soft delete (un-batched, per-op)",
    run: async (store) => {
      const ids = await seedPeople(store, OPERATION_COUNT, "d");
      return timeEachOp(OPERATION_COUNT, async (index) => {
        await store.nodes.Person.delete(ids[index]!);
      });
    },
  },
];

async function makeSqlite(history: boolean): Promise<StoreResources> {
  const tables = createSqliteTables({});
  const sqlite = new Database(":memory:");
  for (const statement of generateSqliteDDL(tables)) sqlite.exec(statement);
  const backend = createSqliteBackend(drizzleSqlite(sqlite), {
    executionProfile: { isSync: true },
    tables,
  });
  await backend.ensureRuntimeContributions?.(graph.id);
  const store = createStore(
    graph,
    backend,
    history ? { history: true } : undefined,
  );
  return {
    store,
    close: async () => {
      sqlite.close();
    },
  };
}

const POSTGRES_RESET_DDL = `
  DROP TABLE IF EXISTS typegraph_recorded_clock CASCADE;
  DROP TABLE IF EXISTS typegraph_recorded_edges CASCADE;
  DROP TABLE IF EXISTS typegraph_recorded_nodes CASCADE;
  DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
  DROP TABLE IF EXISTS typegraph_node_fulltext CASCADE;
  DROP TABLE IF EXISTS typegraph_edges CASCADE;
  DROP TABLE IF EXISTS typegraph_nodes CASCADE;
  DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
`;

async function makePostgres(
  pool: Pool,
  history: boolean,
): Promise<StoreResources> {
  await pool.query(POSTGRES_RESET_DDL);
  const tables = createPostgresTables({});
  await pool.query(generatePostgresMigrationSQL(tables));
  const backend = createPostgresBackend(drizzleNodePostgres(pool), { tables });
  await backend.ensureRuntimeContributions?.(graph.id);
  const store = createStore(
    graph,
    backend,
    history ? { history: true } : undefined,
  );
  return {
    store,
    close: async () => {
      await backend.close();
    },
  };
}

async function runScenarios(
  make: (history: boolean) => Promise<StoreResources>,
): Promise<readonly ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const workload of WORKLOADS) {
    const off = await make(false);
    const offMs = await workload.run(off.store);
    await off.close();

    const on = await make(true);
    const onMs = await workload.run(on.store);
    await on.close();

    results.push({
      label: workload.label,
      off: offMs,
      on: onMs,
      ratio: onMs / offMs,
    });
  }
  return results;
}

function printTable(name: string, results: readonly ScenarioResult[]): void {
  console.log(`\n### ${name} (N=${OPERATION_COUNT} per scenario)\n`);
  console.log(
    `${"scenario".padEnd(34)} ${"history off".padStart(12)} ${"history on".padStart(12)} ${"on/off".padStart(8)}`,
  );
  console.log("-".repeat(70));
  for (const row of results) {
    console.log(
      `${row.label.padEnd(34)} ${`${row.off.toFixed(3)}ms`.padStart(12)} ${`${row.on.toFixed(3)}ms`.padStart(12)} ${`${row.ratio.toFixed(1)}x`.padStart(8)}`,
    );
  }
}

async function main(): Promise<void> {
  printTable(
    "SQLite (:memory:)",
    await runScenarios((history) => makeSqlite(history)),
  );

  if (!process.argv.includes("--postgres")) return;

  const url = process.env["POSTGRES_URL"];
  if (url === undefined) {
    console.log(
      "\n(--postgres given but POSTGRES_URL unset — skipping Postgres lane)",
    );
    return;
  }
  const pool = new Pool({ connectionString: url });
  try {
    printTable(
      "PostgreSQL",
      await runScenarios((history) => makePostgres(pool, history)),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
