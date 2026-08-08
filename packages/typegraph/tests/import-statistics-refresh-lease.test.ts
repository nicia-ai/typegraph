/**
 * A streaming import's trailing statistics refresh is a WRITE, and every write
 * an import makes runs under the target connection's exclusive stream lease.
 *
 * `importGraphStream` used to release the lease as soon as its chunk loop
 * ended, then run `store.refreshStatistics()` — a real ANALYZE — outside every
 * guard. On a serialized connection an export snapshot opening in that window
 * takes the one connection ANALYZE has to run on and holds it for the whole
 * export, so the refresh waits (or errors) on a connection that will not free
 * up; and because the refresh is best-effort, the outcome was swallowed as a
 * console warning. `importGraph` never had that hole — `withImportStreamLease`
 * covers its whole call, refresh included — so this was also a divergence
 * between the two import surfaces.
 *
 * The invariant, stated at full strength: from the moment `importGraphStream`
 * claims the lease, no write it performs happens outside it, and the release
 * happens on every exit — normal, missing-header, and chunk-failure alike.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { acquireSerializedStreamLease } from "../src/backend/transaction-resource";
import { type GraphBackend } from "../src/backend/types";
import {
  exportGraphStream,
  type GraphInterchangeChunk,
  importGraphStream,
  ImportOptionsSchema,
} from "../src/interchange";
import { createStore } from "../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const sourceGraph = defineGraph({
  id: "refresh_lease_source",
  nodes: { Person: { type: Person } },
  edges: {},
});

/** The import target, on the SAME connection as the source. */
const targetGraph = defineGraph({
  id: "refresh_lease_target",
  nodes: { Person: { type: Person } },
  edges: {},
});

const importOptions = ImportOptionsSchema.parse({ onConflict: "error" });

/**
 * Whether the connection's one interchange-stream lease is free right now.
 * Asked by claiming and giving straight back: the lease deliberately offers no
 * way to look without claiming.
 */
function streamLeaseIsFree(backend: GraphBackend): boolean {
  const lease = acquireSerializedStreamLease(backend, "export-snapshot");
  if (!lease.acquired) return false;
  lease.release();
  return true;
}

async function* replayChunks(
  chunks: readonly GraphInterchangeChunk[],
): AsyncIterable<GraphInterchangeChunk> {
  for (const chunk of chunks) yield await Promise.resolve(chunk);
}

async function collectChunks(
  chunks: AsyncIterable<GraphInterchangeChunk>,
): Promise<GraphInterchangeChunk[]> {
  const collected: GraphInterchangeChunk[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return collected;
}

describe("Streaming import statistics refresh", () => {
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) database.close();
  });

  function openMigratedDatabase(): Database.Database {
    const database = new Database(":memory:");
    openDatabases.push(database);
    for (const statement of generateSqliteDDL()) database.exec(statement);
    return database;
  }

  async function seed(): Promise<{
    targetBackend: GraphBackend;
    target: ReturnType<typeof createStore<typeof targetGraph>>;
    chunks: GraphInterchangeChunk[];
  }> {
    const database = openMigratedDatabase();
    const sourceBackend = createSqliteBackend(drizzle(database));
    const targetBackend = createSqliteBackend(drizzle(database));
    const source = createStore(sourceGraph, sourceBackend);
    const target = createStore(targetGraph, targetBackend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "refresh-a" });
    await source.nodes.Person.create({ name: "Bob" }, { id: "refresh-b" });
    // Collected first, so the import replays them with no export transaction
    // open — the lease state observed below is the import's own.
    const chunks = await collectChunks(exportGraphStream(source));
    return { targetBackend, target, chunks };
  }

  it("runs the trailing refresh while still holding the connection's lease", async () => {
    // The load-bearing observation: ask, from INSIDE the refresh, whether the
    // connection is spoken for. A refresh that runs after the release answers
    // "free" — and a free connection is exactly the window an export snapshot
    // walks into.
    const { targetBackend, target, chunks } = await seed();
    const leaseFreeDuringRefresh: boolean[] = [];
    const realRefresh = target.refreshStatistics.bind(target);
    vi.spyOn(target, "refreshStatistics").mockImplementation(async () => {
      leaseFreeDuringRefresh.push(streamLeaseIsFree(targetBackend));
      return realRefresh();
    });

    const imported = await importGraphStream(
      target,
      replayChunks(chunks),
      importOptions,
    );

    expect(imported.success).toBe(true);
    // The refresh ran exactly once, and the connection was still this import's
    // while it did.
    expect(leaseFreeDuringRefresh).toEqual([false]);
    // ...and the lease is given back afterwards, so the next stream is free to
    // start.
    expect(streamLeaseIsFree(targetBackend)).toBe(true);
    expect(await target.nodes.Person.count()).toBe(2);
  });

  it("releases the lease when the stream violates the chunk order", async () => {
    // The refresh now lives inside the try block, so the release has to happen
    // on the throwing exits too — otherwise closing this hole would open a
    // permanent one. A headerless first chunk is the earliest such exit that
    // still gets past the claim: the lease is taken for every chunk BEFORE the
    // chunk is inspected.
    const { targetBackend, target, chunks } = await seed();
    const withoutHeader = chunks.filter((chunk) => chunk.type !== "header");
    expect(withoutHeader.length).toBeGreaterThan(0);

    await expect(
      importGraphStream(target, replayChunks(withoutHeader), importOptions),
    ).rejects.toThrow("must start with a header");

    expect(streamLeaseIsFree(targetBackend)).toBe(true);
  });

  it("releases the lease when a chunk reports import errors", async () => {
    // The other throwing exit: `onStreamChunkError: "abort"` throws out of the
    // chunk loop with the lease held.
    const { targetBackend, target, chunks } = await seed();
    await target.nodes.Person.create({ name: "Clash" }, { id: "refresh-a" });

    await expect(
      importGraphStream(target, replayChunks(chunks), importOptions),
    ).rejects.toThrow("stream aborted after a chunk reported import errors");

    expect(streamLeaseIsFree(targetBackend)).toBe(true);
  });
});
