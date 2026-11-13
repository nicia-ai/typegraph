/**
 * The node-postgres lane of the shared integration suite.
 *
 * Shared by this lane's `postgres-integration-slice-*.test.ts` files. Each
 * slice file provisions its OWN database and passes its URL in — the database
 * is named after the calling test file, so the URL cannot be resolved here —
 * and then owns that database's schema and per-test reset for its part of the
 * suite.
 *
 * Registered only when `POSTGRES_URL` is set (`scripts/test-postgres.sh`).
 * Without the gate, a developer with a stray Docker Postgres container running
 * would trigger the DROP+CREATE schema setup during `pnpm test:unit`.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";

import { createPostgresBackend } from "../../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationSuiteSlice } from "../integration-registrations";
import { createIntegrationTestSuite } from "../integration-test-suite";
import {
  clearPostgresLaneData,
  connectPostgresLanePool,
  recreatePostgresLaneTables,
} from "./postgres-lane-database";

export function registerPostgresIntegrationLane(
  params: Readonly<{ databaseUrl: string; slice: IntegrationSuiteSlice }>,
): void {
  const { databaseUrl, slice } = params;

  describe.runIf(process.env["POSTGRES_URL"])(
    "PostgreSQL Integration Test Suite",
    () => {
      let sharedPool: Pool | undefined;

      beforeAll(async () => {
        sharedPool = requireDefined(
          await connectPostgresLanePool(databaseUrl),
          "POSTGRES_URL is set but the PostgreSQL integration lane could not connect.",
        );
        await recreatePostgresLaneTables(sharedPool);
      });

      afterAll(async () => {
        await sharedPool?.end();
      });

      beforeEach(async () => {
        await clearPostgresLaneData(requireDefined(sharedPool));
      });

      createIntegrationTestSuite(
        "PostgreSQL",
        () => {
          // Create a fresh connection for each backend instance
          const pool = new Pool({ connectionString: databaseUrl });
          return {
            backend: createPostgresBackend(drizzle(pool)),
            cleanup: async () => {
              await pool.end();
            },
            // The suite's own pool is default-sized and therefore audited
            // `independent`. A `max: 1` pool against the same provisioned
            // database is the serialized shape. `overrides.capabilities` is
            // forwarded into `createPostgresBackend` itself — applied at
            // construction, before this connection's write-fence target and
            // derived `unitOfWork` are resolved — for a test that needs a
            // real second connection declaring a non-default write fence.
            createSerializedBackend: (overrides) => {
              const serializedPool = new Pool({
                connectionString: databaseUrl,
                max: 1,
              });
              return Promise.resolve({
                backend: createPostgresBackend(drizzle(serializedPool), {
                  ...(overrides?.capabilities === undefined ?
                    {}
                  : { capabilities: overrides.capabilities }),
                  schemaProvisioning:
                    overrides?.schemaProvisioning ?? "dml-only",
                }),
                close: () => serializedPool.end(),
              });
            },
          };
        },
        {
          slice,
          createIsolatedBackend: async () => {
            const { backend } = await createLocalPgliteBackend();
            return { backend, cleanup: () => backend.close() };
          },
          // A default-sized pool against a real, provisioned PostgreSQL
          // server: two `createSerializedBackend()` handles are genuinely
          // independent physical connections.
          serverLaneConcurrency: true,
        },
      );
    },
  );
}
