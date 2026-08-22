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
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, embedding } from "../../../src";
import { generatePostgresDDL } from "../../../src/backend/drizzle/ddl";
import { PGLITE_MAX_BIND_PARAMETERS } from "../../../src/backend/drizzle/execution/postgres-execution";
import {
  createPostgresTables,
  type PostgresTableNames,
} from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { sharesSerializedTransactionResource } from "../../../src/backend/transaction-resource";
import { type GraphBackend } from "../../../src/backend/types";
import { cloneWorkingCopyStrategy } from "../../../src/graph-merge/working-copy";
import {
  exportGraph,
  exportGraphStream,
  type GraphInterchangeChunk,
  importGraphStream,
  ImportOptionsSchema,
} from "../../../src/interchange";
import {
  createStore,
  createStoreWithSchema,
  type Store,
} from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";
import {
  createGate,
  type Gate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string().optional() }),
});
const peopleGraph = defineGraph({
  id: "pglite_people",
  nodes: { Person: { type: Person } },
  edges: {},
});
const peopleImportGraph = defineGraph({
  id: "pglite_people_import",
  nodes: { Person: { type: Person } },
  edges: {},
});
/** A SECOND import target on that one client, for the import/import pairing. */
const secondPeopleImportGraph = defineGraph({
  id: "pglite_people_import_2",
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

/**
 * Prefixed relations for the branch working copy, so its "fresh, empty"
 * backend can live on the SAME PGlite client as the base store — the exact
 * shape the cloner's serialized-resource recovery exists for.
 */
const CLONE_TABLE_NAMES = {
  nodes: "clone_nodes",
  edges: "clone_edges",
  recordedNodes: "clone_recorded_nodes",
  recordedEdges: "clone_recorded_edges",
  recordedClock: "clone_recorded_clock",
  revisionOrigins: "clone_revision_origins",
  identityAssertions: "clone_identity_assertions",
  recordedIdentityAssertions: "clone_recorded_identity_assertions",
  identityClosure: "clone_identity_closure",
  identitySeparation: "clone_identity_separation",
  uniques: "clone_node_uniques",
  edgeClaims: "clone_edge_claims",
  schemaVersions: "clone_schema_versions",
  fulltext: "clone_node_fulltext",
  indexMaterializations: "clone_index_materializations",
  contributionMaterializations: "clone_contribution_materializations",
  kindRemovals: "clone_kind_removals",
  reconciliationMarkers: "clone_reconciliation_markers",
  graphTemplates: "clone_graph_templates",
} as const satisfies PostgresTableNames;

/**
 * Fails a guard test that regressed into a wedge instead of a refusal. Every
 * scenario here pairs a snapshot export with a write through the SAME PGlite
 * connection: without the guard the two wait on each other, so an unbounded
 * await would hang the suite rather than report the regression.
 */
const GUARD_TIMEOUT_MS = 20_000;

async function withGuardTimeout<T>(work: Promise<T>): Promise<T> {
  const settled = await raceTimeout(work, GUARD_TIMEOUT_MS);
  if (settled === TIMEOUT_SENTINEL) {
    throw new Error(
      `Serialized-connection guard did not settle within ${GUARD_TIMEOUT_MS}ms: the export and the import are waiting on one connection.`,
    );
  }
  return settled;
}

/** A user wrapper around an export stream: it no longer identifies its source. */
async function* relayChunks(
  chunks: AsyncIterable<GraphInterchangeChunk>,
): AsyncIterable<GraphInterchangeChunk> {
  yield* chunks;
}

/** Replays already-collected chunks, so no export transaction is open. */
async function* replayChunks(
  chunks: readonly GraphInterchangeChunk[],
): AsyncIterable<GraphInterchangeChunk> {
  for (const chunk of chunks) {
    yield await Promise.resolve(chunk);
  }
}

/**
 * Replays already-collected chunks, parking the consumer between two of them:
 * `paused` opens once `pauseBefore` chunks have been delivered and the next one
 * is being asked for, and nothing more is delivered until `resume` opens.
 *
 * That is the deterministic mid-import moment — chunks committed, chunks still
 * to come, no export in sight — at which a snapshot export must be refused.
 */
async function* pausingChunks(
  chunks: readonly GraphInterchangeChunk[],
  pauseBefore: number,
  paused: Gate,
  resume: Gate,
): AsyncIterable<GraphInterchangeChunk> {
  let delivered = 0;
  for (const chunk of chunks) {
    if (delivered === pauseBefore) {
      paused.open();
      await resume.opened;
    }
    delivered++;
    yield chunk;
  }
}

/** Pulls an export stream to completion through the iterator already opened on it. */
async function drainIterator(
  iterator: AsyncIterator<GraphInterchangeChunk>,
): Promise<void> {
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) return;
  }
}

/** Collects an export stream, releasing its snapshot registration on completion. */
async function collectExportChunks(
  store: Store<typeof peopleGraph>,
): Promise<readonly GraphInterchangeChunk[]> {
  const chunks: GraphInterchangeChunk[] = [];
  for await (const chunk of exportGraphStream(store)) chunks.push(chunk);
  return chunks;
}

/**
 * A seeded source store and an import target that write through ONE PGlite
 * client — the pairing the serialized-connection import guard exists for.
 *
 * Two distinct `createPostgresBackend` wrappers over the same client, two graph
 * ids, and one seeded node so the export has a row to stream while its snapshot
 * transaction is open.
 */
async function seedSharedClientImportScenario(
  cleanups: (() => Promise<void>)[],
  options: Readonly<{ history?: boolean }> = {},
): Promise<
  Readonly<{
    /** Exposed so a test can add a THIRD wrapper on the same connection. */
    client: PGlite;
    source: Store<typeof peopleGraph>;
    target: Store<typeof peopleImportGraph>;
  }>
> {
  const client = await PGlite.create();
  cleanups.push(() => client.close());
  await client.exec(generatePostgresDDL().join("\n\n"));
  const sourceBackend = createPostgresBackend(drizzle(client), {
    vector: false,
  });
  const targetBackend = createPostgresBackend(drizzle(client), {
    vector: false,
  });
  const [source] = await createStoreWithSchema(peopleGraph, sourceBackend, {
    history: options.history ?? false,
  });
  const [target] = await createStoreWithSchema(
    peopleImportGraph,
    targetBackend,
  );
  await source.nodes.Person.create({ name: "Alice" });
  return { client, source, target };
}

/**
 * A seeded base store plus a factory for a fresh, EMPTY backend on the SAME
 * PGlite client — the working-copy shape the cloner's serialized-resource
 * recovery exists for. The clone gets its own relations so "empty" is true even
 * though the connection is shared.
 */
async function seedCloneScenario(
  history: boolean,
  cleanups: (() => Promise<void>)[],
): Promise<
  Readonly<{
    base: Store<typeof peopleGraph>;
    makeCloneBackend: () => Promise<GraphBackend>;
  }>
> {
  const client = await PGlite.create();
  cleanups.push(() => client.close());
  const cloneTables = createPostgresTables(CLONE_TABLE_NAMES);
  await client.exec(generatePostgresDDL().join("\n\n"));
  await client.exec(generatePostgresDDL(cloneTables).join("\n\n"));
  const baseBackend = createPostgresBackend(drizzle(client), { vector: false });
  const [base] = await createStoreWithSchema(peopleGraph, baseBackend, {
    history,
  });
  await base.nodes.Person.create({ name: "Alice" }, { id: "clone-alice" });
  await base.nodes.Person.create({ name: "Bob" }, { id: "clone-bob" });
  return {
    base,
    makeCloneBackend: () =>
      Promise.resolve(
        createPostgresBackend(drizzle(client), {
          vector: false,
          tables: cloneTables,
        }),
      ),
  };
}

async function expectClonedPeople(
  workingCopy: Store<typeof peopleGraph>,
): Promise<void> {
  const people = await workingCopy.nodes.Person.find();
  expect(
    [...people]
      .map((person) => person.id)
      .toSorted((left, right) => left.localeCompare(right)),
  ).toEqual(["clone-alice", "clone-bob"]);
}

const BatchNode = defineNode("BatchNode", {
  schema: z.object({ name: z.string() }),
});
const batchRelation = defineEdge("batchRelation", {
  schema: z.object({ index: z.number() }),
});
const batchGraph = defineGraph({
  id: "pglite_bind_budget",
  nodes: { BatchNode: { type: BatchNode } },
  edges: {
    batchRelation: {
      type: batchRelation,
      from: [BatchNode],
      to: [BatchNode],
    },
  },
});

describe("PGlite backend", () => {
  // Each test registers its own teardown; closing a backend from
  // createLocalPgliteBackend disposes its PGlite engine, while the bare-client
  // test closes the client directly.
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  describe("serialized transaction resource ownership", () => {
    it("recognizes Drizzle wrappers over the same PGlite client", async () => {
      const client = await PGlite.create();
      cleanups.push(() => client.close());

      const first = createPostgresBackend(drizzle(client), { vector: false });
      const second = createPostgresBackend(drizzle(client), { vector: false });

      expect(sharesSerializedTransactionResource(first, second)).toBe(true);
    });

    it("preserves ownership through the managed local-backend wrapper", async () => {
      const local = await createLocalPgliteBackend({ vector: false });
      cleanups.push(() => local.backend.close());
      const sibling = createPostgresBackend(local.db, { vector: false });

      expect(sharesSerializedTransactionResource(local.backend, sibling)).toBe(
        true,
      );
    });

    it("refuses snapshot import across wrappers sharing one PGlite client", async () => {
      const client = await PGlite.create();
      cleanups.push(() => client.close());
      await client.exec(generatePostgresDDL().join("\n\n"));
      const sourceBackend = createPostgresBackend(drizzle(client), {
        vector: false,
      });
      const targetBackend = createPostgresBackend(drizzle(client), {
        vector: false,
      });
      const [source] = await createStoreWithSchema(peopleGraph, sourceBackend);
      const [target] = await createStoreWithSchema(
        peopleImportGraph,
        targetBackend,
      );

      await expect(
        importGraphStream(
          target,
          exportGraphStream(source),
          ImportOptionsSchema.parse({ onConflict: "error" }),
        ),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: {
          code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT",
          graphId: peopleImportGraph.id,
        },
      });
    });

    it("refuses a snapshot import from a history-enabled store on that client", async () => {
      // A `history: true` store does not run on the backend it was handed: it
      // runs on an overlay over a PROJECTION of it. When the projection dropped
      // the serialized-resource mark, this pairing evaded the guard entirely
      // and the run wedged instead of being refused.
      const { source, target } = await seedSharedClientImportScenario(
        cleanups,
        {
          history: true,
        },
      );

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
          graphId: peopleImportGraph.id,
        },
      });
      expect(await target.nodes.Person.count()).toBe(0);
    });

    it("refuses a snapshot import through a wrapped export stream", async () => {
      // The pre-flight check reads the association between the chunk iterable
      // and its source backend, which any user wrapper erases. The export's
      // OPEN snapshot transaction is the durable fact, so the refusal still
      // lands — before this import writes anything.
      const { source, target } = await seedSharedClientImportScenario(cleanups);

      await expect(
        withGuardTimeout(
          importGraphStream(
            target,
            relayChunks(exportGraphStream(source)),
            ImportOptionsSchema.parse({ onConflict: "error" }),
          ),
        ),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: {
          code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT",
          graphId: peopleImportGraph.id,
        },
      });
      expect(await target.nodes.Person.count()).toBe(0);
    });

    it("refuses an export snapshot that opens between import chunks", async () => {
      // The registry used to be read ONCE, before the first chunk's write. An
      // export snapshot opening later in the stream was therefore invisible, and
      // the import's next chunk waited on a read transaction that could not end
      // until the import did. The import now holds a lease for its whole chunk
      // loop, so the EXPORT — the stream that started second — is refused, and
      // the import (whose earlier chunks are already committed) runs to
      // completion.
      const { source, target } = await seedSharedClientImportScenario(cleanups);
      const chunks = await collectExportChunks(source);
      expect(chunks.length).toBeGreaterThan(1);
      const paused = createGate();
      const resume = createGate();

      const importing = importGraphStream(
        target,
        // Parked after the header: the lease is held, the node chunk is still
        // to come.
        pausingChunks(chunks, 1, paused, resume),
        ImportOptionsSchema.parse({ onConflict: "error" }),
      );
      await paused.opened;

      await expect(withGuardTimeout(exportGraph(source))).rejects.toMatchObject(
        {
          name: "ConfigurationError",
          details: {
            code: "INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS",
            graphId: peopleGraph.id,
          },
        },
      );

      resume.open();
      expect(await withGuardTimeout(importing)).toMatchObject({
        success: true,
      });
      expect(await target.nodes.Person.count()).toBe(1);
    });

    it("refuses a second streaming import through one PGlite client", async () => {
      // Postgres does not reject a nested BEGIN the way SQLite does — it warns
      // and folds the statements into the transaction already in progress — so
      // two imports over this one connection lose their chunk boundaries
      // SILENTLY, and a chunk rollback takes the other import's committed work
      // with it. The lease is what turns that into a refusal.
      const { client, source, target } =
        await seedSharedClientImportScenario(cleanups);
      const secondTargetBackend = createPostgresBackend(drizzle(client), {
        vector: false,
      });
      const [secondTarget] = await createStoreWithSchema(
        secondPeopleImportGraph,
        secondTargetBackend,
      );
      const chunks = await collectExportChunks(source);
      const paused = createGate();
      const resume = createGate();

      const firstImport = importGraphStream(
        target,
        // Parked after the header: the lease is held, chunks are still to come.
        pausingChunks(chunks, 1, paused, resume),
        ImportOptionsSchema.parse({ onConflict: "error" }),
      );
      await paused.opened;

      await expect(
        withGuardTimeout(
          importGraphStream(
            secondTarget,
            replayChunks(chunks),
            ImportOptionsSchema.parse({ onConflict: "error" }),
          ),
        ),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        details: {
          code: "INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS",
          graphId: secondPeopleImportGraph.id,
          requested: "import-stream",
          heldBy: "import-stream",
        },
      });

      resume.open();
      expect(await withGuardTimeout(firstImport)).toMatchObject({
        success: true,
      });
      expect(await target.nodes.Person.count()).toBe(1);
      expect(await secondTarget.nodes.Person.count()).toBe(0);
    });

    it("refuses a second snapshot export from one PGlite client", async () => {
      // Two EXPORTS were the other pairing neither side checked for. Pulling the
      // header proves the first snapshot transaction is open — its producer is
      // inside that transaction and pushed the chunk from there.
      const { source, target } = await seedSharedClientImportScenario(cleanups);
      const stream = exportGraphStream(source)[Symbol.asyncIterator]();
      const header = await withGuardTimeout(stream.next());
      expect(header.done).toBe(false);

      await expect(withGuardTimeout(exportGraph(target))).rejects.toMatchObject(
        {
          name: "ConfigurationError",
          details: {
            code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT",
            graphId: peopleImportGraph.id,
            requested: "export-snapshot",
            heldBy: "export-snapshot",
          },
        },
      );

      // The refused export took nothing: the first one runs to completion, and
      // the connection is free for the next export once it does.
      await withGuardTimeout(drainIterator(stream));
      const reexported = await withGuardTimeout(exportGraph(source));
      expect(reexported.nodes).toHaveLength(1);
    });

    it("allows an export once the import's lease is released", async () => {
      // The refusal above must be scoped to a RUNNING import. A lease left
      // behind would refuse every later export on that connection.
      const { source, target } = await seedSharedClientImportScenario(cleanups);
      const chunks = await collectExportChunks(source);

      const result = await importGraphStream(
        target,
        replayChunks(chunks),
        ImportOptionsSchema.parse({ onConflict: "error" }),
      );
      expect(result.success).toBe(true);

      const exported = await withGuardTimeout(exportGraph(source));
      expect(exported.nodes.map((node) => node.properties["name"])).toEqual([
        "Alice",
      ]);
    });

    it("releases the export registration when the stream completes", async () => {
      // The refusal above must be scoped to an OPEN export. A finished export
      // that left its registration behind would refuse every later import into
      // the same connection.
      const { source, target } = await seedSharedClientImportScenario(cleanups);

      const chunks: GraphInterchangeChunk[] = [];
      for await (const chunk of exportGraphStream(source)) chunks.push(chunk);

      const result = await importGraphStream(
        target,
        replayChunks(chunks),
        ImportOptionsSchema.parse({ onConflict: "error" }),
      );

      expect(result.success).toBe(true);
      expect(await target.nodes.Person.count()).toBe(1);
    });
  });

  describe("branch working copy on one PGlite client", () => {
    // The clone strategy detects that its fresh backend writes through the
    // base store's connection and materializes the export instead of streaming
    // it. Nothing exercised that recovery, so streaming unconditionally used to
    // pass every test; here it is refused by the import guard and fails.
    it("clones a base store that shares its client with the fresh backend", async () => {
      const { base, makeCloneBackend } = await seedCloneScenario(
        false,
        cleanups,
      );

      const workingCopy = await withGuardTimeout(
        cloneWorkingCopyStrategy<typeof peopleGraph>(() =>
          makeCloneBackend(),
        ).create(base),
      );

      await expectClonedPeople(workingCopy);
    });

    it("clones a history-enabled base store on that shared client", async () => {
      const { base, makeCloneBackend } = await seedCloneScenario(
        true,
        cleanups,
      );

      const workingCopy = await withGuardTimeout(
        cloneWorkingCopyStrategy<typeof peopleGraph>(() =>
          makeCloneBackend(),
        ).create(base),
      );

      await expectClonedPeople(workingCopy);
    });
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
      expect(requireDefined(fetched).name).toBe("Alice");
    });

    it("chunks live edge inserts below PGlite's bind limit", async () => {
      const { backend, client } = await createLocalPgliteBackend({
        vector: false,
      });
      cleanups.push(() => backend.close());
      expect(backend.capabilities.maxBindParameters).toBe(
        PGLITE_MAX_BIND_PARAMETERS,
      );
      const store = createStore(batchGraph, backend);
      const from = await store.nodes.BatchNode.create({ name: "from" });
      const to = await store.nodes.BatchNode.create({ name: "to" });

      const created = await store.edges.batchRelation.bulkCreate(
        Array.from({ length: 2979 }, (_, index) => ({
          from,
          props: { index },
          to,
        })),
      );

      expect(created).toHaveLength(2979);
      expect(await store.edges.batchRelation.count()).toBe(2979);
      await expect(client.query("SELECT 1 AS value")).resolves.toMatchObject({
        rows: [{ value: 1 }],
      });
    });

    it("chunks recorded edge inserts below PGlite's bind limit", async () => {
      const { backend, client } = await createLocalPgliteBackend({
        vector: false,
      });
      cleanups.push(() => backend.close());
      const store = createStore(batchGraph, backend, { history: true });
      const from = await store.nodes.BatchNode.create({ name: "from" });
      const to = await store.nodes.BatchNode.create({ name: "to" });

      const created = await store.edges.batchRelation.bulkCreate(
        Array.from({ length: 2048 }, (_, index) => ({
          from,
          props: { index },
          to,
        })),
      );

      expect(created).toHaveLength(2048);
      expect(await store.edges.batchRelation.count()).toBe(2048);
      expect(await store.recordedNow()).toBeDefined();
      await expect(client.query("SELECT 1 AS value")).resolves.toMatchObject({
        rows: [{ value: 1 }],
      });
    });
  });

  describe("createLocalPgliteBackend()", () => {
    it("closes the PGlite client when provisioning fails", async () => {
      const provisioningError = new Error("migration failed");
      const close = vi.fn(() => Promise.resolve());
      const client = {
        close,
        exec: () => Promise.reject(provisioningError),
      } as unknown as PGlite;
      const createSpy = vi.spyOn(PGlite, "create").mockResolvedValue(client);

      try {
        await expect(
          createLocalPgliteBackend({
            vector: false,
          }),
        ).rejects.toBe(provisioningError);
        expect(close).toHaveBeenCalledOnce();
      } finally {
        createSpy.mockRestore();
      }
    });

    it("advertises pgvector and runs a vector search end to end", async () => {
      const { backend } = await createLocalPgliteBackend();
      cleanups.push(() => backend.close());
      expect(backend.capabilities.vector?.supported).toBe(true);
      expect(backend.capabilities.graphAnalytics).toEqual({
        supported: true,
        mathFunctions: true,
      });

      const [store] = await createStoreWithSchema(documentsGraph, backend);
      await store.nodes.Doc.create({ title: "near", embedding: [1, 0, 0, 0] });
      await store.nodes.Doc.create({ title: "far", embedding: [0, 0, 0, 1] });

      const hits = await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        limit: 2,
        metric: "cosine",
      });

      expect(hits).toHaveLength(2);
      expect(requireDefined(hits[0]).node.title).toBe("near");
      expect(requireDefined(hits[0]).score).toBeGreaterThan(
        requireDefined(hits[1]).score,
      );
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

      const [store] = await createStoreWithSchema(documentsGraph, backend);
      await store.nodes.Doc.create({ title: "only", embedding: [0, 1, 0, 0] });
      const hits = await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [0, 1, 0, 0],
        limit: 1,
        metric: "cosine",
      });
      expect(requireDefined(hits[0]).node.title).toBe("only");
    });

    it("persists data (and embeddings) to an on-disk dataDir across reopen", async () => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "typegraph-pglite-"));
      cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

      // Session 1: write a node + embedding, then close to flush to disk.
      // createStoreWithSchema provisions the per-field vector table + marker
      // (both persist to the dataDir for session 2 to assert against).
      const first = await createLocalPgliteBackend({ dataDir });
      const [firstStore] = await createStoreWithSchema(
        documentsGraph,
        first.backend,
      );
      const created = await firstStore.nodes.Doc.create({
        title: "persisted",
        embedding: [1, 0, 0, 0],
      });
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
      expect(requireDefined(hits[0]).node.title).toBe("persisted");
    });
  });
});
