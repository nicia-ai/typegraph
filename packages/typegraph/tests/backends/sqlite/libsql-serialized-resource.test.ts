/**
 * A LOCAL libsql client is one serialized connection.
 *
 * `createLibsqlBackend` already frames transactions as raw BEGIN/COMMIT for a
 * local client precisely because `client.transaction()` would permanently hand
 * that single connection away — so two backends over one local client cannot run
 * a snapshot export and a write concurrently, exactly like two backends over one
 * better-sqlite3 handle. Serialized-resource detection used to duck-type
 * better-sqlite3 only, which left a streaming export/import over one local
 * libsql client to reach BEGIN IMMEDIATE instead of being refused.
 *
 * Remote clients (`http` / `ws`) open an independent stream per transaction and
 * must stay unmarked: refusing there would refuse work that succeeds.
 */
import { type Client, createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import {
  createSqliteBackend,
  isLocalLibsqlClient,
} from "../../../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import {
  sharesSerializedTransactionResource,
  snapshotExportContention,
} from "../../../src/backend/transaction-resource";
import {
  exportGraphStream,
  importGraphStream,
  ImportOptionsSchema,
} from "../../../src/interchange";
import { raceTimeout, TIMEOUT_SENTINEL } from "../../concurrency-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const sourceGraph = defineGraph({
  id: "libsql_serialized_source",
  nodes: { Person: { type: Person } },
  edges: {},
});

const targetGraph = defineGraph({
  id: "libsql_serialized_target",
  nodes: { Person: { type: Person } },
  edges: {},
});

/**
 * Fails a guard test that regressed into a wedge instead of a refusal: an export
 * snapshot and an import on ONE local libsql connection wait on each other, so an
 * unbounded await would hang the suite rather than report the regression.
 */
const GUARD_TIMEOUT_MS = 10_000;

async function withGuardTimeout<T>(work: Promise<T>): Promise<T> {
  const settled = await raceTimeout(work, GUARD_TIMEOUT_MS);
  if (settled === TIMEOUT_SENTINEL) {
    throw new Error(
      `Serialized-connection guard did not settle within ${GUARD_TIMEOUT_MS}ms: the export and the import are waiting on one libsql connection.`,
    );
  }
  return settled;
}

describe("local libsql serialized-resource detection", () => {
  const openClients: Client[] = [];

  afterEach(() => {
    for (const client of openClients.splice(0)) client.close();
  });

  function openLocalClient(): Client {
    // `file::memory:` is the documented in-memory setup and the shape the
    // reviewer reproduced against: one connection, nothing on disk.
    const client = createClient({ url: "file::memory:" });
    openClients.push(client);
    return client;
  }

  it("recognizes two backends over one local libsql client", async () => {
    const client = openLocalClient();

    const { backend: first } = await createLibsqlBackend(client);
    const { backend: second } = await createLibsqlBackend(client);

    expect(first).not.toBe(second);
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);
  });

  it("reports snapshot-export contention between those backends", async () => {
    // The predicate the working-copy cloner consults before it decides to stream
    // an export into a fresh backend: unanswered here, the cloner streams into a
    // backend on the same connection.
    const client = openLocalClient();
    const { backend: source } = await createLibsqlBackend(client);
    const { backend: target } = await createLibsqlBackend(client);

    expect(snapshotExportContention(source, target)).toBe("shared-resource");
  });

  it("refuses a snapshot import across two backends over one local client", async () => {
    const client = openLocalClient();
    const { backend: sourceBackend } = await createLibsqlBackend(client);
    const { backend: targetBackend } = await createLibsqlBackend(client);
    const [source] = await createStoreWithSchema(sourceGraph, sourceBackend);
    const [target] = await createStoreWithSchema(targetGraph, targetBackend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "libsql-alice" });
    const beginExport = vi.spyOn(sourceBackend, "transaction");

    await expect(
      withGuardTimeout(
        importGraphStream(
          target,
          exportGraphStream(source),
          ImportOptionsSchema.parse({ onConflict: "error" }),
        ),
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT",
        graphId: targetGraph.id,
      },
    });
    // Refused before the export opened its snapshot, so nothing was read and
    // nothing was written.
    expect(beginExport).not.toHaveBeenCalled();
    expect(await target.nodes.Person.count()).toBe(0);
  });

  it("classifies local and remote clients", () => {
    const local = openLocalClient();
    const http = createClient({ url: "http://127.0.0.1:9" });
    const webSocket = createClient({ url: "ws://127.0.0.1:9" });

    try {
      expect(isLocalLibsqlClient(local)).toBe(true);
      expect(isLocalLibsqlClient(http)).toBe(false);
      expect(isLocalLibsqlClient(webSocket)).toBe(false);
      // An object carrying the protocol but none of the libsql surface proves
      // nothing and must not be adopted.
      expect(isLocalLibsqlClient({ protocol: "file" })).toBe(false);
      expect(isLocalLibsqlClient(undefined)).toBe(false);
    } finally {
      http.close();
      webSocket.close();
    }
  });

  it("leaves two backends over one remote libsql client unmarked", () => {
    // A remote client runs each transaction on its own stream, so an export
    // snapshot does not hold the connection a concurrent write needs. No server
    // is dialed here: only the marking decision is under test.
    const client = createClient({ url: "http://127.0.0.1:9" });

    try {
      const first = createSqliteBackend(drizzle(client), {
        executionProfile: { isSync: false, transactionMode: "drizzle" },
      });
      const second = createSqliteBackend(drizzle(client), {
        executionProfile: { isSync: false, transactionMode: "drizzle" },
      });

      expect(sharesSerializedTransactionResource(first, second)).toBe(false);
    } finally {
      client.close();
    }
  });
});
