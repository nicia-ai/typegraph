/**
 * PGlite backend — in-process Postgres-in-WASM.
 *
 * Unlike the Docker-gated `postgres-backend.test.ts`, these run in plain
 * `pnpm test`: PGlite boots a real Postgres in the test process, so this
 * exercises the actual PG dialect and the pgvector path with zero Docker.
 *
 * Two things are under test:
 *  - the execution fast-path blocker fix — PGlite's `.query` has no
 *    named-statement config form, and passing one desyncs its single
 *    connection (`08P01`). The default `prepareStatements: true` must route
 *    PGlite to the unnamed positional wrapper instead.
 *  - `createLocalPgliteBackend` — the batteries-included helper, including
 *    the pgvector round trip and the `vector: false` / bring-your-own paths.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, embedding } from "../../../src";
import { generatePostgresDDL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { createStore } from "../../../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string().optional() }),
});
const peopleGraph = defineGraph({
  id: "pglite_people",
  nodes: { Person: { type: Person } },
  edges: {},
});

const Document = defineNode("Doc", {
  schema: z.object({ title: z.string(), embedding: embedding(4) }),
});
const documentsGraph = defineGraph({
  id: "pglite_docs",
  nodes: { Doc: { type: Document } },
  edges: {},
});

describe("PGlite backend", () => {
  // Each test registers its own teardown; closing a backend from
  // createLocalPgliteBackend disposes its PGlite engine, while the bare-client
  // test closes the client directly.
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  describe("execution fast-path (blocker fix)", () => {
    it("runs queries under default prepareStatements (no named-statement desync)", async () => {
      // A bare PGlite + createPostgresBackend with DEFAULT options
      // (prepareStatements: true). Before the fix this routed to the
      // named-statement wrapper and every query failed; now PGlite is
      // detected and routed to the unnamed positional wrapper.
      const client = await PGlite.create();
      await client.exec(generatePostgresDDL().join("\n\n"));
      cleanups.push(() => client.close());

      const backend = createPostgresBackend(drizzle(client), { vector: false });
      const store = createStore(peopleGraph, backend);

      const created = await store.nodes.Person.create({
        name: "Alice",
        email: "alice@example.com",
      });
      const fetched = await store.nodes.Person.getById(created.id);

      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe("Alice");
    });
  });

  describe("createLocalPgliteBackend()", () => {
    it("advertises pgvector and runs a vector search end to end", async () => {
      const { backend } = await createLocalPgliteBackend();
      cleanups.push(() => backend.close());
      expect(backend.capabilities.vector?.supported).toBe(true);

      const store = createStore(documentsGraph, backend);
      await store.nodes.Doc.create({ title: "near", embedding: [1, 0, 0, 0] });
      await store.nodes.Doc.create({ title: "far", embedding: [0, 0, 0, 1] });

      const hits = await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        limit: 2,
        metric: "cosine",
      });

      expect(hits).toHaveLength(2);
      expect(hits[0]!.node.title).toBe("near");
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    });

    it("runs ordinary CRUD and transactions", async () => {
      const { backend } = await createLocalPgliteBackend();
      cleanups.push(() => backend.close());
      const store = createStore(peopleGraph, backend);

      const result = await store.transaction(async (tx) => {
        const alice = await tx.nodes.Person.create({ name: "Alice" });
        const bob = await tx.nodes.Person.create({ name: "Bob" });
        return { alice, bob };
      });

      expect(await store.nodes.Person.getById(result.alice.id)).toBeDefined();
      expect(await store.nodes.Person.getById(result.bob.id)).toBeDefined();
    });

    it("disables vector with vector: false (no extension, CRUD still works)", async () => {
      const { backend } = await createLocalPgliteBackend({ vector: false });
      cleanups.push(() => backend.close());
      expect(backend.capabilities.vector).toBeUndefined();
      expect(backend.upsertEmbedding).toBeUndefined();

      const store = createStore(peopleGraph, backend);
      const created = await store.nodes.Person.create({ name: "Carol" });
      expect(await store.nodes.Person.getById(created.id)).toBeDefined();
    });

    it("accepts a bring-your-own pgvector extension", async () => {
      // The default path dynamically loads @electric-sql/pglite-pgvector;
      // passing the same extension explicitly must produce an equivalent,
      // working vector backend (the escape hatch for version pinning).
      const { backend } = await createLocalPgliteBackend({
        vector: pgvectorExtension,
      });
      cleanups.push(() => backend.close());
      expect(backend.capabilities.vector?.supported).toBe(true);

      const store = createStore(documentsGraph, backend);
      await store.nodes.Doc.create({ title: "only", embedding: [0, 1, 0, 0] });
      const hits = await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [0, 1, 0, 0],
        limit: 1,
        metric: "cosine",
      });
      expect(hits[0]!.node.title).toBe("only");
    });

    it("persists data (and embeddings) to an on-disk dataDir across reopen", async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "typegraph-pglite-"));
      cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

      // Session 1: write a node + embedding, then close to flush to disk.
      const first = await createLocalPgliteBackend({ dataDir });
      const created = await createStore(
        documentsGraph,
        first.backend,
      ).nodes.Doc.create({ title: "persisted", embedding: [1, 0, 0, 0] });
      await first.backend.close();

      // Session 2: reopen the same dataDir — the node and its embedding
      // (pgvector storage) must survive. Read everything, then close before
      // asserting so the engine is disposed even if an expectation fails.
      const second = await createLocalPgliteBackend({ dataDir });
      const store = createStore(documentsGraph, second.backend);
      const fetched = await store.nodes.Doc.getById(created.id);
      const hits = await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        limit: 1,
        metric: "cosine",
      });
      await second.backend.close();

      expect(fetched?.title).toBe("persisted");
      expect(hits[0]!.node.title).toBe("persisted");
    });
  });
});
