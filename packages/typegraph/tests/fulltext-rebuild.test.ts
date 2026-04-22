/**
 * Tests for `store.search.rebuildFulltext()` — the bulk rebuild path used
 * after schema changes, truncation, or data drift.
 */
import { type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, searchable } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { ConfigurationError, ValidationError } from "../src/errors";
import { createStore } from "../src/store";

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    tenantId: z.string(),
  }),
});

const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
  }),
});

const TestGraph = defineGraph({
  id: "fulltext-rebuild-test",
  nodes: {
    Document: { type: Document },
    User: { type: User },
  },
  edges: {},
});

describe("store.search.rebuildFulltext", () => {
  let backend: GraphBackend;
  let db: BetterSQLite3Database;
  let store: ReturnType<typeof createStore<typeof TestGraph>>;

  beforeEach(async () => {
    const result = createLocalSqliteBackend();
    backend = result.backend;
    db = result.db;
    await backend.bootstrapTables?.();
    store = createStore(TestGraph, backend);
  });

  it("restores fulltext results after the fulltext table is truncated", async () => {
    const d1 = await store.nodes.Document.create({
      title: "Climate change report",
      body: "Global warming analysis",
      tenantId: "t1",
    });
    const d2 = await store.nodes.Document.create({
      title: "Quarterly earnings",
      body: "Revenue and margin review",
      tenantId: "t2",
    });

    // Simulate drift by clearing fulltext rows for every node.
    for (const nodeId of [d1.id, d2.id]) {
      await backend.deleteFulltext!({
        graphId: store.graphId,
        nodeKind: "Document",
        nodeId,
      });
    }

    const emptyResults = await store.search.fulltext("Document", {
      query: "climate",
      limit: 10,
    });
    expect(emptyResults).toHaveLength(0);

    const stats = await store.search.rebuildFulltext();
    expect(stats.kinds).toContain("Document");
    expect(stats.upserted).toBe(2);
    expect(stats.cleared).toBe(0);
    expect(stats.skipped).toBe(0);

    const rebuilt = await store.search.fulltext("Document", {
      query: "climate",
      limit: 10,
    });
    expect(rebuilt).toHaveLength(1);
  });

  it("skips kinds with no searchable fields silently", async () => {
    await store.nodes.User.create({ name: "Alice" });
    await store.nodes.Document.create({
      title: "Climate",
      body: "Body",
      tenantId: "t1",
    });

    const stats = await store.search.rebuildFulltext();
    expect(stats.kinds).toEqual(["Document"]);
    expect(stats.processed).toBe(1);
  });

  it("clears the index entry when all searchable fields are empty", async () => {
    const node = await store.nodes.Document.create({
      title: "",
      body: "",
      tenantId: "t1",
    });

    // Force a stale fulltext row to exist so we can verify it gets cleared.
    await backend.upsertFulltext!({
      graphId: store.graphId,
      nodeKind: "Document",
      nodeId: node.id,
      content: "stale content",
      language: "english",
    });

    const stats = await store.search.rebuildFulltext();
    expect(stats.cleared).toBe(1);
    expect(stats.upserted).toBe(0);

    const hits = await store.search.fulltext("Document", {
      query: "stale",
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it("narrows to a single kind when nodeKind is specified", async () => {
    await store.nodes.Document.create({
      title: "Climate",
      body: "Body",
      tenantId: "t1",
    });

    const stats = await store.search.rebuildFulltext("Document");
    expect(stats.kinds).toEqual(["Document"]);
  });

  it("clears fulltext rows for soft-deleted nodes", async () => {
    const document = await store.nodes.Document.create({
      title: "Climate",
      body: "Body",
      tenantId: "t1",
    });
    await store.nodes.Document.delete(document.id);

    // Re-upsert a stale row that would normally have been cleaned up
    // by the delete hook. Rebuild should discover and remove it.
    await backend.upsertFulltext!({
      graphId: store.graphId,
      nodeKind: "Document",
      nodeId: document.id,
      content: "Climate Body",
      language: "english",
    });

    const stats = await store.search.rebuildFulltext();
    expect(stats.cleared).toBeGreaterThanOrEqual(1);

    const hits = await store.search.fulltext("Document", {
      query: "climate",
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it("throws ConfigurationError on a backend without fulltext support", async () => {
    const {
      upsertFulltext: _upsert,
      deleteFulltext: _delete,
      ...rest
    } = backend;
    const backendNoFulltext = rest as GraphBackend;
    const storeNoFulltext = createStore(TestGraph, backendNoFulltext);

    await expect(storeNoFulltext.search.rebuildFulltext()).rejects.toThrow(
      ConfigurationError,
    );
  });

  it("throws on an unknown nodeKind", async () => {
    await expect(
      store.search.rebuildFulltext("NotARealKind" as never),
    ).rejects.toThrow(ConfigurationError);
  });

  it("rejects pageSize values that are not positive integers", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        store.search.rebuildFulltext(undefined, { pageSize: bad }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("handles many rows sharing the same created_at under keyset pagination", async () => {
    // Seed many nodes. With the new keyset pagination order, all are
    // iterated exactly once even though created_at ties are likely.
    const NODE_COUNT = 120;
    for (let index = 0; index < NODE_COUNT; index++) {
      await store.nodes.Document.create({
        title: `Document ${index}`,
        body: `Content about climate change iteration ${index}`,
        tenantId: "t1",
      });
    }

    const stats = await store.search.rebuildFulltext(undefined, {
      pageSize: 20,
    });
    expect(stats.processed).toBe(NODE_COUNT);
    expect(stats.upserted).toBe(NODE_COUNT);
  });

  it("counts corrupt or non-object props in skipped without aborting", async () => {
    await store.nodes.Document.create({
      title: "Climate",
      body: "Body",
      tenantId: "t1",
    });
    const bad = await store.nodes.Document.create({
      title: "Other",
      body: "Body",
      tenantId: "t2",
    });

    // Corrupt the second node's props directly at the row level so it
    // fails JSON.parse. Using the raw better-sqlite3 handle from the
    // test harness; `backend.execute` is SELECT-only.

    const rawDb = (
      db as unknown as {
        $client: {
          prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
        };
      }
    ).$client;
    rawDb
      .prepare(`UPDATE typegraph_nodes SET props = 'not json' WHERE id = ?`)
      .run(bad.id);

    const stats = await store.search.rebuildFulltext();
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    // The good row still indexed.
    expect(stats.upserted).toBeGreaterThanOrEqual(1);
  });
});
