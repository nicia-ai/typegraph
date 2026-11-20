/**
 * Transaction framing across `@libsql/client` versions.
 *
 * Before 0.18 a local client keeps one stable connection, so transactions are
 * framed as raw BEGIN/COMMIT on it (`client.transaction()` would abandon that
 * connection, and with it an in-memory database). From 0.18 a local client
 * pools its connections and rolls back any transaction a raw `execute()`
 * leaves open, so transactions must go through `client.transaction()`. The
 * backend probes which behavior a client has. Both versions run here so
 * neither framing path goes untested while the rest of the suite tracks the
 * newest client.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient as createPooledClient } from "@libsql/client";
import { createClient as createSingleConnectionClient } from "libsql-client-017";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { detectLibsqlTransactionMode } from "../../../src/backend/drizzle/libsql-client";
import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "libsql_client_versions",
  nodes: { Person: { type: Person } },
  edges: {},
});

const CLIENT_VERSIONS = [
  {
    version: "0.17",
    createClient: createSingleConnectionClient,
    expectedTransactionMode: "sql",
  },
  {
    version: "0.18",
    createClient: createPooledClient,
    expectedTransactionMode: "drizzle",
  },
] as const;

const IN_MEMORY_URL = "file::memory:";

const temporaryDirectories: string[] = [];

function createTemporaryFileUrl(): string {
  const directory = mkdtempSync(
    path.join(
      process.env["TYPEGRAPH_LIBSQL_TMPDIR"] ?? tmpdir(),
      "typegraph-libsql-versions-",
    ),
  );
  temporaryDirectories.push(directory);
  return `file:${path.join(directory, "graph.db")}`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(CLIENT_VERSIONS)(
  "@libsql/client $version",
  ({ createClient, expectedTransactionMode }) => {
    it.each([
      { database: "in-memory", url: () => IN_MEMORY_URL },
      { database: "file", url: createTemporaryFileUrl },
    ])(
      `frames $database transactions with "${expectedTransactionMode}"`,
      async ({ url }) => {
        const client = createClient({ url: url() });
        try {
          expect(await detectLibsqlTransactionMode(client)).toBe(
            expectedTransactionMode,
          );
        } finally {
          client.close();
        }
      },
    );

    it("keeps an in-memory database across committed transactions", async () => {
      const client = createClient({ url: IN_MEMORY_URL });
      const { backend } = await createLibsqlBackend(client);
      const [store] = await createStoreWithSchema(graph, backend);

      await store.nodes.Person.create({ name: "BeforeTransaction" });
      await store.transaction(async (tx) => {
        await tx.nodes.Person.create({ name: "InTransaction" });
      });
      await store.nodes.Person.create({ name: "AfterTransaction" });

      const people = await store.nodes.Person.find({ limit: 10 });
      expect(people.map((person) => person.name).toSorted()).toEqual([
        "AfterTransaction",
        "BeforeTransaction",
        "InTransaction",
      ]);

      await backend.close();
      client.close();
    });

    it("discards a failed transaction's writes", async () => {
      const client = createClient({ url: createTemporaryFileUrl() });
      const { backend } = await createLibsqlBackend(client);
      const [store] = await createStoreWithSchema(graph, backend);
      const failure = new Error("abort the transaction");

      await expect(
        store.transaction(async (tx) => {
          await tx.nodes.Person.create({ name: "RolledBack" });
          throw failure;
        }),
      ).rejects.toBe(failure);
      await store.nodes.Person.create({ name: "Committed" });

      const people = await store.nodes.Person.find({ limit: 10 });
      expect(people.map((person) => person.name)).toEqual(["Committed"]);

      await backend.close();
      client.close();
    });
  },
);
