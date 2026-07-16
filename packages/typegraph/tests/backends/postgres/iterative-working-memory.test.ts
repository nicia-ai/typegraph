/**
 * Iterative-algorithm working-memory wiring on Postgres.
 *
 * Pinned here:
 * 1. Opt-in only — an algorithm call WITHOUT `workingMemory` emits no
 *    `set_config` statement, inheriting the server's configured `work_mem`
 *    (a DBA's deliberately conservative setting must not be silently
 *    overridden; `work_mem` is a per-sort/hash-operator threshold, so a
 *    blanket default would multiply under concurrency).
 * 2. When `workingMemory` IS passed, exactly one transaction-scoped
 *    override runs — the parameterized `SET LOCAL` form,
 *    `SELECT set_config('work_mem', $1, true)` — with the value bound as a
 *    parameter, before the working table is created.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import type {
  AdoptedTransaction,
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../../../src/backend/types";
import type {
  CompiledRowsSql,
  CompiledTemporaryStatementSql,
} from "../../../src/query/sql-intent";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

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
const knows = defineEdge("knows", { schema: z.object({}) });

function buildGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: { Person: { type: Person } },
    edges: { knows: { type: knows, from: [Person], to: [Person] } },
  });
}

type CapturedStatement = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

/**
 * Wraps the transaction so every in-transaction statement — both
 * row-returning and temporary — is captured. The working-memory override
 * runs through `executeTemporaryStatement` inside the algorithm's own
 * transaction, which an outer `execute` wrapper never sees.
 */
function withTransactionCapture(backend: GraphBackend): {
  backend: GraphBackend;
  statements: CapturedStatement[];
} {
  const compileSql = backend.compileSql;
  if (compileSql === undefined) {
    throw new Error("Postgres backend must expose compileSql");
  }
  const statements: CapturedStatement[] = [];
  const captured: GraphBackend = {
    ...backend,
    transaction<T>(
      fn: (tx: TransactionBackend, sql: AdoptedTransaction) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      return backend.transaction(async (tx, adoptedTransaction) => {
        const observedTransaction: TransactionBackend = {
          ...tx,
          execute<Result>(query: CompiledRowsSql): Promise<readonly Result[]> {
            statements.push(compileSql(query));
            return tx.execute<Result>(query);
          },
          async executeTemporaryStatement(
            query: CompiledTemporaryStatementSql,
          ): Promise<void> {
            statements.push(compileSql(query));
            await tx.executeTemporaryStatement!(query);
          },
        };
        return fn(observedTransaction, adoptedTransaction);
      }, options);
    },
  };
  return { backend: captured, statements };
}

const WORK_MEM_OVERRIDE_SQL = "SELECT set_config('work_mem', $1, true)";

describe("iterative working-memory wiring (Postgres)", () => {
  it("emits no set_config when workingMemory is not passed", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const raw = createPostgresBackend(drizzle(activePool));
    const { backend, statements } = withTransactionCapture(raw);
    const [store] = await createStoreWithSchema(
      buildGraph(`workmem_inherit_${randomUUID().slice(0, 8)}`),
      backend,
    );

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.edges.knows.create(alice, bob, {});

    statements.length = 0;
    const reached = await store.algorithms.reachable(alice.id, {
      edges: ["knows"],
    });
    expect(reached.map((node) => node.id)).toContain(bob.id);

    const memberships = await store.algorithms.weaklyConnectedComponents({
      edges: ["knows"],
    });
    expect(memberships.length).toBeGreaterThan(0);

    expect(
      statements.filter((statement) => statement.sql.includes("set_config")),
    ).toEqual([]);
  });

  it("emits one parameterized transaction-local override when passed", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const raw = createPostgresBackend(drizzle(activePool));
    const { backend, statements } = withTransactionCapture(raw);
    const [store] = await createStoreWithSchema(
      buildGraph(`workmem_override_${randomUUID().slice(0, 8)}`),
      backend,
    );

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.edges.knows.create(alice, bob, {});

    statements.length = 0;
    const reached = await store.algorithms.reachable(alice.id, {
      edges: ["knows"],
      workingMemory: "32MB",
    });
    expect(reached.map((node) => node.id)).toContain(bob.id);

    const overrides = statements.filter((statement) =>
      statement.sql.includes("set_config"),
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.sql).toBe(WORK_MEM_OVERRIDE_SQL);
    expect(overrides[0]?.params).toEqual(["32MB"]);

    // The override precedes the working table so every round runs under it.
    const overrideIndex = statements.findIndex((statement) =>
      statement.sql.includes("set_config"),
    );
    const createIndex = statements.findIndex((statement) =>
      statement.sql.includes("CREATE TEMP TABLE"),
    );
    expect(overrideIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(overrideIndex);
  });
});
