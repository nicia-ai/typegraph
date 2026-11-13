/**
 * `withEvolvedTransaction()` checks the base-schema marker on the caller's
 * own transaction. With a one-connection pool the caller's transaction holds
 * the only connection, so a check through the root backend would wait for
 * it until the pool's connection timeout, before the callback ran. The
 * adoption reads the marker on the adopted session instead: a current
 * database commits, and one stamped with an earlier release's version
 * refuses with `BaseSchemaMigrationError` before the callback.
 *
 * Load-bearing: restoring a root `assertBaseSchemaCurrent()` call in
 * `#applyEvolvedTransaction` (`store.ts`) makes the first case time out, and
 * dropping the adoption's own marker check makes the second case commit.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BaseSchemaMigrationError,
  createAdapterStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
const POOL_CONNECTION_TIMEOUT_MS = 1000;
const EARLIER_BASE_SCHEMA_VERSION = 8;

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

function graphNamed(id: string) {
  return defineGraph({ id, nodes: { Person: { type: Person } }, edges: {} });
}

const petExtension = defineGraphExtension({
  nodes: { Pet: { properties: { name: { type: "string" } } } },
});

let pool: Pool | undefined;

function requirePool(): Pool {
  if (pool === undefined)
    throw new Error("PostgreSQL pool was not initialized");
  return pool;
}

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
  });
  await pool.query(generatePostgresMigrationSQL());
});

afterAll(async () => {
  await pool?.end();
});

describe.runIf(process.env["POSTGRES_URL"] !== undefined)(
  "withEvolvedTransaction() on a one-connection pool",
  () => {
    it("commits on a current database without a second connection", async () => {
      const backend = createPostgresBackend(drizzle(requirePool()));
      const graph = graphNamed("evolved_base_schema_current");
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(petExtension);
      expect(plan.status).toBe("change");

      let callbackRan = false;
      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            callbackRan = true;
            await tx.nodes.Person.create({ name: "adopted" });
          }),
      );
      console.info("current base-schema evolved receipt", outcome.receipt);
      expect(callbackRan).toBe(true);
      expect(outcome.receipt.schema).toEqual(plan.result);
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(plan.result.version);
    });

    it("refuses a database stamped with an earlier base schema before the callback", async () => {
      const backend = createPostgresBackend(drizzle(requirePool()));
      const graph = graphNamed("evolved_base_schema_stale");
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(petExtension);
      const before = await backend.getActiveSchema(graph.id);
      await requirePool().query(
        "UPDATE typegraph_base_schema_versions SET version = $1",
        [EARLIER_BASE_SCHEMA_VERSION],
      );
      try {
        let callbackRan = false;
        const refusal = await backend
          .transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              callbackRan = true;
              await Promise.resolve();
            }),
          )
          .catch((error: unknown) => error);
        console.info("stale base-schema evolved refusal", refusal);
        expect(refusal).toBeInstanceOf(BaseSchemaMigrationError);
        expect((refusal as BaseSchemaMigrationError).details).toMatchObject({
          installedVersion: EARLIER_BASE_SCHEMA_VERSION,
          reason: "stale",
        });
        expect(callbackRan).toBe(false);
        const after = await backend.getActiveSchema(graph.id);
        expect(after?.version).toBe(before?.version);
      } finally {
        await backend.adoptBaseSchema?.();
      }
    });
  },
);
