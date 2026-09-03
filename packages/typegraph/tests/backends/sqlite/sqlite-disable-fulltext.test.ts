/**
 * `createSqliteBackend(db, { fulltext: false })` — disabling the fulltext
 * stack.
 *
 * The SQLite backend wires `fts5Strategy` by default. `fulltext: false`
 * turns the stack off, mirroring a SQLite connection without sqlite-vec for
 * vector — the backend advertises no `capabilities.fulltext` and omits the
 * fulltext CRUD/search methods, so the store never routes fulltext work to
 * it and refuses with a typed error at the boundary instead.
 *
 * The shape-only tests inspect the constructed backend and issue no SQL. The
 * behavior tests run against a real in-memory better-sqlite3 connection
 * whose DDL never creates a fulltext table at all — proving a hard delete,
 * a plain write, and a plain query never touch it.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ContributionRebuildUnsupportedError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  UnsupportedBackendCapabilityError,
} from "../../../src";
import { generateSqliteDDL } from "../../../src/backend/drizzle/ddl";
import {
  createSqliteBackend,
  tables,
} from "../../../src/backend/drizzle/sqlite";
import { searchable } from "../../../src/core/searchable";
import { createAdapterStoreWithSchema } from "../../../src/store";

describe("createSqliteBackend({ fulltext: false })", () => {
  let sqlite: Database.Database | undefined;

  function backendWith(disableFulltext = false) {
    sqlite = new Database(":memory:");
    for (const statement of generateSqliteDDL(
      tables,
      disableFulltext ? false : undefined,
    )) {
      sqlite.exec(statement);
    }
    const db = drizzle(sqlite);
    return createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables,
      ...(disableFulltext ? { fulltext: false } : {}),
    });
  }

  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("advertises no fulltext capability and omits the five fulltext members", () => {
    const backend = backendWith(true);

    expect(backend.capabilities.fulltext).toBeUndefined();
    expect(backend.upsertFulltext).toBeUndefined();
    expect(backend.deleteFulltext).toBeUndefined();
    expect(backend.upsertFulltextBatch).toBeUndefined();
    expect(backend.deleteFulltextBatch).toBeUndefined();
    expect(backend.fulltextSearch).toBeUndefined();
  });

  it("advertises FTS5 capability by default (no override)", () => {
    const backend = backendWith();

    expect(backend.capabilities.fulltext?.supported).toBe(true);
    expect(backend.upsertFulltext).toBeDefined();
    expect(backend.fulltextSearch).toBeDefined();
  });

  it("retains non-fulltext capabilities when fulltext is disabled", () => {
    const backend = backendWith(true);

    expect(backend.capabilities.execution.interactiveTransactions).toBe(true);
  });

  it("contributions.rebuild tracks the transactional-fence condition with fulltext off", () => {
    const on = backendWith();
    const off = backendWith(true);

    expect(on.capabilities.contributions?.rebuild).toBe(
      on.capabilities.execution.interactiveTransactions,
    );
    expect(off.capabilities.contributions?.rebuild).toBe(
      off.capabilities.execution.interactiveTransactions,
    );
  });
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const plainGraph = defineGraph({
  id: "sqlite-fulltext-off-plain",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const Document = defineNode("Document", {
  schema: z.object({ title: searchable() }),
});
const searchableGraph = defineGraph({
  id: "sqlite-fulltext-off-searchable",
  nodes: { Document: { type: Document } },
  edges: {},
});

describe("fulltext: false — behavior on a graph without searchable fields", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    for (const statement of generateSqliteDDL(tables, false)) {
      sqlite.exec(statement);
    }
  });

  afterEach(() => {
    sqlite.close();
  });

  function backend() {
    return createSqliteBackend(drizzle(sqlite), {
      executionProfile: { isSync: true },
      tables,
      fulltext: false,
    });
  }

  it("creates, updates, hard-deletes nodes and edges, and runs a plain query", async () => {
    const [store] = await createAdapterStoreWithSchema(plainGraph, backend());

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.nodes.Person.update(alice.id, { name: "Alicia" });
    const edge = await store.edges.knows.create(alice, bob, {});

    const found = await store
      .query()
      .from("Person", "p")
      .select((ctx) => ctx.p)
      .execute();
    expect(found.map((node) => node.id).toSorted()).toEqual(
      [alice.id, bob.id].toSorted(),
    );

    // A hard delete never touches a fulltext table — this backend's
    // DDL never created one, so any statement against it would surface as
    // a missing-table SQL error instead of succeeding.
    await store.edges.knows.hardDelete(edge.id);
    await store.nodes.Person.hardDelete(alice.id);
    await store.nodes.Person.hardDelete(bob.id);
  });

  it("refreshes statistics without touching the fulltext table", async () => {
    const [store] = await createAdapterStoreWithSchema(plainGraph, backend());
    await store.nodes.Person.create({ name: "Alice" });

    await store.refreshStatistics();
  });

  it("clears the graph without touching the fulltext table", async () => {
    const [store] = await createAdapterStoreWithSchema(plainGraph, backend());
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.edges.knows.create(alice, bob, {});

    await store.clear();

    const found = await store
      .query()
      .from("Person", "p")
      .select((ctx) => ctx.p)
      .execute();
    expect(found).toEqual([]);
  });

  it("a fulltext predicate refuses with UnsupportedBackendCapabilityError reason fulltext_unsupported", async () => {
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

    // No row is written: the compiler refuses before any SQL runs, so an
    // empty table proves the refusal is not merely "no rows matched".
    const attempt = store
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.$fulltext.matches("hello", 10))
      .select((ctx) => ctx.d)
      .execute();

    await expect(attempt).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(attempt).rejects.toMatchObject({
      details: { capability: "fulltext_unsupported" },
    });
  });

  it("store.search.fulltext refuses with UnsupportedBackendCapabilityError reason fulltext_unsupported", async () => {
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

    const attempt = store.search.fulltext("Document", {
      query: "hello",
      limit: 10,
    });

    await expect(attempt).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(attempt).rejects.toMatchObject({
      details: { capability: "fulltext_unsupported" },
    });
  });

  it("a searchable() field refuses with a typed error on the first write, not a SQL error", async () => {
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

    const attempt = store.nodes.Document.create({ title: "hello world" });

    await expect(attempt).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(attempt).rejects.toMatchObject({
      details: { capability: "fulltext_unsupported" },
    });
  });

  it("rebuilding the fulltext contribution refuses with a typed error naming it", async () => {
    const [store] = await createAdapterStoreWithSchema(plainGraph, backend());

    const attempt = store.rebuildContribution("fulltext");

    await expect(attempt).rejects.toBeInstanceOf(
      ContributionRebuildUnsupportedError,
    );
    await expect(attempt).rejects.toMatchObject({
      reason: "fulltext-unavailable",
      details: { contribution: "fulltext" },
    });
  });

  it("removes a kind's rows via materializeRemovals without touching the fulltext table", async () => {
    const widgetExtension = defineGraphExtension({
      nodes: { Widget: { properties: { label: { type: "string" } } } },
    });
    const [store] = await createStoreWithSchema(plainGraph, backend());
    const evolved = await store.evolve(widgetExtension);
    await evolved.getNodeCollectionOrThrow("Widget").create({ label: "gone" });

    const removed = await evolved.removeKinds(["Widget"]);
    const result = await removed.materializeRemovals();

    const widgetEntry = result.results.find((entry) => entry.kind === "Widget");
    expect(widgetEntry?.status).toBe("removed");
  });
});

describe("fulltext: false — hybrid search refuses on the fulltext leg", () => {
  it("store.search.hybrid refuses with UnsupportedBackendCapabilityError reason fulltext_unsupported, independent of vector support", async () => {
    const sqlite = new Database(":memory:");
    try {
      for (const statement of generateSqliteDDL(tables, false)) {
        sqlite.exec(statement);
      }
      const db = drizzle(sqlite);
      // Deliberately no vector strategy override, and sqlite-vec is not
      // loaded into this connection: the fulltext gate in
      // `executeHybridSearch` runs ahead of the vector gate, so this
      // refusal is provable without a native vector extension.
      const backend = createSqliteBackend(db, {
        executionProfile: { isSync: true },
        tables,
        fulltext: false,
      });
      expect(backend.vectorSearch).toBeUndefined();

      const { embedding } = await import("../../../src/core/embedding");
      const HybridDocument = defineNode("HybridDoc", {
        schema: z.object({ title: searchable(), embedding: embedding(4) }),
      });
      const hybridGraph = defineGraph({
        id: "sqlite-fulltext-off-hybrid",
        nodes: { HybridDoc: { type: HybridDocument } },
        edges: {},
      });
      const [store] = await createAdapterStoreWithSchema(hybridGraph, backend);

      const attempt = store.search.hybrid("HybridDoc", {
        limit: 5,
        vector: {
          fieldPath: "embedding",
          queryEmbedding: [0.1, 0.2, 0.3, 0.4],
        },
        fulltext: { query: "hello" },
      });

      await expect(attempt).rejects.toBeInstanceOf(
        UnsupportedBackendCapabilityError,
      );
      await expect(attempt).rejects.toMatchObject({
        details: { capability: "fulltext_unsupported" },
      });
    } finally {
      sqlite.close();
    }
  });
});
