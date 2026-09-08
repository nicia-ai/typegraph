/**
 * The composition cascade's fused-delete ineligibility, on the ONE backend
 * configuration where the fused atomic `deleteNodes` command is reachable at
 * all — a PGlite ROOT backend (see
 * `node-delete-policy-root-atomic-bypass-pglite.test.ts`'s doc for why SQLite
 * and every transaction-scoped backend never reach it, so a
 * SQLite-only suite could never exercise this).
 *
 * `Podcast` here is deliberately atomic-eligible on every OTHER axis — no
 * uniques, no identity, no searchable/embedding fields, `onDelete: "restrict"`
 * — so the ONLY thing standing between it and the fused command is
 * `resolveAtomicNodeDeleteBatchExecutor`'s composition check
 * (`atomic-mutation-program.ts`). Without that check this delete would be a
 * single read-free SQL statement with no notion of a parts closure, and
 * `Episode` would survive an ostensibly-cascading Podcast delete.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, partOf } from "../src";
import { withAtomicMutationProgramDispatchObserver } from "../src/backend/capabilities/atomic-mutation-program";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createStoreWithSchema } from "../src/store";
import { STORE_RUNTIME } from "../src/store/runtime-port";

const Podcast = defineNode("Podcast", { schema: z.object({}) });
const Episode = defineNode("Episode", { schema: z.object({}) });
const episodeOf = defineEdge("episodeOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition-cascade-pglite-fused-ineligible",
  nodes: {
    Podcast: { type: Podcast, onDelete: "restrict" },
    Episode: { type: Episode },
  },
  edges: {
    episodeOf: {
      type: episodeOf,
      from: [Episode],
      to: [Podcast],
      cardinality: "one",
    },
  },
  ontology: [partOf(Episode, Podcast, { via: episodeOf })],
});

describe("composition whole delete is statically ineligible for the fused atomic path", () => {
  it("never dispatches the fused deleteNodes command, and still cascades to Episode", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const podcast = await store.nodes.Podcast.create({});
      const episode = await store.nodes.Episode.create({});
      await store.edges.episodeOf.create(episode, podcast, {});

      const dispatched: string[] = [];
      await withAtomicMutationProgramDispatchObserver(
        backend,
        (variant) => dispatched.push(variant),
        () =>
          store[STORE_RUNTIME].deleteNodeWithPolicy(backend, {
            kind: "Podcast",
            id: podcast.id,
          }),
      );

      // MUTATION: remove the `compositionEdgeKindsUnder` guard from
      // `resolveAtomicNodeDeleteBatchExecutor` and `deleteNodes` appears
      // here — a single read-free statement that cannot cascade, after
      // which the assertion below (Episode survives) also flips.
      expect(dispatched).not.toContain("deleteNodes");
      await expect(
        store.nodes.Podcast.getById(podcast.id),
      ).resolves.toBeUndefined();
      await expect(
        store.nodes.Episode.getById(episode.id),
      ).resolves.toBeUndefined();
    } finally {
      await local.backend.close();
    }
  });
});
