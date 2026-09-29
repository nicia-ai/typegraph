/**
 * `listGraphIds` walks graph ids by index seek instead of reading every row of
 * the anchor relations. PostgreSQL orders ordinary text indexes by the database
 * collation, not by the byte order a page is defined in, so the walk seeks the
 * byte-ordered (`COLLATE "C"`) `graph_id` index the base schema adds to each
 * anchor relation. This holds that every anchor relation is stepped by
 * `graph_id > previous` through that index (with sequential scans disabled, the
 * planner can only plan the walk if the index is eligible), that a page then
 * visits only the graph ids it needs wherever it sits, and that a database
 * without the index still lists the same ids, by a scan, rather than by a walk
 * whose every step would scan a table. The planner may still prefer a
 * sequential scan of a tiny table; this proves the index is eligible, not that
 * it is chosen for every data distribution.
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
import { graphIdOrderIndexName } from "../../../src/indexes/system";
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

async function createNotes(
  raw: GraphBackend,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    const store = createStore(
      defineGraph({ id, nodes: { Note: { type: Note } }, edges: {} }),
      raw,
    );
    await store.nodes.Note.create({ body: id });
  }
}

function walkStatement(
  captured: readonly CapturedStatement[],
): CapturedStatement {
  return requireDefined(
    captured.find((candidate) => candidate.sql.includes("RECURSIVE")),
  );
}

describe("listGraphIds PostgreSQL query plan", () => {
  it("steps every anchor relation by graph_id > previous through its byte-ordered index", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const raw = createPostgresBackend(drizzle(pool));
    const captured: CapturedStatement[] = [];
    const backend = capturingBackend(raw, captured);
    await createNotes(raw, ["plan_a", "plan_b", "plan_c"]);

    expect(await listGraphIds(backend, { after: "plan_a", limit: 1 })).toEqual([
      "plan_b",
    ]);
    const statement = walkStatement(captured);
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
      // The byte-ordered index specifically: a walk through the collated
      // primary key would be an index scan too, and would visit every graph.
      expect(plan, `relation ${key}`).toMatch(
        new RegExp(
          String.raw`Index (Only )?Scan using ${graphIdOrderIndexName(table)} on ${table}\b`,
        ),
      );
    }
    // Plain EXPLAIN leaves the correlated step out; ANALYZE shows it.
    expect(
      plan.match(/Index Cond: .*\(graph_id > graph_ids_1\.graph_id\)/g) ?? [],
    ).toHaveLength(GRAPH_PRESENCE_ANCHOR_KEYS.length);
  });

  it("visits only the graph ids a page needs, wherever the page sits", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const raw = createPostgresBackend(drizzle(pool));
    const captured: CapturedStatement[] = [];
    const backend = capturingBackend(raw, captured);
    const TOTAL_GRAPHS = 40;
    await createNotes(
      raw,
      Array.from(
        { length: TOTAL_GRAPHS },
        (_, index) => `walk_${String(index).padStart(2, "0")}`,
      ),
    );

    async function visited(
      options: Parameters<typeof listGraphIds>[1],
    ): Promise<number> {
      captured.length = 0;
      await listGraphIds(backend, options);
      const counted = graphIdWalkVisitCount(walkStatement(captured));
      const rows = await requireDefined(pool).query<{ visited: string }>(
        counted.sql,
        [...counted.params],
      );
      return Number(rows.rows[0]?.visited);
    }

    // The first page, a page in the middle, and a page past a prefix's start.
    expect(await visited({ limit: 3 })).toBeLessThanOrEqual(3);
    // One extra visit is the cursor itself, which the page then drops.
    expect(await visited({ after: "walk_20", limit: 3 })).toBeLessThanOrEqual(
      4,
    );
    expect(
      await visited({ prefix: "walk_3", after: "walk_35", limit: 2 }),
    ).toBeLessThanOrEqual(3);
    // A prefix ends the walk one id past its last match.
    expect(await visited({ prefix: "walk_1", limit: 100 })).toBeLessThanOrEqual(
      11,
    );
    expect(await visited({ prefix: "absent", limit: 100 })).toBeLessThanOrEqual(
      1,
    );
    // Unbounded, the same walk covers every graph; that is what the bounds save.
    const everyGraph = await listGraphIds(backend, { limit: 1000 });
    expect(everyGraph.length).toBeGreaterThanOrEqual(TOTAL_GRAPHS);
    expect(await visited({ limit: 1000 })).toBe(everyGraph.length);
  });

  it("lists the same ids by a scan while a byte-ordered index is absent", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const raw = createPostgresBackend(drizzle(pool));
    const captured: CapturedStatement[] = [];
    const backend = capturingBackend(raw, captured);
    await createNotes(raw, ["scan_b", "Scan_a", "scan_c"]);
    const page = { prefix: "", limit: 1000 } as const;
    const indexed = await listGraphIds(backend, page);
    expect(walkStatement(captured).sql).toContain("RECURSIVE");

    const names = resolveGraphRelationNames(raw.tableNames);
    const indexName = graphIdOrderIndexName(names.nodes);
    await pool.query(`DROP INDEX "${indexName}"`);
    try {
      captured.length = 0;
      expect(await listGraphIds(backend, page)).toEqual(indexed);
      expect(
        captured.some((candidate) => candidate.sql.includes("RECURSIVE")),
      ).toBe(false);
      expect(indexed.indexOf("Scan_a")).toBeLessThan(indexed.indexOf("scan_b"));
    } finally {
      await pool.query(
        `CREATE INDEX "${indexName}" ON "${names.nodes}" ("graph_id" COLLATE "C")`,
      );
    }
  });
  it("treats an invalid byte-ordered index as absent", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const raw = createPostgresBackend(drizzle(pool));
    const captured: CapturedStatement[] = [];
    const backend = capturingBackend(raw, captured);
    await createNotes(raw, ["invalid_a", "invalid_b"]);
    const names = resolveGraphRelationNames(raw.tableNames);
    const indexName = graphIdOrderIndexName(names.edges);
    // What an interrupted CREATE INDEX CONCURRENTLY leaves behind.
    await pool.query(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"${indexName}"'::regclass`,
    );
    try {
      captured.length = 0;
      expect(await listGraphIds(backend, { prefix: "invalid_" })).toEqual([
        "invalid_a",
        "invalid_b",
      ]);
      expect(
        captured.some((candidate) => candidate.sql.includes("RECURSIVE")),
      ).toBe(false);
    } finally {
      await pool.query(
        `UPDATE pg_index SET indisvalid = true WHERE indexrelid = '"${indexName}"'::regclass`,
      );
    }
  });
});
