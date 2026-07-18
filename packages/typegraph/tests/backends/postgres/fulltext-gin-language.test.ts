/**
 * PostgreSQL fulltext must be able to use its GIN index.
 *
 * The tsv column has always carried a GIN index, but the default search
 * path parsed queries with the per-row language COLUMN —
 * `websearch_to_tsquery("language", $q)` — a non-constant tsquery the
 * index can never serve, so every fulltext search scanned the kind's
 * rows (btree kind index + per-row Filter in every captured plan).
 *
 * The store now resolves each kind's DECLARED language (the same
 * winning-language rule the write path applies to rows) and passes it as
 * a constant, keeping the tsquery plan-time-stable. Measured at 5000
 * rows: 12.9ms (per-row parse) -> 2.3ms (constant) for a broad term —
 * and the constant makes GIN service POSSIBLE, which dominates as
 * rows-per-kind grow. Pinned here:
 *
 * - PLAN: the compiled statement folds the tsquery to a plan-time
 *   constant; a constant tsquery is servable by the tsv GIN index
 *   (asserted on the minimal match shape — at test scale the planner may
 *   legitimately prefer the kind btree for the full statement); the
 *   per-row form can NEVER be GIN-served, regardless of costing.
 * - WIRING: the facade forwards the declared language; explicit
 *   per-query overrides still win; the inline `$fulltext` compiler emits
 *   a constant for single-language aliases and falls back to the per-row
 *   column only for mixed-language aliases.
 *
 * Skipped automatically when `POSTGRES_URL` is unset (the wiring tests
 * run on local SQLite regardless).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
  subClassOf,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { buildFulltextSearch } from "../../../src/backend/drizzle/operations/fulltext";
import { liveNodeIdsSubquery } from "../../../src/backend/drizzle/operations/shared";
import { tables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { nowIso } from "../../../src/backend/row-mappers";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { type GraphBackend } from "../../../src/backend/types";
import { tsvectorStrategy } from "../../../src/query/dialect";
import { requireDefined } from "../../../src/utils/presence";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
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
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(`
      DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
      DROP TABLE IF EXISTS typegraph_node_fulltext CASCADE;
      DROP TABLE IF EXISTS typegraph_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
    `);
    await candidate.query(generatePostgresMigrationSQL());
    pool = candidate;
    isPostgresAvailable = true;
  } catch {
    await candidate.end().catch(() => {
      // Unreachable Postgres degrades to "skip".
    });
  }
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

const Article = defineNode("GinArticle", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});
const FrenchNote = defineNode("GinFrenchNote", {
  schema: z.object({ title: searchable({ language: "french" }) }),
});

describe("fulltext GIN index usage (constant declared language)", () => {
  it("serves a selective search from the tsv GIN index", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const graph = defineGraph({
      id: "gin_plan",
      nodes: { GinArticle: { type: Article } },
      edges: {},
    });
    const backend = createPostgresBackend(drizzle(activePool));
    const [store] = await createStoreWithSchema(graph, backend);

    // 5000 docs; the probe token appears in ~19 — selective enough that
    // the GIN bitmap beats both a seq scan and the kind btree (whose
    // bitmap matches every row of the kind and rechecks all of them).
    await store.nodes.GinArticle.bulkCreate(
      Array.from({ length: 5000 }, (_, index) => ({
        props: {
          title:
            index % 267 === 0 ?
              `zyzzogeton report ${index}`
            : `ordinary signal document ${index}`,
        },
      })),
    );
    await store.refreshStatistics();

    const query = buildFulltextSearch(
      "typegraph_node_fulltext",
      {
        graphId: "gin_plan",
        nodeKind: "GinArticle",
        query: "zyzzogeton",
        limit: 10,
        language: "english",
      },
      tsvectorStrategy,
      "postgres",
      liveNodeIdsSubquery(tables.nodes, "gin_plan", "GinArticle", nowIso()),
    );
    const compiled = new PgDialect().sqlToQuery(query);
    const explained = await activePool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (COSTS OFF) ${compiled.sql}`,
      compiled.params,
    );
    const plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    // The enabling property: the tsquery folded to a plan-time CONSTANT
    // (websearch_to_tsquery over a constant regconfig), not the per-row
    // language form.
    expect(plan).toContain("::tsquery");
    expect(plan).not.toContain("websearch_to_tsquery(language");
    // Capability: a constant tsquery is servable by the tsv GIN index —
    // asserted on the minimal match shape (at test scale the planner may
    // legitimately prefer the kind btree for the full statement; GIN wins
    // as rows-per-kind grow, and the point of the constant is that the
    // choice EXISTS at all). The per-row form can never be served,
    // regardless of costing — asserted further below.
    const client = await activePool.connect();
    let indexPlan: string;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const explainedIndexed = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (COSTS OFF)
         SELECT node_id FROM typegraph_node_fulltext
         WHERE tsv @@ websearch_to_tsquery('english', $1)`,
        ["zyzzogeton"],
      );
      indexPlan = explainedIndexed.rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(indexPlan).toContain("_tsv_idx");

    // Sanity: the per-row-language form CANNOT use the index.
    const perRow = buildFulltextSearch(
      "typegraph_node_fulltext",
      {
        graphId: "gin_plan",
        nodeKind: "GinArticle",
        query: "zyzzogeton",
        limit: 10,
      },
      tsvectorStrategy,
      "postgres",
      liveNodeIdsSubquery(tables.nodes, "gin_plan", "GinArticle", nowIso()),
    );
    const compiledPerRow = new PgDialect().sqlToQuery(perRow);
    const clientPerRow = await activePool.connect();
    let perRowPlan: string;
    try {
      await clientPerRow.query("BEGIN");
      await clientPerRow.query("SET LOCAL enable_seqscan = off");
      const explainedPerRow = await clientPerRow.query<{
        "QUERY PLAN": string;
      }>(`EXPLAIN (COSTS OFF) ${compiledPerRow.sql}`, compiledPerRow.params);
      perRowPlan = explainedPerRow.rows
        .map((row) => row["QUERY PLAN"])
        .join("\n");
      await clientPerRow.query("ROLLBACK");
    } finally {
      clientPerRow.release();
    }
    expect(perRowPlan).toContain("websearch_to_tsquery(language");
    expect(perRowPlan).not.toContain("_tsv_idx");
  });

  it("inline $fulltext compiles a constant language for single-language aliases", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const graph = defineGraph({
      id: "gin_inline",
      nodes: {
        GinArticle: { type: Article },
        GinFrenchNote: { type: FrenchNote },
      },
      edges: {},
      ontology: [subClassOf(FrenchNote, Article)],
    });
    const backend = createPostgresBackend(drizzle(activePool));
    const [store] = await createStoreWithSchema(graph, backend);

    const single = store
      .query()
      .from("GinArticle", "d")
      .whereNode("d", (document) => document.$fulltext.matches("signal", 10))
      .select((sel) => ({ id: sel.d.id }))
      .toSQL();
    expect(single.sql).not.toContain('websearch_to_tsquery("language"');
    expect(single.params).toContain("english");

    // Mixed-language alias (english base + french subclass): falls back
    // to the per-row column — a constant would mis-parse one kind.
    const mixed = store
      .query()
      .from("GinArticle", "d", { includeSubClasses: true })
      .whereNode("d", (document) => document.$fulltext.matches("signal", 10))
      .select((sel) => ({ id: sel.d.id }))
      .toSQL();
    expect(mixed.sql).toContain('websearch_to_tsquery("language"');
  });
});

describe("facade forwards the declared language (any backend)", () => {
  it("passes the declared language, and explicit overrides win", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const graph = defineGraph({
        id: "gin_wiring",
        nodes: { GinArticle: { type: Article } },
        edges: {},
      });
      const [store] = await createStoreWithSchema(graph, backend);
      await store.nodes.GinArticle.create({ title: "signal doc" });

      const spy = vi.spyOn(
        backend as {
          fulltextSearch: NonNullable<GraphBackend["fulltextSearch"]>;
        },
        "fulltextSearch",
      );
      await store.search.fulltext("GinArticle", {
        query: "signal",
        limit: 5,
      });
      expect(requireDefined(spy.mock.calls[0])[0].language).toBe("english");
    } finally {
      await backend.close();
    }
  });

  it("explicit per-query overrides win over the declared language", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const graph = defineGraph({
      id: "gin_override",
      nodes: { GinArticle: { type: Article } },
      edges: {},
    });
    const backend = createPostgresBackend(drizzle(activePool));
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.GinArticle.create({ title: "signal doc" });

    const spy = vi.spyOn(
      backend as {
        fulltextSearch: NonNullable<GraphBackend["fulltextSearch"]>;
      },
      "fulltextSearch",
    );
    await store.search.fulltext("GinArticle", {
      query: "signal",
      limit: 5,
      language: "simple",
    });
    expect(requireDefined(spy.mock.calls[0])[0].language).toBe("simple");
  });
});
