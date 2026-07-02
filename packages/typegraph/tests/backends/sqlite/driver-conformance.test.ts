/**
 * SQLite driver-conformance suite — the executable version of the driver
 * contracts documented in `limitations.md` and the backend module docs. One
 * shared set of behavioral contracts, run against every locally runnable
 * SQLite flavor, so a driver quirk (like libsql's transaction connection
 * hand-off) surfaces as a red test here instead of as a caveat nobody
 * re-verifies:
 *
 * - transactional writes commit and stay visible to root reads afterwards
 *   (in-memory databases included);
 * - a failed transaction callback rolls everything back;
 * - concurrent plain creates and concurrent transactions serialize without
 *   SQLITE_BUSY;
 * - a root-store operation awaited inside a transaction callback rejects
 *   with a typed ConfigurationError instead of deadlocking.
 *
 * Remote Turso (`libsql://`) needs a network endpoint and is exercised by
 * the shared integration suites when configured; Durable Objects run in the
 * workerd-only `test:do` lane.
 */
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import type { GraphBackend } from "../../../src/backend/types";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "driver_conformance",
  nodes: { Person: { type: Person } },
  edges: {},
});

type Flavor = Readonly<{
  name: string;
  create: () => Promise<
    Readonly<{ backend: GraphBackend; cleanup: () => Promise<void> }>
  >;
}>;

const temporaryFiles: string[] = [];

function temporaryDbPath(): string {
  const dbPath = path.join(
    tmpdir(),
    `typegraph-conformance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  temporaryFiles.push(dbPath);
  return dbPath;
}

afterEach(() => {
  for (const dbPath of temporaryFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = dbPath + suffix;
      if (existsSync(filePath)) unlinkSync(filePath);
    }
  }
});

const flavors: readonly Flavor[] = [
  {
    name: "better-sqlite3 (in-memory)",
    create: () => {
      const { backend } = createLocalSqliteBackend();
      return Promise.resolve({
        backend,
        cleanup: async () => {
          await backend.close();
        },
      });
    },
  },
  {
    name: "libsql (local file)",
    create: async () => {
      const client = createClient({ url: `file:${temporaryDbPath()}` });
      const { backend } = await createLibsqlBackend(client);
      return {
        backend,
        cleanup: async () => {
          await backend.close();
          client.close();
        },
      };
    },
  },
  {
    name: "libsql (in-memory)",
    create: async () => {
      const client = createClient({ url: "file::memory:" });
      const { backend } = await createLibsqlBackend(client);
      return {
        backend,
        cleanup: async () => {
          await backend.close();
          client.close();
        },
      };
    },
  },
];

for (const flavor of flavors) {
  describe(`driver conformance: ${flavor.name}`, () => {
    it("commits transactional writes visibly to later root reads", async () => {
      const { backend, cleanup } = await flavor.create();
      try {
        const [store] = await createStoreWithSchema(graph, backend);
        await store.nodes.Person.create({ name: "Plain" });
        await store.transaction(async (tx) => {
          await tx.nodes.Person.create({ name: "InTx" });
        });

        const people = await store.nodes.Person.find({ limit: 10 });
        expect(people.map((person) => person.name).toSorted()).toEqual([
          "InTx",
          "Plain",
        ]);
      } finally {
        await cleanup();
      }
    });

    it("rolls back everything when the transaction callback throws", async () => {
      const { backend, cleanup } = await flavor.create();
      try {
        const [store] = await createStoreWithSchema(graph, backend);
        await expect(
          store.transaction(async (tx) => {
            await tx.nodes.Person.create({ name: "Doomed" });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");

        await expect(store.nodes.Person.find({ limit: 5 })).resolves.toEqual(
          [],
        );
      } finally {
        await cleanup();
      }
    });

    it("serializes concurrent plain creates and transactions without SQLITE_BUSY", async () => {
      const { backend, cleanup } = await flavor.create();
      try {
        const [store] = await createStoreWithSchema(graph, backend);
        const count = 12;
        await Promise.all([
          ...Array.from({ length: count }, (_, index) =>
            store.nodes.Person.create({ name: `plain-${index}` }),
          ),
          ...Array.from({ length: count }, (_, index) =>
            store.transaction(async (tx) => {
              await tx.nodes.Person.create({ name: `tx-${index}` });
            }),
          ),
        ]);

        const people = await store.nodes.Person.find({ limit: count * 3 });
        expect(people).toHaveLength(count * 2);
      } finally {
        await cleanup();
      }
    });

    it("rejects root-store access inside a transaction callback with a typed error", async () => {
      const { backend, cleanup } = await flavor.create();
      try {
        const [store] = await createStoreWithSchema(graph, backend);
        await expect(
          store.transaction(async () => {
            await store.nodes.Person.find({ limit: 1 });
          }),
        ).rejects.toThrow(ConfigurationError);

        // The rejected transaction rolled back and the store remains usable.
        await store.nodes.Person.create({ name: "AfterRollback" });
        await expect(
          store.nodes.Person.find({ limit: 5 }),
        ).resolves.toHaveLength(1);
      } finally {
        await cleanup();
      }
    });
  });
}
