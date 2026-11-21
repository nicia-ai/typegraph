/**
 * `updateWhere()` against stale planner statistics on a server PostgreSQL,
 * through node-postgres. The cases live in
 * `set-update-stale-statistics-plan.ts`; PGlite runs the same cases in
 * `pglite-set-update-stale-statistics-plan.test.ts`.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe } from "vitest";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import {
  InterceptedStatementError,
  isNodesUpdate,
  NODES_TABLE,
  type PlanNode,
  prepareStaleNodesTable,
  type RecordedStatement,
  registerStaleStatisticsPlanCases,
  type StaleStatisticsHarness,
} from "./set-update-stale-statistics-plan";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

let pool: Pool | undefined;
let harness: StaleStatisticsHarness | undefined;

/** The `(text, values)` of a node-postgres `query(...)` call, if it has text. */
function statementOf(args: readonly unknown[]): RecordedStatement | undefined {
  const [first, second] = args;
  const text =
    typeof first === "string" ? first
    : typeof first === "object" && first !== null && "text" in first ?
      first.text
    : undefined;
  if (typeof text !== "string") return undefined;
  // Drizzle passes `(config, values)`; other callers may put the values on
  // the config object instead.
  const values: unknown =
    Array.isArray(second) ? second
    : typeof first === "object" && first !== null && "values" in first ?
      first.values
    : undefined;
  return { text, values: isUnknownArray(values) ? [...values] : [] };
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  pool = candidate;
  const recorded: RecordedStatement[] = [];
  let pendingIntercept: ((statement: RecordedStatement) => void) | undefined;
  // The set update's statements are internal to the backend, so they never
  // pass through a backend-level `execute` a wrapper could observe: record
  // (and, once armed, refuse) them on every pooled client instead.
  candidate.on("connect", (client: PoolClient) => {
    const original = client.query.bind(client) as (
      ...args: unknown[]
    ) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (
      ...args: unknown[]
    ) => {
      const statement = statementOf(args);
      if (statement !== undefined) {
        recorded.push(statement);
        const resolve = pendingIntercept;
        if (resolve !== undefined && isNodesUpdate(statement.text)) {
          pendingIntercept = undefined;
          resolve(statement);
          return Promise.reject(new InterceptedStatementError());
        }
      }
      return original(...args);
    };
  });
  await candidate.query(generatePostgresMigrationSQL());
  await candidate.query(
    `ALTER TABLE ${NODES_TABLE} SET (autovacuum_enabled = false)`,
  );
  await prepareStaleNodesTable((text) => candidate.query(text));
  harness = {
    createBackend: (capabilities) =>
      createPostgresBackend(
        drizzle(candidate),
        capabilities === undefined ? {} : { capabilities },
      ),
    recorded,
    interceptNextNodesUpdate: () =>
      new Promise((resolve) => {
        pendingIntercept = resolve;
      }),
    explainAnalyze: async (statement) => {
      const client = await candidate.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<{
          "QUERY PLAN": readonly Readonly<{ Plan: PlanNode }>[];
        }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, [
          ...statement.values,
        ]);
        return requireDefined(requireDefined(result.rows[0])["QUERY PLAN"][0])
          .Plan;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
    queryNumber: async (text) => {
      const result = await candidate.query<object>(text);
      return Number(Object.values(requireDefined(result.rows[0]))[0]);
    },
  };
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

describe("updateWhere() against stale PostgreSQL planner statistics", () => {
  registerStaleStatisticsPlanCases(() => harness);
});
