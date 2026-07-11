/**
 * #187 regression: provenance transitions need a full-transaction serialization
 * gate, but that gate cannot share the recorded-clock lock taken late at flush.
 * The fix is a graph-write advisory lock: history writes and provenance
 * transitions take it before graph row reads/writes, while the recorded-clock
 * lock remains a separate late-flush allocator lock.
 *
 * This file proves both sides: the graph-write lock does not contend with the
 * recorded-clock lock, and ordinary history writes do contend with provenance
 * transitions on the same graph. That second property prevents `computeSupport`
 * from observing a torn multi-statement snapshot under Postgres READ COMMITTED.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type HistoryStore,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createRetractionCapability } from "../../../src/provenance";
import {
  recordedClockAdvisoryLockSql,
  recordedGraphWriteAdvisoryLockSql,
} from "../../../src/store/recorded-capture";
import {
  createGate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let pool: Pool | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): Pool {
  if (!isPostgresAvailable || pool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return pool;
}

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(`
      DROP TABLE IF EXISTS typegraph_revision_origins CASCADE;
      DROP TABLE IF EXISTS typegraph_recorded_clock CASCADE;
      DROP TABLE IF EXISTS typegraph_recorded_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_recorded_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
      DROP TABLE IF EXISTS typegraph_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
    `);
    await candidate.query(generatePostgresMigrationSQL());
    // Publish the pool only once connection AND schema setup have succeeded;
    // a partial publish would run every test against an already-ended pool
    // instead of skipping, masking the real setup error.
    pool = candidate;
    isPostgresAvailable = true;
  } catch (error) {
    console.error(
      "provenance-advisory-lock: Postgres setup failed; skipping suite.",
      error,
    );
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await candidate.end().catch(() => {});
  }
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

beforeEach(async () => {
  if (pool === undefined) return;
  await pool.query(
    `TRUNCATE typegraph_revision_origins,
              typegraph_recorded_clock,
              typegraph_recorded_edges,
              typegraph_recorded_nodes,
              typegraph_node_uniques,
              typegraph_nodes,
              typegraph_edges,
              typegraph_schema_versions CASCADE`,
  );
});

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Fact = defineNode("Fact", {
  schema: z.object({ label: z.string() }),
});

const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});

const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const graph = defineGraph({
  id: "pg_provenance_advisory_lock",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source, Fact], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
});

const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

const ScannerSource = defineNode("ScannerSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const VendorSource = defineNode("VendorSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const multiSourceGraph = defineGraph({
  id: "pg_provenance_advisory_lock_multi_source",
  nodes: {
    ScannerSource: { type: ScannerSource },
    VendorSource: { type: VendorSource },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [ScannerSource, VendorSource],
      to: [Justification],
    },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
});

const multiSourceConfig = {
  source: { kinds: ["ScannerSource", "VendorSource"] },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

async function createGraphStore(
  targetPool: Pool,
): Promise<HistoryStore<typeof graph>> {
  const backend = createPostgresBackend(drizzle(targetPool));
  const [store] = await createStoreWithSchema(graph, backend, {
    history: true,
  });
  return store;
}

async function createMultiSourceGraphStore(
  targetPool: Pool,
): Promise<HistoryStore<typeof multiSourceGraph>> {
  const backend = createPostgresBackend(drizzle(targetPool));
  const [store] = await createStoreWithSchema(multiSourceGraph, backend, {
    history: true,
  });
  return store;
}

async function acquireLock(client: PoolClient, lockSql: SQL): Promise<void> {
  const compiled = new PgDialect().sqlToQuery(lockSql);
  await client.query(compiled.sql, compiled.params);
}

describe("recorded graph-write advisory lock (Postgres)", () => {
  let heldClients: PoolClient[] = [];

  afterEach(async () => {
    for (const client of heldClients) {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    heldClients = [];
  });

  it("the graph-write lock does not contend with the recorded-clock lock", async (ctx) => {
    // This is the precise property the fix relies on: two DIFFERENT
    // namespaces for the same graphId must never contend, or the early
    // graph-write acquisition could still deadlock against a writer's late
    // clock allocation. (`retract()` itself still legitimately acquires the
    // recorded-clock lock too, at its own flush, for the same reason any
    // other history-capturing write does — that's exercised by the
    // no-deadlock test below, not this one.)
    const targetPool = requirePostgres(ctx);

    const clientA = await targetPool.connect();
    heldClients.push(clientA);
    await clientA.query("BEGIN");
    await acquireLock(clientA, recordedClockAdvisoryLockSql(graph.id));

    const clientB = await targetPool.connect();
    heldClients.push(clientB);
    await clientB.query("BEGIN");
    const pendingB = raceTimeout(
      acquireLock(clientB, recordedGraphWriteAdvisoryLockSql(graph.id)),
      500,
    );

    expect(await pendingB).not.toBe(TIMEOUT_SENTINEL);
  });

  it("serializes concurrent graph writes on the same graph", async (ctx) => {
    const targetPool = requirePostgres(ctx);

    const clientA = await targetPool.connect();
    heldClients.push(clientA);
    await clientA.query("BEGIN");
    await acquireLock(clientA, recordedGraphWriteAdvisoryLockSql(graph.id));

    const clientB = await targetPool.connect();
    heldClients.push(clientB);
    await clientB.query("BEGIN");
    const pendingB = acquireLock(
      clientB,
      recordedGraphWriteAdvisoryLockSql(graph.id),
    );

    // B must block while A holds the same (namespace, graphId) lock.
    const raced = await raceTimeout(pendingB, 500);
    expect(raced).toBe(TIMEOUT_SENTINEL);

    // Releasing A must unblock B.
    await clientA.query("COMMIT");
    await expect(pendingB).resolves.toBeUndefined();
    await clientB.query("COMMIT");
  });

  it("history-captured ordinary writes take the graph-write lock", async (ctx) => {
    const targetPool = requirePostgres(ctx);
    const store = await createGraphStore(targetPool);
    const source = await store.nodes.Source.create(
      { label: "source-a", retracted: false },
      { id: "source-a" },
    );

    const clientA = await targetPool.connect();
    heldClients.push(clientA);
    await clientA.query("BEGIN");
    await acquireLock(clientA, recordedGraphWriteAdvisoryLockSql(graph.id));

    const pendingWrite = store.nodes.Source.update(source.id, {
      label: "blocked-until-lock-release",
    });
    const blocked = await raceTimeout(pendingWrite, 500);
    expect(blocked).toBe(TIMEOUT_SENTINEL);

    await clientA.query("COMMIT");
    await expect(pendingWrite).resolves.toMatchObject({
      label: "blocked-until-lock-release",
    });
  });

  it("history-captured adopted transactions take the graph-write lock before the callback", async (ctx) => {
    const targetPool = requirePostgres(ctx);
    const db = drizzle(targetPool);
    const backend = createPostgresBackend(db);
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const source = await store.nodes.Source.create(
      { label: "source-a", retracted: false },
      { id: "source-a" },
    );

    const clientA = await targetPool.connect();
    heldClients.push(clientA);
    await clientA.query("BEGIN");
    await acquireLock(clientA, recordedGraphWriteAdvisoryLockSql(graph.id));

    let callbackEntered = false;
    const pendingTransaction = db.transaction((externalTx) =>
      store.withRecordedTransaction(externalTx, async (tx) => {
        callbackEntered = true;
        await tx.nodes.Source.update(source.id, {
          label: "updated-inside-adopted-transaction",
        });
      }),
    );

    const blocked = await raceTimeout(pendingTransaction, 500);
    expect(blocked).toBe(TIMEOUT_SENTINEL);
    expect(callbackEntered).toBe(false);

    await clientA.query("COMMIT");
    await expect(pendingTransaction).resolves.toBeUndefined();
    await expect(store.nodes.Source.getById(source.id)).resolves.toMatchObject({
      label: "updated-inside-adopted-transaction",
    });
  });

  it("resolves without deadlocking against a concurrent ordinary write to the retracted source", async (ctx) => {
    const targetPool = requirePostgres(ctx);
    const store = await createGraphStore(targetPool);
    const source = await store.nodes.Source.create(
      { label: "source-a", retracted: false },
      { id: "source-a" },
    );
    const fact = await store.nodes.Fact.create(
      { label: "fact-a" },
      { id: "fact-a" },
    );
    const justification = await store.nodes.Justification.create(
      { label: "justification-a" },
      { id: "justification-a" },
    );
    await store.edges.premiseOf.create(source, justification, {}, { id: "p1" });
    await store.edges.derives.create(justification, fact, {}, { id: "d1" });
    const provenance = createRetractionCapability(store, config);

    // Reproduces the originally-reported shape, but with the fixed acquire
    // order: an ordinary write holds the graph-write gate and the Source row,
    // then reaches the separate recorded-clock lock at flush. Provenance must
    // wait at the graph-write gate instead of forming a cycle against the
    // writer's late clock allocation.
    const writerGate = createGate();
    const writerLocked = createGate();
    const writer = store.transaction(async (tx) => {
      await tx.nodes.Source.update(source.id, { label: "changed" });
      writerLocked.open();
      await writerGate.opened;
    });

    // Wait until the writer has taken the source row lock before provenance
    // tries to touch the same row.
    await writerLocked.opened;
    const retraction = provenance.retract(source);

    // Let the writer proceed to its own flush/commit while provenance is
    // blocked on the graph-write gate it holds.
    await new Promise((resolve) => setTimeout(resolve, 100));
    writerGate.open();

    await expect(Promise.all([writer, retraction])).resolves.toBeDefined();
  }, 10_000);

  it("correctly loses support when its two independent sources are retracted concurrently", async (ctx) => {
    // The functional consequence of the fix, under Postgres's mandatory
    // READ COMMITTED isolation for history-enabled stores: a fact
    // supported by two disjoint justification chains must never end up
    // incorrectly believed because each concurrent retraction saw a torn
    // snapshot in which the OTHER source still looked available.
    const targetPool = requirePostgres(ctx);
    const store = await createMultiSourceGraphStore(targetPool);
    const scannerSource = await store.nodes.ScannerSource.create(
      { label: "scanner", retracted: false },
      { id: "scanner-a" },
    );
    const vendorSource = await store.nodes.VendorSource.create(
      { label: "vendor", retracted: false },
      { id: "vendor-a" },
    );
    const fact = await store.nodes.Fact.create(
      { label: "fact-a" },
      { id: "fact-a" },
    );
    const scannerJustification = await store.nodes.Justification.create(
      { label: "scanner-justification" },
      { id: "scanner-justification" },
    );
    const vendorJustification = await store.nodes.Justification.create(
      { label: "vendor-justification" },
      { id: "vendor-justification" },
    );
    await store.edges.premiseOf.create(
      scannerSource,
      scannerJustification,
      {},
      { id: "scanner-premise" },
    );
    await store.edges.premiseOf.create(
      vendorSource,
      vendorJustification,
      {},
      { id: "vendor-premise" },
    );
    await store.edges.derives.create(
      scannerJustification,
      fact,
      {},
      { id: "scanner-derives" },
    );
    await store.edges.derives.create(
      vendorJustification,
      fact,
      {},
      { id: "vendor-derives" },
    );
    const provenance = createRetractionCapability(store, multiSourceConfig);

    const [scannerReport, vendorReport] = await Promise.all([
      provenance.retract(scannerSource),
      provenance.retract(vendorSource),
    ]);

    const died = [...scannerReport.died, ...vendorReport.died];
    expect(died).toEqual([{ kind: "Fact", id: "fact-a" }]);
    await expect(store.nodes.Fact.getById(fact.id)).resolves.toBeUndefined();
  });
});
