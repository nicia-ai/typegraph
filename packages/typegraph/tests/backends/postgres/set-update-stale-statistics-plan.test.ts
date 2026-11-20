/**
 * `updateWhere()` stays linear in the candidate count when the nodes table's
 * planner statistics predate the candidates — the state a bulk load into a
 * large shared table leaves behind, because one import never reaches
 * autovacuum's analyze threshold.
 *
 * With those statistics PostgreSQL estimates the target kind at one row. A
 * candidate subquery semi-joined into the UPDATE then runs as a nested loop
 * driven from the nodes table that rescans the candidates once per row (and,
 * when the candidates are joined back onto the nodes table for their version,
 * once per row of that join too): quadratic or worse. The set update instead
 * reads the candidate keys in one statement and writes them with bound key
 * lists, so neither statement can join the candidates to anything. These
 * tests pin that shape on a deliberately stale table and pin that the write
 * spans several statements when the keys exceed one statement's bind budget.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/** Rows of other graphs the planner has statistics for. */
const PREFILL_ROWS = 50_000;
/** Fresh candidates inserted after the last ANALYZE. */
const FRESH_ROWS = 300;
const GRAPH_ID = "stale_statistics_plan";

const Item = defineNode("Item", {
  schema: z.object({ status: z.string() }),
});
const graph = defineGraph({
  id: GRAPH_ID,
  nodes: { Item: { type: Item } },
  edges: {},
});

type RecordedStatement = Readonly<{ text: string; values: unknown[] }>;

let pool: Pool | undefined;
const recorded: RecordedStatement[] = [];

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Records every parameterized statement a pooled client runs: the set
 * update's statements are internal to the backend, so they never pass
 * through a backend-level `execute` a wrapper could observe.
 */
function recordStatements(target: Pool): void {
  target.on("connect", (client: PoolClient) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      const [first, second] = args;
      const text =
        typeof first === "string" ? first
        : typeof first === "object" && first !== null && "text" in first ?
          first.text
        : undefined;
      // Drizzle passes `(config, values)`; node-postgres callers may put the
      // values on the config object instead.
      const values: unknown =
        Array.isArray(second) ? second
        : typeof first === "object" && first !== null && "values" in first ?
          first.values
        : undefined;
      if (typeof text === "string") {
        recorded.push({
          text,
          values: isUnknownArray(values) ? [...values] : [],
        });
      }
      return original(...args);
    };
  });
}

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  pool = candidate;
  recordStatements(candidate);
  await candidate.query(generatePostgresMigrationSQL());
  await candidate.query(
    "ALTER TABLE typegraph_nodes SET (autovacuum_enabled = false)",
  );
  await candidate.query("TRUNCATE typegraph_nodes");
  await candidate.query(
    `INSERT INTO typegraph_nodes
       (graph_id, kind, id, props, version, created_at, updated_at)
     SELECT 'other_graph_' || (i % 7), 'Kind' || (i % 5), 'prefill-' || i,
            '{}'::jsonb, 1, now(), now()
     FROM generate_series(1, $1::int) AS i`,
    [PREFILL_ROWS],
  );
  await candidate.query("ANALYZE typegraph_nodes");
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

type PlanNode = Readonly<{
  "Node Type": string;
  "Relation Name"?: string;
  "Plan Rows": number;
  "Parent Relationship"?: string;
  Plans?: readonly PlanNode[];
}>;

function planNodes(node: PlanNode): readonly PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap((child) => planNodes(child))];
}

/** The plan nodes that read the nodes table (`ModifyTable` only writes it). */
function nodeTableScans(plan: PlanNode): readonly PlanNode[] {
  return planNodes(plan).filter(
    (node) =>
      node["Relation Name"] === "typegraph_nodes" &&
      node["Node Type"] !== "ModifyTable",
  );
}

async function explain(statement: RecordedStatement): Promise<PlanNode> {
  const client = await requireDefined(pool).connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      "QUERY PLAN": readonly Readonly<{ Plan: PlanNode }>[];
    }>(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values);
    return requireDefined(requireDefined(result.rows[0])["QUERY PLAN"][0]).Plan;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

const JOIN_NODE_TYPES = new Set(["Nested Loop", "Hash Join", "Merge Join"]);

function statementsTouchingCandidates(): readonly RecordedStatement[] {
  return recorded.filter(
    (statement) =>
      /\bUPDATE "typegraph_nodes"/.test(statement.text) ||
      statement.text.includes("tg_set_candidate"),
  );
}

async function insertFreshItems(
  store: Awaited<ReturnType<typeof createStoreWithSchema<typeof graph>>>[0],
  prefix: string,
  count: number,
): Promise<readonly string[]> {
  const ids = Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  await store.nodes.Item.bulkInsert(
    ids.map((id) => ({ id, props: { status: "pending" } })),
  );
  return ids;
}

describe("updateWhere() against stale PostgreSQL planner statistics", () => {
  it("joins the candidates to nothing, so no plan can rescan them", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const backend = createPostgresBackend(drizzle(pool));
    const [store] = await createStoreWithSchema(graph, backend, {
      autoRefreshStatistics: false,
    });
    const ids = await insertFreshItems(store, "plan", FRESH_ROWS);

    recorded.length = 0;
    const { affectedCount } = await store.nodes.Item.updateWhere({
      where: (item) => item.id.in([...ids]),
      patch: { status: "promoted" },
    });
    const statements = statementsTouchingCandidates();
    const plans = await Promise.all(
      statements.map((statement) => explain(statement)),
    );
    const nodes = plans.flatMap((plan) => planNodes(plan));
    const nodeScans = plans.flatMap((plan) => nodeTableScans(plan));

    expect(affectedCount).toBe(FRESH_ROWS);
    // The statistics really are stale: every scan of the nodes table is
    // estimated far below the rows it will meet.
    expect(nodeScans.length).toBeGreaterThan(0);
    for (const scan of nodeScans) {
      expect(scan["Plan Rows"]).toBeLessThan(FRESH_ROWS / 10);
    }
    expect({
      joins: nodes
        .filter((node) => JOIN_NODE_TYPES.has(node["Node Type"]))
        .map((node) => node["Node Type"]),
      subplans: nodes
        .filter(
          (node) =>
            node["Parent Relationship"] === "SubPlan" ||
            node["Parent Relationship"] === "InitPlan",
        )
        .map((node) => node["Node Type"]),
      nodeScansPerStatement: plans.map((plan) => nodeTableScans(plan).length),
    }).toEqual({
      joins: [],
      subplans: [],
      nodeScansPerStatement: [1, 1],
    });
  });

  it("writes every candidate across several statements when the keys exceed the bind budget", async (ctx) => {
    if (pool === undefined) {
      ctx.skip();
      return;
    }
    const bindBudget = 64;
    const backend = createPostgresBackend(drizzle(pool), {
      capabilities: { maxBindParameters: bindBudget },
    });
    const [store] = await createStoreWithSchema(graph, backend, {
      autoRefreshStatistics: false,
    });
    const ids = await insertFreshItems(store, "chunked", 100);

    recorded.length = 0;
    const { affectedCount } = await store.nodes.Item.updateWhere({
      where: (item) => item.status.eq("pending"),
      patch: { status: "chunked" },
    });
    const updates = recorded.filter((statement) =>
      /\bUPDATE "typegraph_nodes"/.test(statement.text),
    );
    const stored = await requireDefined(pool).query<{ count: string }>(
      `SELECT count(*) AS count FROM typegraph_nodes
       WHERE graph_id = $1 AND id LIKE 'chunked-%'
         AND props->>'status' = 'chunked' AND version = 2`,
      [GRAPH_ID],
    );

    expect(affectedCount).toBe(ids.length);
    expect(updates.length).toBeGreaterThan(2);
    for (const update of updates) {
      expect(update.values.length).toBeLessThanOrEqual(bindBudget);
    }
    expect(Number(requireDefined(stored.rows[0]).count)).toBe(ids.length);
  });
});
