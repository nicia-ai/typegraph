/**
 * SQLite CRUD statement-cache reuse.
 *
 * The operation backend's CRUD helpers previously executed through
 * drizzle's `db.all()` / `db.run()`, which re-prepares every statement on
 * every call — only the query engine's `backend.execute` path used the
 * prepared-statement LRU. CRUD now routes through the execution adapter's
 * compiled path on synchronous drivers, so a repeated operation shape
 * re-binds parameters against a cached prepared statement instead of
 * re-preparing.
 *
 * The spy counts raw `$client.prepare` calls: after one warmup pass over a
 * CRUD cycle (create, update, delete), repeating the same cycle must
 * prepare nothing new.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const knows = defineEdge("knows");

const graph = defineGraph({
  id: "crud-stmt-cache",
  nodes: {
    Person: {
      type: Person,
      onDelete: "disconnect",
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

function rawClient(db: unknown): Database.Database {
  return (db as { $client: Database.Database }).$client;
}

describe("SQLite CRUD statement-cache reuse", () => {
  it("re-prepares nothing when a warmed CRUD cycle repeats", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const client = rawClient(db);
    const originalPrepare = client.prepare.bind(client);
    let prepareCalls = 0;
    try {
      const store = createStore(graph, backend);

      async function crudCycle(tag: string): Promise<void> {
        const alice = await store.nodes.Person.create({
          name: `alice-${tag}`,
          email: `alice-${tag}@example.com`,
        });
        const bob = await store.nodes.Person.create({
          name: `bob-${tag}`,
          email: `bob-${tag}@example.com`,
        });
        await store.edges.knows.create(alice, bob);
        await store.nodes.Person.update(alice.id, {
          name: `alice-${tag}-renamed`,
        });
        await store.nodes.Person.delete(alice.id);
        await store.nodes.Person.delete(bob.id);
      }

      // Warmup populates the cache with every statement shape the cycle
      // touches (probes, inserts, uniqueness upserts, updates, deletes).
      await crudCycle("warmup");

      (client as { prepare: unknown }).prepare = (sqlText: string) => {
        prepareCalls += 1;
        return originalPrepare(sqlText);
      };

      await crudCycle("second");
      await crudCycle("third");

      expect(prepareCalls).toBe(0);
    } finally {
      (client as { prepare: unknown }).prepare = originalPrepare;
      await backend.close();
    }
  });

  it("keeps CRUD results correct through the cached path", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const store = createStore(graph, backend);

      const created = await store.nodes.Person.create({
        name: "carol",
        email: "carol@example.com",
      });
      const updated = await store.nodes.Person.update(created.id, {
        name: "carol-2",
      });
      expect(updated.name).toBe("carol-2");

      const fetched = await store.nodes.Person.getById(created.id);
      expect(fetched?.name).toBe("carol-2");

      await store.nodes.Person.delete(created.id);
      expect(await store.nodes.Person.getById(created.id)).toBeUndefined();
    } finally {
      await backend.close();
    }
  });
});
