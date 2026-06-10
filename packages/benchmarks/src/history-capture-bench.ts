/**
 * F1a recorded-time history-capture benchmark.
 *
 * Measures the runtime cost of `createStore(graph, backend, { history: true })`
 * against the design's two performance gates
 * (`docs/design/temporal-f1a-history-capture.md`, "Pre-registered gates"):
 *
 *   Gate 2 — single-op writes:  history-ON p50 latency overhead ≤ 15%
 *   Gate 3 — bulk ingest:       history-ON wall-clock overhead   ≤ 30%
 *
 * (Gate 1 — "history off = byte-identical compiled SQL" — is covered by a
 * snapshot test in the library and is *not* benchmarked here; with history
 * off no capture statement is emitted, so there is nothing to time.)
 *
 * For each dialect we build the E-spike graph twice against two freshly
 * reset databases — one store with history OFF, one with history ON — seed
 * both identically, then time the same operations on each and report the
 * ON/OFF overhead.
 *
 * Shapes measured:
 *
 *   single-op update:  `store.nodes.User.update(id, props)` on an existing
 *                      row. History ON captures one pre-image per call.
 *   single-op delete:  `store.nodes.User.delete(id)` (soft delete) on an
 *                      existing row. Captures one pre-image per call.
 *   bulk ingest:       `store.nodes.User.bulkUpsertById(items)` over IDs
 *                      that ALREADY EXIST. This is the load-bearing choice:
 *                      bulk *create* / *insert* writes NO history (the
 *                      current row is the record of the open interval — see
 *                      design D2), so timing a fresh bulk insert would
 *                      measure zero capture overhead and tell us nothing.
 *                      The bulk-ingest gate's intent is the re-ingest /
 *                      upsert pass that overwrites existing rows — exactly
 *                      what a real ETL "load the latest snapshot" job does —
 *                      so we re-ingest the already-seeded users as updates,
 *                      which forces one captured pre-image per row, batched
 *                      with the data statements.
 *
 * Run:
 *   pnpm bench:history                      # SQLite (better-sqlite3, in-memory)
 *   pnpm bench:history -- --backend=pglite  # Postgres via in-process PGlite
 *   pnpm bench:history -- --backend=postgres# Postgres via node-postgres (POSTGRES_URL)
 *
 * Size knobs (defaults target the E-spike ~50k nodes / ~200k edges):
 *   --users=N            user node count (drives follow/post/edge counts)
 *   --single-op-samples=N
 *   --bulk-batch=N       rows per bulkUpsertById batch
 */
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { createLocalPgliteBackend } from "@nicia-ai/typegraph/postgres/pglite";
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
import { z } from "zod";

import { getPostgresUrl } from "./config";
import { formatMs, median, percentile } from "./utils";

// ============================================================
// Benchmark graph (self-contained; no embeddings / fulltext so the
// numbers isolate the cost of history capture, not side-table sync)
// ============================================================

const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    city: z.string(),
    bio: z.string(),
  }),
});

const Post = defineNode("Post", {
  schema: z.object({
    title: z.string(),
    body: z.string(),
  }),
});

/**
 * Edgeless node kind used for the single-op *delete* measurement. A soft
 * delete of a node that is an edge endpoint is restricted by default
 * (`onDelete: "restrict"`), and switching to cascade/disconnect would
 * soft-delete the connected edges too — extra captures that would pollute
 * the single-row delete number. `Account` carries no edges, so its delete
 * exercises exactly one captured pre-image and nothing else.
 */
const Account = defineNode("Account", {
  schema: z.object({
    handle: z.string(),
    bio: z.string(),
  }),
});

const follows = defineEdge("follows");
const authored = defineEdge("authored");

const historyGraph = defineGraph({
  id: "history_capture_bench",
  nodes: {
    User: { type: User },
    Post: { type: Post },
    Account: { type: Account },
  },
  edges: {
    follows: { type: follows, from: [User], to: [User], cardinality: "many" },
    authored: { type: authored, from: [User], to: [Post], cardinality: "many" },
  },
});

type HistoryStore = ReturnType<typeof createStore<typeof historyGraph>>;

// ============================================================
// CLI
// ============================================================

type HistoryBackend = "sqlite" | "postgres" | "pglite";

type Options = Readonly<{
  backend: HistoryBackend;
  userCount: number;
  singleOpSamples: number;
  bulkBatch: number;
}>;

// E-spike target: ~50k nodes / ~200k edges. With these densities:
//   nodes  = userCount * (1 + postsPerUser)
//   edges  = userCount * (followsPerUser + postsPerUser)   [authored == posts]
// 25k users → 25k + 125k = 150k nodes, 25k*(6+5)=275k edges — comfortably
// in the E-spike band while staying tractable for the in-WASM PGlite engine.
const DEFAULT_USER_COUNT = 25_000;
const FOLLOWS_PER_USER = 6;
const POSTS_PER_USER = 5;
const DEFAULT_SINGLE_OP_SAMPLES = 200;
const DEFAULT_BULK_BATCH = 500;
const USER_BIO_BYTES = 256;
const POST_BODY_BYTES = 512;

function parseNumberFlag(
  argv: readonly string[],
  flag: string,
  fallback: number,
): number {
  const match = argv.find((argument) => argument.startsWith(`${flag}=`));
  if (match === undefined) return fallback;
  const parsed = Number(match.slice(flag.length + 1));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: "${match}". Must be positive.`);
  }
  return Math.round(parsed);
}

function parseOptions(argv: readonly string[]): Options {
  const backendArgument = argv.find((argument) =>
    argument.startsWith("--backend="),
  );
  const rawBackend =
    backendArgument === undefined ? "sqlite" : backendArgument.slice(10);
  if (
    rawBackend !== "sqlite" &&
    rawBackend !== "postgres" &&
    rawBackend !== "pglite"
  ) {
    throw new Error(
      `Unsupported --backend: "${rawBackend}". Expected "sqlite", "postgres", or "pglite".`,
    );
  }
  return {
    backend: rawBackend,
    userCount: parseNumberFlag(argv, "--users", DEFAULT_USER_COUNT),
    singleOpSamples: parseNumberFlag(
      argv,
      "--single-op-samples",
      DEFAULT_SINGLE_OP_SAMPLES,
    ),
    bulkBatch: parseNumberFlag(argv, "--bulk-batch", DEFAULT_BULK_BATCH),
  };
}

// ============================================================
// Backend construction (one factory call yields a fresh DB; we call it
// twice per dialect so history-OFF and history-ON each get a clean store)
// ============================================================

type StoreResources = Readonly<{
  store: HistoryStore;
  refreshStatistics: () => Promise<void>;
  close: () => Promise<void>;
}>;

const POSTGRES_RESET_DDL = `
  DROP TABLE IF EXISTS typegraph_node_history CASCADE;
  DROP TABLE IF EXISTS typegraph_edge_history CASCADE;
  DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
  DROP TABLE IF EXISTS typegraph_edges CASCADE;
  DROP TABLE IF EXISTS typegraph_nodes CASCADE;
  DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
  DROP TABLE IF EXISTS typegraph_node_fulltext CASCADE;
`;

async function createSqliteResources(
  history: boolean,
): Promise<StoreResources> {
  const tables = createSqliteTables({});
  const sqlite = new Database(":memory:");
  for (const statement of generateSqliteDDL(tables)) {
    sqlite.exec(statement);
  }
  const backend = createSqliteBackend(drizzleSqlite(sqlite), {
    executionProfile: { isSync: true },
    tables,
  });
  await backend.ensureRuntimeContributions?.(historyGraph.id);
  return {
    store: createStore(historyGraph, backend, { history }),
    refreshStatistics: async () => {
      await backend.refreshStatistics();
    },
    close: async () => {
      backend.close();
      sqlite.close();
    },
  };
}

async function createNodePostgresResources(
  history: boolean,
): Promise<StoreResources> {
  const pool = new Pool({ connectionString: getPostgresUrl() });
  const drizzleDb = drizzleNodePostgres(pool);
  await pool.query(POSTGRES_RESET_DDL);
  const tables = createPostgresTables({});
  await pool.query(generatePostgresMigrationSQL(tables));
  const backend = createPostgresBackend(drizzleDb, { tables });
  await backend.ensureRuntimeContributions?.(historyGraph.id);
  return {
    store: createStore(historyGraph, backend, { history }),
    refreshStatistics: async () => {
      await backend.refreshStatistics();
    },
    close: async () => {
      await backend.close();
      await pool.end();
    },
  };
}

async function createPgliteResources(
  history: boolean,
): Promise<StoreResources> {
  // Each PGlite instance is its own in-memory engine, so OFF and ON get
  // genuinely isolated databases without a reset step. The returned backend
  // is wrapped with a managed `close()` that disposes the WASM engine.
  const { backend } = await createLocalPgliteBackend({ vector: false });
  await backend.ensureRuntimeContributions?.(historyGraph.id);
  return {
    store: createStore(historyGraph, backend, { history }),
    refreshStatistics: async () => {
      await backend.refreshStatistics();
    },
    close: async () => {
      await backend.close();
    },
  };
}

function buildResources(
  backend: HistoryBackend,
  history: boolean,
): Promise<StoreResources> {
  switch (backend) {
    case "sqlite": {
      return createSqliteResources(history);
    }
    case "postgres": {
      return createNodePostgresResources(history);
    }
    case "pglite": {
      return createPgliteResources(history);
    }
  }
}

// ============================================================
// Seeding (identical for OFF and ON; deterministic)
// ============================================================

function createRng(seed_: number): () => number {
  let seed = seed_;
  return function next(): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_295;
  };
}

function buildPayload(prefix: string, bytes: number): string {
  const chunk = `${prefix}|`;
  return chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes);
}

type SeedShape = Readonly<{
  userIds: readonly string[];
  accountIds: readonly string[];
  totalNodes: number;
  totalEdges: number;
}>;

async function seed(store: HistoryStore, options: Options): Promise<SeedShape> {
  const { userCount, bulkBatch, singleOpSamples } = options;
  const rng = createRng(42);

  const userIds = Array.from(
    { length: userCount },
    (_, index) => `user_${index}`,
  );

  // Edgeless Account nodes, one per delete sample (+ warmup headroom), so
  // the single-op delete window deletes each exactly once.
  const accountCount = singleOpSamples + 10;
  const accountIds = Array.from(
    { length: accountCount },
    (_, index) => `account_${index}`,
  );
  for (let index = 0; index < accountCount; index += bulkBatch) {
    const batch = accountIds
      .slice(index, index + bulkBatch)
      .map((id, offset) => ({
        id,
        props: {
          handle: `acct_${index + offset}`,
          bio: buildPayload(`acctbio_${index + offset}`, USER_BIO_BYTES),
        },
      }));
    await store.nodes.Account.bulkInsert(batch);
  }

  // Users
  for (let index = 0; index < userCount; index += bulkBatch) {
    const batch = userIds.slice(index, index + bulkBatch).map((id, offset) => ({
      id,
      props: {
        name: `User ${index + offset}`,
        city: (index + offset) % 3 === 0 ? "San Francisco" : "New York",
        bio: buildPayload(`bio_${index + offset}`, USER_BIO_BYTES),
      },
    }));
    await store.nodes.User.bulkInsert(batch);
  }

  // Posts (POSTS_PER_USER each) + authored edges
  let postCount = 0;
  for (let index = 0; index < userCount; index += bulkBatch) {
    const userBatch = userIds.slice(index, index + bulkBatch);
    const posts: {
      id: string;
      props: { title: string; body: string };
    }[] = [];
    const authoredEdges: {
      from: { kind: "User"; id: string };
      to: { kind: "Post"; id: string };
    }[] = [];
    for (const userId of userBatch) {
      for (let p = 0; p < POSTS_PER_USER; p += 1) {
        const postId = `post_${userId}_${p}`;
        posts.push({
          id: postId,
          props: {
            title: `Post ${userId} ${p}`,
            body: buildPayload(`body_${userId}_${p}`, POST_BODY_BYTES),
          },
        });
        authoredEdges.push({
          from: { kind: "User", id: userId },
          to: { kind: "Post", id: postId },
        });
        postCount += 1;
      }
    }
    await store.nodes.Post.bulkInsert(posts);
    await store.edges.authored.bulkInsert(
      authoredEdges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        props: {},
      })),
    );
  }

  // Follow edges (FOLLOWS_PER_USER each)
  let followCount = 0;
  for (let index = 0; index < userCount; index += bulkBatch) {
    const userBatch = userIds.slice(index, index + bulkBatch);
    const followEdges: {
      from: { kind: "User"; id: string };
      to: { kind: "User"; id: string };
    }[] = [];
    for (const fromId of userBatch) {
      const seen = new Set<number>();
      while (seen.size < Math.min(FOLLOWS_PER_USER, userCount - 1)) {
        const candidate = Math.floor(rng() * userCount);
        if (`user_${candidate}` === fromId || seen.has(candidate)) continue;
        seen.add(candidate);
        followEdges.push({
          from: { kind: "User", id: fromId },
          to: { kind: "User", id: `user_${candidate}` },
        });
        followCount += 1;
      }
    }
    await store.edges.follows.bulkInsert(
      followEdges.map((edge) => ({ from: edge.from, to: edge.to, props: {} })),
    );
  }

  return {
    userIds,
    accountIds,
    totalNodes: userCount + postCount + accountCount,
    totalEdges: followCount + postCount,
  };
}

// ============================================================
// Measurement
// ============================================================

type Latency = Readonly<{ p50: number; p95: number; samples: number }>;

function summarize(samples: readonly number[]): Latency {
  return {
    p50: median(samples),
    p95: percentile(samples, 0.95),
    samples: samples.length,
  };
}

/**
 * Measure single-op update latency: each sample updates a distinct existing
 * user row (so history ON captures one pre-image per call). Warmup updates
 * the first 10 rows; the timed window uses fresh indices so no row is
 * updated twice within the timed window (history ON would otherwise grow
 * the side-table and shift later samples).
 */
async function measureSingleOpUpdate(
  store: HistoryStore,
  userIds: readonly string[],
  sampleCount: number,
): Promise<Latency> {
  // Widened (string-keyed) collection: seed ids are plain strings, not
  // the branded `NodeId<User>` the typed collection expects.
  const users = store.getNodeCollectionOrThrow("User");
  const warmup = Math.min(10, userIds.length);
  for (let i = 0; i < warmup; i += 1) {
    await users.update(userIds[i]!, { city: "Warmup" });
  }
  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const id = userIds[(warmup + i) % userIds.length]!;
    const start = performance.now();
    await users.update(id, { city: `City ${i}` });
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

/**
 * Measure single-op (soft) delete latency on edgeless Account rows: each
 * sample deletes a distinct existing row, so history ON captures exactly one
 * pre-image per call (no edge cascade). The first 10 accounts are warmup.
 */
async function measureSingleOpDelete(
  store: HistoryStore,
  accountIds: readonly string[],
  sampleCount: number,
): Promise<Latency> {
  const accounts = store.getNodeCollectionOrThrow("Account");
  const warmup = Math.min(10, accountIds.length);
  for (let i = 0; i < warmup; i += 1) {
    await accounts.delete(accountIds[i]!);
  }
  const count = Math.min(sampleCount, accountIds.length - warmup);
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = accountIds[warmup + i]!;
    const start = performance.now();
    await accounts.delete(id);
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

/**
 * Measure bulk-ingest wall-clock: re-ingest every seeded user as an upsert
 * over its EXISTING id. With history ON this captures one pre-image per row,
 * batched with the data statements — the bulk-ingest gate's load-bearing
 * shape (see file header). Returns total wall-clock for the full pass.
 */
async function measureBulkReingest(
  store: HistoryStore,
  userIds: readonly string[],
  bulkBatch: number,
): Promise<number> {
  const start = performance.now();
  for (let index = 0; index < userIds.length; index += bulkBatch) {
    const batch = userIds.slice(index, index + bulkBatch).map((id, offset) => ({
      id,
      props: {
        name: `Reingest ${index + offset}`,
        city: (index + offset) % 2 === 0 ? "Austin" : "Denver",
        bio: buildPayload(`reingest_${index + offset}`, USER_BIO_BYTES),
      },
    }));
    await store.nodes.User.bulkUpsertById(batch);
  }
  return performance.now() - start;
}

// ============================================================
// Reporting
// ============================================================

function overheadPct(off: number, on: number): number {
  if (off <= 0) return Number.POSITIVE_INFINITY;
  return ((on - off) / off) * 100;
}

function gateVerdict(overhead: number, ceilingPct: number): string {
  return overhead <= ceilingPct ? "PASS" : "FAIL";
}

const SINGLE_OP_GATE_PCT = 15;
const BULK_GATE_PCT = 30;

type DialectResult = Readonly<{
  updateOff: Latency;
  updateOn: Latency;
  deleteOff: Latency;
  deleteOn: Latency;
  bulkOffMs: number;
  bulkOnMs: number;
}>;

async function runDialect(options: Options): Promise<DialectResult> {
  // --- History OFF ---
  const off = await buildResources(options.backend, false);
  let updateOff: Latency;
  let deleteOff: Latency;
  let bulkOffMs: number;
  try {
    const shape = await seed(off.store, options);
    await off.refreshStatistics();
    console.log(
      `  seeded: ${shape.totalNodes} nodes, ${shape.totalEdges} edges`,
    );
    bulkOffMs = await measureBulkReingest(
      off.store,
      shape.userIds,
      options.bulkBatch,
    );
    updateOff = await measureSingleOpUpdate(
      off.store,
      shape.userIds,
      options.singleOpSamples,
    );
    deleteOff = await measureSingleOpDelete(
      off.store,
      shape.accountIds,
      options.singleOpSamples,
    );
  } finally {
    await off.close();
  }

  // --- History ON ---
  const on = await buildResources(options.backend, true);
  let updateOn: Latency;
  let deleteOn: Latency;
  let bulkOnMs: number;
  try {
    const shape = await seed(on.store, options);
    await on.refreshStatistics();
    bulkOnMs = await measureBulkReingest(
      on.store,
      shape.userIds,
      options.bulkBatch,
    );
    updateOn = await measureSingleOpUpdate(
      on.store,
      shape.userIds,
      options.singleOpSamples,
    );
    deleteOn = await measureSingleOpDelete(
      on.store,
      shape.accountIds,
      options.singleOpSamples,
    );
  } finally {
    await on.close();
  }

  return { updateOff, updateOn, deleteOff, deleteOn, bulkOffMs, bulkOnMs };
}

function printResult(options: Options, result: DialectResult): void {
  const updateOverhead = overheadPct(result.updateOff.p50, result.updateOn.p50);
  const deleteOverhead = overheadPct(result.deleteOff.p50, result.deleteOn.p50);
  const bulkOverhead = overheadPct(result.bulkOffMs, result.bulkOnMs);

  console.log(`\n=== ${options.backend} — F1a history-capture overhead ===`);
  console.log(
    `  single-op update p50:  off=${formatPrecise(result.updateOff.p50)}  on=${formatPrecise(result.updateOn.p50)}  overhead=${updateOverhead.toFixed(1)}%  [${gateVerdict(updateOverhead, SINGLE_OP_GATE_PCT)} ≤${SINGLE_OP_GATE_PCT}%]`,
  );
  console.log(
    `  single-op delete p50:  off=${formatPrecise(result.deleteOff.p50)}  on=${formatPrecise(result.deleteOn.p50)}  overhead=${deleteOverhead.toFixed(1)}%  [${gateVerdict(deleteOverhead, SINGLE_OP_GATE_PCT)} ≤${SINGLE_OP_GATE_PCT}%]`,
  );
  console.log(
    `  bulk re-ingest wall:   off=${formatMs(result.bulkOffMs)}  on=${formatMs(result.bulkOnMs)}  overhead=${bulkOverhead.toFixed(1)}%  [${gateVerdict(bulkOverhead, BULK_GATE_PCT)} ≤${BULK_GATE_PCT}%]`,
  );
}

/**
 * Millisecond formatter with sub-millisecond resolution, so the in-memory
 * SQLite single-op p50s (tens of microseconds) are honestly visible rather
 * than rounding to "0.0ms / 0.1ms".
 */
function formatPrecise(value: number): string {
  return value < 1 ? `${value.toFixed(3)}ms` : `${value.toFixed(2)}ms`;
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseOptions(argv);
  console.log(
    `TypeGraph F1a history-capture benchmark (backend=${options.backend}, users=${options.userCount}, single-op samples=${options.singleOpSamples}, bulk batch=${options.bulkBatch})`,
  );
  const result = await runDialect(options);
  printResult(options, result);
}

await main(process.argv.slice(2));
