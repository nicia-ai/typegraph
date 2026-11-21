/**
 * `updateWhere()` against stale planner statistics on PGlite. The cases live
 * in `set-update-stale-statistics-plan.ts`; a server PostgreSQL runs the same
 * cases in `set-update-stale-statistics-plan.test.ts`.
 */
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe } from "vitest";

import { createPostgresBackend } from "../../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { requireDefined } from "../../../src/utils/presence";
import {
  InterceptedStatementError,
  isNodesUpdate,
  type PlanNode,
  prepareStaleNodesTable,
  type RecordedStatement,
  registerStaleStatisticsPlanCases,
  type StaleStatisticsHarness,
} from "./set-update-stale-statistics-plan";

type Query = PGlite["query"];

let client: PGlite | undefined;
let harness: StaleStatisticsHarness | undefined;

beforeAll(async () => {
  const local = await createLocalPgliteBackend({ vector: false });
  const engine = local.client;
  client = engine;
  const recorded: RecordedStatement[] = [];
  let pendingIntercept: ((statement: RecordedStatement) => void) | undefined;
  const run = engine.query.bind(engine);
  // Drizzle sends a statement through the engine itself, or through the
  // transaction object `transaction()` hands its callback: record (and, once
  // armed, refuse) on both.
  function intercepting(query: Query): Query {
    return ((text: string, values?: unknown[], options?: unknown) => {
      recorded.push({ text, values: [...(values ?? [])] });
      const resolve = pendingIntercept;
      if (resolve !== undefined && isNodesUpdate(text)) {
        pendingIntercept = undefined;
        resolve({ text, values: [...(values ?? [])] });
        return Promise.reject(new InterceptedStatementError());
      }
      return query(text, values, options as Parameters<Query>[2]);
    }) as Query;
  }
  engine.query = intercepting(run);
  const transaction = engine.transaction.bind(engine);
  engine.transaction = <T>(callback: (tx: Transaction) => Promise<T>) =>
    transaction((tx) =>
      callback(
        new Proxy(tx, {
          get(target, property) {
            if (property === "query") {
              return intercepting(target.query.bind(target) as Query);
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ?
                (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          },
        }),
      ),
    );
  await prepareStaleNodesTable((text) => run(text));
  harness = {
    createBackend: (capabilities) =>
      createPostgresBackend(drizzle(engine), {
        vector: false,
        ...(capabilities === undefined ? {} : { capabilities }),
      }),
    recorded,
    interceptNextNodesUpdate: () =>
      new Promise((resolve) => {
        pendingIntercept = resolve;
      }),
    explainAnalyze: async (statement) => {
      await run("BEGIN");
      try {
        const result = await run<{
          "QUERY PLAN": readonly Readonly<{ Plan: PlanNode }>[];
        }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`, [
          ...statement.values,
        ]);
        return requireDefined(requireDefined(result.rows[0])["QUERY PLAN"][0])
          .Plan;
      } finally {
        await run("ROLLBACK");
      }
    },
    queryNumber: async (text) => {
      const result = await run<object>(text);
      return Number(Object.values(requireDefined(result.rows[0]))[0]);
    },
  };
});

afterAll(async () => {
  await client?.close();
});

describe("updateWhere() against stale PGlite planner statistics", () => {
  registerStaleStatisticsPlanCases(() => harness);
});
