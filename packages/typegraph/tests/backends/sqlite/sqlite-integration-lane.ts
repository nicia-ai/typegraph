/**
 * The better-sqlite3 lane of the shared integration suite.
 *
 * Shared by this lane's `sqlite-integration-slice-*.test.ts` files so every
 * slice builds its backends the same way; each slice file states only which
 * part of the suite it runs.
 */
import { createSqliteBackend } from "../../../src/backend/sqlite";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
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
          const { backend } = createLocalSqliteBackend({
            schemaProvisioning: overrides?.schemaProvisioning ?? "dml-only",
          });
          return Promise.resolve({ backend, close: () => backend.close() });
        },
      };
    },
    { slice: params.slice },
  );
}
