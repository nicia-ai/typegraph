/**
 * Recorded-capture advisory-lock churn: `pg_advisory_xact_lock` is
 * reentrant and held to transaction end, so within one transaction the
 * graph-write lock must be acquired ONCE per graph — not once per captured
 * write. Previously a store.transaction with N writes paid N+1 lock round
 * trips (one from the write-transaction boundary, one per delegate write).
 *
 * Counted through the drizzle statement logger, filtered to the
 * graph-write namespace bind param so the late-flush recorded-clock lock
 * (a different namespace, deliberately separate — see clock.ts) is not
 * conflated. Also pinned: the lock is still acquired (exactly once) per
 * NEW transaction — the memo must not leak across transactions.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const GRAPH_WRITE_NAMESPACE = "typegraph:recorded-graph-write";

let pool: Pool | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): Pool {
  if (!isPostgresAvailable || pool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return pool;
}

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(`
      DROP TABLE IF EXISTS typegraph_recorded_clock CASCADE;
      DROP TABLE IF EXISTS typegraph_recorded_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_recorded_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
      DROP TABLE IF EXISTS typegraph_edges CASCADE;
      DROP TABLE IF EXISTS typegraph_nodes CASCADE;
      DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
    `);
    await candidate.query(generatePostgresMigrationSQL());
    pool = candidate;
    isPostgresAvailable = true;
  } catch {
    await candidate.end().catch(() => {
      // Unreachable Postgres degrades to "skip".
    });
  }
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

function buildGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: { Person: { type: Person } },
    edges: {},
  });
}

type LoggedStatement = Readonly<{ query: string; params: unknown[] }>;

function graphWriteLockCount(statements: readonly LoggedStatement[]): number {
  return statements.filter(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params[0] === GRAPH_WRITE_NAMESPACE,
  ).length;
}

describe("recorded graph-write advisory lock churn", () => {
  it("acquires the lock once per transaction, not once per write", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const statements: LoggedStatement[] = [];
    const backend = createPostgresBackend(
      drizzle(activePool, {
        logger: {
          logQuery(query: string, params: unknown[]) {
            statements.push({ query, params });
          },
        },
      }),
    );
    const [store] = await createStoreWithSchema(
      buildGraph("lock_churn_txn"),
      backend,
      { history: true },
    );

    // --- Multi-write transaction: exactly ONE graph-write acquisition. ---
    statements.length = 0;
    await store.transaction(async (tx) => {
      for (let index = 0; index < 10; index++) {
        await tx.nodes.Person.create(
          { name: `p${index}` },
          { id: `txn-${index}` },
        );
      }
    });
    expect(graphWriteLockCount(statements)).toBe(1);

    // --- Single autocommit write: also exactly one (was two — the
    //     write-transaction boundary plus the delegate's own write). ---
    statements.length = 0;
    await store.nodes.Person.create({ name: "solo" }, { id: "solo" });
    expect(graphWriteLockCount(statements)).toBe(1);

    // --- The memo must not leak across transactions: a second operation
    //     opens a new transaction and MUST re-acquire. ---
    statements.length = 0;
    await store.nodes.Person.create({ name: "solo-2" }, { id: "solo-2" });
    await store.nodes.Person.create({ name: "solo-3" }, { id: "solo-3" });
    expect(graphWriteLockCount(statements)).toBe(2);
  });

  it("still serializes: the lock statement is present before row writes", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const statements: LoggedStatement[] = [];
    const backend = createPostgresBackend(
      drizzle(activePool, {
        logger: {
          logQuery(query: string, params: unknown[]) {
            statements.push({ query, params });
          },
        },
      }),
    );
    const [store] = await createStoreWithSchema(
      buildGraph("lock_churn_order"),
      backend,
      { history: true },
    );

    statements.length = 0;
    await store.nodes.Person.create({ name: "ordered" }, { id: "ordered" });

    const lockIndex = statements.findIndex(
      (statement) =>
        statement.query.includes("pg_advisory_xact_lock") &&
        statement.params[0] === GRAPH_WRITE_NAMESPACE,
    );
    const insertIndex = statements.findIndex((statement) =>
      statement.query.includes("typegraph_nodes"),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(lockIndex);
  });
});
