/**
 * `createPostgresBackend(db, { fulltext: false })` — disabling the fulltext
 * stack.
 *
 * The Postgres backend wires `tsvectorStrategy` by default. `fulltext:
 * false` turns the stack off, mirroring `vector: false` — the backend
 * advertises no `capabilities.fulltext` and omits the fulltext CRUD/search
 * methods, so the store never routes fulltext work to it and refuses with a
 * typed error at the boundary instead.
 *
 * The shape-only tests inspect the constructed backend's shape only and
 * issue no SQL, so they run in plain `pnpm test` without a database. The
 * behavior tests run against a real in-process PGlite database whose DDL
 * never creates a fulltext table at all — proving a hard delete, a plain
 * write, and a plain query never touch it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ContributionRebuildUnsupportedError,
  createStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
  UnsupportedBackendCapabilityError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { tables as postgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { createLocalPgliteStore } from "../../../src/backend/postgres/pglite-store";
import { embedding } from "../../../src/core/embedding";
import { searchable } from "../../../src/core/searchable";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { createAdapterStoreWithSchema } from "../../../src/store";

// A pool is lazy — it opens no connection until the first query — and
// `createPostgresBackend` issues none at construction, so this never touches a
// real database.
const PLACEHOLDER_URL = "postgresql://placeholder@127.0.0.1:5432/placeholder";

describe("createPostgresBackend({ fulltext: false })", () => {
  let pool: Pool | undefined;

  function backendWith(disableFulltext = false) {
    pool = new Pool({ connectionString: PLACEHOLDER_URL });
    const db = drizzle(pool);
    return createPostgresBackend(
      db,
      disableFulltext ? { fulltext: false } : {},
    );
  }

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
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

  it("advertises tsvector capability by default (no override)", () => {
    const backend = backendWith();

    expect(backend.capabilities.fulltext?.supported).toBe(true);
    expect(backend.upsertFulltext).toBeDefined();
    expect(backend.fulltextSearch).toBeDefined();
  });

  it("retains non-fulltext capabilities when fulltext is disabled, and vector is unaffected", () => {
    const backend = backendWith(true);

    expect(backend.capabilities.execution.interactiveTransactions).toBe(true);
    expect(backend.capabilities.execution.atomicBatch).toBe("root");
    expect(backend.capabilities.vector?.supported).toBe(true);
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

describe("createLocalPgliteBackend({ fulltext: false })", () => {
  it("forwards the option to both the installation DDL and the backend, so bootstrap creates no fulltext table", async () => {
    const { backend } = await createLocalPgliteBackend({ fulltext: false });
    try {
      expect(backend.capabilities.fulltext).toBeUndefined();
      expect(backend.upsertFulltext).toBeUndefined();

      const rows = await backend.execute(
        asCompiledRowsSql(
          sql`SELECT to_regclass(${postgresTables.fulltextTableName}) AS relation`,
        ),
      );
      expect(
        (rows[0] as { relation: string | null } | undefined)?.relation,
      ).toBeNull();
    } finally {
      await backend.close();
    }
  });
});

describe("createLocalPgliteStore({ fulltext: false })", () => {
  it(
    "forwards the option through the managed wrapper, so bootstrap creates no fulltext table",
    { timeout: 60_000 },
    async () => {
      const dataDir = await mkdtemp(
        path.join(tmpdir(), "typegraph-pglite-store-"),
      );
      try {
        const WrapperPerson = defineNode("Person", {
          schema: z.object({ name: z.string() }),
        });
        const wrapperGraph = defineGraph({
          id: "pglite-store-fulltext-off",
          nodes: { Person: { type: WrapperPerson } },
          edges: {},
        });
        const store = await createLocalPgliteStore(wrapperGraph, {
          dataDir,
          fulltext: false,
        });
        await store.close();

        // Reopen the data directory directly, bypassing every TypeGraph
        // factory, so this proves what the wrapper's own bootstrap wrote to
        // disk rather than what a second factory call would additionally
        // provision.
        const raw = await PGlite.create({ dataDir });
        try {
          const rows = await raw.query<{ to_regclass: string | null }>(
            "SELECT to_regclass($1)",
            [postgresTables.fulltextTableName],
          );
          expect(rows.rows[0]?.to_regclass).toBeNull();
        } finally {
          await raw.close();
        }
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const plainGraph = defineGraph({
  id: "pglite-fulltext-off-plain",
  nodes: { Person: { type: Person } },
  edges: {},
});

const Document = defineNode("Document", {
  schema: z.object({ title: searchable() }),
});
const searchableGraph = defineGraph({
  id: "pglite-fulltext-off-searchable",
  nodes: { Document: { type: Document } },
  edges: {},
});

describe("fulltext: false — behavior on PGlite", () => {
  let client: PGlite;

  async function setUp(): Promise<void> {
    client = await PGlite.create({ extensions: { vector: pgvectorExtension } });
    // `false` skips the fulltext table entirely; the vector extension is
    // still installed so the hybrid-refusal test below can reach the
    // fulltext leg of `store.search.hybrid` rather than refusing on the
    // (present) vector leg first.
    await client.exec(generatePostgresMigrationSQL(postgresTables, false));
  }

  afterEach(async () => {
    await client.close();
  });

  function backend() {
    return createPostgresBackend(drizzlePglite(client), {
      tables: postgresTables,
      fulltext: false,
    });
  }

  it("creates, updates, hard-deletes nodes, and runs a plain query", async () => {
    await setUp();
    const [store] = await createAdapterStoreWithSchema(plainGraph, backend());

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    await store.nodes.Person.update(alice.id, { name: "Alicia" });

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
    // a missing-relation SQL error instead of succeeding.
    await store.nodes.Person.hardDelete(alice.id);
    await store.nodes.Person.hardDelete(bob.id);
  });

  it("bootstraps with no relation named like the fulltext table", async () => {
    await setUp();
    const rows = await client.query<{ to_regclass: string | null }>(
      "SELECT to_regclass($1)",
      [postgresTables.fulltextTableName],
    );
    expect(rows.rows[0]?.to_regclass).toBeNull();
  });

  it("refreshes statistics without touching the fulltext table", async () => {
    await setUp();
    const [store] = await createAdapterStoreWithSchema(plainGraph, backend());
    await store.nodes.Person.create({ name: "Alice" });

    await store.refreshStatistics();
  });

  it("clears the graph without touching the fulltext table", async () => {
    await setUp();
    const [store] = await createAdapterStoreWithSchema(plainGraph, backend());
    await store.nodes.Person.create({ name: "Alice" });

    await store.clear();

    const found = await store
      .query()
      .from("Person", "p")
      .select((ctx) => ctx.p)
      .execute();
    expect(found).toEqual([]);
  });

  it("removes a kind's rows via materializeRemovals without touching the fulltext table", async () => {
    await setUp();
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

  it("a fulltext predicate refuses with UnsupportedBackendCapabilityError reason fulltext_unsupported", async () => {
    await setUp();
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

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
    await setUp();
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
    await setUp();
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
    await setUp();
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );
    const seeded = await backend().insertNode({
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
    await setUp();
    // `insertNode` bypasses `store.nodes.Document.create()` (which itself
    // refuses on this backend), the way a row written before a database
    // was reconfigured with `fulltext: false` would already exist. The
    // point of this test is the delete path alone: `deleteNodeFulltext`
    // must treat "no fulltext strategy" as "nothing to clean up", not as
    // an availability refusal — and this backend's DDL never created a
    // fulltext table, so any statement against one would surface as a
    // missing-relation SQL error instead of succeeding.
    const seeded = await backend().insertNode({
      graphId: searchableGraph.id,
      kind: "Document",
      id: "seeded-soft-delete",
      props: { title: "hello world" },
    });
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

    const query = vi.spyOn(client, "query");

    await store.nodes.Document.delete(seeded.id as never);

    const statements = query.mock.calls.map((call) => call[0]);
    expect(
      statements.some((text) =>
        text.includes(postgresTables.fulltextTableName),
      ),
    ).toBe(false);
  });

  it("hard-deletes a searchable node that predates fulltext being disabled, without touching the fulltext table", async () => {
    await setUp();
    const seeded = await backend().insertNode({
      graphId: searchableGraph.id,
      kind: "Document",
      id: "seeded-hard-delete",
      props: { title: "hello world" },
    });
    const [store] = await createAdapterStoreWithSchema(
      searchableGraph,
      backend(),
    );

    const query = vi.spyOn(client, "query");

    await store.nodes.Document.hardDelete(seeded.id as never);

    const statements = query.mock.calls.map((call) => call[0]);
    expect(
      statements.some((text) =>
        text.includes(postgresTables.fulltextTableName),
      ),
    ).toBe(false);
  });

  it("rebuildFulltext() refuses with UnsupportedBackendCapabilityError reason fulltext_unsupported", async () => {
    await setUp();
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
    await setUp();
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
    await setUp();
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

  it("store.search.hybrid refuses with UnsupportedBackendCapabilityError reason fulltext_unsupported", async () => {
    await setUp();
    const HybridDocument = defineNode("HybridDoc", {
      schema: z.object({ title: searchable(), embedding: embedding(4) }),
    });
    const hybridGraph = defineGraph({
      id: "pglite-fulltext-off-hybrid",
      nodes: { HybridDoc: { type: HybridDocument } },
      edges: {},
    });
    const hybridBackend = backend();
    expect(hybridBackend.vectorSearch).toBeDefined();
    const [store] = await createAdapterStoreWithSchema(
      hybridGraph,
      hybridBackend,
    );

    const attempt = store.search.hybrid("HybridDoc", {
      limit: 5,
      vector: { fieldPath: "embedding", queryEmbedding: [0.1, 0.2, 0.3, 0.4] },
      fulltext: { query: "hello" },
    });

    await expect(attempt).rejects.toBeInstanceOf(
      UnsupportedBackendCapabilityError,
    );
    await expect(attempt).rejects.toMatchObject({
      details: { capability: "fulltext", reason: "fulltext_unsupported" },
    });
  });
});
