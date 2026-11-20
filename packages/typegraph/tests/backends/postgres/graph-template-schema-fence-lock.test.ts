/**
 * Graph-template instantiation and the PostgreSQL schema-commit fence take
 * the identical ONE-ARGUMENT advisory lock on `hashtext(graphId)`
 * (`advisoryLockSingleExpression`, `postgres-fence-sql.ts`) — never the
 * namespaced two-argument form every other TypeGraph lock uses. PostgreSQL
 * keys the two forms with different `locktag` field4 values, so only a
 * shared one-argument spelling makes the two operations mutually exclude on
 * the same graph id; a template statement that took the two-argument form
 * instead would let a concurrent schema commit and template instantiation
 * both succeed against the same target graph.
 *
 * This suite holds that exact lock open on one connection — the same
 * statement text `acquireSchemaWriteFence` issues while a schema commit is
 * in flight — and proves a template instantiation targeting the same graph
 * id blocks on a second connection until the first commits.
 *
 * Server Postgres only: the anomaly needs a second connection holding an
 * uncommitted lock, which the single-connection PGlite lane cannot provide.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { advisoryLockSingleExpression } from "../../../src/backend/drizzle/postgres-fence-sql";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { renderPostgres, sql } from "../../../src/query/sql-fragment";
import {
  instantiateGraphTemplate,
  registerGraphTemplate,
} from "../../../src/schema/graph-templates";
import { requireDefined } from "../../../src/utils/presence";
import { raceTimeout, TIMEOUT_SENTINEL } from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const TEMPLATE_SOURCE_GRAPH_ID = "graph_template_fence_lock_source";
const TEMPLATE_TARGET_GRAPH_ID = "graph_template_fence_lock_target";
const TEMPLATE_ID = "graph-template-fence-lock-template";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const templateSourceGraph = defineGraph({
  id: TEMPLATE_SOURCE_GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: {},
});

let pool: Pool | undefined;

function requirePool(): Pool {
  return requireDefined(pool, "PostgreSQL pool was not initialized");
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await candidate.query("SELECT 1");
  await candidate.query(generatePostgresMigrationSQL());
  pool = candidate;
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

/**
 * Opens a transaction on its own connection and takes literally the
 * statement `acquireSchemaWriteFence` issues for the "lock" plan arm —
 * `SELECT pg_advisory_xact_lock(hashtext($graphId))`, rendered through the
 * same {@link advisoryLockSingleExpression} the fence and the graph-template
 * statement both call back into. Held open (never committed by this
 * function) so the caller can assert a concurrent instantiation blocks on
 * it, then release with `COMMIT`.
 */
async function holdSchemaCommitFence(
  targetPool: Pool,
  graphId: string,
): Promise<PoolClient> {
  const client = await targetPool.connect();
  await client.query("BEGIN");
  const compiled = renderPostgres(
    sql`SELECT ${advisoryLockSingleExpression(graphId)}`,
  );
  await client.query(compiled.sql, [...compiled.params]);
  return client;
}

describe.runIf(process.env["POSTGRES_URL"])(
  "graph-template instantiation vs. the PostgreSQL schema-commit fence",
  () => {
    let flipHolder: PoolClient | undefined;

    afterEach(async () => {
      if (flipHolder === undefined) return;
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await flipHolder.query("ROLLBACK").catch(() => {});
      flipHolder.release();
      flipHolder = undefined;
    });

    it("blocks a concurrent template instantiation on the same graph id until the fence commits", async () => {
      const targetPool = requirePool();

      const sourceBackend = createPostgresBackend(drizzle(targetPool));
      const [source] = await createAdapterStoreWithSchema(
        templateSourceGraph,
        sourceBackend,
      );
      const template = await registerGraphTemplate(sourceBackend, {
        templateId: TEMPLATE_ID,
        reconciled: source.reconciledSchema,
      });

      flipHolder = await holdSchemaCommitFence(
        targetPool,
        TEMPLATE_TARGET_GRAPH_ID,
      );

      const instantiationBackend = createPostgresBackend(drizzle(targetPool));
      const pendingInstantiation = instantiateGraphTemplate(
        instantiationBackend,
        { template, graphId: TEMPLATE_TARGET_GRAPH_ID },
      );
      const raced = await raceTimeout(pendingInstantiation, 500);
      expect(raced).toBe(TIMEOUT_SENTINEL);

      await requireDefined(flipHolder).query("COMMIT");
      requireDefined(flipHolder).release();
      flipHolder = undefined;

      await expect(pendingInstantiation).resolves.toMatchObject({
        status: "ready",
      });
    });
  },
);
