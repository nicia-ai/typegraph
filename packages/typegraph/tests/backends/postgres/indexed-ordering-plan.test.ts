/** PostgreSQL planning evidence for index-served nullable field ordering. */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { compileQuery } from "../../../src/query/compiler";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

let pool: Pool | undefined;

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  pool = candidate;
  await candidate.query(generatePostgresMigrationSQL());
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

const Person = defineNode("IndexedOrderPerson", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});

describe("PostgreSQL indexed field ordering", () => {
  it("can satisfy native null ordering from a matching expression index", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const graph = defineGraph({
      id: "indexed_ordering_plan",
      nodes: { IndexedOrderPerson: { type: Person } },
      edges: {},
    });
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.IndexedOrderPerson.bulkCreate(
      Array.from({ length: 1000 }, (_, index) => ({
        props: {
          name: `Person ${index}`,
          ...(index % 10 === 0 ? {} : { age: index }),
        },
      })),
    );
    await pool.query(`
      CREATE INDEX indexed_ordering_age_idx
      ON typegraph_nodes (
        graph_id,
        kind,
        ((props #>> ARRAY['age'])::numeric) ASC NULLS LAST
      )
    `);
    await pool.query("ANALYZE typegraph_nodes");

    const query = store
      .query()
      .from("IndexedOrderPerson", "person")
      .select((fields) => ({
        name: fields.person.name,
        age: fields.person.age,
      }))
      .orderBy("person", "age", "asc")
      .limit(20);
    const compiled = requireDefined(backend.compileSql)(
      compileQuery(query.toAst(), graph.id, "postgres"),
    );
    const client = await pool.connect();
    let transactionStarted = false;
    let plan: string;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      // This proves the matching index is eligible to provide the requested
      // order. It does not claim PostgreSQL will choose it for every data
      // distribution when sequential scans are available.
      await client.query("SET LOCAL enable_seqscan = off");
      const explained = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${compiled.sql}`,
        [...compiled.params],
      );
      plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally {
      if (transactionStarted) await client.query("ROLLBACK");
      client.release();
    }

    expect(plan).toContain("indexed_ordering_age_idx");
    expect(plan).not.toContain("Sort Key:");
  });
});
