/**
 * The better-sqlite3 lane of the shared integration suite.
 *
 * Shared by this lane's `sqlite-integration-slice-*.test.ts` files so every
 * slice builds its backends the same way; each slice file states only which
 * part of the suite it runs.
 */
import { createSqliteTables } from "../../../src/backend/drizzle/schema/sqlite";
import { createSqliteBackend } from "../../../src/backend/sqlite";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { openReopenableSqliteStorage } from "../../helpers/reopenable-storage";
import { openTracedSqliteConnection } from "../../helpers/traced-connection";
import { createTestDatabase } from "../../test-utils";
import { refuseUnsupportedSerializedBackendCapabilities } from "../integration/test-context";
import type { IntegrationSuiteSlice } from "../integration-registrations";
import { createIntegrationTestSuite } from "../integration-test-suite";

const LANE_NAME = "SQLite";

export function registerSqliteIntegrationLane(
  params: Readonly<{ slice: IntegrationSuiteSlice }>,
): void {
  createIntegrationTestSuite(
    LANE_NAME,
    () => {
      const db = createTestDatabase();
      // SQLite uses in-memory databases, no cleanup needed
      return {
        backend: createSqliteBackend(db),
        // better-sqlite3 is one synchronous handle, so the batteries-included
        // factory already yields a serialized backend. It gets its own database
        // so nothing a provenance test does reaches the suite's own fixture.
        createSerializedBackend: (overrides) => {
          refuseUnsupportedSerializedBackendCapabilities(LANE_NAME, overrides);
          const serializedOptions = {
            schemaProvisioning: overrides?.schemaProvisioning ?? "dml-only",
            ...(overrides?.tableNames === undefined ?
              {}
            : { tables: createSqliteTables(overrides.tableNames) }),
          } as const;
          const { backend, db: serializedDb } =
            createLocalSqliteBackend(serializedOptions);
          return Promise.resolve({
            backend,
            // The batteries-included factory over the same better-sqlite3
            // handle: a second wrapper, not a derivation of `backend`.
            createWrapper: () =>
              Promise.resolve(
                createSqliteBackend(serializedDb, {
                  ...serializedOptions,
                  executionProfile: { isSync: true },
                }),
              ),
            close: () => backend.close(),
          });
        },
      };
    },
    {
      slice: params.slice,
      driver: "better-sqlite3",
      openTracedConnection: openTracedSqliteConnection,
      openReopenableStorage: openReopenableSqliteStorage,
    },
  );
}
