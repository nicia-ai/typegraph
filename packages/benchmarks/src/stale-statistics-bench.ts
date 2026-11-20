/**
 * Stale-statistics write benchmark (PostgreSQL).
 *
 * Reproduces a bulk load into a large shared nodes table: the table is
 * pre-filled with rows of other graphs and kinds and analyzed, autovacuum is
 * disabled on the TypeGraph tables, and then a batch of fresh nodes of one
 * kind is inserted through the store with NO analyze, so the planner believes
 * the target `(graph_id, kind)` holds almost nothing. Each scenario then runs
 * a set-wise write over those fresh rows and reports the time of every
 * statement it issued, grouped by statement shape, plus the
 * `EXPLAIN (ANALYZE, BUFFERS)` of the slowest one.
 *
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:stale-statistics
 *
 * Flags:
 *
 * - `--scenario=update-where|siblings|slope|analyze-cost|all` (default
 *   `update-where`)
 * - `--sizes=1000,2500,5000,10000,20000` — the fresh-row counts N
 * - `--prefill=300000` — rows of other graphs and kinds
 * - `--fresh` — also run every N after `ANALYZE` (the "fresh" column)
 * - `--explain` — print the plan of each N's slowest statement
 * - `--print-sql` — print the text of each N's slowest statement
 * - `--sqlite` — run the same scenarios on in-memory SQLite (time only)
 * - `--statement-timeout=600000` — per-statement cap in milliseconds
 *
 * The benchmark creates and drops its own database next to the one
 * `POSTGRES_URL` names (`<database>_stale_stats_bench`); it needs `CREATEDB`.
 */
import { performance } from "node:perf_hooks";

import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import pg from "pg";
import { z } from "zod";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createSqliteTables } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";

import { getPostgresUrl } from "./config";

const { Pool } = pg;

const GRAPH_ID = "stale_stats";
const TARGET_KIND = "Item";
const INSERT_CHUNK = 1000;

const Item = defineNode(TARGET_KIND, {
  schema: z.object({
    status: z.string(),
    ordinal: z.number(),
    code: z.string(),
  }),
});
const Holder = defineNode("Holder", {
  schema: z.object({ name: z.string() }),
});
const link = defineEdge("link");

const graph = defineGraph({
  id: GRAPH_ID,
  nodes: {
    Item: {
      type: Item,
      unique: [
        {
          name: "item_code",
          fields: ["code"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Holder: { type: Holder },
  },
  edges: {
    link: { type: link, from: [Holder], to: [Item] },
  },
});

type BenchStore = Awaited<
  ReturnType<typeof createStoreWithSchema<typeof graph>>
>[0];

type Options = Readonly<{
  scenario: string;
  sizes: readonly number[];
  prefill: number;
  fresh: boolean;
  explain: boolean;
  printSql: boolean;
  sqlite: boolean;
  statementTimeoutMs: number;
}>;

function parseOptions(argv: readonly string[]): Options {
  function value(name: string): string | undefined {
    const prefix = `--${name}=`;
    return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  }
  return {
    scenario: value("scenario") ?? "update-where",
    sizes: (value("sizes") ?? "1000,2500,5000,10000,20000")
      .split(",")
      .map((size) => Number.parseInt(size, 10)),
    prefill: Number.parseInt(value("prefill") ?? "300000", 10),
    fresh: argv.includes("--fresh"),
    explain: argv.includes("--explain"),
    printSql: argv.includes("--print-sql"),
    sqlite: argv.includes("--sqlite"),
    statementTimeoutMs: Number.parseInt(
      value("statement-timeout") ?? "600000",
      10,
    ),
  };
}

// ---------------------------------------------------------------------------
// Statement recorder
// ---------------------------------------------------------------------------

type RecordedStatement = Readonly<{
  text: string;
  values: readonly unknown[];
  ms: number;
}>;

type Recorder = {
  statements: RecordedStatement[];
};

type QueryConfigLike = Readonly<{ text: string; values?: unknown[] }>;

function statementText(first: unknown): string | undefined {
  if (typeof first === "string") return first;
  if (typeof first === "object" && first !== null && "text" in first) {
    const text = (first as QueryConfigLike).text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

function statementValues(first: unknown, second: unknown): readonly unknown[] {
  if (Array.isArray(second)) return second;
  if (typeof first === "object" && first !== null && "values" in first) {
    return (first as QueryConfigLike).values ?? [];
  }
  return [];
}

/**
 * Times every statement any pooled client runs. `pg.Pool#query` and drizzle's
 * transaction sessions both end in `Client#query`, so wrapping each client as
 * it connects covers every statement the store issues.
 */
function instrumentPool(pool: pg.Pool, recorder: Recorder): void {
  pool.on("connect", (client) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      const text = statementText(args[0]);
      if (text === undefined) return original(...args);
      const values = statementValues(args[0], args[1]);
      const started = performance.now();
      function record(): void {
        recorder.statements.push({
          text: text ?? "",
          values,
          ms: performance.now() - started,
        });
      }
      const last = args.at(-1);
      if (typeof last === "function") {
        const callback = last as (...callbackArgs: unknown[]) => void;
        return original(...args.slice(0, -1), (...callbackArgs: unknown[]) => {
          record();
          callback(...callbackArgs);
        });
      }
      const result = original(...args);
      if (result instanceof Promise) {
        return result.finally(() => {
          record();
        });
      }
      record();
      return result;
    };
  });
}

/** A stable label for a statement: its first line of SQL, whitespace-folded. */
function statementShape(text: string): string {
  const folded = text.replaceAll(/\s+/g, " ").trim();
  const withoutLists = folded
    .replaceAll(/\$\d+(, \$\d+)+/g, "$…")
    .replaceAll(/\(\$\d+, \$\d+\)(, \(\$\d+, \$\d+\))+/g, "($…)");
  return withoutLists.length > 110 ?
      `${withoutLists.slice(0, 110)}…`
    : withoutLists;
}

type ShapeTotal = Readonly<{ shape: string; count: number; ms: number }>;

function totalsByShape(
  statements: readonly RecordedStatement[],
): readonly ShapeTotal[] {
  const totals = new Map<string, { count: number; ms: number }>();
  for (const statement of statements) {
    const shape = statementShape(statement.text);
    const entry = totals.get(shape) ?? { count: 0, ms: 0 };
    entry.count += 1;
    entry.ms += statement.ms;
    totals.set(shape, entry);
  }
  return [...totals.entries()]
    .map(([shape, entry]) => ({ shape, ...entry }))
    .toSorted((left, right) => right.ms - left.ms);
}

function slowest(
  statements: readonly RecordedStatement[],
): RecordedStatement | undefined {
  return statements.reduce<RecordedStatement | undefined>(
    (current, statement) =>
      current === undefined || statement.ms > current.ms ? statement : current,
    undefined,
  );
}

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

function benchDatabaseUrl(baseUrl: string): Readonly<{
  url: string;
  name: string;
}> {
  const url = new URL(baseUrl);
  const name = `${url.pathname.slice(1)}_stale_stats_bench`;
  url.pathname = `/${name}`;
  return { url: url.toString(), name };
}

async function recreateDatabase(baseUrl: string, name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

const TYPEGRAPH_TABLES_QUERY = `
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND tablename LIKE 'typegraph_%'
`;

async function disableAutovacuum(pool: pg.Pool): Promise<void> {
  const tables = await pool.query<{ tablename: string }>(
    TYPEGRAPH_TABLES_QUERY,
  );
  for (const row of tables.rows) {
    await pool.query(
      `ALTER TABLE "${row.tablename}" SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)`,
    );
  }
}

async function analyzeAll(pool: pg.Pool): Promise<number> {
  const tables = await pool.query<{ tablename: string }>(
    TYPEGRAPH_TABLES_QUERY,
  );
  const started = performance.now();
  for (const row of tables.rows) {
    await pool.query(`ANALYZE "${row.tablename}"`);
  }
  return performance.now() - started;
}

/**
 * Rows of other graphs, plus other kinds of the target graph, so the target
 * `(graph_id, kind)` is a sliver of a large analyzed table. Edges likewise.
 */
async function prefill(pool: pg.Pool, rows: number): Promise<void> {
  await pool.query(
    `INSERT INTO typegraph_nodes
       (graph_id, kind, id, props, version, created_at, updated_at)
     SELECT
       CASE WHEN i % 6 = 0 THEN $2 ELSE 'other_graph_' || (i % 7) END,
       CASE WHEN i % 6 = 0 THEN 'Holder' ELSE 'Kind' || (i % 5) END,
       'prefill-' || i,
       jsonb_build_object('name', 'n' || i, 'status', 'old', 'ordinal', i),
       1, now(), now()
     FROM generate_series(1, $1::int) AS i`,
    [rows, GRAPH_ID],
  );
  await pool.query(
    `INSERT INTO typegraph_edges
       (graph_id, id, kind, from_kind, from_id, to_kind, to_id, props,
        created_at, updated_at)
     SELECT
       'other_graph_' || (i % 7), 'prefill-edge-' || i, 'rel',
       'Kind' || (i % 5), 'prefill-' || i,
       'Kind' || ((i + 1) % 5), 'prefill-' || (i + 1),
       '{}'::jsonb, now(), now()
     FROM generate_series(1, $1::int) AS i`,
    [rows],
  );
}

type PostgresHarness = Readonly<{
  store: BenchStore;
  backend: GraphBackend;
  pool: pg.Pool;
  recorder: Recorder;
  close: () => Promise<void>;
}>;

async function createPostgresHarness(
  options: Options,
): Promise<PostgresHarness> {
  const { url, name } = benchDatabaseUrl(getPostgresUrl());
  await recreateDatabase(getPostgresUrl(), name);
  const recorder: Recorder = { statements: [] };
  const pool = new Pool({
    connectionString: url,
    max: 4,
    options: `-c statement_timeout=${options.statementTimeoutMs}`,
  });
  instrumentPool(pool, recorder);
  const tables = createPostgresTables();
  await pool.query(generatePostgresMigrationSQL(tables));
  await disableAutovacuum(pool);
  const backend = createPostgresBackend(drizzleNodePostgres(pool), { tables });
  const [store] = await createStoreWithSchema(graph, backend, {
    autoRefreshStatistics: false,
  });
  await prefill(pool, options.prefill);
  const analyzeMs = await analyzeAll(pool);
  console.log(
    `prefilled ${options.prefill} nodes and ${options.prefill} edges; analyze took ${Math.round(analyzeMs)} ms`,
  );
  return {
    store,
    backend,
    pool,
    recorder,
    close: async () => {
      await backend.close();
      await pool.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

let freshSequence = 0;

/** Inserts `count` fresh Items through the store, in chunks, without analyze. */
async function insertFreshItems(
  store: BenchStore,
  count: number,
): Promise<readonly string[]> {
  const batch = freshSequence++;
  const ids: string[] = [];
  for (let offset = 0; offset < count; offset += INSERT_CHUNK) {
    const size = Math.min(INSERT_CHUNK, count - offset);
    const items = Array.from({ length: size }, (_, index) => {
      const ordinal = offset + index;
      const id = `fresh-${batch}-${ordinal}`;
      ids.push(id);
      return {
        id,
        props: {
          status: "pending",
          ordinal,
          code: `code-${batch}-${ordinal}`,
        },
      };
    });
    await store.nodes.Item.bulkInsert(items);
  }
  return ids;
}

type Measurement = Readonly<{
  label: string;
  n: number;
  statistics: "stale" | "fresh";
  ms: number;
  statements: readonly RecordedStatement[];
}>;

async function measure(
  recorder: Recorder,
  label: string,
  n: number,
  statistics: "stale" | "fresh",
  run: () => Promise<unknown>,
): Promise<Measurement> {
  recorder.statements = [];
  const started = performance.now();
  await run();
  const ms = performance.now() - started;
  const statements = recorder.statements;
  recorder.statements = [];
  return { label, n, statistics, ms, statements };
}

async function explain(
  pool: pg.Pool,
  statement: RecordedStatement,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${statement.text}`,
      [...statement.values],
    );
    return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function report(
  measurement: Measurement,
  pool: pg.Pool | undefined,
  options: Options,
): Promise<void> {
  const top = totalsByShape(measurement.statements).slice(0, 3);
  console.log(
    JSON.stringify({
      label: measurement.label,
      n: measurement.n,
      statistics: measurement.statistics,
      ms: Math.round(measurement.ms),
      statements: measurement.statements.length,
      top: top.map((entry) => ({
        shape: entry.shape,
        count: entry.count,
        ms: Math.round(entry.ms),
      })),
    }),
  );
  const worst = slowest(measurement.statements);
  if (options.printSql && worst !== undefined) {
    console.log(`--- SQL ${measurement.label}\n${worst.text}\n---`);
  }
  if (options.explain && pool !== undefined && worst !== undefined) {
    console.log(
      `--- EXPLAIN ${measurement.label} N=${measurement.n} ${measurement.statistics}\n${await explain(pool, worst)}\n---`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type ScenarioContext = Readonly<{
  store: BenchStore;
  pool: pg.Pool | undefined;
  recorder: Recorder;
  options: Options;
  analyze: () => Promise<number>;
}>;

async function updateWhereScenario(context: ScenarioContext): Promise<void> {
  const { store, recorder, options } = context;
  const statisticsModes: readonly ("stale" | "fresh")[] =
    options.fresh ? ["stale", "fresh"] : ["stale"];
  for (const statistics of statisticsModes) {
    for (const n of options.sizes) {
      const ids = await insertFreshItems(store, n);
      if (statistics === "fresh") await context.analyze();
      await report(
        await measure(recorder, "updateWhere id.in", n, statistics, () =>
          store.nodes.Item.updateWhere({
            where: (item) => item.id.in([...ids]),
            patch: { status: "promoted" },
          }),
        ),
        context.pool,
        options,
      );
    }
  }
  // Small-N controls: one id, and a predicate with no id list.
  const [single] = await insertFreshItems(store, 1);
  await report(
    await measure(recorder, "updateWhere single id", 1, "stale", () =>
      store.nodes.Item.updateWhere({
        where: (item) => item.id.eq(single ?? ""),
        patch: { status: "single" },
      }),
    ),
    context.pool,
    options,
  );
  await report(
    await measure(recorder, "updateWhere predicate", 0, "stale", () =>
      store.nodes.Item.updateWhere({
        where: (item) => item.ordinal.eq(-1),
        patch: { status: "none" },
      }),
    ),
    context.pool,
    options,
  );
}

const SCENARIOS: Readonly<
  Record<string, (context: ScenarioContext) => Promise<void>>
> = {
  "update-where": updateWhereScenario,
};

async function runPostgres(options: Options): Promise<void> {
  const harness = await createPostgresHarness(options);
  try {
    const context: ScenarioContext = {
      store: harness.store,
      pool: harness.pool,
      recorder: harness.recorder,
      options,
      analyze: () => analyzeAll(harness.pool),
    };
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (options.scenario !== "all" && options.scenario !== name) continue;
      console.log(`## postgres ${name}`);
      await scenario(context);
    }
  } finally {
    await harness.close();
  }
}

async function runSqlite(options: Options): Promise<void> {
  const { backend } = createLocalSqliteBackend({
    tables: createSqliteTables(),
  });
  const [store] = await createStoreWithSchema(graph, backend, {
    autoRefreshStatistics: false,
  });
  const recorder: Recorder = { statements: [] };
  try {
    const context: ScenarioContext = {
      store,
      pool: undefined,
      recorder,
      options,
      analyze: async () => {
        const started = performance.now();
        await store.refreshStatistics();
        return performance.now() - started;
      },
    };
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      if (options.scenario !== "all" && options.scenario !== name) continue;
      console.log(`## sqlite ${name}`);
      await scenario(context);
    }
  } finally {
    await backend.close();
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await (options.sqlite ? runSqlite(options) : runPostgres(options));
}

await main();
