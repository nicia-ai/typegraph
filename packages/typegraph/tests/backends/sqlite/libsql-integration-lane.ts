/**
 * The libSQL lane of the shared integration suite.
 *
 * Shared by this lane's `libsql-integration-slice-*.test.ts` files so every
 * slice builds its backends and removes its temporary database files the same
 * way; each slice file states only which part of the suite it runs.
 */
import { createClient } from "@libsql/client";
import { afterEach } from "vitest";

import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import { refuseUnsupportedSerializedBackendCapabilities } from "../integration/test-context";
import type { IntegrationSuiteSlice } from "../integration-registrations";
import { createIntegrationTestSuite } from "../integration-test-suite";
import {
  cleanupTemporaryFiles,
  createTemporaryDbPath,
} from "./libsql-temporary-database";

const LANE_NAME = "libsql";

export function registerLibsqlIntegrationLane(
  params: Readonly<{ slice: IntegrationSuiteSlice }>,
): void {
  afterEach(cleanupTemporaryFiles);

  createIntegrationTestSuite(
    LANE_NAME,
    async () => {
      const dbPath = createTemporaryDbPath();
      const client = createClient({ url: `file:${dbPath}` });
      const { backend } = await createLibsqlBackend(client);
      return {
        backend,
        cleanup: async () => {
          await backend.close();
          client.close();
        },
        // A local-FILE client is the serialized libsql shape
        // (`protocol: "file"`), opened on its own temp file so nothing a
        // provenance test does reaches the suite's own fixture.
        createSerializedBackend: async (overrides) => {
          refuseUnsupportedSerializedBackendCapabilities(LANE_NAME, overrides);
          const serializedPath = createTemporaryDbPath();
          const serializedClient = createClient({
            url: `file:${serializedPath}`,
          });
          const { backend: serializedBackend } = await createLibsqlBackend(
            serializedClient,
            {
              schemaProvisioning: overrides?.schemaProvisioning ?? "dml-only",
            },
          );
          return {
            backend: serializedBackend,
            close: async () => {
              await serializedBackend.close();
              serializedClient.close();
            },
          };
        },
      };
    },
    { slice: params.slice },
  );
}
