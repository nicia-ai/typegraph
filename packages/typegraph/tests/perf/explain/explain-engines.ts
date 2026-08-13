/**
 * The both-engines seam for plan-shape suites: {@link forEachExplainEngine}
 * defines a case once and runs it against both dialects, so a divergence
 * cannot be certified by a per-dialect test (AGENTS.md "Backend parity").
 *
 * ## Statement capture, and why this file owns its own
 *
 * `tests/test-utils.ts`'s `createPlanCaptureBackend()` and this package's
 * `createRecordedPglite()` both capture statements at the level the QUERY
 * DSL executes them (`GraphBackend.execute` / `executeRaw`, and drizzle's
 * `logger`, respectively). Verified in this tree: neither captures a
 * statement issued by a CRUD backend method (`getNode`, `insertNode`,
 * `updateNode`, the claim builders, …) — both dialects route those through a
 * "fast path" that talks to the raw driver client directly (cached prepared
 * statements on SQLite; `client.query()` on Postgres), bypassing the
 * QUERY-DSL-level seam entirely. On Postgres the fast path is ALSO taken
 * inside a `backend.transaction(...)` callback by a driver object distinct
 * from the root client (PGlite's own `.transaction()` hands the callback a
 * separate transaction handle with its own `.query()`), so even statements
 * that reach the fast path outside a transaction can vanish once one opens.
 *
 * `coalesce-probe.test.ts` and `claim-upsert.test.ts` measure exactly these
 * CRUD paths (`upsertById`, `bulkUpsertById`, constrained `create`,
 * `bulkCreate`), so this file wraps the raw driver client directly —
 * `client.prepare` on SQLite, `client.query` (recursively, through
 * `.transaction()`) on Postgres — the same "wrap the client" idiom
 * `explainQueryPlan` already uses, just extended from compiling a statement
 * to observing every execution of one. `createPlanCaptureBackend()` and
 * `createRecordedPglite()` are still the sole backend/client FACTORIES this
 * file uses (auto-close, DDL, `deriveBackend` seam); only the capture array
 * fed to `ExplainSubject.captured` is this file's own.
 */
import type { PGlite } from "@electric-sql/pglite";
import type Database from "better-sqlite3";
import { describe } from "vitest";

import {
  type BaseStoreOptions,
  createStoreWithSchema,
  type GraphDef,
  type Store,
} from "../../../src";
import { createRecordedPglite } from "../../statement-recorder";
import {
  type CapturedStatement,
  createPlanCaptureBackend,
  explainQueryPlan,
} from "../../test-utils";
import {
  type ExplainedPlan,
  renderPostgresPlan,
  totalActualRows,
} from "./explain-harness";

type ExplainEngine = "sqlite" | "postgres";

type ExplainSubject<TGraph extends GraphDef> = Readonly<{
  engine: ExplainEngine;
  store: Store<TGraph>;
  captured: readonly CapturedStatement[];
  reset: () => void;
  /** EXPLAIN of a READ statement. Postgres: ANALYZE + FORMAT JSON (fills `visitedRows`). SQLite: EXPLAIN QUERY PLAN. */
  explainRead: (
    label: string,
    statement: CapturedStatement,
  ) => Promise<ExplainedPlan>;
  /** EXPLAIN of a WRITE statement. NEVER executes it: `EXPLAIN (COSTS OFF)` on Postgres, EQP on SQLite; `visitedRows` is undefined. */
  explainWrite: (
    label: string,
    statement: CapturedStatement,
  ) => Promise<ExplainedPlan>;
}>;

export type ExplainHarness = Readonly<{
  engine: ExplainEngine;
  provision: <TGraph extends GraphDef>(
    graph: TGraph,
    seed: (store: Store<TGraph>) => Promise<void>,
    options?: Readonly<{ storeOptions?: BaseStoreOptions }>,
  ) => Promise<ExplainSubject<TGraph>>;
}>;

/**
 * Wraps a better-sqlite3 client's `prepare` so every statement it ever
 * prepares logs on EXECUTION (`.all()` / `.run()`), not on compilation.
 *
 * Installed before any statement is issued, this is a strict superset of
 * `createPlanCaptureBackend()`'s own `captured` array (verified: it also sees
 * query-DSL executions, which run through the same cached-prepared-statement
 * fast path) — and unlike that array, it also sees a REPEATED execution of a
 * SQL text the LRU statement cache already prepared once, which a
 * `client.prepare` call-count hook would miss on every cache hit.
 */
function wrapSqliteClientCapture(
  client: Database.Database,
): Readonly<{ captured: CapturedStatement[]; reset: () => void }> {
  const captured: CapturedStatement[] = [];
  const originalPrepare = client.prepare.bind(client);
  client.prepare = ((sqlText: string) => {
    const statement = originalPrepare(sqlText);
    const originalAll = statement.all.bind(statement);
    const originalRun = statement.run.bind(statement);
    statement.all = (...params: unknown[]) => {
      captured.push({ sql: sqlText, params });
      return originalAll(...params);
    };
    statement.run = (...params: unknown[]) => {
      captured.push({ sql: sqlText, params });
      return originalRun(...params);
    };
    return statement;
  }) as Database.Database["prepare"];
  return {
    captured,
    reset: () => {
      captured.length = 0;
    },
  };
}

/**
 * The minimal PGlite / PGlite-transaction shape this file instruments. A
 * mutable interface (not `Readonly`) on purpose: {@link wrapPgliteClientCapture}
 * reassigns `query` and `transaction` on the real client/transaction object it
 * is handed, and a mutable member is what lets it do so without an `any` cast.
 */
interface PgliteQueryable {
  query: (
    sqlText: string,
    params?: readonly unknown[],
    ...rest: readonly unknown[]
  ) => unknown;
  transaction?: (fn: (tx: PgliteQueryable) => unknown) => unknown;
}

/**
 * Wraps a PGlite client's `query`, recursively re-wrapping the transaction
 * handle PGlite's own `.transaction()` hands to its callback — a DIFFERENT
 * object from the outer client, with its own `.query()`, that drizzle's
 * Postgres backend calls into for every statement issued inside
 * `backend.transaction(...)`. Verified in this tree: wrapping only the outer
 * client's `.query()` misses every statement a coalescing upsert's
 * in-transaction confirm read issues, on both a resurrection-prone bulk path
 * and the single-row path — the recursive re-wrap is what makes those visible.
 */
function wrapPgliteClientCapture(
  client: PGlite,
): Readonly<{ captured: CapturedStatement[]; reset: () => void }> {
  const captured: CapturedStatement[] = [];
  function instrument(target: PgliteQueryable): void {
    const originalQuery = target.query.bind(target);
    target.query = (
      sqlText: string,
      params?: readonly unknown[],
      ...rest: readonly unknown[]
    ) => {
      captured.push({ sql: sqlText, params: params ?? [] });
      return originalQuery(sqlText, params, ...rest);
    };
    if (target.transaction !== undefined) {
      const originalTransaction = target.transaction.bind(target);
      target.transaction = (fn: (tx: PgliteQueryable) => unknown) =>
        originalTransaction((tx: PgliteQueryable) => {
          instrument(tx);
          return fn(tx);
        });
    }
  }
  instrument(client as unknown as PgliteQueryable);
  return {
    captured,
    reset: () => {
      captured.length = 0;
    },
  };
}

/** Shape of the row `client.query("EXPLAIN (COSTS OFF) ...")` returns on Postgres. */
type PostgresTextExplainRow = Readonly<{ "QUERY PLAN": string }>;

/** Shape of the row `client.query("EXPLAIN (... FORMAT JSON) ...")` returns on Postgres. */
type PostgresJsonExplainRow = Readonly<{
  "QUERY PLAN": readonly Readonly<{
    Plan: Parameters<typeof totalActualRows>[0];
  }>[];
}>;

async function explainPostgresRead(
  client: PGlite,
  label: string,
  statement: CapturedStatement,
): Promise<ExplainedPlan> {
  const result = await client.query<PostgresJsonExplainRow>(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, FORMAT JSON) ${statement.sql}`,
    [...statement.params],
  );
  const document = result.rows[0]?.["QUERY PLAN"][0];
  if (document === undefined) {
    throw new Error(`postgres EXPLAIN produced no plan for "${label}"`);
  }
  return {
    engine: "postgres",
    label,
    text: renderPostgresPlan(document.Plan),
    visitedRows: totalActualRows(document.Plan),
  };
}

async function explainPostgresWrite(
  client: PGlite,
  label: string,
  statement: CapturedStatement,
): Promise<ExplainedPlan> {
  const result = await client.query<PostgresTextExplainRow>(
    `EXPLAIN (COSTS OFF) ${statement.sql}`,
    [...statement.params],
  );
  return {
    engine: "postgres",
    label,
    text: result.rows.map((row) => row["QUERY PLAN"]).join("\n"),
    visitedRows: undefined,
  };
}

function explainSqlite(
  client: Database.Database,
  label: string,
  statement: CapturedStatement,
): ExplainedPlan {
  return {
    engine: "sqlite",
    label,
    text: explainQueryPlan(client, statement),
    visitedRows: undefined,
  };
}

/**
 * Runs `seed`, refreshes planner statistics (both planners plan from
 * statistics; measuring before they exist would measure planner defaults —
 * the same rationale `tests/identity-frontier-bounded.test.ts` documents),
 * then resets capture so the first statement the caller sees belongs to the
 * measured operation.
 */
async function provisionSqlite<TGraph extends GraphDef>(
  graph: TGraph,
  seed: (store: Store<TGraph>) => Promise<void>,
  options?: Readonly<{ storeOptions?: BaseStoreOptions }>,
): Promise<ExplainSubject<TGraph>> {
  const { backend, client } = createPlanCaptureBackend();
  const { captured, reset } = wrapSqliteClientCapture(client);
  const [store] = await createStoreWithSchema<TGraph>(
    graph,
    backend,
    options?.storeOptions,
  );
  await seed(store);
  await store.refreshStatistics();
  reset();
  return {
    engine: "sqlite",
    store,
    captured,
    reset,
    explainRead: (label, statement) =>
      Promise.resolve(explainSqlite(client, label, statement)),
    explainWrite: (label, statement) =>
      Promise.resolve(explainSqlite(client, label, statement)),
  };
}

async function provisionPostgres<TGraph extends GraphDef>(
  graph: TGraph,
  seed: (store: Store<TGraph>) => Promise<void>,
  options?: Readonly<{ storeOptions?: BaseStoreOptions }>,
): Promise<ExplainSubject<TGraph>> {
  const { client, backend } = await createRecordedPglite();
  const { captured, reset } = wrapPgliteClientCapture(client);
  const [store] = await createStoreWithSchema<TGraph>(
    graph,
    backend,
    options?.storeOptions,
  );
  await seed(store);
  await store.refreshStatistics();
  reset();
  return {
    engine: "postgres",
    store,
    captured,
    reset,
    explainRead: (label, statement) =>
      explainPostgresRead(client, label, statement),
    explainWrite: (label, statement) =>
      explainPostgresWrite(client, label, statement),
  };
}

const SQLITE_HARNESS: ExplainHarness = {
  engine: "sqlite",
  provision: provisionSqlite,
};

const POSTGRES_HARNESS: ExplainHarness = {
  engine: "postgres",
  provision: provisionPostgres,
};

/**
 * Defines the same cases on both engines inside `describe("sqlite" | "postgres")`.
 * THE parity seam (AGENTS.md "Backend parity"): a case written once here runs
 * against both dialects, so a per-dialect-only test cannot certify a
 * divergence.
 */
export function forEachExplainEngine(
  define: (harness: ExplainHarness) => void,
): void {
  describe("sqlite", () => {
    define(SQLITE_HARNESS);
  });
  describe("postgres", () => {
    define(POSTGRES_HARNESS);
  });
}
