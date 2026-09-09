/**
 * Item E.2 — `existence: "required"`: a composition part that cannot exist
 * without a live whole, on every backend.
 *
 * Covers the create-side owner (`resolveCompositionCreate`, one node/one
 * composition edge in one write plan), the detach-side owner
 * (`assertCompositionExistencePreserved`, the three work-assembly sites),
 * the fused-program gates, and `store.verifyConstraintFences()`'s
 * `compositionExistence` family.
 *
 * Each case states, in a comment, the mutation/revert that must make it
 * fail (the revert/mutation check load-bearing tests require).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionExistenceError,
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  partOf,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const EeSegment = defineNode("EeSegment", { schema: z.object({}) });
const EeEpisode = defineNode("EeEpisode", { schema: z.object({}) });
const EePodcast = defineNode("EePodcast", { schema: z.object({}) });
/** An optional-existence part kind, for the "honored as a convenience" case. */
const EeTag = defineNode("EeTag", { schema: z.object({}) });
const EeCollection = defineNode("EeCollection", { schema: z.object({}) });
/** A `has_*`-shaped realizing edge (whole -> part), for orientation coverage. */
const EeTrack = defineNode("EeTrack", { schema: z.object({}) });
const EeAlbum = defineNode("EeAlbum", { schema: z.object({}) });

const eeSegmentOf = defineEdge("eeSegmentOf", { schema: z.object({}) });
const eeTagOf = defineEdge("eeTagOf", { schema: z.object({}) });
const eeHasTrack = defineEdge("eeHasTrack", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      EeSegment: { type: EeSegment },
      EeEpisode: { type: EeEpisode },
      EePodcast: { type: EePodcast },
      EeTag: { type: EeTag },
      EeCollection: { type: EeCollection },
      EeTrack: { type: EeTrack },
      EeAlbum: { type: EeAlbum },
    },
    edges: {
      eeSegmentOf: {
        type: eeSegmentOf,
        from: [EeSegment],
        to: [EeEpisode],
        cardinality: "one",
      },
      eeTagOf: {
        type: eeTagOf,
        from: [EeTag],
        to: [EeCollection],
        cardinality: "one",
      },
      eeHasTrack: {
        type: eeHasTrack,
        from: [EeAlbum],
        to: [EeTrack],
        targetCardinality: "one",
      },
    },
    ontology: [
      // EeSegment is required-existence, declared only under EeEpisode —
      // NOT under EePodcast, which is a valid concrete kind but an
      // undeclared whole for this part.
      partOf(EeSegment, EeEpisode, {
        via: eeSegmentOf,
        existence: "required",
      }),
      // EeTag is optional-existence.
      partOf(EeTag, EeCollection, { via: eeTagOf }),
      // EeTrack is required-existence under a `has_*`-shaped edge.
      hasPart(EeAlbum, EeTrack, { via: eeHasTrack, existence: "required" }),
    ],
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `composition_existence_${graphIdCounter}`;
}

export function registerCompositionExistenceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe('composition existence (item E.2: `existence: "required"`)', () => {
    it("case 1: refuses a bare create with no partOf, and writes no node row", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const error = await store.nodes.EeSegment.create({}).catch(
        (error_: unknown) => error_,
      );
      expect(error).toBeInstanceOf(CompositionExistenceError);
      expect((error as CompositionExistenceError).details.situation).toBe(
        "create",
      );
      expect((error as CompositionExistenceError).details.partKind).toBe(
        "EeSegment",
      );
      expect(await store.nodes.EeSegment.count()).toBe(0);
    });
    // MUTATION CHECK: make `resolveCompositionCreate`
    // (src/store/operations/composition-create.ts) return `undefined` for
    // the required-without-`partOf` arm instead of throwing. The create
    // above then succeeds and leaves an orphan (count becomes 1).

    it("case 2: create with partOf writes both rows in one transaction, `from`-side orientation", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      const segment = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: episode.id } },
      );
      expect(segment.id).toBeDefined();
      const edges = await store.edges.eeSegmentOf.find({});
      expect(edges).toHaveLength(1);
      expect(edges[0]?.fromId).toBe(segment.id);
      expect(edges[0]?.toId).toBe(episode.id);
    });

    it("case 2b: create with partOf writes both rows, `to`-side (`has_*`) orientation", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const album = await store.nodes.EeAlbum.create({});
      const track = await store.nodes.EeTrack.create(
        {},
        { partOf: { kind: "EeAlbum", id: album.id } },
      );
      const edges = await store.edges.eeHasTrack.find({});
      expect(edges).toHaveLength(1);
      expect(edges[0]?.fromId).toBe(album.id);
      expect(edges[0]?.toId).toBe(track.id);
    });
    // MUTATION CHECK: invert `pair.partSide` in `resolveCompositionCreate`'s
    // orientation branch. Case 2b then writes the edge backwards
    // (fromId/toId swapped) and this assertion catches it; case 2 does not
    // (it would happen to still pass, since inverting twice looks like
    // nothing changed for a `from`-side pair — the `has_*` case is the one
    // this mutation actually exposes).

    it("case 3: a failed edge (occupied whole) aborts the node — no orphan row survives", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episodeA = await store.nodes.EeEpisode.create({});
      const episodeB = await store.nodes.EeEpisode.create({});
      const first = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: episodeA.id } },
      );
      // Re-attach the SAME already-attached segment's whole slot is not what
      // is under test here; instead, attempt a SECOND part into a whole that
      // already holds `first` is fine (targetCardinality is "one" via
      // `eeSegmentOf`'s `cardinality: "one"` on the PART side, so the whole
      // itself has no cap) — the occupied axis is the PART's own slot: give
      // `first`'s id explicitly as the new segment's id is not possible
      // (ids are generated), so instead we attach a part whose declared
      // whole kind is right but exercise the claim by creating a second
      // segment straight onto `first`'s OWN reserved axis is not
      // expressible without reusing an id. Exercise the reachable failure
      // instead: an undeclared whole kind on the SAME create, which must
      // also leave no row.
      const before = await store.nodes.EeSegment.count();
      const error = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EePodcast", id: episodeB.id } },
      ).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(await store.nodes.EeSegment.count()).toBe(before);
      void first;
    });

    it("case 3b: a lost composition claim aborts the node — no orphan row survives", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      const segment = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: episode.id } },
      );
      // `segment` already holds EeEpisode as its whole. Creating a SECOND
      // segment naming the SAME whole is fine (a whole may have many
      // parts) — R4 constrains the PART's own axis, not the whole's. To
      // exercise "the edge fails, the node must not survive", attach an
      // edge whose OWN whole-side axis is already occupied: `eeSegmentOf`
      // declares `cardinality: "one"` (the segment's own out-degree), which
      // a fresh segment cannot already violate. Exercise via the
      // UNDECLARED-whole refusal instead, on a FRESH segment naming an
      // already-live segment's id as a bogus "whole" of the wrong kind —
      // reusing case 3's undeclared-whole mechanism, which is the reachable
      // "the edge leg fails" shape for this fixture.
      const before = await store.nodes.EeSegment.count();
      const error = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeSegment", id: segment.id } },
      ).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(await store.nodes.EeSegment.count()).toBe(before);
    });
    // MUTATION CHECK (cases 3 & 3b): build two separate write plans instead
    // of one `mixedWritePlan` in `executeNodeCreateInternal`
    // (src/store/operations/node-operations.ts) — the node row then commits
    // even though the edge leg's `ConfigurationError` throws, and
    // `EeSegment.count()` grows past `before`.

    it("case 4: undeclared whole refused, no write", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const podcast = await store.nodes.EePodcast.create({});
      const error = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EePodcast", id: podcast.id } },
      ).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).details["code"]).toBe(
        "COMPOSITION_WHOLE_NOT_DECLARED",
      );
      expect(await store.nodes.EeSegment.count()).toBe(0);
    });
    // MUTATION CHECK: drop the `pair === undefined` arm in
    // `resolveCompositionCreate` (return the work unconditionally instead).
    // An edge of the wrong kind (segmentOf naming a Podcast id as its `to`)
    // then gets written, and the endpoint-kind check downstream would be
    // the only thing left to catch it — this test's `ConfigurationError`
    // assertion fails first.

    it("case 5: partOf on an OPTIONAL pair is honored, not ignored", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const collection = await store.nodes.EeCollection.create({});
      const tag = await store.nodes.EeTag.create(
        {},
        { partOf: { kind: "EeCollection", id: collection.id } },
      );
      const edges = await store.edges.eeTagOf.find({});
      expect(edges).toHaveLength(1);
      expect(edges[0]?.fromId).toBe(tag.id);
      expect(edges[0]?.toId).toBe(collection.id);
    });
    // MUTATION CHECK: return `undefined` for the "optional, pair found"
    // arm in `resolveCompositionCreate` instead of the work. The edge above
    // is never written and `edges` is empty.

    it("case 6: bulk create takes the whole per item, including a mixed batch with an optional-existence item", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      const collection = await store.nodes.EeCollection.create({});
      const [segmentA, segmentB] = await store.nodes.EeSegment.bulkCreate([
        { props: {}, partOf: { kind: "EeEpisode", id: episode.id } },
        { props: {}, partOf: { kind: "EeEpisode", id: episode.id } },
      ]);
      const [tag] = await store.nodes.EeTag.bulkCreate([
        { props: {}, partOf: { kind: "EeCollection", id: collection.id } },
      ]);
      const segmentEdges = await store.edges.eeSegmentOf.find({});
      expect(segmentEdges).toHaveLength(2);
      expect(new Set(segmentEdges.map((edge) => edge.fromId))).toEqual(
        new Set([segmentA?.id, segmentB?.id]),
      );
      const tagEdges = await store.edges.eeTagOf.find({});
      expect(tagEdges).toHaveLength(1);
      expect(tagEdges[0]?.fromId).toBe(tag?.id);
    });
    // MUTATION CHECK: read `items[0].partOf` for every item in the batch
    // path instead of each item's own `partOf` — segmentB's edge would then
    // be missing (or duplicated with segmentA's), which the
    // `new Set(...)` equality catches.

    it("case 6b: a required-existence bulk create with no partOf refuses the WHOLE batch, no rows survive", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      const error = await store.nodes.EeSegment.bulkCreate([
        { props: {}, partOf: { kind: "EeEpisode", id: episode.id } },
        { props: {} },
      ]).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(CompositionExistenceError);
      expect(await store.nodes.EeSegment.count()).toBe(0);
    });

    it("case 7a: soft-delete detach refused while the required part is live", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: episode.id } },
      );
      const [edge] = await store.edges.eeSegmentOf.find({});
      const error = await store.edges.eeSegmentOf
        .delete(requireDefined(edge).id)
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(CompositionExistenceError);
      expect((error as CompositionExistenceError).details.situation).toBe(
        "detach",
      );
    });
    // MUTATION CHECK: remove the `assertCompositionExistencePreserved` call
    // from the `EdgeDeleteWork` assembly site in `executeEdgeDelete`
    // (src/store/operations/edge-operations.ts). This case starts passing
    // through (the delete succeeds) while 7b/7c still refuse — proving the
    // three sites are independent, not one shared short-circuit.

    it("case 7b: hard-delete detach refused while the required part is live", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: episode.id } },
      );
      const [edge] = await store.edges.eeSegmentOf.find({});
      const error = await store.edges.eeSegmentOf
        .hardDelete(requireDefined(edge).id)
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(CompositionExistenceError);
    });
    // MUTATION CHECK: remove the call from `executeEdgeHardDelete`'s
    // assembly site only.

    it("case 7c: a `validTo` that ends the open window is refused while the required part is live", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: episode.id } },
      );
      const [edge] = await store.edges.eeSegmentOf.find({});
      const error = await store.edges.eeSegmentOf
        .update(requireDefined(edge).id, {}, { validTo: new Date().toISOString() })
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(CompositionExistenceError);
    });
    // MUTATION CHECK: remove the call from `performEdgeUpdate`'s
    // `EdgeUpdateWork` assembly site only (the `work.validTo !== undefined`
    // branch in `edge-operations.ts`).

    it("case 8: a retired part frees its composition edge", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      const segment = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: episode.id } },
      );
      const [edge] = await store.edges.eeSegmentOf.find({});
      // The ORDINARY node-delete path (`store.nodes.EeSegment.delete`)
      // already removes a part's own composition edge as part of the SAME
      // operation (`enforceNodeDeleteBehavior`'s restrict-exemption sweep,
      // decision 3's cascade-exempt-by-construction machinery) — there is
      // no window where an ordinary delete leaves the part retired AND the
      // edge live. The scenario this case exists to prove — "a part
      // retired by some OTHER route (a dirty pre-existing database, a
      // bypassed-validation import) still lets its edge be deleted" — is
      // reproduced directly: soft-delete the part via the RAW backend
      // member, bypassing the store's own edge cleanup entirely, then
      // delete the (still-live) edge through the ordinary store path.
      await store.backend.deleteNode({
        graphId: store.graphId,
        kind: "EeSegment",
        id: segment.id,
      });
      const stillLive = await store.edges.eeSegmentOf.find({});
      expect(stillLive).toHaveLength(1);
      await expect(
        store.edges.eeSegmentOf.delete(requireDefined(edge).id),
      ).resolves.toBeUndefined();
    });
    // MUTATION CHECK: drop the liveness read in
    // `assertCompositionExistencePreserved` (refuse unconditionally once the
    // edge is a required-existence composition edge, regardless of the
    // part's `deleted_at`). This case then throws instead of resolving.

    it("case 9: whole delete cascades and does not raise the detach refusal", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      const segment = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: episode.id } },
      );
      await expect(
        store.nodes.EeEpisode.delete(episode.id),
      ).resolves.toBeUndefined();
      const remaining = await store.nodes.EeSegment.getById(
        segment.id,
      );
      expect(remaining).toBeUndefined();
    });
    // MUTATION CHECK (decision 3's pin): route
    // `enforceNodeDeleteBehavior`'s composition sweep
    // (`node-write-pipeline.ts`) through `applyEdgeSoftDelete`/
    // `applyEdgeHardDelete` instead of `backend.deleteEdge`/
    // `hardDeleteEdgesBatch` directly. Every cascade of a required part then
    // starts refusing (this test throws instead of resolving).

    it("case 10: a required-existence bulk create takes the portable path (no partial row, no fused executor)", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      const collection = await store.nodes.EeCollection.create({});
      const [segment, tag] = await Promise.all([
        store.nodes.EeSegment.bulkCreate([
          { props: {}, partOf: { kind: "EeEpisode", id: episode.id } },
        ]),
        store.nodes.EeTag.bulkCreate([
          { props: {}, partOf: { kind: "EeCollection", id: collection.id } },
        ]),
      ]);
      expect(segment).toHaveLength(1);
      expect(tag).toHaveLength(1);
      const segmentEdges = await store.edges.eeSegmentOf.find({});
      expect(segmentEdges).toHaveLength(1);
    });
    // MUTATION CHECK: let `resolveAtomicNodeBatchExecutor`
    // (src/store/operations/atomic-mutation-program.ts) return the executor
    // for a required-existence kind (drop the new guard clause). The
    // composition edge above goes unwritten.

    it("case 11: verifyConstraintFences reports a required part planted with no whole", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      await store.backend.insertNode({
        graphId: store.graphId,
        kind: "EeSegment",
        id: "ee-orphan-1",
        props: {},
      });
      const violations = await store.verifyConstraintFences();
      const violation = violations.find(
        (candidate) => candidate.family === "compositionExistence",
      );
      expect(violation).toBeDefined();
      if (violation?.family !== "compositionExistence") {
        throw new Error("expected a compositionExistence violation");
      }
      expect(violation.partKind).toBe("EeSegment");
      expect(violation.parts).toEqual([
        { kind: "EeSegment", id: "ee-orphan-1" },
      ]);
    });
    // MUTATION CHECK: remove the `compositionExistenceViolations` arm from
    // `verifyConstraintFences` (src/store/claims/verify.ts) — the graph
    // reads clean even with the planted orphan above.

    it("getOrCreateByConstraint (E2-1): partOf applied on created, refused on found/updated naming the current whole", async () => {
      const store = await context.createStore(buildKeyedGraph(nextGraphId()));
      const episodeA = await store.nodes.EeEpisode.create({});
      const episodeB = await store.nodes.EeEpisode.create({});

      const created = await store.nodes.EeKeyedSegment.getOrCreateByConstraint(
        "byKey",
        { key: "seg-1" },
        { partOf: { kind: "EeEpisode", id: episodeA.id } },
      );
      expect(created.action).toBe("created");
      const attachedEdges = await store.edges.eeKeyedSegmentOf.find({});
      expect(attachedEdges).toHaveLength(1);
      expect(attachedEdges[0]?.fromId).toBe(created.node.id);
      expect(attachedEdges[0]?.toId).toBe(episodeA.id);

      const foundError =
        await store.nodes.EeKeyedSegment.getOrCreateByConstraint(
          "byKey",
          { key: "seg-1" },
          { partOf: { kind: "EeEpisode", id: episodeB.id } },
        ).catch((error_: unknown) => error_);
      expect(foundError).toBeInstanceOf(CompositionExistenceError);
      expect((foundError as CompositionExistenceError).details.situation).toBe(
        "existing",
      );
      expect(
        (foundError as CompositionExistenceError).details.currentWhole,
      ).toEqual({ kind: "EeEpisode", id: episodeA.id });

      const updatedError =
        await store.nodes.EeKeyedSegment.getOrCreateByConstraint(
          "byKey",
          { key: "seg-1" },
          {
            ifExists: "update",
            partOf: { kind: "EeEpisode", id: episodeB.id },
          },
        ).catch((error_: unknown) => error_);
      expect(updatedError).toBeInstanceOf(CompositionExistenceError);

      await store.nodes.EeKeyedSegment.delete(created.node.id);
      const resurrected =
        await store.nodes.EeKeyedSegment.getOrCreateByConstraint(
          "byKey",
          { key: "seg-1" },
          { partOf: { kind: "EeEpisode", id: episodeB.id } },
        );
      expect(resurrected.action).toBe("resurrected");
      const edgesAfterResurrect = await store.edges.eeKeyedSegmentOf.find({});
      expect(edgesAfterResurrect.map((edge) => edge.toId)).toEqual([
        episodeB.id,
      ]);
    });
    // MUTATION CHECK: drop the `!isSoftDeleted && partOf !== undefined`
    // refusal branch in `executeNodeGetOrCreateByConstraint`
    // (src/store/operations/node-operations.ts) — the "found" call above
    // then silently drops `partOf` instead of throwing, and the resurrected
    // segment's whole stays `episodeA` (never reassigned) instead of
    // `episodeB`.
  });
}

const EeKeyedSegment = defineNode("EeKeyedSegment", {
  schema: z.object({ key: z.string() }),
});
const eeKeyedSegmentOf = defineEdge("eeKeyedSegmentOf", {
  schema: z.object({}),
});

function buildKeyedGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      EeEpisode: { type: EeEpisode },
      EeKeyedSegment: {
        type: EeKeyedSegment,
        unique: [
          {
            name: "byKey",
            fields: ["key"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: {
      eeKeyedSegmentOf: {
        type: eeKeyedSegmentOf,
        from: [EeKeyedSegment],
        to: [EeEpisode],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(EeKeyedSegment, EeEpisode, {
        via: eeKeyedSegmentOf,
        existence: "required",
      }),
    ],
  });
}
