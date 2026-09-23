/**
 * `tx.writeNodeUpsertBatch` writes node rows only: it has no `partOf` input
 * and no composition-edge shape. A required-existence part kind therefore
 * must be refused before the upsert CTE runs — otherwise a fresh insert
 * writes a live part with no whole, and the CTE's `ON CONFLICT … deleted_at =
 * NULL` arm resurrects a part the composition cascade tombstoned together
 * with its whole.
 *
 * PGlite is the in-process backend that implements `upsertHeterogeneousNodes`
 * (SQLite has no such command), so this is where the refusal is reachable.
 */
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import {
  createLocalPgliteBackend,
  type LocalPgliteBackendResult,
} from "../src/backend/postgres/pglite";
import { ConfigurationError } from "../src/errors";

const Album = defineNode("Album", { schema: z.object({}) });
const Track = defineNode("Track", { schema: z.object({ title: z.string() }) });
const trackOf = defineEdge("trackOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "heterogeneous-upsert-required-composition",
  nodes: {
    Album: { type: Album },
    Track: { type: Track },
  },
  edges: {
    trackOf: { type: trackOf, from: [Track], to: [Album], cardinality: "one" },
  },
  ontology: [partOf(Track, Album, { via: trackOf, existence: "required" })],
});

const opened: LocalPgliteBackendResult[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((local) => local.backend.close()));
});

async function openRecordedStore() {
  const local = await createLocalPgliteBackend({ vector: false });
  opened.push(local);
  const backend = createPostgresBackend(local.db, { vector: false });
  const [store] = await createAdapterStoreWithSchema(graph, backend, {
    history: true,
  });
  return { db: local.db, backend, store };
}

type RecordedStore = Awaited<ReturnType<typeof openRecordedStore>>;

async function recordedTrackRowCount(
  recorded: RecordedStore,
  id: string,
): Promise<number> {
  const result = await recorded.db.execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM typegraph_recorded_nodes WHERE graph_id = ${graph.id} AND kind = 'Track' AND id = ${id}`,
  );
  return result.rows[0]?.count ?? 0;
}

function upsertTrack(recorded: RecordedStore, id: string) {
  return recorded.db.transaction(async (pgTx) =>
    recorded.store.withRecordedTransaction(pgTx, async (tx) =>
      tx.writeNodeUpsertBatch([
        {
          kind: "Track",
          id: asNodeId<typeof Track>(id),
          props: { title: "upserted" },
        },
      ] as const),
    ),
  );
}

function isRequiredCompositionRefusal(error: unknown): boolean {
  return (
    error instanceof ConfigurationError &&
    error.details["code"] === "HETEROGENEOUS_NODE_BATCH_UNSUPPORTED_KIND" &&
    error.details["kind"] === "Track"
  );
}

describe("tx.writeNodeUpsertBatch refuses required-existence part kinds", () => {
  it("refuses a fresh insert of a required part, writing no row and no recorded row", async () => {
    const recorded = await openRecordedStore();

    await expect(upsertTrack(recorded, "fresh")).rejects.toSatisfy(
      (error: unknown) => isRequiredCompositionRefusal(error),
    );

    await expect(recordedTrackRowCount(recorded, "fresh")).resolves.toBe(0);
    await expect(
      recorded.backend.getNode(graph.id, "Track", "fresh"),
    ).resolves.toBeUndefined();
  });

  it("refuses to resurrect a part the composition cascade tombstoned, leaving it deleted", async () => {
    const recorded = await openRecordedStore();
    const album = await recorded.store.nodes.Album.create({});
    const track = await recorded.store.nodes.Track.create(
      { title: "original" },
      { id: "cascaded", partOf: { kind: "Album", id: album.id } },
    );
    await recorded.store.nodes.Album.delete(album.id);
    await expect(
      recorded.store.nodes.Track.getById(track.id),
    ).resolves.toBeUndefined();
    const tombstone = await recorded.backend.getNode(
      graph.id,
      "Track",
      "cascaded",
    );
    expect(tombstone?.deleted_at).toBeDefined();
    const recordedRowsBefore = await recordedTrackRowCount(
      recorded,
      "cascaded",
    );

    await expect(upsertTrack(recorded, "cascaded")).rejects.toSatisfy(
      (error: unknown) => isRequiredCompositionRefusal(error),
    );

    await expect(recordedTrackRowCount(recorded, "cascaded")).resolves.toBe(
      recordedRowsBefore,
    );
    await expect(
      recorded.store.nodes.Track.getById(track.id),
    ).resolves.toBeUndefined();
    await expect(
      recorded.backend.getNode(graph.id, "Track", "cascaded"),
    ).resolves.toEqual(tombstone);
  });
});
