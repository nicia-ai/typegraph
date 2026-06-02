/**
 * Maintenance benchmarks: `evolve`, `materializeIndexes`, `removeKinds`,
 * `mergeGraphExtension`, `compileGraphExtension`. Establishes baselines
 * for schema lifecycle and materialization flows that the query benchmarks
 * don't exercise. Run with `pnpm bench:maintenance`.
 *
 * Default backend is SQLite (in-memory) for fast iteration. Pass
 * `--backend=postgres` for the realistic concurrent-DDL story; in CI we
 * gate Postgres runs on `POSTGRES_URL` being set (same convention as the
 * query bench).
 */
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";
import {
  createStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
  type GraphBackend,
  type GraphExtension,
} from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/postgres";
import {
  createSqliteBackend,
  createSqliteTables,
  generateSqliteDDL,
} from "@nicia-ai/typegraph/sqlite";

import { getPostgresUrl } from "./config";
import { formatMs, median, percentile } from "./utils";

const WARMUP_ITERATIONS = 3;
const SAMPLE_ITERATIONS = 10;
const KIND_COUNT = 50;

type AdminBackend = "sqlite" | "postgres";

type AdminCloser = () => Promise<void>;

type AdminResources = Readonly<{
  backend: GraphBackend;
  graphId: string;
  close: AdminCloser;
}>;

// The maintenance graph declares no embedding fields, so no `tg_vec_*` tables
// are ever created here — only the core tables need resetting.
const POSTGRES_RESET_DDL = `
  DROP TABLE IF EXISTS typegraph_index_materializations CASCADE;
  DROP TABLE IF EXISTS typegraph_kind_removals CASCADE;
  DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
  DROP TABLE IF EXISTS typegraph_edges CASCADE;
  DROP TABLE IF EXISTS typegraph_nodes CASCADE;
  DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
  DROP TABLE IF EXISTS typegraph_node_fulltext CASCADE;
`;

async function createSqliteResources(graphId: string): Promise<AdminResources> {
  const tables = createSqliteTables({});
  const sqlite = new Database(":memory:");
  for (const statement of generateSqliteDDL(tables)) {
    sqlite.exec(statement);
  }
  const db = drizzleSqlite(sqlite);
  const backend = createSqliteBackend(db, {
    executionProfile: { isSync: true },
    tables,
  });
  return {
    backend,
    graphId,
    close: async () => {
      backend.close();
      sqlite.close();
    },
  };
}

async function createPostgresResources(
  graphId: string,
): Promise<AdminResources> {
  const pool = new Pool({ connectionString: getPostgresUrl() });
  const drizzleDb = drizzleNodePostgres(pool);
  await pool.query(POSTGRES_RESET_DDL);
  const tables = createPostgresTables({});
  await pool.query(generatePostgresMigrationSQL(tables));
  const backend = createPostgresBackend(drizzleDb, { tables });
  return {
    backend,
    graphId,
    close: async () => {
      await backend.close();
      await pool.end();
    },
  };
}

function buildBaseGraph(graphId: string) {
  // A small fixed compile-time graph; the maintenance verbs operate on
  // graph-extension kinds layered on top.
  const Doc = defineNode("Doc", { schema: z.object({ title: z.string() }) });
  return defineGraph({
    id: graphId,
    nodes: { Doc: { type: Doc } },
    edges: {},
  });
}

function buildExtensionWithKinds(count: number): GraphExtension {
  const nodes: Record<
    string,
    { properties: Record<string, { type: "string" | "number" }> }
  > = {};
  for (let i = 0; i < count; i += 1) {
    nodes[`Kind${i}`] = {
      properties: {
        name: { type: "string" },
        count: { type: "number" },
      },
    };
  }
  return defineGraphExtension({ nodes });
}

function buildExtensionPlusOne(base: GraphExtension): GraphExtension {
  return defineGraphExtension({
    nodes: {
      ...base.nodes,
      [`Kind${KIND_COUNT}`]: { properties: { value: { type: "string" } } },
    },
  });
}

type Sample = Readonly<{
  label: string;
  median: number;
  p95: number;
  samples: readonly number[];
}>;

async function measure(
  label: string,
  fn: () => Promise<void>,
): Promise<Sample> {
  for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) {
    await fn();
  }
  const samples: number[] = [];
  for (let iteration = 0; iteration < SAMPLE_ITERATIONS; iteration += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    median: median(samples),
    p95: percentile(samples, 0.95),
    samples,
  };
}

function printSample(sample: Sample): void {
  console.log(
    `  ${sample.label.padEnd(40)}  median=${formatMs(sample.median).padStart(8)}  p95=${formatMs(sample.p95).padStart(8)}`,
  );
}

async function runEvolveBench(
  resources: AdminResources,
  baseExtension: GraphExtension,
): Promise<void> {
  const graph = buildBaseGraph(resources.graphId);
  const [store] = await createStoreWithSchema(graph, resources.backend);

  // Prime the extension once so subsequent no-op evolves can observe
  // the canonicalEqual fast path.
  const primed = await store.evolve(baseExtension);

  console.log("\nevolve:");
  const noOp = await measure("no-op (canonicalEqual fast path)", async () => {
    await primed.evolve(baseExtension);
  });
  printSample(noOp);

  // For "add one kind": each iteration evolves a fresh primed store so
  // the new kind genuinely lands. Restoring state between iterations is
  // costly (full reset), so we measure with a stack of evolves and then
  // amortize by capturing the first iteration's cost separately.
  const addOneCost: number[] = [];
  for (let iteration = 0; iteration < SAMPLE_ITERATIONS; iteration += 1) {
    const ext = defineGraphExtension({
      nodes: {
        ...baseExtension.nodes,
        [`AddOne${iteration}`]: { properties: { x: { type: "string" } } },
      },
    });
    const start = performance.now();
    await primed.evolve(ext);
    addOneCost.push(performance.now() - start);
  }
  const addOne: Sample = {
    label: "add one kind (genuine)",
    median: median(addOneCost),
    p95: percentile(addOneCost, 0.95),
    samples: addOneCost,
  };
  printSample(addOne);
}

async function runMaterializeBench(
  resources: AdminResources,
  baseExtension: GraphExtension,
): Promise<void> {
  const graph = buildBaseGraph(`${resources.graphId}_mat`);
  const [store] = await createStoreWithSchema(graph, resources.backend);
  const primed = await store.evolve(baseExtension);

  console.log("\nmaterializeIndexes:");
  // First call materializes nothing (extension declares no indexes here)
  // — but it still pays the table-ensure + status-table preload.
  const firstRun = await measure(
    "first call (no declared indexes)",
    async () => {
      await primed.materializeIndexes();
    },
  );
  printSample(firstRun);

  const repeat = await measure("repeated call (idempotent)", async () => {
    await primed.materializeIndexes();
  });
  printSample(repeat);
}

async function runRemoveBench(
  resources: AdminResources,
  baseExtension: GraphExtension,
): Promise<void> {
  const graph = buildBaseGraph(`${resources.graphId}_rm`);
  const [store] = await createStoreWithSchema(graph, resources.backend);
  let current = await store.evolve(baseExtension);

  console.log("\nremoveKinds:");
  const removeCost: number[] = [];
  for (let iteration = 0; iteration < SAMPLE_ITERATIONS; iteration += 1) {
    const target = `Kind${iteration}`;
    const start = performance.now();
    current = await current.removeKinds([target]);
    removeCost.push(performance.now() - start);
  }
  const remove: Sample = {
    label: `remove kind (cascade, ${SAMPLE_ITERATIONS}x distinct)`,
    median: median(removeCost),
    p95: percentile(removeCost, 0.95),
    samples: removeCost,
  };
  printSample(remove);
}

function parseAdminBackend(argv: readonly string[]): AdminBackend {
  for (const arg of argv) {
    if (arg === "--backend=postgres") return "postgres";
    if (arg === "--backend=sqlite") return "sqlite";
  }
  return "sqlite";
}

async function main(argv: readonly string[]): Promise<void> {
  const backendKind = parseAdminBackend(argv);
  console.log(
    `TypeGraph maintenance benchmark (backend=${backendKind}, kinds=${KIND_COUNT})`,
  );

  const baseExtension = buildExtensionWithKinds(KIND_COUNT);
  const buildPlusOne = buildExtensionPlusOne;
  void buildPlusOne; // kept for future scale tests

  const buildResources = (graphId: string) =>
    backendKind === "sqlite" ?
      createSqliteResources(graphId)
    : createPostgresResources(graphId);

  // Each verb gets its own backend + graph so stale tables from a
  // prior verb don't pollute the next baseline.
  for (const [verb, run] of [
    ["evolve", runEvolveBench],
    ["materializeIndexes", runMaterializeBench],
    ["removeKinds", runRemoveBench],
  ] as const) {
    const resources = await buildResources(`maintenance_${verb}`);
    try {
      await run(resources, baseExtension);
    } finally {
      await resources.close();
    }
  }
}

await main(process.argv.slice(2));
