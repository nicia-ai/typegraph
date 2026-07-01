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
import { z } from "zod";

import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import { wrapWithManagedClose } from "../../../src/backend/types";
import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { createAdapterTestSuite } from "../adapter-test-suite";
import { createIntegrationTestSuite } from "../integration-test-suite";

const ConcurrencyPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const concurrencyGraph = defineGraph({
  id: "libsql_concurrency",
  nodes: { Person: { type: ConcurrencyPerson } },
  edges: {},
});

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

  // Regression: concurrent write transactions on one async libsql connection
  // used to open overlapping BEGINs and fail with SQLITE_BUSY. The per-backend
  // serialized queue must order them (temp file — libsql transactions open a
  // separate connection, which destroys an in-memory database).
  it("serializes concurrent write transactions without SQLITE_BUSY", async () => {
    const dbPath = createTemporaryDbPath();
    const client = createClient({ url: `file:${dbPath}` });
    const { backend } = await createLibsqlBackend(client);
    const [store] = await createStoreWithSchema(concurrencyGraph, backend);

    const count = 24;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.transaction(async (tx) => {
          await tx.nodes.Person.create({ name: `P${index}` });
        }),
      ),
    );

    const people = await store.nodes.Person.find({ limit: count + 10 });
    expect(people).toHaveLength(count);

    await backend.close();
    client.close();
  });

  // Regression: with the mutation cascade wrapped in a transaction on every
  // store (not only history stores), concurrent plain creates each open a
  // transaction. They must serialize rather than collide with SQLITE_BUSY.
  it("runs concurrent non-history creates without SQLITE_BUSY", async () => {
    const dbPath = createTemporaryDbPath();
    const client = createClient({ url: `file:${dbPath}` });
    const { backend } = await createLibsqlBackend(client);
    const [store] = await createStoreWithSchema(concurrencyGraph, backend);

    const count = 24;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        store.nodes.Person.create({ name: `N${index}` }),
      ),
    );

    const people = await store.nodes.Person.find({ limit: count + 10 });
    expect(people).toHaveLength(count);

    await backend.close();
    client.close();
  });
});
