/**
 * `listGraphIds` walks graph ids by index seek instead of reading every row of
 * the anchor relations. With sequential scans disabled, PostgreSQL can only
 * plan the walk if an index leads with `graph_id`, so this holds that every
 * anchor relation is stepped by `graph_id > previous` through an index. The
 * planner may still prefer a sequential scan of a tiny table; this proves the
 * index is eligible, not that it is chosen for every data distribution.
 *
 * PostgreSQL orders those indexes by the database collation, not by the byte
 * order a page is defined in, so a page's cursor and limit cannot narrow the
 * walk the way they do on SQLite. This also pins that cost: a page visits every
 * graph id, and the test is the place to change when an index in byte order
 * makes that untrue.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  listGraphIds,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import {
  GRAPH_PRESENCE_ANCHOR_KEYS,
  resolveGraphRelationNames,
} from "../../../src/backend/graph-relations";
import { createPostgresBackend } from "../../../src/backend/postgres";
import type { GraphBackend } from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import {
  type CapturedStatement,
  graphIdWalkVisitCount,
} from "../../test-utils";

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

const Note = defineNode("Note", { schema: z.object({ body: z.string() }) });

function capturingBackend(
  raw: GraphBackend,
  captured: CapturedStatement[],
): GraphBackend {
  return deriveBackend(raw, {
    transaction: (run, options) =>
      raw.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              async execute<T>(
                query: Parameters<typeof target.execute>[0],
              ): Promise<readonly T[]> {
                const compiled = target.compileSql?.(query);
                if (compiled) {
                  captured.push({
                    sql: compiled.sql,
                    params: compiled.params,
                  });
                }
                return target.execute<T>(query);
              },
            }),
          ),
        options,
      ),
  });
}

describe("listGraphIds PostgreSQL query plan", () => {
  it("steps every anchor relation by graph_id > previous through an index", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const raw = createPostgresBackend(drizzle(pool));
    const captured: CapturedStatement[] = [];
    const backend = capturingBackend(raw, captured);
    for (const id of ["plan_a", "plan_b", "plan_c"]) {
      const store = createStore(
        defineGraph({ id, nodes: { Note: { type: Note } }, edges: {} }),
        raw,
      );
      await store.nodes.Note.create({ body: id });
    }

    expect(await listGraphIds(backend, { after: "plan_a", limit: 1 })).toEqual([
      "plan_b",
    ]);
    const statement = requireDefined(
      captured.find((candidate) => candidate.sql.includes("RECURSIVE")),
    );
    const client = await pool.connect();
    let plan: string;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const explained = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${statement.sql}`,
        [...statement.params],
      );
      plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    const names = resolveGraphRelationNames(raw.tableNames);
    for (const key of GRAPH_PRESENCE_ANCHOR_KEYS) {
      const table = names[key];
      expect(plan, `relation ${key}`).not.toMatch(
        new RegExp(String.raw`Seq Scan on ${table}\b`),
      );
      expect(plan, `relation ${key}`).toMatch(
        new RegExp(String.raw`Index (Only )?Scan using \S+ on ${table}\b`),
      );
    }
    const counted = graphIdWalkVisitCount(statement);
    const visited = await pool.query<{ visited: string }>(counted.sql, [
      ...counted.params,
    ]);
    // Three graphs; a page of one after the first would visit two if the walk
    // could be bounded by them.
    expect(Number(visited.rows[0]?.visited)).toBe(3);
    // Plain EXPLAIN leaves the correlated step out; ANALYZE shows it.
    expect(
      plan.match(/Index Cond: \(graph_id > graph_ids_1\.graph_id\)/g) ?? [],
    ).toHaveLength(GRAPH_PRESENCE_ANCHOR_KEYS.length);
  });
});
