/**
 * libsql Backend Integration Tests
 *
 * Runs the shared adapter and integration test suites against a libsql
 * backend, plus libsql-specific tests for lifecycle and known caveats.
 */
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";

import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import { wrapWithManagedClose } from "../../../src/backend/types";
import { createAdapterTestSuite } from "../adapter-test-suite";
import { createIntegrationTestSuite } from "../integration-test-suite";

// ============================================================
// Temp File Helpers
// ============================================================

// libsql transactions open a separate connection, which destroys
// in-memory databases (tursodatabase/libsql-client-ts#229).
// Use temp files so the shared suites' transaction tests work.

const temporaryFiles: string[] = [];

function createTemporaryDbPath(): string {
  const dbPath = path.join(
    tmpdir(),
    `typegraph-libsql-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  temporaryFiles.push(dbPath);
  return dbPath;
}

function cleanupTemporaryFiles(): void {
  for (const dbPath of temporaryFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = dbPath + suffix;
      if (existsSync(filePath)) unlinkSync(filePath);
    }
  }
}

afterEach(cleanupTemporaryFiles);

// ============================================================
// Shared Adapter Test Suite
// ============================================================

createAdapterTestSuite("libsql", async () => {
  const dbPath = createTemporaryDbPath();
  const client = createClient({ url: `file:${dbPath}` });
  const { backend } = await createLibsqlBackend(client);
  // Adapter suite calls backend.close() in afterEach; close client after.
  return wrapWithManagedClose(backend, () => {
    client.close();
  });
});

// ============================================================
// Shared Integration Test Suite
// ============================================================

createIntegrationTestSuite("libsql", async () => {
  const dbPath = createTemporaryDbPath();
  const client = createClient({ url: `file:${dbPath}` });
  const { backend } = await createLibsqlBackend(client);
  return {
    backend,
    cleanup: async () => {
      await backend.close();
      client.close();
    },
  };
});

// ============================================================
// libsql-Specific Tests
// ============================================================

describe("libsql Backend - Specific", () => {
  it("exposes the Drizzle database instance", async () => {
    const client = createClient({ url: "file::memory:" });
    const { backend, db } = await createLibsqlBackend(client);
    expect(db).toBeDefined();
    await backend.close();
    client.close();
  });

  it("caller retains client ownership", async () => {
    const client = createClient({ url: "file::memory:" });
    await createLibsqlBackend(client);
    // Client is still usable after backend creation — not closed by the factory
    const result = await client.execute("SELECT 1 AS value");
    expect(result.rows[0]!.value).toBe(1);
    client.close();
  });
});
