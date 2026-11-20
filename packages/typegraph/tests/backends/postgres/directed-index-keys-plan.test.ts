/** PostgreSQL planning evidence for directed node index keys. */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { defineNodeIndex, generateIndexDDL } from "../../../src/indexes";
import { compileQuery } from "../../../src/query/compiler";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

let pool: Pool | undefined;

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await pool.query(generatePostgresMigrationSQL());
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

const Person = defineNode("DirectedKeyPerson", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});

describe("PostgreSQL directed node index keys", () => {
  it("is eligible for mixed-direction pagination ordering", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const ordered = defineNodeIndex(Person, {
      name: "directed_key_age_id_idx",
      keys: [
        { field: "age", direction: "desc" },
        { system: "id", direction: "asc" },
      ],
      coveringFields: ["name"],
    });
    const graph = defineGraph({
      id: "directed_index_keys_plan",
      nodes: { DirectedKeyPerson: { type: Person } },
      edges: {},
      indexes: [ordered],
    });
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.DirectedKeyPerson.bulkCreate(
      Array.from({ length: 1000 }, (_, index) => ({
        id: `person-${index.toString().padStart(4, "0")}`,
        props: {
          name: `Person ${index}`,
          ...(index % 10 === 0 ? {} : { age: index }),
        },
      })),
    );
    const indexDdl = generateIndexDDL(ordered, "postgres");
    expect(indexDdl).toMatch(
      /numeric\) DESC, "id" ASC, \("props" #>> ARRAY\['name'\]\)\)/,
    );
    await pool.query(indexDdl);
    await pool.query("ANALYZE typegraph_nodes");

    const query = store
      .query()
      .from("DirectedKeyPerson", "person")
      .select((fields) => ({
        name: fields.person.name,
        age: fields.person.age,
      }))
      .orderBy("person", "age", "desc")
      .orderBy("person", "id", "asc")
      .limit(20);
    const page = await store
      .query()
      .from("DirectedKeyPerson", "person")
      .select((fields) => ({ age: fields.person.age }))
      .orderBy("person", "age", "desc")
      .orderBy("person", "id", "asc")
      .paginate({ first: 20 });
    expect(page.data).toHaveLength(20);
    expect(page.nextCursor).toBeDefined();
    const compiled = requireDefined(backend.compileSql)(
      compileQuery(query.toAst(), graph.id, "postgres"),
    );
    const client = await pool.connect();
    let transactionStarted = false;
    let plan: string;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
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

    expect(plan).toContain("directed_key_age_id_idx");
    expect(plan).not.toContain("Sort Key:");
  });
});
