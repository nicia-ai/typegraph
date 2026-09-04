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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { createLocalSqliteStore } from "../../../src/backend/sqlite/local-store";
import { searchable } from "../../../src/core/searchable";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { createAdapterStoreWithSchema } from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";

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

describe("createLocalSqliteBackend({ fulltext: false })", () => {
  it("forwards the option to both the installation DDL and the backend, so bootstrap creates no fulltext table", async () => {
    const { backend } = createLocalSqliteBackend({ fulltext: false });
    try {
      expect(backend.capabilities.fulltext).toBeUndefined();
      expect(backend.upsertFulltext).toBeUndefined();

      const rows = await backend.execute(
        asCompiledRowsSql(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${tables.fulltextTableName}`,
        ),
      );
      expect(rows).toEqual([]);
    } finally {
      await backend.close();
    }
  });
});

describe("createLocalSqliteStore({ fulltext: false })", () => {
  it("forwards the option through the managed wrapper, so bootstrap creates no fulltext table", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "typegraph-sqlite-"));
    const dbPath = path.join(dataDir, "store.db");
    try {
      const WrapperPerson = defineNode("Person", {
        schema: z.object({ name: z.string() }),
      });
      const wrapperGraph = defineGraph({
        id: "sqlite-store-fulltext-off",
        nodes: { Person: { type: WrapperPerson } },
        edges: {},
      });
      const store = await createLocalSqliteStore(wrapperGraph, {
        path: dbPath,
        fulltext: false,
      });
      await store.close();

      // Reopen the file directly, bypassing every TypeGraph factory, so
      // this proves what the wrapper's own bootstrap wrote to disk rather
      // than what a second factory call would additionally provision.
      const raw = new Database(dbPath, { readonly: true });
      try {
        const row = raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(tables.fulltextTableName);
        expect(row).toBeUndefined();
      } finally {
        raw.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
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

  it("bootstraps with no relation named like the fulltext table", () => {
    const rows = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .all(tables.fulltextTableName);
    expect(rows).toEqual([]);
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
      details: { capability: "fulltext", reason: "fulltext_unsupported" },
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
      details: { capability: "fulltext", reason: "fulltext_unsupported" },
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
      details: { capability: "fulltext", reason: "fulltext_unsupported" },
    });
  });

  it("update() on a searchable kind refuses with UnsupportedBackendCapabilityError, not a SQL error", async () => {
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );
    const seededBackend = backend();
    const seeded = await seededBackend.insertNode({
      graphId: searchableGraph.id,
      kind: "Document",
      id: "seeded-update",
      props: { title: "hello world" },
    });

    const attempt = store.nodes.Document.update(seeded.id as never, {
      title: "goodbye",
    });

    await expect(attempt).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(attempt).rejects.toMatchObject({
      details: { capability: "fulltext", reason: "fulltext_unsupported" },
    });
  });

  it("soft-deletes a searchable node that predates fulltext being disabled, without touching the fulltext table", async () => {
    // `insertNode` bypasses `store.nodes.Document.create()` (which itself
    // refuses on this backend), the way a row written before a database
    // was reconfigured with `fulltext: false` would already exist. The
    // point of this test is the delete path alone: `deleteNodeFulltext`
    // must treat "no fulltext strategy" as "nothing to clean up", not as
    // an availability refusal.
    const seedingBackend = backend();
    const seeded = await seedingBackend.insertNode({
      graphId: searchableGraph.id,
      kind: "Document",
      id: "seeded-soft-delete",
      props: { title: "hello world" },
    });
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

    const statements: string[] = [];
    const originalPrepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, "prepare").mockImplementation((sqlText: string) => {
      statements.push(sqlText);
      return originalPrepare(sqlText);
    });

    await store.nodes.Document.delete(seeded.id as never);

    expect(
      statements.some((text) => text.includes(tables.fulltextTableName)),
    ).toBe(false);
  });

  it("hard-deletes a searchable node that predates fulltext being disabled, without touching the fulltext table", async () => {
    const seedingBackend = backend();
    const seeded = await seedingBackend.insertNode({
      graphId: searchableGraph.id,
      kind: "Document",
      id: "seeded-hard-delete",
      props: { title: "hello world" },
    });
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

    const statements: string[] = [];
    const originalPrepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, "prepare").mockImplementation((sqlText: string) => {
      statements.push(sqlText);
      return originalPrepare(sqlText);
    });

    await store.nodes.Document.hardDelete(seeded.id as never);

    expect(
      statements.some((text) => text.includes(tables.fulltextTableName)),
    ).toBe(false);
  });

  it("rebuildFulltext() refuses with UnsupportedBackendCapabilityError reason fulltext_unsupported", async () => {
    const [store] = await createAdapterStoreWithSchema(plainGraph, backend());

    const attempt = store.search.rebuildFulltext();

    await expect(attempt).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(attempt).rejects.toMatchObject({
      details: { capability: "fulltext", reason: "fulltext_unsupported" },
    });
  });

  it("updateWhere() on a searchable kind refuses with UnsupportedBackendCapabilityError, not the batch-primitive ConfigurationError", async () => {
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

    // No row is written, and none needs to be: the capability check runs
    // ahead of the candidate-row UPDATE, so an empty table already reaches
    // it. `all: true` bypasses the separate "requires where/exists/all"
    // guard without depending on any existing row.
    const attempt = store.nodes.Document.updateWhere({
      patch: { title: "hello" },
      all: true,
    });

    await expect(attempt).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(attempt).rejects.toMatchObject({
      details: { capability: "fulltext", reason: "fulltext_unsupported" },
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
        details: { capability: "fulltext", reason: "fulltext_unsupported" },
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("fulltext: false — an orphaned sidecar row left by a hard delete while off", () => {
  it("store.search.rebuildFulltext() cannot clear the orphan; the contribution rebuild can", async () => {
    const sqlite = new Database(":memory:");
    try {
      // Fulltext ON (the dialect default): write and index a searchable
      // node.
      for (const statement of generateSqliteDDL(tables)) {
        sqlite.exec(statement);
      }
      const [storeOn] = await createStoreWithSchema(
        searchableGraph,
        createSqliteBackend(drizzle(sqlite), {
          executionProfile: { isSync: true },
          tables,
        }),
      );
      const created = await storeOn.nodes.Document.create({
        title: "an orphaned unobtainium treasure",
      });

      // Reopen the SAME database — same connection, same tables — with
      // fulltext disabled, and hard-delete the node. `hardDeleteNode`'s
      // cascade has no active fulltext strategy to build a delete
      // statement from, so the row it already wrote to the fulltext
      // table is never touched: it survives as an orphan.
      const [storeOff] = await createStoreWithSchema(
        searchableGraph,
        createSqliteBackend(drizzle(sqlite), {
          executionProfile: { isSync: true },
          tables,
          fulltext: false,
        }),
      );
      await storeOff.nodes.Document.hardDelete(created.id);

      // Reopen with fulltext back on. `rebuildFulltext()` pages live
      // nodes to recompute their content; the hard-deleted node has no
      // row left in the node table for it to page, so it never revisits
      // the orphan.
      const backendBackOn = createSqliteBackend(drizzle(sqlite), {
        executionProfile: { isSync: true },
        tables,
      });
      const [storeBackOn] = await createStoreWithSchema(
        searchableGraph,
        backendBackOn,
      );
      await storeBackOn.search.rebuildFulltext();

      // `store.search.fulltext` restricts to nodes still in the node
      // table by default — a hard-deleted node fails that join whether or
      // not its sidecar row survives, so it cannot show the orphan.
      // Searching directly against the deleted node's exact id as the
      // sole candidate proves whether the FULLTEXT TABLE still has a
      // matching row for it, independent of that join.
      const orphanCandidate = sql`SELECT ${created.id}`;
      const searchOrphan = () =>
        requireDefined(backendBackOn.fulltextSearch)({
          graphId: searchableGraph.id,
          nodeKind: "Document",
          query: "unobtainium",
          limit: 10,
          candidates: orphanCandidate,
        });

      const orphanMatchesAfterRebuildFulltext = await searchOrphan();
      expect(orphanMatchesAfterRebuildFulltext.length).toBeGreaterThan(0);

      // The destructive contribution rebuild drops and recreates the
      // fulltext table, then refills it from current live nodes only —
      // the orphan cannot survive a table that no longer exists.
      await storeBackOn.rebuildContribution("fulltext");

      expect(await searchOrphan()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
