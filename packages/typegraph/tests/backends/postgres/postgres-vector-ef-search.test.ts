/**
 * Postgres `efSearch` (HNSW `hnsw.ef_search` override) mechanism tests.
 *
 * These assert the *mechanism*, not a statistical recall lift (which
 * depends on HNSW build randomness + corpus size and belongs in a
 * benchmark, not a flaky CI assertion):
 *
 * - The override is applied transaction-locally and does NOT leak to the
 *   next query on a pooled connection — the load-bearing property of
 *   `SET LOCAL`. Issued in autocommit it would roll off with the
 *   statement and the next pooled query would see the session default.
 * - The transactional path still returns correct nearest-neighbor rows.
 * - A backend without interactive transactions warns once and
 *   ignores the option rather than emitting an unscoped `SET`.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { embedding } from "../../../src/core/embedding";
import { defineGraph, defineNode } from "../../../src/index";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { createStoreWithSchema } from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

let sharedPool: Pool | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): { pool: Pool } {
  if (!isPostgresAvailable || sharedPool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { pool: sharedPool };
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await pool.query("SELECT 1");
    sharedPool = pool;
    isPostgresAvailable = true;
    await pool.query(`
      DROP TABLE IF EXISTS typegraph_node_embeddings CASCADE;
      DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
      DROP TABLE IF EXISTS typegraph_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
    `);
    await pool.query(generatePostgresMigrationSQL());
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await pool.end().catch(() => {});
  }
});

afterAll(async () => {
  if (sharedPool !== undefined) await sharedPool.end();
});

beforeEach(async () => {
  if (sharedPool === undefined) return;
  await sharedPool.query(
    `TRUNCATE typegraph_node_uniques,
              typegraph_nodes,
              typegraph_edges,
              typegraph_schema_versions CASCADE`,
  );
  // The strategy's per-(kind, field) vector table is created lazily, so
  // truncate any that exist to keep embedding rows from leaking across
  // tests that reuse the `Doc.embedding` slot under different graph ids.
  const { rows } = await sharedPool.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  for (const row of rows) {
    await sharedPool.query(`TRUNCATE "${row.tablename}" CASCADE`);
  }
});

const Document = defineNode("Doc", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(4),
  }),
});

async function seed(pool: Pool, graphId: string) {
  const graph = defineGraph({
    id: graphId,
    nodes: { Doc: { type: Document } },
    edges: {},
  });
  const backend = createPostgresBackend(drizzle(pool));
  const [store] = await createStoreWithSchema(graph, backend);
  await store.nodes.Doc.create({ title: "alpha", embedding: [1, 0, 0, 0] });
  await store.nodes.Doc.create({ title: "beta", embedding: [0, 1, 0, 0] });
  await store.nodes.Doc.create({ title: "gamma", embedding: [0, 0, 1, 0] });
  return { graph, backend, store };
}

describe("Postgres efSearch — SET LOCAL transaction scoping", () => {
  it("does not leak hnsw.ef_search to the next query on the same connection", async (ctx) => {
    requirePostgres(ctx);
    // max:1 pins one backend connection so the post-search read lands on
    // the same connection the override ran on. SET LOCAL must have rolled
    // off with the committed transaction; a (buggy) session-level SET
    // would still be visible here.
    const pinned = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      const backend = createPostgresBackend(drizzle(pinned));
      const graph = defineGraph({
        id: "ef_leak",
        nodes: { Doc: { type: Document } },
        edges: {},
      });
      const [store] = await createStoreWithSchema(graph, backend);
      await store.nodes.Doc.create({ title: "alpha", embedding: [1, 0, 0, 0] });

      const readEfSearch = async () => {
        const rows = await backend.execute<{ ef: string }>(
          asCompiledRowsSql(
            sql`SELECT current_setting('hnsw.ef_search') AS ef`,
          ),
        );
        return rows[0]?.ef;
      };

      const baseline = await readEfSearch();
      await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        limit: 5,
        efSearch: 256,
      });
      const afterOverride = await readEfSearch();

      expect(baseline).toBeDefined();
      expect(afterOverride).toBe(baseline);
      expect(afterOverride).not.toBe("256");
    } finally {
      await pinned.end();
    }
  });

  it("restores the override inside a caller transaction so later searches don't inherit it", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const { backend } = await seed(pool, "ef_tx_restore");

    await backend.transaction(async (tx) => {
      const readEfSearch = async () => {
        const rows = await tx.execute<{ ef: string }>(
          asCompiledRowsSql(
            sql`SELECT current_setting('hnsw.ef_search') AS ef`,
          ),
        );
        return rows[0]?.ef;
      };
      const baseline = await readEfSearch();
      const params = {
        graphId: "ef_tx_restore",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "hnsw",
        limit: 3,
      } as const;

      await requireDefined(tx.vectorSearch)({ ...params, efSearch: 256 });

      // The override was restored within the same transaction: a later
      // search without efSearch must not inherit 256.
      expect(await readEfSearch()).toBe(baseline);
      expect(await readEfSearch()).not.toBe("256");
      const hits = await requireDefined(tx.vectorSearch)(params);
      expect(hits.length).toBeGreaterThan(0);
      expect(await readEfSearch()).toBe(baseline);
    });
  });

  it("keeps two concurrent searches' GUC groups from interleaving", async (ctx) => {
    requirePostgres(ctx);
    // A transaction has ONE GUC namespace. Serializing statements individually
    // is not enough: `A snapshot → B snapshot → A set → B set → A select` puts
    // A's SELECT under B's ef_search. The whole snapshot/set/select/restore
    // group has to hold the connection.
    const pinned = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    // The driver fills a query config's `values` after we see it, so keep the
    // reference and read it back once the transaction has committed.
    type QueryConfig = Readonly<{ text?: string; values?: readonly unknown[] }>;
    const issued: QueryConfig[] = [];
    pinned.on("connect", (client) => {
      const original = client.query.bind(client);
      Object.defineProperty(client, "query", {
        configurable: true,
        value: (...args: readonly unknown[]): unknown => {
          const [config, values] = args;
          issued.push(
            typeof config === "string" ?
              { text: config, values: values as readonly unknown[] }
            : (config as QueryConfig),
          );
          return (original as (...a: readonly unknown[]) => unknown)(...args);
        },
      });
    });

    try {
      const { backend } = await seed(pinned, "ef_guc_group");
      const params = {
        graphId: "ef_guc_group",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "hnsw",
        limit: 3,
      } as const;

      issued.length = 0;
      await backend.transaction(async (tx) => {
        await Promise.all([
          requireDefined(tx.vectorSearch)({ ...params, efSearch: 111 }),
          requireDefined(tx.vectorSearch)({ ...params, efSearch: 222 }),
        ]);
      });

      function appliesEfSearch(statement: QueryConfig, value: string): boolean {
        return (
          statement.text?.includes("set_config") === true &&
          statement.values?.[0] === "hnsw.ef_search" &&
          statement.values[1] === value
        );
      }

      const applyFirst = issued.findIndex((s) => appliesEfSearch(s, "111"));
      const applySecond = issued.findIndex((s) => appliesEfSearch(s, "222"));
      // The per-field ensure DDL also names the table, so match the ranked
      // SELECT itself rather than any statement mentioning it.
      const firstSearch = issued.findIndex(
        (s) =>
          s.text?.includes("tg_vec_ef_guc_group") === true &&
          s.text.includes("AS node_id"),
      );

      expect(applyFirst).toBeGreaterThanOrEqual(0);
      expect(applySecond).toBeGreaterThanOrEqual(0);
      expect(firstSearch).toBeGreaterThanOrEqual(0);

      // Exactly one search applies its override before the first SELECT runs.
      // Both applying first is the interleave: whichever SELECT goes next would
      // run under the other search's frontier.
      expect(Math.min(applyFirst, applySecond)).toBeLessThan(firstSearch);
      expect(Math.max(applyFirst, applySecond)).toBeGreaterThan(firstSearch);
    } finally {
      await pinned.end();
    }
  });

  it("returns correct nearest-neighbor rows on the transactional path", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const { store } = await seed(pool, "ef_functional");

    const hits = await store.search.vector("Doc", {
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      limit: 3,
      efSearch: 200,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(
      (requireDefined(hits[0]).node as unknown as { title: string }).title,
    ).toBe("alpha");
  });
});

describe("Postgres efSearch — transaction-less backend", () => {
  it("refuses the override instead of silently changing search recall", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    // Seed via a normal (transactional) backend — a transaction-less
    // backend can't bootstrap schema (commitSchemaVersion needs atomicity).
    await seed(pool, "ef_txless");

    const noTxBackend = createPostgresBackend(drizzle(pool), {
      capabilities: { execution: { interactiveTransactions: false } },
    });
    const params = {
      graphId: "ef_txless",
      nodeKind: "Doc",
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      dimensions: 4,
      indexType: "hnsw",
      limit: 3,
      efSearch: 256,
    } as const;

    await expect(
      requireDefined(noTxBackend.vectorSearch)(params),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_BACKEND_CAPABILITY",
      details: {
        capability: "execution.interactiveTransactions",
        efSearch: 256,
      },
    });
  });
});

describe("Postgres efSearch — index contract", () => {
  it("refuses efSearch for an IVFFlat slot instead of ignoring it", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    await seed(pool, "ef_ivfflat_refusal");
    const backend = createPostgresBackend(drizzle(pool));

    await expect(
      requireDefined(backend.vectorSearch)({
        graphId: "ef_ivfflat_refusal",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "ivfflat",
        limit: 3,
        efSearch: 256,
      }),
    ).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      details: { efSearch: 256, indexType: "ivfflat" },
    });
  });
});

/**
 * Whether the connected pgvector defines `hnsw.iterative_scan` (>= 0.8).
 * The assertions that require it degrade to a skip on older servers so
 * external POSTGRES_URL runners don't fail on a version difference. Probed
 * via extversion — the GUC itself registers only after the extension
 * library loads into a session.
 */
async function iterativeScanAvailable(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ v: string | null }>(
    "SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'",
  );
  const version = result.rows[0]?.v;
  if (typeof version !== "string") return false;
  const [major = 0, minor = 0] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return major > 0 || (major === 0 && minor >= 8);
}

describe("Postgres iterative scan — hnsw.iterative_scan on filtered searches", () => {
  it("applies strict_order transaction-locally on HNSW searches and skips brute-force slots", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    if (!(await iterativeScanAvailable(pool))) {
      ctx.skip();
      return;
    }
    await seed(pool, "iter_scan_apply");

    // `set_config` is fully parameterized (`SELECT set_config($1, $2, true)`),
    // so the GUC name only appears in the bind params — capture both.
    const statements: { query: string; params: unknown[] }[] = [];
    const backend = createPostgresBackend(
      drizzle(pool, {
        logger: {
          logQuery(query: string, params: unknown[]) {
            statements.push({ query, params });
          },
        },
      }),
    );

    const params = {
      graphId: "iter_scan_apply",
      nodeKind: "Doc",
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0, 0],
      metric: "cosine",
      dimensions: 4,
      limit: 3,
    } as const;

    await requireDefined(backend.vectorSearch)({
      ...params,
      indexType: "hnsw",
    });
    const hnswSetCalls = statements.filter((statement) =>
      statement.query.includes("set_config"),
    );
    expect(
      hnswSetCalls.some(
        (statement) =>
          statement.params[0] === "hnsw.iterative_scan" &&
          statement.params[1] === "strict_order",
      ),
      "HNSW search must apply hnsw.iterative_scan = strict_order",
    ).toBe(true);

    statements.length = 0;
    await requireDefined(backend.vectorSearch)({
      ...params,
      indexType: "ivfflat",
    });
    const ivfflatSetCalls = statements.filter((statement) =>
      statement.query.includes("set_config"),
    );
    expect(
      ivfflatSetCalls.some(
        (statement) =>
          statement.params[0] === "ivfflat.iterative_scan" &&
          statement.params[1] === "relaxed_order",
      ),
      "IVFFlat search must apply ivfflat.iterative_scan = relaxed_order",
    ).toBe(true);
    // The IVFFlat SQL re-sorts the relaxed candidate set in a
    // MATERIALIZED wrapper so relaxed_order cannot leak misordered rows.
    const ivfflatSelect = statements.find((statement) =>
      statement.query.includes("tg_vec_index_candidates"),
    );
    expect(
      ivfflatSelect?.query,
      "IVFFlat search must re-sort via the MATERIALIZED wrapper",
    ).toContain("AS MATERIALIZED");

    statements.length = 0;
    await requireDefined(backend.vectorSearch)({
      ...params,
      indexType: "none",
    });
    expect(
      statements.filter((statement) => statement.query.includes("set_config")),
      "brute-force slot must not touch GUCs",
    ).toEqual([]);
  });

  it("does not leak hnsw.iterative_scan to the next query on the same connection", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    if (!(await iterativeScanAvailable(pool))) {
      ctx.skip();
      return;
    }
    const pinned = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      await seed(pinned, "iter_scan_leak");
      const backend = createPostgresBackend(drizzle(pinned));

      const readIterativeScan = async () => {
        const result = await pinned.query<{ v: string }>(
          "SELECT current_setting('hnsw.iterative_scan') AS v",
        );
        return result.rows[0]?.v;
      };

      const baseline = await readIterativeScan();
      await requireDefined(backend.vectorSearch)({
        graphId: "iter_scan_leak",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "hnsw",
        limit: 3,
      });
      const afterSearch = await readIterativeScan();

      expect(baseline).toBeDefined();
      expect(afterSearch).toBe(baseline);
      expect(afterSearch).not.toBe("strict_order");
    } finally {
      await pinned.end();
    }
  });

  it("restores the setting inside a caller transaction", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    if (!(await iterativeScanAvailable(pool))) {
      ctx.skip();
      return;
    }
    const { backend } = await seed(pool, "iter_scan_tx");

    await backend.transaction(async (tx) => {
      const readIterativeScan = async () => {
        const rows = await tx.execute<{ v: string }>(
          asCompiledRowsSql(
            sql`SELECT current_setting('hnsw.iterative_scan') AS v`,
          ),
        );
        return rows[0]?.v;
      };
      const baseline = await readIterativeScan();
      await requireDefined(tx.vectorSearch)({
        graphId: "iter_scan_tx",
        nodeKind: "Doc",
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        metric: "cosine",
        dimensions: 4,
        indexType: "hnsw",
        limit: 3,
      });
      expect(await readIterativeScan()).toBe(baseline);
      expect(await readIterativeScan()).not.toBe("strict_order");
    });
  });
});

describe("Postgres search parameters — a session that has not loaded pgvector", () => {
  // pgvector defines `hnsw.*` only when its library loads in the backend
  // process. A search inside a transaction on such a session snapshots an
  // undefined parameter; restoring it must reset it to its default rather than
  // leave the search's value in force for the rest of the transaction.
  it("resets a parameter that was undefined before the search to its default", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const iterativeScan = await iterativeScanAvailable(pool);
    await seed(pool, "ef_cold_restore");
    // A new pool: its one connection has not used a vector value.
    const cold = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      const backend = createPostgresBackend(drizzle(cold));
      await backend.transaction(async (tx) => {
        const read = async (
          statement: Parameters<typeof asCompiledRowsSql>[0],
        ) => {
          const rows = await tx.execute<Record<string, unknown>>(
            asCompiledRowsSql(statement),
          );
          return rows[0];
        };
        // The precondition the case is about: nothing defined the parameter.
        const before = await read(
          sql`SELECT current_setting('hnsw.ef_search', true) AS ef_search`,
        );
        expect(before?.["ef_search"]).toBeNull();

        const hits = await requireDefined(tx.vectorSearch)({
          graphId: "ef_cold_restore",
          nodeKind: "Doc",
          fieldPath: "embedding",
          queryEmbedding: [1, 0, 0, 0],
          metric: "cosine",
          dimensions: 4,
          indexType: "hnsw",
          limit: 1,
          efSearch: 256,
        });
        expect(hits).toHaveLength(1);

        const settings = await read(sql`
          SELECT current_setting('hnsw.ef_search') AS ef_search,
                 (SELECT boot_val FROM pg_settings WHERE name = 'hnsw.ef_search') AS ef_search_default,
                 current_setting('hnsw.iterative_scan', true) AS iterative_scan,
                 (SELECT boot_val FROM pg_settings WHERE name = 'hnsw.iterative_scan') AS iterative_scan_default
        `);
        // `hnsw.iterative_scan` is overridden only on pgvector >= 0.8.
        const observed = {
          efSearch: settings?.["ef_search"],
          iterativeScan:
            iterativeScan ? settings?.["iterative_scan"] : undefined,
        };
        expect(observed).toEqual({
          efSearch: settings?.["ef_search_default"],
          iterativeScan:
            iterativeScan ? settings?.["iterative_scan_default"] : undefined,
        });
        expect(observed.efSearch).not.toBe("256");
        expect(observed.iterativeScan).not.toBe("strict_order");
      });
    } finally {
      await cold.end();
    }
  });

  it("resets a placeholder a rolled-back SET LOCAL left empty", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    await seed(pool, "ef_empty_placeholder");
    const cold = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    try {
      // Before pgvector loads, a rolled-back SET LOCAL leaves a placeholder
      // with no value, which reads as the empty string.
      const client = await cold.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL hnsw.ef_search = 60");
        await client.query("ROLLBACK");
        const placeholder = await client.query<{ v: string }>(
          "SELECT current_setting('hnsw.ef_search', true) AS v",
        );
        expect(placeholder.rows[0]?.v).toBe("");
      } finally {
        client.release();
      }

      const backend = createPostgresBackend(drizzle(cold));
      await backend.transaction(async (tx) => {
        const hits = await requireDefined(tx.vectorSearch)({
          graphId: "ef_empty_placeholder",
          nodeKind: "Doc",
          fieldPath: "embedding",
          queryEmbedding: [1, 0, 0, 0],
          metric: "cosine",
          dimensions: 4,
          indexType: "hnsw",
          limit: 1,
          efSearch: 256,
        });
        expect(hits).toHaveLength(1);
        const rows = await tx.execute<Record<string, unknown>>(
          asCompiledRowsSql(sql`
            SELECT current_setting('hnsw.ef_search') AS ef_search,
                   (SELECT boot_val FROM pg_settings WHERE name = 'hnsw.ef_search') AS ef_search_default
          `),
        );
        expect(rows[0]?.["ef_search"]).toBe(rows[0]?.["ef_search_default"]);
      });
    } finally {
      await cold.end();
    }
  });
});
