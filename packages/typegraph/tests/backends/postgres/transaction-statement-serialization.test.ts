/**
 * A transaction-scoped Postgres backend must present exactly one statement at
 * a time to its pinned connection.
 *
 * node-postgres queued overlapping `client.query()` calls internally, but
 * deprecated that in 8.22 ("Calling client.query() when the client is already
 * executing a query is deprecated and will be removed in pg@9.0") and removes
 * the queue in pg@9. TypeGraph overlaps statements on a pinned connection in
 * two ways:
 *
 * 1. Always-on, no user concurrency required — the node write pipeline runs
 *    `Promise.all([syncEmbeddings, syncFulltext])` for any schema carrying
 *    both a `searchable()` field and an `embedding()` field.
 * 2. User-driven — `store.transaction()` invites callers to `Promise.all`
 *    their writes.
 *
 * Both are covered here by instrumenting the physical `pg.Client` the pool
 * hands the transaction, and asserting the maximum number of simultaneously
 * in-flight queries never exceeds one.
 *
 * Skipped unless `POSTGRES_URL` is set (or `scripts/test-postgres.sh`).
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

/**
 * Tracks queries in flight **per physical connection**. Two queries running
 * at once on one client is exactly the condition that trips node-postgres's
 * deprecation notice and throws under pg@9; two queries on two different
 * pooled clients is ordinary concurrency and must not be reported.
 */
type ConcurrencyProbe = Readonly<{
  /** Highest number of queries ever simultaneously open on a single client. */
  maxPerClient: () => number;
  reset: () => void;
}>;

function probePoolConcurrency(pool: Pool): ConcurrencyProbe {
  const inFlight = new WeakMap<PoolClient, number>();
  let maxPerClient = 0;

  pool.on("connect", (client: PoolClient) => {
    const original = client.query.bind(client);
    // `query(config)` / `query(text, values)` both return a promise when no
    // callback is passed, which is the only form Drizzle and TypeGraph use.
    Object.defineProperty(client, "query", {
      configurable: true,
      value: (...args: readonly unknown[]): unknown => {
        const open = (inFlight.get(client) ?? 0) + 1;
        inFlight.set(client, open);
        maxPerClient = Math.max(maxPerClient, open);
        const settled = (original as (...a: readonly unknown[]) => unknown)(
          ...args,
        );
        return Promise.resolve(settled).finally(() => {
          inFlight.set(client, (inFlight.get(client) ?? 1) - 1);
        });
      },
    });
  });

  return {
    maxPerClient: () => maxPerClient,
    reset: () => {
      maxPerClient = 0;
    },
  };
}

// Both a searchable field and an embedding field: this is the schema shape
// whose insert side effects the write pipeline issues concurrently.
const Document = defineNode("Doc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    vector: embedding(3),
  }),
});

const Graph = defineGraph({
  id: "pg_tx_statement_serialization",
  nodes: { Doc: { type: Document } },
  edges: {},
});

let pool: Pool | undefined;
let db: NodePgDatabase | undefined;
let probe: ConcurrencyProbe | undefined;
let postgresAvailable = false;

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  try {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    probe = probePoolConcurrency(pool);
    await pool.query("SELECT 1");
    await pool.query(generatePostgresMigrationSQL());
    db = drizzle(pool);
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

function embeddingValue(seed: number): readonly number[] {
  return [seed, seed + 1, seed + 2];
}

describe.runIf(process.env["POSTGRES_URL"])(
  "transaction-scoped Postgres backend serializes statements on its pinned connection",
  () => {
    beforeEach(async () => {
      if (!postgresAvailable || !pool) return;
      await pool.query(
        `TRUNCATE typegraph_nodes, typegraph_edges,
                  typegraph_node_uniques, typegraph_node_fulltext,
                  typegraph_schema_versions CASCADE`,
      );
      probe?.reset();
    });

    it("never overlaps the write pipeline's embedding and fulltext sync", async () => {
      const backend = createPostgresBackend(requireDefined(db));
      const [store] = await createStoreWithSchema(Graph, backend);
      requireDefined(probe).reset();

      // A single create: no user concurrency at all. The pipeline's own
      // `Promise.all([syncEmbeddings, syncFulltext])` is the overlap source.
      await store.nodes.Doc.create({
        title: "the pinned connection",
        vector: embeddingValue(1),
      });

      expect(requireDefined(probe).maxPerClient()).toBe(1);
    });

    it("never overlaps writes a caller issues with Promise.all inside store.transaction", async () => {
      const backend = createPostgresBackend(requireDefined(db));
      const [store] = await createStoreWithSchema(Graph, backend);
      requireDefined(probe).reset();

      await store.transaction(async (tx) => {
        await Promise.all([
          tx.nodes.Doc.create({ title: "alpha", vector: embeddingValue(1) }),
          tx.nodes.Doc.create({ title: "beta", vector: embeddingValue(4) }),
          tx.nodes.Doc.create({ title: "gamma", vector: embeddingValue(7) }),
        ]);
      });

      expect(requireDefined(probe).maxPerClient()).toBe(1);
      expect(await store.nodes.Doc.count()).toBe(3);
    });

    it("survives a failing statement inside Promise.all and rolls the transaction back", async () => {
      const backend = createPostgresBackend(requireDefined(db));
      const [store] = await createStoreWithSchema(Graph, backend);
      await store.nodes.Doc.create(
        { title: "already here", vector: embeddingValue(1) },
        { id: "taken" },
      );
      requireDefined(probe).reset();

      // The second create collides on the primary key, so the failure comes
      // from Postgres itself — after its sibling has already been queued.
      await expect(
        store.transaction(async (tx) => {
          await Promise.all([
            tx.nodes.Doc.create({
              title: "rolled back",
              vector: embeddingValue(4),
            }),
            tx.nodes.Doc.create(
              { title: "duplicate", vector: embeddingValue(7) },
              { id: "taken" },
            ),
          ]);
        }),
      ).rejects.toThrow();

      expect(requireDefined(probe).maxPerClient()).toBe(1);
      const attached = createStore(
        Graph,
        createPostgresBackend(requireDefined(db)),
      );
      expect(await attached.nodes.Doc.count()).toBe(1);
    });
  },
);
