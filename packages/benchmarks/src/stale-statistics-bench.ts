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
 * - `--explain` — print the plan of each N's slowest statement. Every
 *   statement is explained in place, immediately before it runs, on its own
 *   connection inside a savepoint (or a rolled-back transaction) — so the
 *   plan is the measured statement's, against the rows it writes. Timings in
 *   this mode include the rehearsal's effects on the table.
 * - `--print-sql` — print the text of each N's slowest statement
 * - `--sqlite` — run the same scenarios on in-memory SQLite (time only)
 * - `--statement-timeout=600000` — per-statement cap in milliseconds
 * - `--analyze-every=N` — slope only: ANALYZE the TypeGraph tables after
 *   every N batches
 * - `--autoanalyze-threshold=N` — keep autovacuum on the TypeGraph tables
 *   with `autovacuum_analyze_scale_factor = 0` and this analyze threshold,
 *   instead of disabling it
 *
 * The benchmark creates a database of its own with a random name
 * (`typegraph_stale_stats_<hex>`) on the server `POSTGRES_URL` names, so runs
 * can go side by side, and drops only that database when it finishes; it
 * never drops a database it did not create. It needs `CREATEDB`. Every flag is
 * validated before any statement runs.
 */
import { randomBytes } from "node:crypto";
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
  partOf,
} from "@nicia-ai/typegraph";
import {
  asBranchId,
  applyMergePlan,
  branch,
  planMerge,
} from "@nicia-ai/typegraph/graph-merge";
import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { FORMAT_VERSION, importGraph } from "@nicia-ai/typegraph/interchange";
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
const Show = defineNode("Show", { schema: z.object({ title: z.string() }) });
const Clip = defineNode("Clip", { schema: z.object({ title: z.string() }) });
const clipOf = defineEdge("clipOf");
const itemStatusIndex = defineNodeIndex(Item, {
  fields: ["status"],
  name: "stale_stats_item_status",
});

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
    Show: { type: Show },
    Clip: { type: Clip },
  },
  edges: {
    link: { type: link, from: [Holder], to: [Item] },
    clipOf: {
      type: clipOf,
      from: [Clip],
      to: [Show],
      cardinality: "oneActive",
    },
  },
  ontology: [partOf(Clip, Show, { via: clipOf })],
  indexes: [itemStatusIndex],
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
  autoanalyzeThreshold: number | undefined;
  analyzeEvery: number | undefined;
}>;

/** A flag's whole-number value, refused unless it is one (`minimum` up). */
function parseCount(name: string, raw: string, minimum: number): number {
  if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) < minimum) {
    throw new Error(
      `--${name} must be a whole number of at least ${minimum}, got "${raw}".`,
    );
  }
  return Number.parseInt(raw, 10);
}

/**
 * Parses and validates every flag. An unknown scenario or a malformed number
 * is refused here, before the benchmark connects to anything.
 */
function parseOptions(argv: readonly string[]): Options {
  function value(name: string): string | undefined {
    const prefix = `--${name}=`;
    return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  }
  function optionalCount(name: string, minimum: number): number | undefined {
    const raw = value(name);
    return raw === undefined ? undefined : parseCount(name, raw, minimum);
  }
  const scenario = value("scenario") ?? "update-where";
  if (scenario !== "all" && !Object.hasOwn(SCENARIOS, scenario)) {
    throw new Error(
      `--scenario must be one of all, ${Object.keys(SCENARIOS).join(", ")}; got "${scenario}".`,
    );
  }
  return {
    scenario,
    sizes: (value("sizes") ?? "1000,2500,5000,10000,20000")
      .split(",")
      .map((size) => parseCount("sizes", size, 1)),
    prefill: parseCount("prefill", value("prefill") ?? "300000", 0),
    fresh: argv.includes("--fresh"),
    explain: argv.includes("--explain"),
    printSql: argv.includes("--print-sql"),
    sqlite: argv.includes("--sqlite"),
    statementTimeoutMs: parseCount(
      "statement-timeout",
      value("statement-timeout") ?? "600000",
      0,
    ),
    analyzeEvery: optionalCount("analyze-every", 1),
    autoanalyzeThreshold: optionalCount("autoanalyze-threshold", 0),
  };
}

// ---------------------------------------------------------------------------
// Statement recorder
// ---------------------------------------------------------------------------

type RecordedStatement = Readonly<{
  text: string;
  values: readonly unknown[];
  ms: number;
  /** `EXPLAIN (ANALYZE, BUFFERS)` of the statement, under `--explain`. */
  plan: string | undefined;
}>;

type Recorder = {
  statements: RecordedStatement[];
  /** Whether to explain every statement in place before it runs. */
  explain: boolean;
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

type RunQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<pg.QueryResult<Record<string, unknown>>>;

const EXPLAINABLE_STATEMENT = /^\s*(select|insert|update|delete|with)\b/i;
const EXPLAIN_SAVEPOINT = "tg_bench_explain";

/**
 * `EXPLAIN (ANALYZE, BUFFERS)` of a statement about to run on `run`'s
 * connection, rolled back so the statement then runs against the same rows:
 * inside a savepoint when the connection is in a transaction, in a
 * transaction of its own otherwise.
 */
async function explainInPlace(
  run: RunQuery,
  text: string,
  values: readonly unknown[],
  inTransaction: boolean,
): Promise<string> {
  try {
    await run(inTransaction ? `SAVEPOINT ${EXPLAIN_SAVEPOINT}` : "BEGIN");
  } catch (error) {
    return `(not explained: ${error instanceof Error ? error.message : String(error)})`;
  }
  try {
    const result = await run(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
    return result.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  } catch (error) {
    return `(explain failed: ${error instanceof Error ? error.message : String(error)})`;
  } finally {
    if (inTransaction) {
      await run(`ROLLBACK TO SAVEPOINT ${EXPLAIN_SAVEPOINT}`);
      await run(`RELEASE SAVEPOINT ${EXPLAIN_SAVEPOINT}`);
    } else {
      await run("ROLLBACK");
    }
  }
}

/** How a statement moves its connection in or out of a transaction. */
function transactionEffect(text: string): "begin" | "end" | undefined {
  const folded = text.trim().toLowerCase();
  if (folded.startsWith("begin") || folded.startsWith("start transaction")) {
    return "begin";
  }
  if (folded === "commit" || folded === "end" || folded === "rollback") {
    return "end";
  }
  return undefined;
}

/**
 * Times every statement any pooled client runs. `pg.Pool#query` and drizzle's
 * transaction sessions both end in `Client#query`, so wrapping each client as
 * it connects covers every statement the store issues. Under `--explain`,
 * each promise-style statement is first explained in place
 * ({@link explainInPlace}); its recorded time is the statement's alone.
 */
function instrumentPool(pool: pg.Pool, recorder: Recorder): void {
  pool.on("connect", (client) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    const run: RunQuery = (text, values) =>
      original(
        text,
        values === undefined ? undefined : [...values],
      ) as ReturnType<RunQuery>;
    let inTransaction = false;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      const text = statementText(args[0]);
      if (text === undefined) return original(...args);
      const values = statementValues(args[0], args[1]);
      const effect = transactionEffect(text);
      if (effect !== undefined) inTransaction = effect === "begin";
      const last = args.at(-1);
      if (
        recorder.explain &&
        typeof last !== "function" &&
        EXPLAINABLE_STATEMENT.test(text)
      ) {
        return (async () => {
          const plan = await explainInPlace(run, text, values, inTransaction);
          const started = performance.now();
          try {
            return await (original(...args) as Promise<unknown>);
          } finally {
            recorder.statements.push({
              text,
              values,
              ms: performance.now() - started,
              plan,
            });
          }
        })();
      }
      const started = performance.now();
      function record(): void {
        recorder.statements.push({
          text: text ?? "",
          values,
          ms: performance.now() - started,
          plan: undefined,
        });
      }
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

/** The only database names this benchmark creates, and so may drop. */
const BENCH_DATABASE_NAME = /^typegraph_stale_stats_[0-9a-f]{16}$/;

/** A fresh database name: a fixed prefix and 64 random bits, 38 bytes. */
function benchDatabaseName(): string {
  return `typegraph_stale_stats_${randomBytes(8).toString("hex")}`;
}

function benchDatabaseUrl(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withAdmin(
  baseUrl: string,
  run: (admin: pg.Client) => Promise<void>,
): Promise<void> {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}

function assertBenchDatabaseName(name: string): void {
  if (!BENCH_DATABASE_NAME.test(name)) {
    throw new Error(`Refusing to touch database "${name}".`);
  }
}

/**
 * Creates the run's database. `CREATE DATABASE` fails on an existing name, so
 * a run can never adopt — and later drop — a database it did not create.
 */
async function createBenchDatabase(
  baseUrl: string,
  name: string,
): Promise<void> {
  assertBenchDatabaseName(name);
  await withAdmin(baseUrl, async (admin) => {
    await admin.query(`CREATE DATABASE "${name}"`);
  });
}

/** Drops the database {@link createBenchDatabase} created for this run. */
async function dropBenchDatabase(baseUrl: string, name: string): Promise<void> {
  assertBenchDatabaseName(name);
  await withAdmin(baseUrl, async (admin) => {
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  });
}

const TYPEGRAPH_TABLES_QUERY = `
  SELECT tablename FROM pg_tables
  WHERE schemaname = 'public' AND tablename LIKE 'typegraph_%'
`;

/**
 * Disables autovacuum on the TypeGraph tables, or — with
 * `--autoanalyze-threshold=N` — leaves it on with a size-independent analyze
 * trigger of N changed rows, the storage parameters statistics maintenance
 * could recommend.
 */
async function configureAutovacuum(
  pool: pg.Pool,
  autoanalyzeThreshold: number | undefined,
): Promise<void> {
  const tables = await pool.query<{ tablename: string }>(
    TYPEGRAPH_TABLES_QUERY,
  );
  for (const row of tables.rows) {
    await pool.query(
      autoanalyzeThreshold === undefined ?
        `ALTER TABLE "${row.tablename}" SET (autovacuum_enabled = false, toast.autovacuum_enabled = false)`
      : `ALTER TABLE "${row.tablename}" SET (autovacuum_enabled = true, autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = ${autoanalyzeThreshold})`,
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
  const baseUrl = getPostgresUrl();
  const name = benchDatabaseName();
  await createBenchDatabase(baseUrl, name);
  console.log(`created database ${name}`);
  const recorder: Recorder = { statements: [], explain: false };
  const pool = new Pool({
    connectionString: benchDatabaseUrl(baseUrl, name),
    max: 4,
    options: `-c statement_timeout=${options.statementTimeoutMs}`,
  });
  async function dropDatabase(): Promise<void> {
    await pool.end();
    await dropBenchDatabase(baseUrl, name);
  }
  try {
    instrumentPool(pool, recorder);
    const tables = createPostgresTables();
    await pool.query(generatePostgresMigrationSQL(tables));
    await configureAutovacuum(pool, options.autoanalyzeThreshold);
    const backend = createPostgresBackend(drizzleNodePostgres(pool), {
      tables,
    });
    const [store] = await createStoreWithSchema(graph, backend, {
      autoRefreshStatistics: false,
    });
    await store.materializeIndexes({ refreshStatistics: false });
    await prefill(pool, options.prefill);
    const analyzeMs = await analyzeAll(pool);
    console.log(
      `prefilled ${options.prefill} nodes and ${options.prefill} edges; analyze took ${Math.round(analyzeMs)} ms`,
    );
    // Explain only the scenarios' statements, not the setup's.
    recorder.explain = options.explain;
    return {
      store,
      backend,
      pool,
      recorder,
      close: async () => {
        await backend.close();
        await dropDatabase();
      },
    };
  } catch (error) {
    await dropDatabase();
    throw error;
  }
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

function report(measurement: Measurement, options: Options): void {
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
  if (options.explain && worst?.plan !== undefined) {
    console.log(
      `--- EXPLAIN ${measurement.label} N=${measurement.n} ${measurement.statistics}\n${worst.plan}\n---`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

type ScenarioContext = Readonly<{
  store: BenchStore;
  backend: GraphBackend;
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
      report(
        await measure(recorder, "updateWhere id.in", n, statistics, () =>
          store.nodes.Item.updateWhere({
            where: (item) => item.id.in([...ids]),
            patch: { status: "promoted" },
          }),
        ),
        options,
      );
    }
  }
  // Small-N controls: one id, and a predicate with no id list.
  const [single] = await insertFreshItems(store, 1);
  report(
    await measure(recorder, "updateWhere single id", 1, "stale", () =>
      store.nodes.Item.updateWhere({
        where: (item) => item.id.eq(single ?? ""),
        patch: { status: "single" },
      }),
    ),
    options,
  );
  report(
    await measure(recorder, "updateWhere predicate", 0, "stale", () =>
      store.nodes.Item.updateWhere({
        where: (item) => item.ordinal.eq(-1),
        patch: { status: "none" },
      }),
    ),
    options,
  );
}

/** The size the sibling audit runs every operation at (`--sizes` overrides). */
function siblingSize(options: Options): number {
  return options.sizes.length === 1 ? (options.sizes[0] ?? 10_000) : 10_000;
}

async function insertFreshClips(
  store: BenchStore,
  count: number,
): Promise<
  Readonly<{
    clipIds: readonly string[];
    to: Awaited<ReturnType<BenchStore["nodes"]["Show"]["create"]>>;
  }>
> {
  const batch = freshSequence++;
  const from = await store.nodes.Show.create({ title: `from-${batch}` });
  const to = await store.nodes.Show.create({ title: `to-${batch}` });
  const clipIds: string[] = [];
  for (let offset = 0; offset < count; offset += INSERT_CHUNK) {
    const size = Math.min(INSERT_CHUNK, count - offset);
    const created = await store.nodes.Clip.bulkCreate(
      Array.from({ length: size }, (_, index) => ({
        props: { title: `clip-${batch}-${offset + index}` },
        partOf: { whole: from },
      })),
    );
    for (const clip of created) clipIds.push(clip.id);
  }
  return { clipIds, to };
}

/**
 * Every set-wise write or read-then-write with a candidate-set shape, each at
 * N fresh rows under stale statistics. Each operation gets its own fresh rows
 * so one operation's writes cannot warm the next one's.
 */
async function siblingsScenario(context: ScenarioContext): Promise<void> {
  const { store, recorder, options } = context;
  const n = siblingSize(options);
  async function run(label: string, operation: () => Promise<unknown>) {
    report(await measure(recorder, label, n, "stale", operation), options);
  }

  const casIds = await insertFreshItems(store, n);
  await run("compareAndSet (one id among N fresh)", () =>
    store.nodes.Item.compareAndSet(asItemId(casIds.at(-1)), {
      expected: { status: "pending" },
      patch: { status: "swapped" },
    }),
  );

  const deleteIds = await insertFreshItems(store, n);
  await run("bulkDelete", () =>
    store.nodes.Item.bulkDelete(deleteIds.map((id) => asItemId(id))),
  );

  const hardDeleteIds = await insertFreshItems(store, n);
  await run("bulkHardDelete", () =>
    store.nodes.Item.bulkHardDelete(hardDeleteIds.map((id) => asItemId(id))),
  );

  const findIds = await insertFreshItems(store, n);
  const findBatch = freshSequence - 1;
  await run("bulkFindByConstraint", () =>
    store.nodes.Item.bulkFindByConstraint(
      "item_code",
      findIds.map((_, ordinal) => ({
        props: {
          status: "pending",
          ordinal,
          code: `code-${findBatch}-${ordinal}`,
        },
      })),
    ),
  );
  await run("bulkFindByIndex (status, N probes)", () =>
    store.nodes.Item.bulkFindByIndex(
      itemStatusIndex.name,
      findIds.map(() => ({ props: { status: "pending" } })),
      { limitPerInput: 1 },
    ),
  );

  const importIds = await insertFreshItems(store, n);
  await run("importGraph onConflict update", async () => {
    const result = await importGraph(
      store,
      {
        formatVersion: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        source: { type: "external", description: "stale-statistics bench" },
        nodes: importIds.map((id, ordinal) => ({
          kind: TARGET_KIND,
          id,
          properties: {
            status: "imported",
            ordinal,
            code: `import-${id}`,
          },
        })),
        edges: [],
      },
      {
        onConflict: "update",
        onUnknownProperty: "error",
        validateReferences: false,
        refreshStatistics: false,
      },
    );
    if (!result.success) {
      throw new Error(`import failed: ${JSON.stringify(result.errors[0])}`);
    }
  });

  const { clipIds, to } = await insertFreshClips(store, n);
  await run("bulkReparent", () =>
    store.nodes.Clip.bulkReparent(
      clipIds.map((id) => ({
        id: id as Parameters<BenchStore["nodes"]["Clip"]["reparent"]>[0],
        options: { whole: to },
      })),
    ),
  );

  await mergeApplySibling(context, n);
}

/**
 * Merge apply: a branch rewrites N fresh target rows and the plan is applied
 * back onto the stale target table.
 */
async function mergeApplySibling(
  context: ScenarioContext,
  n: number,
): Promise<void> {
  const { recorder, options } = context;
  const [target] = await createStoreWithSchema(graph, context.backend, {
    autoRefreshStatistics: false,
    revisionTracking: true,
  });
  const ids = await insertFreshItems(target, n);
  const fixture = createLocalSqliteBackend({ tables: createSqliteTables() });
  try {
    const branched = await branch(
      target,
      () => Promise.resolve(fixture.backend),
      {
        id: asBranchId(`stale-stats-${freshSequence}`),
      },
    );
    if (!branched.success) throw branched.error;
    const source = branched.data;
    for (const id of ids) {
      await source.store.nodes.Item.update(asItemId(id), { status: "merged" });
    }
    const planned = await planMerge(target, [source]);
    if (!planned.success) throw planned.error;
    report(
      await measure(recorder, "merge apply (N updated rows)", n, "stale", () =>
        applyMergePlan(target, planned.data),
      ),
      options,
    );
  } finally {
    await fixture.backend.close();
  }
}

function asItemId(
  id: string | undefined,
): Parameters<BenchStore["nodes"]["Item"]["getById"]>[0] {
  if (id === undefined) throw new Error("no fresh item id");
  return id as Parameters<BenchStore["nodes"]["Item"]["getById"]>[0];
}

const SLOPE_BATCHES = 500;
const SLOPE_BATCH_SIZE = 20;

/**
 * A long run of small write batches: each batch creates 20 Items and one
 * Holder-to-Item edge per Item, in one transaction. Logs per-batch time and,
 * every 50 batches, the per-shape statement time of the last 50 batches.
 */
async function slopeScenario(context: ScenarioContext): Promise<void> {
  const { store, recorder } = context;
  const holder = await store.nodes.Holder.create({ name: "slope-holder" });
  const window: RecordedStatement[] = [];
  const batchTimes: number[] = [];
  for (let batchIndex = 0; batchIndex < SLOPE_BATCHES; batchIndex++) {
    recorder.statements = [];
    const started = performance.now();
    await store.transaction(async (tx) => {
      const items = await tx.nodes.Item.bulkCreate(
        Array.from({ length: SLOPE_BATCH_SIZE }, (_, index) => ({
          props: {
            status: "slope",
            ordinal: index,
            code: `slope-${batchIndex}-${index}`,
          },
        })),
      );
      await tx.edges.link.bulkCreate(
        items.map((item) => ({ from: holder, to: item, props: {} })),
      );
    });
    batchTimes.push(performance.now() - started);
    window.push(...recorder.statements);
    const analyzeEvery = context.options.analyzeEvery;
    if (analyzeEvery !== undefined && (batchIndex + 1) % analyzeEvery === 0) {
      await context.analyze();
    }
    if ((batchIndex + 1) % 50 === 0) {
      const recent = batchTimes.slice(-50);
      console.log(
        JSON.stringify({
          label: "slope",
          batches: batchIndex + 1,
          meanBatchMs:
            Math.round(
              (recent.reduce((sum, value) => sum + value, 0) / recent.length) *
                100,
            ) / 100,
          top: totalsByShape(window)
            .slice(0, 6)
            .map((entry) => ({
              shape: entry.shape,
              count: entry.count,
              meanMs: Math.round((entry.ms / entry.count) * 1000) / 1000,
            })),
        }),
      );
      window.length = 0;
    }
  }
}

/** What one ANALYZE of the TypeGraph tables costs on the pre-filled table. */
async function analyzeCostScenario(context: ScenarioContext): Promise<void> {
  const samples: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    samples.push(await context.analyze());
  }
  console.log(
    JSON.stringify({
      label: "analyze all TypeGraph tables",
      samplesMs: samples.map((sample) => Math.round(sample)),
    }),
  );
  if (context.pool === undefined) return;
  for (const table of ["typegraph_nodes", "typegraph_edges"]) {
    const timings: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const started = performance.now();
      await context.pool.query(`ANALYZE "${table}"`);
      timings.push(performance.now() - started);
    }
    console.log(
      JSON.stringify({
        label: `analyze ${table}`,
        samplesMs: timings.map((timing) => Math.round(timing)),
      }),
    );
  }
}

const SCENARIOS: Readonly<
  Record<string, (context: ScenarioContext) => Promise<void>>
> = {
  "update-where": updateWhereScenario,
  siblings: siblingsScenario,
  slope: slopeScenario,
  "analyze-cost": analyzeCostScenario,
};

async function runPostgres(options: Options): Promise<void> {
  const harness = await createPostgresHarness(options);
  try {
    const context: ScenarioContext = {
      store: harness.store,
      backend: harness.backend,
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
  await store.materializeIndexes({ refreshStatistics: false });
  const recorder: Recorder = { statements: [], explain: false };
  try {
    const context: ScenarioContext = {
      store,
      backend,
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
