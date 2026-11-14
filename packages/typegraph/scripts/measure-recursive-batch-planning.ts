/**
 * PostgreSQL 18 measurement, deliberately composing compiler output outside
 * batchOnce's admission guard to measure oversized statements safely in isolation.
 * Run against the bundled Docker server:
 * POSTGRES_URL=postgresql://typegraph:typegraph@localhost:5432/typegraph_test \
 * node --import tsx packages/typegraph/scripts/measure-recursive-batch-planning.ts
 * Set POSTGRES_CONTAINER if its name differs; output includes full EXPLAIN JSON.
 */
import { execFileSync } from "node:child_process";

import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import type { EmbeddableOneStatementRead } from "../src/query/builder/types";
import { getDialect } from "../src/query/dialect";
import { sql, type SqlFragment } from "../src/query/sql-fragment";
import type { CompiledRowsSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";

const connectionString = requireDefined(process.env["POSTGRES_URL"]);
const container = process.env["POSTGRES_CONTAINER"] ?? "typegraph-postgres";
const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", { schema: z.object({}) });
const graph = defineGraph({
  id: "recursive_batch_measurement",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});
const pool = new Pool({ connectionString });
const schema = `recursive_batch_measurement_${process.pid}`;
await pool.query(`CREATE SCHEMA "${schema}"`);
const client = await pool.connect();
try {
  // All fixture tables live in a throwaway schema, never in the caller's graph.
  await client.query(`SET search_path TO "${schema}", public`);
  await client.query(generatePostgresMigrationSQL());
  const backend = createPostgresBackend(drizzle(client));
  const store = createStore(graph, backend);
  const nodes = await store.nodes.Person.bulkCreate(
    Array.from({ length: 8 }, (_, index) => ({
      id: `person-${index}`,
      props: { name: `Person ${index}` },
    })),
  );
  for (const [index, node] of nodes.entries()) {
    const next = nodes[index + 1];
    if (next !== undefined) await store.edges.knows.create(node, next, {});
  }
  await client.query("ANALYZE");
  const version = await client.query<{ version: string }>(
    "SELECT version() AS version",
  );
  console.log(JSON.stringify({ server: version.rows }));

  for (const size of [25, 100, 500]) {
    const reads: EmbeddableOneStatementRead<unknown>[] = [];
    const ctes: SqlFragment[] = [];
    const branches: SqlFragment[] = [];
    for (const index of Array.from({ length: size }, (_, offset) => offset)) {
      const query = store
        .query()
        .from("Person", "person")
        .whereNode("person", (person) => person.id.eq(`person-${index % 8}`))
        .traverse("knows", "edge")
        .recursive({ maxHops: 2 })
        .to("Person", "friend")
        .select((fields) => fields.friend.name);
      reads.push(query);
      const item = requireDefined(query.compileOneStatementBatchItem?.());
      const source = `typegraph_batch_source_${index}`;
      const rows = `typegraph_batch_rows_${index}`;
      ctes.push(
        sql`${sql.identifier(source)} AS (${item.query})`,
        sql`${sql.identifier(rows)} AS (SELECT ${sql.identifier(source)}.*, ROW_NUMBER() OVER () AS ${sql.identifier("typegraphbatchordinal")} FROM ${sql.identifier(source)})`,
      );
      const payload = getDialect("postgres").orderedRowsJsonArray(
        rows,
        item.outputNames,
        "typegraphbatchordinal",
      );
      branches.push(sql`SELECT ${index} AS batch_index, ${payload} AS payload`);
    }
    const statement = requireDefined(backend.compileSql)(
      sql`WITH ${sql.join(ctes, sql`, `)} SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) AS typegraph_batch_envelope ORDER BY batch_index`,
    );
    if (size === 25) {
      const capturedStore = createStore(
        graph,
        deriveBackend(backend, {
          execute<Row>(query: CompiledRowsSql): Promise<readonly Row[]> {
            const actual = requireDefined(backend.compileSql)(query);
            if (actual.sql !== statement.sql)
              throw new Error(
                "Measurement SQL differs from batchOnce compilation",
              );
            return Promise.resolve([]);
          },
        }),
      );
      await capturedStore.batchOnce(() => reads);
    }
    for (const mode of ["unnamed", "named"] as const) {
      const session = new Client({ connectionString });
      await session.connect();
      try {
        await session.query(`SET search_path TO "${schema}", public`);
        const processId = await session.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = requireDefined(processId.rows[0]).pid;
        const samples = [];
        for (const iteration of [1, 2, 3, 4, 5, 6]) {
          // A named EXPLAIN would cache EXPLAIN, not the measured SELECT. Run
          // the SELECT under its actual driver name, then EXPLAIN EXECUTE it.
          if (mode === "named")
            await session.query({
              name: "recursive_batch",
              text: statement.sql,
              values: [...statement.params],
            });
          const explain =
            mode === "named" ?
              await session.query<{ "QUERY PLAN": unknown }>(
                `EXPLAIN (ANALYZE, BUFFERS, MEMORY, FORMAT JSON) EXECUTE recursive_batch(${statement.params.map((value) => session.escapeLiteral(String(value))).join(", ")})`,
              )
            : await session.query<{ "QUERY PLAN": unknown }>(
                `EXPLAIN (ANALYZE, BUFFERS, MEMORY, FORMAT JSON) ${statement.sql}`,
                [...statement.params],
              );
          const status = execFileSync(
            "docker",
            ["exec", container, "cat", `/proc/${pid}/status`],
            { encoding: "utf8" },
          );
          const rss = Object.fromEntries(
            status
              .split("\n")
              .filter((line) => /^Vm(RSS|HWM):/.test(line))
              .map((line) => {
                const [key, value] = line.trim().split(/:\s*/);
                return [requireDefined(key), requireDefined(value)] as const;
              }),
          );
          samples.push({
            iteration,
            rss,
            explain: requireDefined(explain.rows[0])["QUERY PLAN"],
          });
        }
        const prepared = await session.query<{
          name: string;
          generic_plans: string;
          custom_plans: string;
        }>(
          "SELECT name, generic_plans, custom_plans FROM pg_prepared_statements",
        );
        console.log(
          JSON.stringify({
            size,
            mode,
            sqlBytes: Buffer.byteLength(statement.sql),
            binds: statement.params.length,
            prepared: prepared.rows,
            samples,
          }),
        );
      } finally {
        await session.end();
      }
    }
  }
} finally {
  client.release();
  await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}
