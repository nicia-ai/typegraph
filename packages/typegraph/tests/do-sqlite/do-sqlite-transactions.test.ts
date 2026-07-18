/**
 * #140 — `transactionMode: "do-sqlite"` integration suite.
 *
 * Runs against a real Cloudflare `workerd` Durable Object with SQLite
 * storage (not a Node fake), exercising the ACTUAL auto-detected
 * `backend.transaction()` / `adoptTransaction()` paths — no
 * `executionProfile` hint. `drizzle(ctx.storage)` must be detected as
 * `transactionMode: "do-sqlite"` and advertise
 * `capabilities.transactions: true`.
 *
 * The async storage runner `ctx.storage.transaction(async () => ...)`
 * (surfaced by Drizzle as `db.$client.transaction`) rolls back SQL
 * writes across `await`. There is no Drizzle tx handle on DO: the
 * storage transaction is ambient on the object, so TypeGraph binds the
 * outer `db`.
 *
 * Boot uses `createAdapterStoreWithSchema` (the real adapter path): `bootstrapTables`
 * DDL and the durable contribution marker run OUTSIDE any storage
 * transaction (the #135 invariant); the schema-version commit runs
 * through the `do-sqlite` storage runner (data only, never DDL).
 *
 * Each `it` runs in its OWN Durable Object instance (unique
 * `idFromName`) so storage is isolated. The graph node has no
 * `searchable` field, so a create is a pure INSERT and the fulltext
 * gate is never reached. Store reads return the flattened node shape
 * (`node.title`, `node.meta`) — there is no `node.props`.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  createAdapterStoreWithSchema,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../src";
import { createSqliteBackend } from "../../src/backend/drizzle/sqlite";
import { tables as defaultTables } from "../../src/backend/sqlite";
import { DURABLE_OBJECT_MAX_BIND_PARAMETERS } from "../../src/backend/types";
import { RECORDED_EDGE_COLUMNS } from "../../src/store/recorded-capture";

import { SpikeDO } from "./worker";

// The product's own relational ledger — NOT a TypeGraph table. The
// composite PK is the racing-save anti-divergence mechanic: a stale
// writer targeting an already-written (slug, version) is rejected.
const docVersions = sqliteTable(
  "doc_versions",
  {
    documentSlug: text("document_slug").notNull(),
    docVersion: integer("doc_version").notNull(),
    payload: text("payload").notNull(),
  },
  (table) => [primaryKey({ columns: [table.documentSlug, table.docVersion] })],
);

const Doc = defineNode("Doc", { schema: z.object({ title: z.string() }) });
const linksTo = defineEdge("links_to", {
  schema: z.object({ cost: z.number() }),
});

const DocGraph = defineGraph({
  id: "do-sqlite",
  nodes: { Doc: { type: Doc } },
  edges: { links_to: { type: linksTo, from: [Doc], to: [Doc] } },
});

const Message = defineNode("Message", {
  schema: z.object({ text: z.string() }),
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const mentions = defineEdge("mentions");

const HistoryGraph = defineGraph({
  id: "do-sqlite-history",
  nodes: { Message: { type: Message }, Person: { type: Person } },
  edges: {
    mentions: {
      type: mentions,
      from: [Message],
      to: [Person],
      cardinality: "many",
    },
  },
});

// Exercise several chunks, with enough margin that a modest reduction in
// recorded columns cannot make the pre-fix single statement fit accidentally.
const RECORDED_EDGE_COUNT_EXCEEDING_ONE_STATEMENT =
  Math.ceil(DURABLE_OBJECT_MAX_BIND_PARAMETERS / RECORDED_EDGE_COLUMNS.length) *
  4;

async function bootInsideDurableObject(storage: DurableObjectStorage) {
  // No executionProfile hint: detection must classify drizzle(ctx.storage)
  // as `do-sqlite` on its own.
  const db = drizzle(storage);
  const backend = createSqliteBackend(db, { tables: defaultTables });

  // Real boot path: bootstrap DDL + durable marker run OUTSIDE any
  // storage transaction; the schema-version commit runs through the
  // do-sqlite storage runner (data only).
  const [store] = await createAdapterStoreWithSchema(DocGraph, backend);

  // The caller's own relational table (created outside any business
  // transaction, like the TypeGraph base tables).
  db.run(
    sql.raw(
      "CREATE TABLE doc_versions (" +
        "document_slug TEXT NOT NULL, doc_version INTEGER NOT NULL, " +
        "payload TEXT NOT NULL, PRIMARY KEY (document_slug, doc_version))",
    ),
  );

  return { db, backend, store };
}

async function bootHistoryInsideDurableObject(storage: DurableObjectStorage) {
  const db = drizzle(storage);
  const backend = createSqliteBackend(db, { tables: defaultTables });
  const [store] = await createAdapterStoreWithSchema(HistoryGraph, backend, {
    history: true,
  });
  return store;
}

function inObject<T>(
  name: string,
  body: (
    ctx: Awaited<ReturnType<typeof bootInsideDurableObject>>,
    storage: DurableObjectStorage,
  ) => Promise<T>,
): Promise<T> {
  const stub = env.SPIKE_DO.get(env.SPIKE_DO.idFromName(name));
  return runInDurableObject(
    stub,
    async (_instance: SpikeDO, state: DurableObjectState) =>
      body(await bootInsideDurableObject(state.storage), state.storage),
  );
}

describe("#140 do-sqlite transactions (Durable Objects, real workerd)", () => {
  it("auto-detects do-sqlite and advertises capabilities.transactions:true", async () => {
    await inObject("detect", async ({ db, backend }, storage) => {
      expect(db.$client).toBe(storage);
      expect(typeof storage.transaction).toBe("function");
      expect(backend.capabilities.transactions).toBe(true);
      expect(backend.capabilities.graphAnalytics?.supported).toBe(false);
      expect(backend.capabilities.maxBindParameters).toBe(
        DURABLE_OBJECT_MAX_BIND_PARAMETERS,
      );

      const staleHintBackend = createSqliteBackend(db, {
        capabilities: {
          graphAnalytics: { supported: true, mathFunctions: false },
          maxBindParameters: 999,
        },
        executionProfile: { isSync: false, transactionMode: "none" },
        tables: defaultTables,
      });
      expect(staleHintBackend.capabilities.transactions).toBe(true);
      expect(staleHintBackend.capabilities.graphAnalytics?.supported).toBe(
        false,
      );
      expect(staleHintBackend.capabilities.maxBindParameters).toBe(
        DURABLE_OBJECT_MAX_BIND_PARAMETERS,
      );
      const staleHintStore = createStore(DocGraph, staleHintBackend);
      await expect(
        staleHintStore.transaction(async (tx) => {
          await tx.nodes.Doc.create({ title: "must-roll-back" });
          throw new Error("stale-hint-rollback");
        }),
      ).rejects.toThrow("stale-hint-rollback");
      expect(await staleHintStore.nodes.Doc.count()).toBe(0);
    });
  });

  it("routes graph algorithms around forbidden temporary tables", async () => {
    await inObject("algorithms", async ({ store }) => {
      const source = await store.nodes.Doc.create({ title: "source" });
      const target = await store.nodes.Doc.create({ title: "target" });
      await store.edges.links_to.create(source, target, { cost: 2 });

      const path = await store.algorithms.shortestPath(source, target, {
        edges: ["links_to"],
      });

      expect(path?.nodes.map((node) => node.id)).toEqual([
        source.id,
        target.id,
      ]);

      const reachable = await store.algorithms.reachable(source, {
        edges: ["links_to"],
      });
      expect(reachable.map((node) => [node.id, node.depth])).toEqual([
        [source.id, 0],
        [target.id, 1],
      ]);

      const weightedPath = await store.algorithms.weightedShortestPath(
        source,
        target,
        { edges: ["links_to"], weightProperty: "cost" },
      );
      expect(weightedPath?.totalWeight).toBe(2);
      expect(weightedPath?.nodes.map((node) => node.id)).toEqual([
        source.id,
        target.id,
      ]);

      await expect(
        store.algorithms.weaklyConnectedComponents({ edges: ["links_to"] }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_BACKEND_CAPABILITY",
        details: { capability: "graphAnalytics", supported: false },
      });
    });
  });

  it("packs a literal IN list larger than the platform bind limit", async () => {
    await inObject("large-in-list", async ({ store }) => {
      await store.nodes.Doc.create({ title: "included" });
      await store.nodes.Doc.create({ title: "excluded" });
      const titles = [
        ...Array.from(
          { length: DURABLE_OBJECT_MAX_BIND_PARAMETERS + 1 },
          (_, index) => `missing-${index}`,
        ),
        "included",
      ];

      const results = await store
        .query()
        .from("Doc", "doc")
        .whereNode("doc", (doc) => doc.title.in(titles))
        .select((ctx) => ctx.doc.title)
        .execute();

      expect(results).toEqual(["included"]);
    });
  });

  it("chunks recorded history flushes to Durable Objects' 100-bind limit", async () => {
    const stub = env.SPIKE_DO.get(
      env.SPIKE_DO.idFromName("history-bind-limit"),
    );
    await runInDurableObject(
      stub,
      async (_instance: SpikeDO, state: DurableObjectState) => {
        const store = await bootHistoryInsideDurableObject(state.storage);

        await store.transaction(async (tx) => {
          const message = await tx.nodes.Message.create(
            { text: "hello" },
            { id: "message" },
          );
          for (
            let index = 0;
            index < RECORDED_EDGE_COUNT_EXCEEDING_ONE_STATEMENT;
            index += 1
          ) {
            const person = await tx.nodes.Person.create(
              { name: `person-${index}` },
              { id: `person-${index}` },
            );
            await tx.edges.mentions.create(
              message,
              person,
              {},
              {
                id: `mention-${index}`,
              },
            );
          }
        });

        expect(await store.nodes.Person.count()).toBe(
          RECORDED_EDGE_COUNT_EXCEEDING_ONE_STATEMENT,
        );
        expect(await store.edges.mentions.count()).toBe(
          RECORDED_EDGE_COUNT_EXCEEDING_ONE_STATEMENT,
        );
        const recordedAt = await store.recordedNow();
        expect(recordedAt).toBeDefined();
        if (recordedAt === undefined) {
          throw new Error("expected a recorded commit instant");
        }
        const recordedEdges = await Promise.all(
          Array.from(
            { length: RECORDED_EDGE_COUNT_EXCEEDING_ONE_STATEMENT },
            (_, index) =>
              store
                .asOfRecorded(recordedAt)
                .edges.mentions.getById(
                  asEdgeId<typeof mentions>(`mention-${index}`),
                ),
          ),
        );
        expect(recordedEdges.every((edge) => edge !== undefined)).toBe(true);
      },
    );
  });

  it("A) graph-owned store.transaction(): throw-after-await rolls back BOTH TypeGraph and product writes", async () => {
    await inObject("A-rollback", async ({ db, store }) => {
      await expect(
        store.transaction(async (tx) => {
          await tx.nodes.Doc.create({ title: "rollback-A" });
          await db
            .insert(docVersions)
            .values({ documentSlug: "A", docVersion: 1, payload: "x" });
          throw new Error("do-sqlite-A-rollback");
        }),
      ).rejects.toThrow("do-sqlite-A-rollback");

      expect(await store.nodes.Doc.count()).toBe(0);
      expect((await db.select().from(docVersions)).length).toBe(0);
    });
  });

  it("A) graph-owned store.transaction(): normal return commits BOTH", async () => {
    await inObject("A-commit", async ({ db, store }) => {
      await store.transaction(async (tx) => {
        await tx.nodes.Doc.create({ title: "commit-A" });
        await db
          .insert(docVersions)
          .values({ documentSlug: "A", docVersion: 2, payload: "y" });
      });

      expect(await store.nodes.Doc.count()).toBe(1);
      expect((await db.select().from(docVersions)).length).toBe(1);
    });
  });

  it("B) caller-owned ctx.storage.transaction()+withTransaction(): throw rolls back BOTH; prior committed work survives", async () => {
    await inObject("B-rollback", async ({ db, store }, storage) => {
      const seeded = await store.transaction(async (tx) =>
        tx.nodes.Doc.create({ title: "seed" }),
      );
      expect(await store.nodes.Doc.count()).toBe(1);

      await expect(
        storage.transaction(async () => {
          const txStore = store.withTransaction(db);
          await txStore.nodes.Doc.update(seeded.id, { title: "MUTATED" });
          await db
            .insert(docVersions)
            .values({ documentSlug: "B", docVersion: 1, payload: "z" });
          throw new Error("do-sqlite-B-rollback");
        }),
      ).rejects.toThrow("do-sqlite-B-rollback");

      const after = await store.nodes.Doc.getById(seeded.id);
      expect(after?.title).toBe("seed");
      expect(await store.nodes.Doc.count()).toBe(1);
      expect((await db.select().from(docVersions)).length).toBe(0);
    });
  });

  it("B) caller-owned ctx.storage.transaction()+withTransaction(): normal return commits BOTH", async () => {
    await inObject("B-commit", async ({ db, store }, storage) => {
      const seeded = await store.transaction(async (tx) =>
        tx.nodes.Doc.create({ title: "seed" }),
      );

      await storage.transaction(async () => {
        const txStore = store.withTransaction(db);
        await txStore.nodes.Doc.update(seeded.id, { title: "committed" });
        await db
          .insert(docVersions)
          .values({ documentSlug: "B", docVersion: 2, payload: "ok" });
      });

      const after = await store.nodes.Doc.getById(seeded.id);
      expect(after?.title).toBe("committed");
      expect((await db.select().from(docVersions)).length).toBe(1);
    });
  });

  it("a product-table PK violation surfaces as a catchable error and rolls back the earlier TypeGraph mutation", async () => {
    await inObject("pk-violation", async ({ db, store }) => {
      await expect(
        store.transaction(async (tx) => {
          await tx.nodes.Doc.create({ title: "pk-victim" });
          await db
            .insert(docVersions)
            .values({ documentSlug: "P", docVersion: 1, payload: "a" });
          // Same composite PK — the stale-writer rejection.
          await db
            .insert(docVersions)
            .values({ documentSlug: "P", docVersion: 1, payload: "b" });
        }),
      ).rejects.toThrow();

      expect(await store.nodes.Doc.count()).toBe(0);
      expect((await db.select().from(docVersions)).length).toBe(0);
    });
  });

  it("same-document contention: two concurrent saves race for one (slug, version); only the winner persists", async () => {
    await inObject("contention", async ({ db, store }) => {
      const save = (title: string) =>
        store.transaction(async (tx) => {
          await tx.nodes.Doc.create({ title });
          await db
            .insert(docVersions)
            .values({ documentSlug: "HEAD", docVersion: 1, payload: title });
        });

      const results = await Promise.allSettled([
        save("writer-1"),
        save("writer-2"),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");

      // Exactly one writer wins the (HEAD, 1) ledger row; the loser's
      // PK conflict rolls back its TypeGraph node mutation too.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(await store.nodes.Doc.count()).toBe(1);

      const ledger = await db.select().from(docVersions);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.documentSlug).toBe("HEAD");
    });
  });

  it("graph-owned tx.sql: product write via tx.sql commits/rolls back with the TypeGraph mutation", async () => {
    await inObject("tx-sql", async ({ db, store }) => {
      // Adapter tx.sql is the precisely typed bound do-sqlite Drizzle handle.
      await store.transaction(async (tx) => {
        await tx.nodes.Doc.create({ title: "via-tx-sql" });
        await tx.sql
          .insert(docVersions)
          .values({ documentSlug: "S", docVersion: 1, payload: "ok" });
      });
      expect(await store.nodes.Doc.count()).toBe(1);
      expect((await db.select().from(docVersions)).length).toBe(1);

      await expect(
        store.transaction(async (tx) => {
          await tx.nodes.Doc.create({ title: "doomed" });
          await tx.sql
            .insert(docVersions)
            .values({ documentSlug: "S", docVersion: 2, payload: "z" });
          throw new Error("phase2-do-sqlite-rollback");
        }),
      ).rejects.toThrow("phase2-do-sqlite-rollback");

      // Rolled back: still one Doc, still one ledger row.
      expect(await store.nodes.Doc.count()).toBe(1);
      expect((await db.select().from(docVersions)).length).toBe(1);
    });
  });
});
