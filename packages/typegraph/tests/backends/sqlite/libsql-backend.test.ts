/**
 * libsql Backend Integration Tests
 *
 * Runs the shared adapter test suite against a libsql backend, plus
 * libsql-specific tests for lifecycle and known caveats. The shared
 * cross-backend integration suite runs from this lane's
 * `libsql-integration-slice-*.test.ts` files.
 */
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { wrapWithManagedClose } from "../../../src/backend/derive-backend";
import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import { requireDefined } from "../../../src/utils/presence";
import { createAdapterTestSuite } from "../adapter-test-suite";
import {
  cleanupTemporaryFiles,
  createTemporaryDbPath,
} from "./libsql-temporary-database";

const ConcurrencyPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const concurrencyGraph = defineGraph({
  id: "libsql_concurrency",
  nodes: { Person: { type: ConcurrencyPerson } },
  edges: {},
});

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
// libsql-Specific Tests
// ============================================================

describe("libsql Backend - Specific", () => {
  it("preserves committed data when a fixture file is closed and reopened", async () => {
    const dbPath = createTemporaryDbPath();
    const client = createClient({ url: `file:${dbPath}` });
    try {
      await client.execute("CREATE TABLE fixture_probe (value TEXT)");
      await client.execute("INSERT INTO fixture_probe VALUES ('committed')");
    } finally {
      client.close();
    }

    const reopened = createClient({ url: `file:${dbPath}` });
    try {
      expect(reopened.protocol).toBe("file");
      const persisted = await reopened.execute(
        "SELECT value FROM fixture_probe",
      );
      const synchronous = await reopened.execute("PRAGMA synchronous");
      const journalMode = await reopened.execute("PRAGMA journal_mode");
      expect(persisted.rows).toEqual([{ value: "committed" }]);
      expect(synchronous.rows).toEqual([{ synchronous: 2 }]);
      expect(journalMode.rows).toEqual([{ journal_mode: "delete" }]);
    } finally {
      reopened.close();
    }
  });

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
    expect(requireDefined(result.rows[0])["value"]).toBe(1);
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

  // Regression: before @libsql/client 0.18, client.transaction() permanently
  // hands a local client's connection to the transaction and lazily opens a
  // fresh — empty — database afterwards (tursodatabase/libsql-client-ts#229),
  // so those clients frame transactions as raw BEGIN/COMMIT. From 0.18 the
  // transaction's connection returns to the pool. Either way the documented
  // in-memory setup survives transactional writes.
  it("supports in-memory databases across transactional writes", async () => {
    const client = createClient({ url: "file::memory:" });
    const { backend } = await createLibsqlBackend(client);
    const [store] = await createStoreWithSchema(concurrencyGraph, backend);

    await store.nodes.Person.create({ name: "InMemory" });
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create({ name: "InTx" });
    });

    const people = await store.nodes.Person.find({ limit: 10 });
    expect(people.map((person) => person.name).toSorted()).toEqual([
      "InMemory",
      "InTx",
    ]);

    await backend.close();
    client.close();
  });

  // A root-store operation awaited inside a transaction callback can never
  // run — the transaction holds the backend's serialized execution slot for
  // its whole duration — so the queue rejects the submission with a typed
  // error instead of deadlocking.
  it("rejects root-store access inside a transaction callback", async () => {
    const client = createClient({ url: "file::memory:" });
    const { backend } = await createLibsqlBackend(client);
    const [store] = await createStoreWithSchema(concurrencyGraph, backend);

    await expect(
      store.transaction(async () => {
        await store.nodes.Person.find({ limit: 1 });
      }),
    ).rejects.toThrow(ConfigurationError);

    // The failed transaction rolled back cleanly; the store remains usable.
    await store.nodes.Person.create({ name: "AfterRollback" });
    const people = await store.nodes.Person.find({ limit: 10 });
    expect(people).toHaveLength(1);

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
