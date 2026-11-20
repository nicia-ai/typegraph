/**
 * Server PostgreSQL leg of the missing transition-log relations check
 * (`tests/identity-transition-relations-missing.ts`): the `pg` driver's own
 * error shape for an undefined relation (SQLSTATE 42P01) must reach the same
 * typed refusal SQLite's message and PGlite's error reach.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";
import {
  expectTransitionLogRefusesMissingRelations,
  TRANSITION_LOG_RELATIONS,
} from "../../identity-transition-relations-missing";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

let pool: Pool | undefined;

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await candidate.query(generatePostgresMigrationSQL());
  pool = candidate;
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

describe.skipIf(!process.env["POSTGRES_URL"])(
  "missing transition-log relations on PostgreSQL",
  () => {
    it("refuses transition-log reads, prune and writes with the typed missing-relations error", async () => {
      const activePool = requireDefined(pool, "PostgreSQL pool");
      const backend = createPostgresBackend(drizzle(activePool));
      await expectTransitionLogRefusesMissingRelations(backend, async () => {
        for (const relation of TRANSITION_LOG_RELATIONS) {
          await activePool.query(`DROP TABLE IF EXISTS "${relation}"`);
        }
      });
    });
  },
);
