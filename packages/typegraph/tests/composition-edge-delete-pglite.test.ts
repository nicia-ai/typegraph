/**
 * An edge bulk delete of a required-existence composition edge kind is
 * statically ineligible for the fused atomic `deleteEdges` command, on the ONE
 * backend configuration where that command is reachable at all — a PGlite ROOT
 * backend (see `node-delete-policy-root-atomic-bypass-pglite.test.ts`'s doc for
 * why SQLite and every transaction-scoped backend never reach it).
 *
 * The fused command is read-free, so it cannot ask whether the part a
 * composition edge holds is still live; only the portable path's per-member
 * `assertCompositionExistencePreserved` can. The optional-existence control
 * kind below proves the fused path is reachable here, so the required kind's
 * absence from the dispatch log is the decline, not an unreachable command.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionExistenceError,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { withAtomicMutationProgramDispatchObserver } from "../src/backend/capabilities/atomic-mutation-program";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createStoreWithSchema } from "../src/store";

const Episode = defineNode("Episode", { schema: z.object({}) });
const Segment = defineNode("Segment", { schema: z.object({}) });
const Collection = defineNode("Collection", { schema: z.object({}) });
const Tag = defineNode("Tag", { schema: z.object({}) });
const segmentOf = defineEdge("segmentOf", { schema: z.object({}) });
const tagOf = defineEdge("tagOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition-edge-delete-pglite-fused-ineligible",
  nodes: {
    Episode: { type: Episode },
    Segment: { type: Segment },
    Collection: { type: Collection },
    Tag: { type: Tag },
  },
  edges: {
    segmentOf: {
      type: segmentOf,
      from: [Segment],
      to: [Episode],
      cardinality: "one",
    },
    tagOf: { type: tagOf, from: [Tag], to: [Collection], cardinality: "one" },
  },
  ontology: [
    partOf(Segment, Episode, { via: segmentOf, existence: "required" }),
    partOf(Tag, Collection, { via: tagOf }),
  ],
});

describe("an edge bulkDelete of a required-existence composition edge kind on a PGlite root backend", () => {
  it("never dispatches the fused deleteEdges command, and refuses detaching a live part", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const episode = await store.nodes.Episode.create({});
      const segment = await store.nodes.Segment.create(
        {},
        { partOf: { whole: { kind: "Episode", id: episode.id } } },
      );
      const collection = await store.nodes.Collection.create({});
      await store.nodes.Tag.create(
        {},
        { partOf: { whole: { kind: "Collection", id: collection.id } } },
      );
      const segmentEdgeIds = async () => {
        const edges = await store.edges.segmentOf.find({});
        return edges.map((edge) => edge.id);
      };
      const segmentEdgesBefore = await segmentEdgeIds();
      const tagEdges = await store.edges.tagOf.find({});

      const dispatched: string[] = [];
      const refusal = await withAtomicMutationProgramDispatchObserver(
        backend,
        (variant) => dispatched.push(variant),
        async () => {
          await store.edges.tagOf.bulkDelete(tagEdges.map((edge) => edge.id));
          expect(dispatched).toEqual(["deleteEdges"]);
          return store.edges.segmentOf
            .bulkDelete(segmentEdgesBefore)
            .catch((error: unknown) => error);
        },
      );

      // MUTATION: drop the `compositionEdgeHasRequiredExistencePart` decline
      // from `resolveAtomicEdgeDeleteBatchExecutor` and a second
      // `deleteEdges` appears here, the delete resolves, and the segment is
      // left with no whole.
      expect(dispatched).toEqual(["deleteEdges"]);
      expect(refusal).toBeInstanceOf(CompositionExistenceError);
      expect((refusal as CompositionExistenceError).details).toMatchObject({
        situation: "detach",
        partId: segment.id,
      });
      expect(await segmentEdgeIds()).toEqual(segmentEdgesBefore);
      expect(await store.edges.tagOf.find({})).toEqual([]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    } finally {
      await local.backend.close();
    }
  });
});
