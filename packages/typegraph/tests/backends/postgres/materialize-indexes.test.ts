/**
 * PostgreSQL-specific tests for `store.materializeIndexes()`.
 *
 * Verifies the CONCURRENTLY path, status persistence in pgvector-bearing
 * databases, and the two-instance race (idempotency under concurrent
 * callers).
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import {
  generatePostgresDDL,
  generatePostgresMigrationSQL,
} from "../../../src/backend/drizzle/ddl";
import { tables as defaultPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { defineEdgeIndex, defineNodeIndex } from "../../../src/indexes";
import { createStoreWithSchema } from "../../../src/store";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let sharedPool: Pool | undefined;
let sharedDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): {
  pool: Pool;
  db: NodePgDatabase;
} {
  if (
    !isPostgresAvailable ||
    sharedPool === undefined ||
    sharedDb === undefined
  ) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { pool: sharedPool, db: sharedDb };
}

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await pool.query("SELECT 1");
    sharedPool = pool;
    sharedDb = drizzle(pool);
    isPostgresAvailable = true;
    await pool.query(`
      DROP TABLE IF EXISTS typegraph_index_materializations CASCADE;
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
    `TRUNCATE typegraph_index_materializations,
              typegraph_node_uniques,
              typegraph_nodes,
              typegraph_edges,
              typegraph_schema_versions CASCADE`,
  );
  // Drop any indexes leaked from prior runs so CONCURRENTLY can recreate them.
  const leakedIndexes = await sharedPool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_tg_%'`,
  );
  for (const { indexname } of leakedIndexes.rows) {
    await sharedPool.query(`DROP INDEX IF EXISTS "${indexname}"`);
  }
});

const Person = defineNode("Person", {
  schema: z.object({ email: z.email(), name: z.string() }),
});

function buildGraph() {
  const personEmail = defineNodeIndex(Person, { fields: ["email"] });
  const personName = defineNodeIndex(Person, { fields: ["name"] });
  return defineGraph({
    id: "pg_materialize_test",
    nodes: { Person: { type: Person } },
    edges: {},
    indexes: [personEmail, personName],
  });
}

describe("Postgres store.materializeIndexes — CONCURRENTLY", () => {
  it("creates indexes via CREATE INDEX CONCURRENTLY", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();
    expect(result.results).toHaveLength(2);
    for (const entry of result.results) {
      expect(entry.status).toBe("created");
    }

    // Indexes physically present in the catalog.
    const created = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_tg_%'`,
    );
    expect(created.rows.length).toBe(2);
  });

  it("is idempotent: a second call reports alreadyMaterialized", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    await store.materializeIndexes();
    const second = await store.materializeIndexes();
    for (const entry of second.results) {
      expect(entry.status).toBe("alreadyMaterialized");
    }
  });

  it("a sequential second caller from a fresh store sees alreadyMaterialized", async (ctx) => {
    // The spec says "behavior verified across two replicas of the same
    // schema_doc" — i.e. two callers (potentially in different
    // processes) against the SAME database see consistent status. Run
    // two callers against fresh stores backed by the same pool: the
    // second sees alreadyMaterialized, not failed, not re-created.
    const { pool } = requirePostgres(ctx);
    const graph = buildGraph();
    const backendA = createPostgresBackend(drizzle(pool));
    const [storeA] = await createStoreWithSchema(graph, backendA);
    const first = await storeA.materializeIndexes();
    expect(first.results.every((entry) => entry.status === "created")).toBe(
      true,
    );

    const backendB = createPostgresBackend(drizzle(pool));
    const [storeB] = await createStoreWithSchema(graph, backendB);
    const second = await storeB.materializeIndexes();
    expect(
      second.results.every((entry) => entry.status === "alreadyMaterialized"),
    ).toBe(true);
  });

  it("two concurrent callers serialize through the build claim", async (ctx) => {
    // Two fresh stores fire materializeIndexes simultaneously against an
    // empty status table. The cross-caller claim serializes same-index
    // CONCURRENTLY builds (two same-name expression-index CICs deadlock —
    // no safe-snapshot exemption), so per index EXACTLY ONE caller
    // creates and the other settles as alreadyMaterialized after
    // re-claiming. Repeated to deny the old code its timing luck; the
    // automatic post-create ANALYZE (re-enabled with the claim) runs in
    // every iteration — the timing shift that originally surfaced the
    // deadlock.
    const { pool } = requirePostgres(ctx);
    for (let iteration = 0; iteration < 3; iteration++) {
      await pool.query(`TRUNCATE typegraph_index_materializations CASCADE`);
      const leaked = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_tg_%'`,
      );
      for (const { indexname } of leaked.rows) {
        await pool.query(`DROP INDEX IF EXISTS "${indexname}"`);
      }

      const graph = buildGraph();
      const backendA = createPostgresBackend(drizzle(pool));
      const backendB = createPostgresBackend(drizzle(pool));
      const [storeA] = await createStoreWithSchema(graph, backendA);
      const [storeB] = await createStoreWithSchema(graph, backendB);

      const [a, b] = await Promise.all([
        storeA.materializeIndexes(),
        storeB.materializeIndexes(),
      ]);

      for (const [index, entryA] of a.results.entries()) {
        const entryB = b.results[index]!;
        const statuses = [entryA.status, entryB.status].toSorted();
        expect(statuses, `iteration ${iteration}: ${entryA.indexName}`).toEqual(
          ["alreadyMaterialized", "created"],
        );
      }

      const created = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_tg_%'`,
      );
      expect(created.rows.length).toBe(2);
    }
  });

  it("does not hold AccessExclusiveLock on typegraph_nodes during materialization", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    // Run materializeIndexes concurrently with a SELECT against the
    // target table. If CREATE INDEX (without CONCURRENTLY) were used,
    // the SELECT would block until the index build completes. With
    // CONCURRENTLY it doesn't.
    const select = pool.query("SELECT count(*) FROM typegraph_nodes");
    const materialize = store.materializeIndexes();
    const [, result] = await Promise.all([select, materialize]);

    for (const entry of result.results) {
      expect(entry.status).toBe("created");
    }
  });
});

describe("Postgres store.materializeIndexes — status table", () => {
  it("records timestamps in the status table", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    await store.materializeIndexes();

    const db = drizzle(pool);
    const rows = await db
      .select()
      .from(defaultPostgresTables.indexMaterializations);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.materializedAt).not.toBeNull();
      expect(row.lastError).toBeNull();
      expect(row.signature).toMatch(/^[0-9a-f]+$/);
    }
  });
});

describe("Postgres store.materializeIndexes — GIN-family methods", () => {
  const Article = defineNode("Article", {
    schema: z.object({
      title: z.string(),
      tags: z.array(z.string()),
    }),
  });

  function buildGinGraph() {
    return defineGraph({
      id: "pg_gin_method_test",
      nodes: { Article: { type: Article } },
      edges: {},
      indexes: [
        defineNodeIndex(Article, {
          fields: ["tags"],
          method: "gin",
          name: "idx_tg_article_tags_gin",
        }),
        defineNodeIndex(Article, {
          fields: ["title"],
          method: "trigram",
          name: "idx_tg_article_title_trgm",
        }),
      ],
    });
  }

  it("creates gin and trigram expression indexes and is idempotent", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(buildGinGraph(), backend);

    const first = await store.materializeIndexes();
    expect(first.results.map((entry) => entry.status).toSorted()).toEqual([
      "created",
      "created",
    ]);

    const second = await store.materializeIndexes();
    expect(
      second.results.every((entry) => entry.status === "alreadyMaterialized"),
    ).toBe(true);

    // Physically present with the expected access method and the pg_trgm
    // extension installed by the trigram materialization.
    const indexRows = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname IN ('idx_tg_article_tags_gin', 'idx_tg_article_title_trgm')`,
    );
    expect(indexRows.rows).toHaveLength(2);
    for (const row of indexRows.rows) {
      expect(row.indexdef).toContain("USING gin");
    }
    const extension = await pool.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(extension.rows).toHaveLength(1);
  });

  it("keeps containment and substring queries correct with the indexes in place", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(buildGinGraph(), backend);
    await store.materializeIndexes();

    await store.nodes.Article.create({
      title: "Postgres indexing deep dive",
      tags: ["databases", "postgres"],
    });
    await store.nodes.Article.create({
      title: "Cooking with cast iron",
      tags: ["cooking"],
    });

    const tagged = await store
      .query()
      .from("Article", "a")
      .whereNode("a", (article) => article.tags.contains("postgres"))
      .select(({ a }) => ({ title: a.title }))
      .execute();
    expect(tagged.map((row) => row.title)).toEqual([
      "Postgres indexing deep dive",
    ]);

    const substring = await store
      .query()
      .from("Article", "a")
      .whereNode("a", (article) => article.title.contains("INDEXING"))
      .select(({ a }) => ({ title: a.title }))
      .execute();
    expect(substring.map((row) => row.title)).toEqual([
      "Postgres indexing deep dive",
    ]);
  });
});

describe("Postgres store.materializeIndexes — edge GIN-family methods", () => {
  const Tagged = defineEdge("tagged", {
    schema: z.object({
      labels: z.array(z.string()),
      note: z.string(),
    }),
  });

  function buildEdgeGinGraph() {
    return defineGraph({
      id: "pg_edge_gin_method_test",
      nodes: { Person: { type: Person } },
      edges: {
        tagged: {
          type: Tagged,
          from: [Person],
          to: [Person],
          cardinality: "many",
        },
      },
      indexes: [
        defineEdgeIndex(Tagged, {
          fields: ["labels"],
          method: "gin",
          name: "idx_tg_tagged_labels_gin",
        }),
        defineEdgeIndex(Tagged, {
          fields: ["note"],
          method: "trigram",
          name: "idx_tg_tagged_note_trgm",
        }),
      ],
    });
  }

  it("creates edge gin/trigram expression indexes on typegraph_edges and is idempotent", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(buildEdgeGinGraph(), backend);

    const first = await store.materializeIndexes();
    expect(first.results.map((entry) => entry.status).toSorted()).toEqual([
      "created",
      "created",
    ]);
    for (const entry of first.results) {
      expect(entry.entity).toBe("edge");
    }

    const second = await store.materializeIndexes();
    expect(
      second.results.every((entry) => entry.status === "alreadyMaterialized"),
    ).toBe(true);

    // Physically present on typegraph_edges with the GIN access method.
    const indexRows = await pool.query<{ indexdef: string; tablename: string }>(
      `SELECT indexdef, tablename FROM pg_indexes WHERE indexname IN ('idx_tg_tagged_labels_gin', 'idx_tg_tagged_note_trgm')`,
    );
    expect(indexRows.rows).toHaveLength(2);
    for (const row of indexRows.rows) {
      expect(row.indexdef).toContain("USING gin");
      expect(row.tablename).toBe("typegraph_edges");
    }
  });
});

// Used to keep the import linter happy when the suite skips entirely.
void generatePostgresDDL;

describe("Postgres materialize build claim", () => {
  it("waits for a live claim holder, then converges without rebuilding", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const graph = buildGraph();
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(graph, backend);

    // First materialize normally to learn the two index names and seed
    // valid status rows, then wipe status to stage the contention.
    const first = await store.materializeIndexes();
    const indexNames = first.results.map((entry) => entry.indexName);
    const claimedName = indexNames[0]!;

    // Stage: another materializer "holds" a live claim on index 0 and has
    // NOT yet recorded a result. Rows for both indexes are wiped so this
    // caller must build both.
    await pool.query(`TRUNCATE typegraph_index_materializations CASCADE`);
    for (const indexname of indexNames) {
      await pool.query(`DROP INDEX IF EXISTS "${indexname}"`);
    }
    await pool.query(
      `INSERT INTO typegraph_index_materializations
         (index_name, graph_id, entity, kind, signature, schema_version,
          last_attempted_at, building_since, claim_token)
       VALUES ($1, 'pg_materialize_test', 'node', 'Person', 'foreign', 1,
               now(), now(), 'other-holder')`,
      [claimedName],
    );

    // The "holder" finishes 400ms in: it creates the physical index,
    // records success with the REAL signature, and releases the claim —
    // exactly what a winning materializer does.
    const holderFinishes = (async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 400);
      });
      const holderBackend = createPostgresBackend(drizzle(pool));
      const [holderStore] = await createStoreWithSchema(graph, holderBackend);
      // Clear the fake claim so the holder-run can claim and build.
      await pool.query(
        `UPDATE typegraph_index_materializations
         SET building_since = NULL, claim_token = NULL
         WHERE index_name = $1`,
        [claimedName],
      );
      await holderStore.materializeIndexes();
    })();

    const [result] = await Promise.all([
      store.materializeIndexes(),
      holderFinishes,
    ]);

    // This caller never failed and never double-built: the claimed index
    // settles as alreadyMaterialized (built by the "holder") or created
    // (if this caller won the post-release claim race) — either way both
    // indexes exist exactly once and no entry failed.
    for (const entry of result.results) {
      expect(entry.status).not.toBe("failed");
    }
    const created = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_tg_%'`,
    );
    expect(created.rows.length).toBe(2);
  });

  it("takes over a stale (lease-expired) claim immediately", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const graph = buildGraph();
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(graph, backend);
    const first = await store.materializeIndexes();
    const staleName = first.results[0]!.indexName;

    await pool.query(`TRUNCATE typegraph_index_materializations CASCADE`);
    for (const entry of first.results) {
      await pool.query(`DROP INDEX IF EXISTS "${entry.indexName}"`);
    }
    // A crashed materializer's claim: 16 minutes old, past the 15-minute
    // lease.
    await pool.query(
      `INSERT INTO typegraph_index_materializations
         (index_name, graph_id, entity, kind, signature, schema_version,
          last_attempted_at, building_since, claim_token)
       VALUES ($1, 'pg_materialize_test', 'node', 'Person', 'crashed', 1,
               now() - interval '16 minutes', now() - interval '16 minutes',
               'crashed-holder')`,
      [staleName],
    );

    const startedAt = Date.now();
    const result = await store.materializeIndexes();
    const elapsed = Date.now() - startedAt;

    for (const entry of result.results) {
      expect(entry.status).toBe("created");
    }
    // Takeover is immediate — no lease-length wait.
    expect(elapsed).toBeLessThan(30_000);
    const claim = await pool.query<{ claim_token: string | null }>(
      `SELECT claim_token FROM typegraph_index_materializations WHERE index_name = $1`,
      [staleName],
    );
    expect(claim.rows[0]?.claim_token).toBeNull();
  });

  it("self-heals an INVALID leftover from an interrupted CONCURRENTLY build", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const graph = buildGraph();
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(graph, backend);
    const first = await store.materializeIndexes();
    const indexName = first.results[0]!.indexName;

    await pool.query(`TRUNCATE typegraph_index_materializations CASCADE`);
    for (const entry of first.results) {
      await pool.query(`DROP INDEX IF EXISTS "${entry.indexName}"`);
    }

    // Manufacture the leftover honestly: seed duplicate rows, then let a
    // UNIQUE CONCURRENTLY build with the declaration's name fail — it
    // leaves an INVALID index with that name behind, the exact state a
    // crashed materializer produces.
    await store.nodes.Person.create({ email: "dup@example.com", name: "a" });
    await store.nodes.Person.create({ email: "dup@example.com", name: "b" });
    await expect(
      pool.query(
        `CREATE UNIQUE INDEX CONCURRENTLY "${indexName}" ON typegraph_nodes ((props ->> 'email'))`,
      ),
    ).rejects.toThrow();
    const invalidBefore = await pool.query<{ indisvalid: boolean }>(
      `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`,
      [indexName],
    );
    expect(invalidBefore.rows[0]?.indisvalid).toBe(false);

    // CREATE INDEX CONCURRENTLY IF NOT EXISTS would silently no-op on the
    // invalid name; the claim-holding materializer must drop and rebuild.
    const result = await store.materializeIndexes();
    const healed = result.results.find(
      (entry) => entry.indexName === indexName,
    );
    expect(healed?.status).toBe("created");

    const validAfter = await pool.query<{ indisvalid: boolean }>(
      `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`,
      [indexName],
    );
    expect(validAfter.rows[0]?.indisvalid).toBe(true);
  });

  it("rebuilds a poisoned success: valid status row over an INVALID index", async (ctx) => {
    // The older failure mode: a recorded SUCCESS whose physical index is
    // invalid (a run interrupted after IF NOT EXISTS silently kept a
    // leftover, or a pre-claim-protocol run recorded over one). The
    // status row is NOT wiped here — alreadyMaterialized must not be
    // trusted over an invalid index.
    const { pool } = requirePostgres(ctx);
    const graph = buildGraph();
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(graph, backend);
    const first = await store.materializeIndexes();
    const indexName = first.results[0]!.indexName;

    // Keep the success row; poison only the physical index.
    await pool.query(`DROP INDEX IF EXISTS "${indexName}"`);
    await store.nodes.Person.create({ email: "p@example.com", name: "a" });
    await store.nodes.Person.create({ email: "p@example.com", name: "b" });
    await expect(
      pool.query(
        `CREATE UNIQUE INDEX CONCURRENTLY "${indexName}" ON typegraph_nodes ((props ->> 'email'))`,
      ),
    ).rejects.toThrow();

    const result = await store.materializeIndexes();
    const healed = result.results.find(
      (entry) => entry.indexName === indexName,
    );
    expect(healed?.status).toBe("created");
    const validAfter = await pool.query<{ indisvalid: boolean }>(
      `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1`,
      [indexName],
    );
    expect(validAfter.rows[0]?.indisvalid).toBe(true);
  });

  it("re-enables the automatic post-create ANALYZE on Postgres", async (ctx) => {
    const { pool } = requirePostgres(ctx);
    const statements: string[] = [];
    const backend = createPostgresBackend(
      drizzle(pool, {
        logger: {
          logQuery(query: string) {
            statements.push(query);
          },
        },
      }),
    );
    const graph = buildGraph();
    const [store] = await createStoreWithSchema(graph, backend);

    statements.length = 0;
    const result = await store.materializeIndexes();
    expect(result.results.some((entry) => entry.status === "created")).toBe(
      true,
    );
    expect(
      statements.some((statement) => statement.includes("ANALYZE")),
      "post-create statistics refresh must run under the claim protocol",
    ).toBe(true);
  });
});
