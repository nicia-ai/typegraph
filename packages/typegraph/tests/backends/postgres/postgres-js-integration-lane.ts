/**
 * The postgres-js lane of the shared integration suite.
 *
 * Mirrors `postgres-integration-lane.ts` but wires the backend through
 * `drizzle-orm/postgres-js` + the `postgres` driver, so the full integration
 * suite proves driver-agnostic behavior end-to-end.
 *
 * Shared by this lane's `postgres-js-integration-slice-*.test.ts` files. Each
 * slice file provisions its OWN database and passes its URL in — the database
 * is named after the calling test file, so the URL cannot be resolved here.
 * Registered only when `POSTGRES_URL` is set (`scripts/test-postgres.sh`).
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe } from "vitest";

import { createPostgresBackend } from "../../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationSuiteSlice } from "../integration-registrations";
import { createIntegrationTestSuite } from "../integration-test-suite";
import {
  clearPostgresJsLaneData,
  connectPostgresJsLaneClient,
  migratePostgresJsLaneTables,
  POSTGRES_JS_LANE_MAX_CONNECTIONS,
} from "./postgres-js-lane-database";

export function registerPostgresJsIntegrationLane(
  params: Readonly<{ databaseUrl: string; slice: IntegrationSuiteSlice }>,
): void {
  const { databaseUrl, slice } = params;

  describe.runIf(process.env["POSTGRES_URL"])(
    "PostgreSQL (postgres-js driver) Integration Test Suite",
    () => {
      let sharedSql: Sql | undefined;

      beforeAll(async () => {
        sharedSql = requireDefined(
          await connectPostgresJsLaneClient(databaseUrl),
          "POSTGRES_URL is set but the postgres-js integration lane could not connect.",
        );
        await migratePostgresJsLaneTables(sharedSql);
      });

      afterAll(async () => {
        await sharedSql?.end();
      });

      beforeEach(async () => {
        await clearPostgresJsLaneData(requireDefined(sharedSql));
      });

      createIntegrationTestSuite(
        "PostgreSQL (postgres-js)",
        () => {
          const sql = postgres(databaseUrl, {
            max: POSTGRES_JS_LANE_MAX_CONNECTIONS,
          });
          return {
            backend: createPostgresBackend(drizzle(sql)),
            cleanup: async () => {
              await sql.end();
            },
            // The suite's own client runs at `max: 4` and is audited
            // `independent`; `{ max: 1 }` is its serialized shape.
            // `overrides.capabilities` is forwarded into
            // `createPostgresBackend` itself — applied at construction, before
            // this connection's write-fence target and derived `unitOfWork`
            // are resolved — for a test that needs a real second connection
            // declaring a non-default write fence.
            createSerializedBackend: (overrides) => {
              const serializedSql = postgres(databaseUrl, { max: 1 });
              return Promise.resolve({
                backend: createPostgresBackend(drizzle(serializedSql), {
                  ...(overrides?.capabilities === undefined ?
                    {}
                  : { capabilities: overrides.capabilities }),
                  schemaProvisioning:
                    overrides?.schemaProvisioning ?? "dml-only",
                }),
                close: () => serializedSql.end(),
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
          // A real `postgres-js` client against a real, provisioned
          // PostgreSQL server: two `createSerializedBackend()` handles are
          // genuinely independent physical connections.
          serverLaneConcurrency: true,
        },
      );
    },
  );
}
