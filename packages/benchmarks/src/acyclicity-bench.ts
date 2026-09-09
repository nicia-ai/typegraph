/**
 * Item D.2's benchmark gate (design note §13): prices the acyclicity
 * reachability probe against the `cardinality: "one"` fence baseline and
 * an unconstrained `many` baseline, on chain-append, chain-prepend, and
 * forest shapes.
 *
 * Run:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:acyclicity
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:acyclicity:file
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:acyclicity:postgres
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:acyclicity:contention
 *
 * The default and `:file`/`:postgres` invocations also print a §7.6
 * `EXPLAIN`/`EXPLAIN QUERY PLAN` reading of the probe statement itself,
 * asserting `typegraph_edges_from_idx` coverage rather than assuming it.
 * `:contention` is a separate mode (§13.4): *W* ∈ {2, 4, 8, 16} real
 * PostgreSQL connections appending to a shared acyclic relation for 30s
 * each, reporting aggregate throughput, p99 latency, and the fraction of
 * time spent waiting on the per-graph advisory lock — it requires
 * `--backend=postgres` (PGlite/SQLite cannot exhibit genuine contention) and
 * is not run as part of the ordinary latency invocations above.
 *
 * Scope note: the wide-DAG and diamond-lattice shapes from the design
 * note's §13.2 table are NOT implemented here; chain-append, chain-prepend,
 * and forest are, at 10^4 and 10^5 edges. Report-only, no guardrails,
 * matching write-bench's stance. The ship-criteria decision (D-7) is the
 * lead's, run against this lane's own PostgreSQL numbers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3 } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type Store,
} from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import {
  createSqliteBackend,
  generateSqliteMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import {
  createPostgresBackend,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { z } from "zod";

import { getPostgresUrl, type PerfBackend, type SqliteStorage } from "./config";
import { writeHistoryEntry } from "./history";
import { type LatencyRecord } from "./measurements";
import { formatMs, median, nowMs, percentile } from "./utils";

const WARMUP_ITERATIONS = 1;
const SAMPLE_ITERATIONS = 7;
const SIZES = [10_000, 100_000] as const;

const Task = defineNode("Task", { schema: z.object({}) });
/** The unconstrained baseline: no probe, no fence. */
const plainMany = defineEdge("plainMany", { schema: z.object({}) });
/** The fence-only baseline: `checkCardinalityConstraint`, no reachability walk. */
const cardinalityOne = defineEdge("cardinalityOne", { schema: z.object({}) });
/** The subject: the fence plus the recursive reachability probe. */
const dependsOn = defineEdge("dependsOn", { schema: z.object({}) });

const graph = defineGraph({
  id: "acyclicity_bench",
  nodes: { Task: { type: Task } },
  edges: {
    plainMany: { type: plainMany, from: [Task], to: [Task] },
    cardinalityOne: {
      type: cardinalityOne,
      from: [Task],
      to: [Task],
      cardinality: "one",
    },
    dependsOn: {
      type: dependsOn,
      from: [Task],
      to: [Task],
      cardinality: "many",
      acyclic: true,
    },
  },
});

type BenchStore = Store<typeof graph>;

type BackendHandle = Readonly<{
  backend: GraphBackend;
  /**
   * Refreshes planner statistics after a bulk seed. Both engines plan the
   * fenced claim statements from table statistics; a 10^5-row seed followed
   * by a measured insert on stale statistics measures a mis-planned
   * statement, not the probe (PostgreSQL chose a nested-loop anti-join with
   * the edge id as a join filter over the whole graph — minutes per insert).
   * Production databases reach the same state through autovacuum / ANALYZE.
   */
  refreshStatistics: () => Promise<void>;
  close: () => Promise<void>;
}>;

async function buildBackend(
  kind: PerfBackend,
  sqliteStorage: SqliteStorage,
): Promise<BackendHandle> {
  if (kind === "sqlite") {
    const tempDir =
      sqliteStorage === "file" ?
        mkdtempSync(join(tmpdir(), "typegraph-acyclicity-bench-"))
      : undefined;
    const { backend } = createLocalSqliteBackend(
      tempDir === undefined ? {} : { path: join(tempDir, "bench.db") },
    );
    return {
      backend,
      refreshStatistics: async () => {
        if (backend.executeDdl !== undefined)
          await backend.executeDdl("ANALYZE");
      },
      close: async () => {
        await backend.close();
        if (tempDir !== undefined)
          rmSync(tempDir, { recursive: true, force: true });
      },
    };
  }
  const pool = new Pool({ connectionString: getPostgresUrl() });
  const backend = createPostgresBackend(drizzleNodePostgres(pool));
  return {
    backend,
    refreshStatistics: async () => {
      await pool.query("ANALYZE");
    },
    close: () => pool.end(),
  };
}

/**
 * Seeds edges the way each kind can afford. `plainMany` (no claim, no fence)
 * takes chunked `bulkCreate`; the two fenced kinds take one sequential
 * `create` per edge. For `dependsOn` that avoids the O(CHUNK^2) in-batch
 * acyclicity probe over a contiguous chain run (design note §9.3). For
 * `cardinalityOne` it avoids the atomic claim program's N-arm statements
 * (`buildDeleteStaleAtomicEdgeClaims` / `buildAcquireAtomicEdgeClaims`), whose
 * PostgreSQL executor cost grows super-linearly in the chunk size — a
 * 2000-row chunk ran for minutes at more than 2 GB of backend memory before
 * the OOM killer took it (tracked as a follow-up issue). Sequential creates
 * are also the realistic way an application grows a fenced relation, so this
 * is the representative seeding cost, not a benchmark-only shortcut.
 */
async function seedEdges(
  store: BenchStore,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  edges: readonly Readonly<{
    from: Readonly<{ kind: "Task"; id: string }>;
    to: Readonly<{ kind: "Task"; id: string }>;
  }>[],
): Promise<void> {
  if (edgeKind !== "plainMany") {
    for (const edge of edges) {
      await store.edges[edgeKind].create(edge.from, edge.to);
    }
    return;
  }
  // Chunked so one bulkCreate statement never exceeds a reasonable bind
  // budget at 10^5 edges.
  const CHUNK = 2000;
  for (let start = 0; start < edges.length; start += CHUNK) {
    await store.edges[edgeKind].bulkCreate(edges.slice(start, start + CHUNK));
  }
}

/**
 * Every `Task` id, in a chain: `task-0 -> task-1 -> ... -> task-{size-1}`,
 * seeded through {@link seedEdges}.
 */
async function seedChain(
  store: BenchStore,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  size: number,
): Promise<readonly string[]> {
  const nodes = await store.nodes.Task.bulkCreate(
    Array.from({ length: size }, () => ({ props: {} })),
  );
  const ids = nodes.map((node) => node.id);
  await seedEdges(
    store,
    edgeKind,
    Array.from({ length: nodes.length - 1 }, (_unused, index) => ({
      from: nodes[index]!,
      to: nodes[index + 1]!,
    })),
  );
  return ids;
}

/**
 * `count` disjoint 4-node trees, each with a `root` this function returns:
 * a branching root with two children for `plainMany`/`dependsOn`, or (since
 * `cardinality: "one"` permits at most one outgoing edge per source, ruling
 * out a branching root) a 4-node linear chain for `cardinalityOne` — same
 * node count and walk depth, the only shape that edge kind's fence allows.
 */
async function seedForest(
  store: BenchStore,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  treeCount: number,
): Promise<readonly string[]> {
  const nodesPerTree = 4;
  const nodes = await store.nodes.Task.bulkCreate(
    Array.from({ length: treeCount * nodesPerTree }, () => ({ props: {} })),
  );
  const edges: { from: (typeof nodes)[number]; to: (typeof nodes)[number] }[] =
    [];
  const roots: string[] = [];
  for (let tree = 0; tree < treeCount; tree += 1) {
    const base = tree * nodesPerTree;
    const root = nodes[base]!;
    roots.push(root.id);
    if (edgeKind === "cardinalityOne") {
      edges.push({ from: root, to: nodes[base + 1]! });
      edges.push({ from: nodes[base + 1]!, to: nodes[base + 2]! });
      edges.push({ from: nodes[base + 2]!, to: nodes[base + 3]! });
    } else {
      edges.push({ from: root, to: nodes[base + 1]! });
      edges.push({ from: root, to: nodes[base + 2]! });
      edges.push({ from: nodes[base + 1]!, to: nodes[base + 3]! });
    }
  }
  await seedEdges(store, edgeKind, edges);
  return roots;
}

async function measureInsert(
  run: () => Promise<void>,
): Promise<
  Readonly<{ median: number; p95: number; samples: readonly number[] }>
> {
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await run();
  const samples: number[] = [];
  for (let index = 0; index < SAMPLE_ITERATIONS; index += 1) {
    const start = nowMs();
    await run();
    samples.push(nowMs() - start);
  }
  return { median: median(samples), p95: percentile(samples, 0.95), samples };
}

async function benchChainAppend(
  backendHandle: BackendHandle,
  size: number,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  latencies: LatencyRecord,
): Promise<void> {
  const [store] = await createStoreWithSchema(graph, backendHandle.backend);
  const ids = await seedChain(store, edgeKind, size);
  await backendHandle.refreshStatistics();
  // Rolls forward each iteration: a `cardinality: "one"` edge allows only
  // one outgoing edge per source, so re-appending from the SAME tail on
  // every sample would refuse from the second iteration on.
  let tail = { kind: "Task" as const, id: ids[ids.length - 1]! };
  const label = `acyclicity:${edgeKind}:chain-append:${String(size)}`;
  const {
    median: medianMs,
    p95,
    samples,
  } = await measureInsert(async () => {
    const fresh = await store.nodes.Task.create({});
    await store.edges[edgeKind].create(tail, fresh);
    tail = { kind: "Task", id: fresh.id };
  });
  latencies.set(label, { median: medianMs, p95, samples });
  console.log(
    `${label.padEnd(48)} ${formatMs(medianMs).padStart(8)}  p95 ${formatMs(p95).padStart(8)}`,
  );
}

async function benchChainPrepend(
  backendHandle: BackendHandle,
  size: number,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  latencies: LatencyRecord,
): Promise<void> {
  const [store] = await createStoreWithSchema(graph, backendHandle.backend);
  const ids = await seedChain(store, edgeKind, size);
  await backendHandle.refreshStatistics();
  const head = { kind: "Task" as const, id: ids[0]! };
  const label = `acyclicity:${edgeKind}:chain-prepend:${String(size)}`;
  const {
    median: medianMs,
    p95,
    samples,
  } = await measureInsert(async () => {
    const fresh = await store.nodes.Task.create({});
    await store.edges[edgeKind].create(fresh, head);
  });
  latencies.set(label, { median: medianMs, p95, samples });
  console.log(
    `${label.padEnd(48)} ${formatMs(medianMs).padStart(8)}  p95 ${formatMs(p95).padStart(8)}`,
  );
}

async function benchForest(
  backendHandle: BackendHandle,
  size: number,
  edgeKind: "plainMany" | "cardinalityOne" | "dependsOn",
  latencies: LatencyRecord,
): Promise<void> {
  const treeCount = Math.max(1, Math.floor(size / 4));
  const [store] = await createStoreWithSchema(graph, backendHandle.backend);
  const roots = await seedForest(store, edgeKind, treeCount);
  await backendHandle.refreshStatistics();
  // A fresh node above an EXISTING tree's root: the walk from that root
  // must traverse the whole (small, ~4-node) tree before concluding "not
  // found", and — this is the point of the shape — must not touch any of
  // the other disjoint trees to do it. `from` is always a brand-new node,
  // so cardinality: "one" never refuses a repeat.
  const label = `acyclicity:${edgeKind}:forest:${String(size)}`;
  const {
    median: medianMs,
    p95,
    samples,
  } = await measureInsert(async () => {
    const fresh = await store.nodes.Task.create({});
    const root = { kind: "Task" as const, id: roots[0]! };
    await store.edges[edgeKind].create(fresh, root);
  });
  latencies.set(label, { median: medianMs, p95, samples });
  console.log(
    `${label.padEnd(48)} ${formatMs(medianMs).padStart(8)}  p95 ${formatMs(p95).padStart(8)}`,
  );
}

// ============================================================
// §7.6 / §13.3's fourth reading: EXPLAIN (ANALYZE, BUFFERS) / EXPLAIN QUERY
// PLAN of the reachability probe itself, asserting index coverage rather
// than assuming it (design note line 516-517, 999-1003).
// ============================================================

/**
 * The system indexes the recursive term's `(graph_id, [kind,] from_kind,
 * from_id)` seek may use. SQLite picks `typegraph_edges_from_idx`; PostgreSQL
 * prefers `typegraph_edges_cardinality_idx`, which leads with the same three
 * columns plus `kind` and is the tighter match for a single-kind relation.
 * Either is the per-hop seek the probe's cost model assumes; what must NOT
 * appear is a whole-partition scan (`typegraph_edges_kind_idx`, a heap scan,
 * or SQLite's `MATERIALIZE candidates`).
 */
const EXPECTED_ACYCLICITY_INDEXES = [
  "typegraph_edges_from_idx",
  "typegraph_edges_cardinality_idx",
] as const;

function seekIndexNamed(planText: string): string | undefined {
  return EXPECTED_ACYCLICITY_INDEXES.find((name) => planText.includes(name));
}

type CapturedStatement = Readonly<{ sql: string; params: readonly unknown[] }>;

/**
 * A bring-your-own-connection SQLite backend (public
 * `@nicia-ai/typegraph/adapters/drizzle/sqlite`) whose driver-level
 * `client.prepare` is patched to record every statement — the same idiom
 * `tests/lock-fence-test-utils.ts` uses, reimplemented here so this package
 * depends on no typegraph test file. `better-sqlite3`'s synchronous session
 * never routes a query through Drizzle's own session object, tx-scoped or
 * not, so patching `prepare` alone sees everything.
 */
function buildCapturingSqliteBackend(): Readonly<{
  backend: GraphBackend;
  statements: CapturedStatement[];
  close: () => Promise<void>;
}> {
  const client = new Database(":memory:");
  client.exec(generateSqliteMigrationSQL());
  const statements: CapturedStatement[] = [];
  const originalPrepare = client.prepare.bind(client);
  client.prepare = ((sqlText: string) => {
    const statement = originalPrepare(sqlText);
    const originalAll = statement.all.bind(statement);
    statement.all = (...params: unknown[]) => {
      statements.push({ sql: sqlText, params });
      return originalAll(...params);
    };
    return statement;
  }) as typeof client.prepare;
  const backend = createSqliteBackend(drizzleBetterSqlite3(client));
  return {
    backend,
    statements,
    close: () => {
      client.close();
      return Promise.resolve();
    },
  };
}

/**
 * A bring-your-own-connection PostgreSQL backend (public
 * `@nicia-ai/typegraph/adapters/drizzle/postgres`) whose Drizzle `logger`
 * records every statement. The acyclicity probe always runs inside the
 * per-graph write-fence transaction, which routes through Drizzle's own
 * session (`postgres.ts`'s tx-scoped execution adapter), so the logger alone
 * — no driver-level `pool.query` patch — sees it.
 */
function buildCapturingPostgresBackend(pool: Pool): Readonly<{
  backend: GraphBackend;
  statements: CapturedStatement[];
}> {
  const statements: CapturedStatement[] = [];
  const db = drizzleNodePostgres(pool, {
    logger: {
      logQuery(query: string, params: unknown[]): void {
        statements.push({ sql: query, params });
      },
    },
  });
  return { backend: createPostgresBackend(db), statements };
}

/** The captured probe statement, or `undefined` if none was issued. */
function findAcyclicityProbeStatement(
  statements: readonly CapturedStatement[],
): CapturedStatement | undefined {
  return statements.find(
    (statement) =>
      statement.sql.includes("WITH RECURSIVE") &&
      statement.sql.includes("ancestry"),
  );
}

/**
 * Runs the reachability probe once against a chain of `size` edges (the
 * chain-prepend shape: the walk from `head` traverses the whole chain, the
 * realistic worst case for the recursive term), captures its exact SQL text
 * and bound parameters, and re-issues it as an `EXPLAIN` on the SAME
 * connection. Prints the plan and reports whether it names
 * one of {@link EXPECTED_ACYCLICITY_INDEXES} — report-only, matching this lane's
 * stance elsewhere, but printed prominently: a silent heap scan here means
 * every other number in this file is priced against the wrong plan.
 */
async function explainAcyclicityProbe(
  backendKind: PerfBackend,
  size: number,
): Promise<void> {
  if (backendKind === "sqlite") {
    const { backend, statements, close } = buildCapturingSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const ids = await seedChain(store, "dependsOn", size);
      if (backend.executeDdl !== undefined) await backend.executeDdl("ANALYZE");
      const fresh = await store.nodes.Task.create({});
      const head = { kind: "Task" as const, id: ids[0]! };
      statements.splice(0);
      await store.edges.dependsOn.create(fresh, head);

      const probe = findAcyclicityProbeStatement(statements);
      if (probe === undefined) {
        console.log(
          `acyclicity:explain:sqlite:${String(size)}  NO PROBE STATEMENT CAPTURED`,
        );
        return;
      }
      // Re-run EXPLAIN QUERY PLAN on the SAME backend connection the probe
      // itself ran on, not a fresh one, so the plan reflects the actual
      // populated database.
      if (backend.executeRaw === undefined) {
        console.log(
          `acyclicity:explain:sqlite:${String(size)}  backend exposes no executeRaw`,
        );
        return;
      }
      const plan = await backend.executeRaw<Record<string, unknown>>(
        `EXPLAIN QUERY PLAN ${probe.sql}`,
        probe.params,
      );
      const planText = plan
        .map((row) => Object.values(row).join(" "))
        .join("\n");
      const seekIndex = seekIndexNamed(planText);
      console.log(
        `acyclicity:explain:sqlite:${String(size)}  ${seekIndex === undefined ? "DOES NOT NAME A SEEK INDEX — see plan below" : `USES ${seekIndex}`}`,
      );
      if (seekIndex === undefined) console.log(planText);
    } finally {
      await close();
    }
    return;
  }

  // PostgreSQL: a fresh pool, migrated once, capturing statements through
  // Drizzle's logger (see {@link buildCapturingPostgresBackend}).
  const pool = new Pool({ connectionString: getPostgresUrl() });
  try {
    await pool.query(generatePostgresMigrationSQL());
    const { backend, statements } = buildCapturingPostgresBackend(pool);
    const [store] = await createStoreWithSchema(graph, backend);
    const ids = await seedChain(store, "dependsOn", size);
    await pool.query("ANALYZE");
    const fresh = await store.nodes.Task.create({});
    const head = { kind: "Task" as const, id: ids[0]! };
    statements.splice(0);
    await store.edges.dependsOn.create(fresh, head);

    const probe = findAcyclicityProbeStatement(statements);
    if (probe === undefined) {
      console.log(
        `acyclicity:explain:postgres:${String(size)}  NO PROBE STATEMENT CAPTURED`,
      );
      return;
    }
    const result = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${probe.sql}`, [
      ...probe.params,
    ]);
    const planText = (result.rows as readonly Record<string, unknown>[])
      .map((row) => Object.values(row).join(" "))
      .join("\n");
    const seekIndex = seekIndexNamed(planText);
    const isIndexOnlyScan = /Index Only Scan/i.test(planText);
    console.log(
      `acyclicity:explain:postgres:${String(size)}  ${
        seekIndex === undefined ?
          "DOES NOT NAME A SEEK INDEX — see plan below"
        : `USES ${seekIndex}${isIndexOnlyScan ? " (index-only scan)" : " (NOT an index-only scan — see plan below)"}`
      }`,
    );
    if (seekIndex === undefined || !isIndexOnlyScan) console.log(planText);
  } finally {
    await pool.end();
  }
}

// ============================================================
// §13.4 Contention run (PostgreSQL only, real server — PGlite is
// single-connection and cannot overlap). Not run by this lane's SQLite
// invocations; wired behind `--contention --backend=postgres`.
// ============================================================

const CONTENTION_WRITER_COUNTS = [2, 4, 8, 16] as const;
const CONTENTION_DURATION_MS = 30_000;
const CONTENTION_SEED_EDGES = 100_000;
/** `pg_advisory_xact_lock`'s wait event, per `pg_stat_activity.wait_event`. */
const ADVISORY_LOCK_WAIT_EVENT = "advisory";

type ContentionResult = Readonly<{
  writers: number;
  throughputPerSecond: number;
  p99Ms: number;
  waitFraction: number;
}>;

/**
 * One writer's loop for the duration of the run: append a fresh node onto
 * the END of its own private chain (so writers never contend on the SAME
 * two-node cycle — see D-7's intent, which prices FENCE HOLD TIME, not
 * refusal handling), recording each insert's latency.
 */
async function runContentionWriter(
  store: BenchStore,
  edgeKind: "cardinalityOne" | "dependsOn",
  headId: string,
  deadline: number,
): Promise<{ count: number; latenciesMs: number[] }> {
  let tail = { kind: "Task" as const, id: headId };
  const latenciesMs: number[] = [];
  let count = 0;
  while (nowMs() < deadline) {
    const fresh = await store.nodes.Task.create({});
    const startedAt = nowMs();
    await store.edges[edgeKind].create(tail, fresh);
    latenciesMs.push(nowMs() - startedAt);
    tail = { kind: "Task", id: fresh.id };
    count += 1;
  }
  return { count, latenciesMs };
}

/** Fraction of `pg_stat_activity` samples, taken once per second, waiting on the advisory lock. */
async function sampleAdvisoryWaitFraction(
  pool: Pool,
  deadline: number,
): Promise<number> {
  let waiting = 0;
  let total = 0;
  while (nowMs() < deadline) {
    const result = await pool.query<{ wait_event: string | null }>(
      "SELECT wait_event FROM pg_stat_activity WHERE state = 'active'",
    );
    total += result.rows.length;
    waiting += result.rows.filter(
      (row) => row.wait_event === ADVISORY_LOCK_WAIT_EVENT,
    ).length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return total === 0 ? 0 : waiting / total;
}

/**
 * *W* writer connections, each appending to its OWN chain of the given edge
 * kind on the same graph, for {@link CONTENTION_DURATION_MS}. Every writer
 * of `dependsOn` contends for the SAME per-graph advisory lock regardless of
 * which chain it appends to (`edgeWriteNeedsConstraintFence` fences the
 * whole graph, not a chain), so this measures exactly the fence-hold-time
 * question §13.4 asks: how much of it is the probe.
 */
async function runContentionLevel(
  edgeKind: "cardinalityOne" | "dependsOn",
  writerCount: number,
): Promise<ContentionResult> {
  const pools = Array.from(
    { length: writerCount },
    () => new Pool({ connectionString: getPostgresUrl(), max: 2 }),
  );
  const samplerPool = new Pool({ connectionString: getPostgresUrl() });
  try {
    await pools[0]!.query(generatePostgresMigrationSQL());
    const stores = pools.map((pool) =>
      createStoreWithSchema(
        graph,
        createPostgresBackend(drizzleNodePostgres(pool)),
      ),
    );
    const resolvedStores = await Promise.all(stores);
    // Each writer gets its own disjoint chain, seeded up front so the
    // measured loop is pure append cost, matching `benchChainAppend`. The
    // chains are sized so the relation's TOTAL population reaches
    // §13.4's stated 10^5 edges before the timed contention window opens —
    // an append is O(1) regardless of chain length in this design (the
    // walk from a fresh leaf finds no out-edges), so this sizing is about
    // matching the stated population, not stressing the probe itself.
    const perWriterSeedSize = Math.max(
      1,
      Math.floor(CONTENTION_SEED_EDGES / writerCount),
    );
    const heads = await Promise.all(
      resolvedStores.map(async ([store]) => {
        const ids = await seedChain(store, edgeKind, perWriterSeedSize);
        return ids[ids.length - 1]!;
      }),
    );

    const deadline = nowMs() + CONTENTION_DURATION_MS;
    const [writerResults, waitFraction] = await Promise.all([
      Promise.all(
        resolvedStores.map(async ([store], index) =>
          runContentionWriter(store, edgeKind, heads[index]!, deadline),
        ),
      ),
      sampleAdvisoryWaitFraction(samplerPool, deadline),
    ]);
    const allLatencies = writerResults.flatMap((result) => result.latenciesMs);
    const totalCount = writerResults.reduce(
      (sum, result) => sum + result.count,
      0,
    );
    return {
      writers: writerCount,
      throughputPerSecond: totalCount / (CONTENTION_DURATION_MS / 1000),
      p99Ms: percentile(allLatencies, 0.99),
      waitFraction,
    };
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await samplerPool.end();
  }
}

async function runContentionSuite(): Promise<void> {
  console.log(
    `\nD-7 contention run: W writers appending to a shared ${String(CONTENTION_SEED_EDGES)}-edge acyclic relation for ${String(CONTENTION_DURATION_MS / 1000)}s each.\n`,
  );
  const baseline: ContentionResult[] = [];
  const subject: ContentionResult[] = [];
  for (const writerCount of CONTENTION_WRITER_COUNTS) {
    const cardinalityOneResult = await runContentionLevel(
      "cardinalityOne",
      writerCount,
    );
    baseline.push(cardinalityOneResult);
    console.log(
      `contention:cardinalityOne:writers=${String(writerCount)}  throughput=${cardinalityOneResult.throughputPerSecond.toFixed(1)}/s  p99=${formatMs(cardinalityOneResult.p99Ms)}  waitFraction=${cardinalityOneResult.waitFraction.toFixed(2)}`,
    );
    const dependsOnResult = await runContentionLevel("dependsOn", writerCount);
    subject.push(dependsOnResult);
    console.log(
      `contention:dependsOn:writers=${String(writerCount)}      throughput=${dependsOnResult.throughputPerSecond.toFixed(1)}/s  p99=${formatMs(dependsOnResult.p99Ms)}  waitFraction=${dependsOnResult.waitFraction.toFixed(2)}`,
    );
  }

  const eightWriterBaseline = baseline.find((result) => result.writers === 8);
  const eightWriterSubject = subject.find((result) => result.writers === 8);
  if (eightWriterBaseline !== undefined && eightWriterSubject !== undefined) {
    const ratio =
      eightWriterSubject.throughputPerSecond /
      eightWriterBaseline.throughputPerSecond;
    console.log(
      `\nD-7: 8-writer dependsOn throughput is ${(ratio * 100).toFixed(1)}% of the cardinalityOne baseline (criterion: >= 70%).`,
    );
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const backendKind: PerfBackend =
    argv.includes("--backend=postgres") ? "postgres" : "sqlite";
  const sqliteStorage: SqliteStorage =
    argv.includes("--storage=file") ? "file" : "memory";

  // §13.4: a separate mode from the latency lane above — 30s per writer
  // count is far too slow to run inline with every invocation, and the
  // measurement only means anything on a real PostgreSQL server (PGlite
  // cannot overlap two writers).
  if (argv.includes("--contention")) {
    if (backendKind !== "postgres") {
      throw new Error(
        "--contention requires --backend=postgres: PGlite/SQLite are " +
          "single-connection and cannot exhibit genuine write contention.",
      );
    }
    await runContentionSuite();
    return;
  }

  console.log(
    `TypeGraph acyclicity bench (backend=${backendKind}${backendKind === "sqlite" ? `, storage=${sqliteStorage}` : ""}, warmup=${WARMUP_ITERATIONS}, samples=${SAMPLE_ITERATIONS})`,
  );

  const latencies: LatencyRecord = new Map();
  for (const size of SIZES) {
    for (const edgeKind of [
      "plainMany",
      "cardinalityOne",
      "dependsOn",
    ] as const) {
      for (const shape of [benchChainAppend, benchChainPrepend, benchForest]) {
        const handle = await buildBackend(backendKind, sqliteStorage);
        try {
          await shape(handle, size, edgeKind, latencies);
        } finally {
          await handle.close();
        }
      }
    }
  }

  const historyPath = writeHistoryEntry({
    backend: backendKind,
    ...(backendKind === "sqlite" ? { sqliteStorage } : {}),
    scale: 1,
    userCount: 0,
    latencies,
  });
  console.log(`\nappended run to ${historyPath}`);

  console.log("\n§7.6 index-coverage reading:");
  for (const size of SIZES) {
    await explainAcyclicityProbe(backendKind, size);
  }

  console.log(
    "\nD-7 ship criteria (read manually against the numbers above):" +
      '\n  - acyclic insert p95 within ~3x the cardinality:"one" insert p95 at 10^5 edges on the forest shape, on both engines.' +
      '\n  - 8-writer PostgreSQL contention run keeps aggregate throughput within ~30% of the cardinality:"one" run: run separately with `--backend=postgres --contention` (30s per writer count, not run as part of this invocation).' +
      "\nFail either => the maintained ancestor set needs to be designed before D.2 ships. This lane does not decide it — the lead does, from PostgreSQL numbers.",
  );
}

await main(process.argv.slice(2));
