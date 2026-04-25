/**
 * Postgres-specific fulltext search integration tests.
 *
 * Skipped automatically unless POSTGRES_URL is set (or the
 * scripts/test-postgres.sh harness is used).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, embedding, searchable } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createStore } from "../../../src/store";
import { type FulltextSearchHit } from "../../../src/store/search";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
  }),
});

const HybridDocument = defineNode("HybridDoc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    embedding: embedding(4),
  }),
});

const SearchGraph = defineGraph({
  id: "pg_fts_search",
  nodes: {
    Document: { type: Document },
    HybridDoc: { type: HybridDocument },
  },
  edges: {},
});

type DocumentShape = Readonly<{ title: string; body: string }>;
function asDocument(hit: FulltextSearchHit): DocumentShape {
  return hit.node as unknown as DocumentShape;
}

let pool: Pool | undefined;
let postgresAvailable = false;

beforeAll(async () => {
  // NOTE: do not DROP tables here — `postgres-backend.test.ts` runs in
  // parallel against the same database and also owns the schema. The
  // generated migration SQL uses `CREATE TABLE IF NOT EXISTS` so it's
  // safe to run alongside; per-test isolation is handled by TRUNCATE in
  // `beforeEach` below.
  //
  // Gated on POSTGRES_URL so `pnpm test:unit` doesn't try to attach to a
  // stray Docker Postgres and race other postgres files.
  if (!process.env.POSTGRES_URL) return;
  try {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await pool.query("SELECT 1");
    await pool.query(generatePostgresMigrationSQL());
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe.runIf(process.env.POSTGRES_URL)("PostgreSQL fulltext search", () => {
  let store: ReturnType<typeof createStore<typeof SearchGraph>>;

  beforeEach(async () => {
    if (!postgresAvailable || !pool) return;
    await pool.query("TRUNCATE typegraph_node_fulltext CASCADE");
    await pool.query("TRUNCATE typegraph_nodes CASCADE");
    const db = drizzle(new Pool({ connectionString: TEST_DATABASE_URL }));
    const backend = createPostgresBackend(db);
    store = createStore(SearchGraph, backend);
  });

  it("declares fulltext capability with stemmer languages", () => {
    const db = drizzle(new Pool({ connectionString: TEST_DATABASE_URL }));
    const backend = createPostgresBackend(db);
    expect(backend.capabilities.fulltext?.supported).toBe(true);
    expect(backend.capabilities.fulltext?.phraseQueries).toBe(true);
    expect(backend.capabilities.fulltext?.highlighting).toBe(true);
    expect(backend.capabilities.fulltext?.languages).toContain("english");
  });

  it("indexes searchable fields and finds them via tsvector", async () => {
    await store.nodes.Document.create({
      title: "Climate change drivers",
      body: "Rising temperatures linked to greenhouse emissions",
    });
    await store.nodes.Document.create({
      title: "Local cuisine guide",
      body: "Restaurants worth visiting in town this weekend",
    });

    const results = await store.search.fulltext("Document", {
      query: "climate temperatures",
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(asDocument(results[0]!).title).toBe("Climate change drivers");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("supports websearch syntax with negation and phrase", async () => {
    await store.nodes.Document.create({
      title: "Apple harvest",
      body: "apples and oranges in autumn",
    });
    await store.nodes.Document.create({
      title: "Apple recipe",
      body: "apples and cinnamon make a fine pie",
    });

    const negated = await store.search.fulltext("Document", {
      query: "apples -oranges",
      mode: "websearch",
      limit: 10,
    });
    expect(negated).toHaveLength(1);
    expect(asDocument(negated[0]!).title).toBe("Apple recipe");

    const phrase = await store.search.fulltext("Document", {
      query: "fine pie",
      mode: "phrase",
      limit: 10,
    });
    expect(phrase).toHaveLength(1);
    expect(asDocument(phrase[0]!).title).toBe("Apple recipe");
  });

  it("returns ts_headline snippets when requested", async () => {
    await store.nodes.Document.create({
      title: "Snippet test",
      body: "A long body with the word climate buried in the middle",
    });

    const results = await store.search.fulltext("Document", {
      query: "climate",
      limit: 1,
      includeSnippets: true,
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.snippet).toBeDefined();
    // ts_headline default highlight is <b>...</b>
    expect(results[0]?.snippet?.toLowerCase()).toMatch(/climate/);
  });

  it("removes the fulltext row on hard delete cascade", async () => {
    const document = await store.nodes.Document.create({
      title: "ephemeral",
      body: "to be deleted",
    });

    await store.nodes.Document.hardDelete(document.id);

    const results = await store.search.fulltext("Document", {
      query: "ephemeral",
      limit: 10,
    });
    expect(results).toHaveLength(0);
  });

  it("hybrid search fuses pgvector and tsvector results via RRF", async () => {
    // Three docs with very different vector + textual signals.
    const a = await store.nodes.HybridDoc.create({
      title: "Solar power",
      body: "renewable energy from photovoltaics",
      embedding: [1, 0, 0, 0],
    });
    const b = await store.nodes.HybridDoc.create({
      title: "Wind turbines",
      body: "kinetic energy converted by rotors",
      embedding: [0, 1, 0, 0],
    });
    const c = await store.nodes.HybridDoc.create({
      title: "Hydroelectric dams",
      body: "energy from controlled water flow",
      embedding: [0, 0, 1, 0],
    });

    // Vector query closer to "wind" (b), fulltext favors "solar" (a).
    const results = await store.search.hybrid("HybridDoc", {
      limit: 3,
      vector: {
        fieldPath: "embedding",
        queryEmbedding: [0, 1, 0, 0],
      },
      fulltext: { query: "solar" },
    });

    // All three docs should appear since vector pulls all of them in;
    // the top result should be one of (a, b) — both have a strong source.
    expect(results.length).toBeGreaterThan(0);
    const topId = results[0]!.node.id;
    expect([a.id, b.id]).toContain(topId);

    // At least one result should report sub-scores from both halves.
    const fused = results.find(
      (r) => r.vector !== undefined && r.fulltext !== undefined,
    );
    expect(fused).toBeDefined();
    // Avoid an unused-variable lint: c is the hydroelectric doc, only
    // here to provide a third candidate that should appear via vector.
    expect([a.id, b.id, c.id]).toContain(topId);
  });

  it("honors per-query language override via ${lang}::regconfig cast", async () => {
    // Row is stored with `language = english`, so the tsvector holds the
    // stemmed lexeme `run` for both "running" and "runs". Query "running":
    //   - english override: stems the query to `run`, matches the lexeme.
    //   - simple override:  keeps the literal `running`, does NOT match.
    // The gap only appears because the override actually takes effect —
    // exercising the `${language}::regconfig` bound-parameter cast branch
    // of `postgresTsquery` that SQLite rejects but PG honors.
    await store.nodes.Document.create({
      title: "Running shoes",
      body: "the best trainers for long runs",
    });

    const englishHits = await store.search.fulltext("Document", {
      query: "running",
      limit: 5,
      language: "english",
    });
    expect(englishHits).toHaveLength(1);

    const simpleHits = await store.search.fulltext("Document", {
      query: "running",
      limit: 5,
      language: "simple",
    });
    expect(simpleHits).toHaveLength(0);
  });

  it("tsv is a generated column: raw content updates reindex automatically", async () => {
    // The `tsv` column is `GENERATED ALWAYS AS (to_tsvector("language",
    // "content")) STORED` — Postgres recomputes it whenever `content`
    // changes. Prove the invariant by updating `content` via raw SQL
    // (bypassing the strategy's `buildUpsert`) and confirming the search
    // surfaces the new term. If STORED is ever dropped or the generated
    // expression changes, this test fails.
    if (!pool) throw new Error("pool not initialised");

    const document = await store.nodes.Document.create({
      title: "Before",
      body: "initial content",
    });

    const beforeHits = await store.search.fulltext("Document", {
      query: "koala",
      limit: 1,
    });
    expect(beforeHits).toHaveLength(0);

    await pool.query(
      `UPDATE typegraph_node_fulltext SET "content" = $1
       WHERE "node_id" = $2`,
      ["article about koalas in eucalyptus forests", document.id],
    );

    const afterHits = await store.search.fulltext("Document", {
      query: "koala",
      limit: 1,
    });
    expect(afterHits).toHaveLength(1);
    expect(afterHits[0]?.node.id).toBe(document.id);
  });

  it("rejects direct writes to the tsv generated column", async () => {
    // PG raises `cannot insert a non-DEFAULT value into column "tsv"` for
    // direct INSERTs that target a GENERATED column. If STORED were
    // dropped, this insert would quietly succeed — which is the exact
    // regression we want to catch.
    if (!pool) throw new Error("pool not initialised");

    await expect(
      pool.query(
        `INSERT INTO typegraph_node_fulltext
           ("graph_id", "node_kind", "node_id", "content", "language", "tsv", "updated_at")
         VALUES ($1, $2, $3, $4, $5::regconfig, $6::tsvector, NOW())`,
        [
          SearchGraph.id,
          "Document",
          "direct-write",
          "hello",
          "english",
          "hello",
        ],
      ),
    ).rejects.toThrow(/generated column|cannot insert/i);
  });

  it("query-builder hybrid search keeps single-source candidates", async () => {
    const solar = await store.nodes.HybridDoc.create({
      title: "Solar power",
      body: "renewable energy from photovoltaics",
      embedding: [1, 0, 0, 0],
    });
    const wind = await store.nodes.HybridDoc.create({
      title: "Wind turbines",
      body: "kinetic energy converted by rotors",
      embedding: [0, 1, 0, 0],
    });

    const results = await store
      .query()
      .from("HybridDoc", "d")
      .whereNode("d", (d) =>
        d.$fulltext
          .matches("solar", 2)
          .and(d.embedding.similarTo([0, 1, 0, 0], 2)),
      )
      .select((ctx) => ctx.d as unknown as { id: string; title: string })
      .limit(2)
      .execute();

    const resultIds = results.map((result) => result.id);
    expect(resultIds).toContain(solar.id);
    expect(resultIds).toContain(wind.id);
  });
});
