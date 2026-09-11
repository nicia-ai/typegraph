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
  asEdgeId,
  CompositionExistenceError,
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  EdgeAcyclicityError,
  EndpointNotFoundError,
  hasPart,
  partOf,
  subClassOf,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const EeSegment = defineNode("EeSegment", { schema: z.object({}) });
/** A SUBCLASS of a required-existence part kind, never declared as its own composition pair (subclass existence inheritance). */
const EeSubSegment = defineNode("EeSubSegment", { schema: z.object({}) });
const EeEpisode = defineNode("EeEpisode", { schema: z.object({}) });
const EePodcast = defineNode("EePodcast", { schema: z.object({}) });
/** An optional-existence part kind, for the "honored as a convenience" case. */
const EeTag = defineNode("EeTag", { schema: z.object({}) });
const EeCollection = defineNode("EeCollection", { schema: z.object({}) });
/** A `has_*`-shaped realizing edge (whole -> part), for orientation coverage. */
const EeTrack = defineNode("EeTrack", { schema: z.object({}) });
const EeAlbum = defineNode("EeAlbum", { schema: z.object({}) });
/**
 * A REFLEXIVE optional-existence composition kind: a folder may be part of
 * another folder. The only shape in which a node batch can propose a
 * composition CYCLE at all — every item of a create batch is a new node, so a
 * cycle can only run through the batch's own items — which is what the
 * batch-level acyclicity probe below is about.
 */
const EeFolder = defineNode("EeFolder", { schema: z.object({}) });
/** A `population: "oneActive"` required part, for the temporal (valid-time) coverage below. */
const EeLiveClip = defineNode("EeLiveClip", { schema: z.object({}) });
const EeShow = defineNode("EeShow", { schema: z.object({}) });

const eeSegmentOf = defineEdge("eeSegmentOf", { schema: z.object({}) });
const eeTagOf = defineEdge("eeTagOf", { schema: z.object({}) });
const eeHasTrack = defineEdge("eeHasTrack", { schema: z.object({}) });
const eeLiveClipOf = defineEdge("eeLiveClipOf", { schema: z.object({}) });
const eeFolderOf = defineEdge("eeFolderOf", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      EeSegment: { type: EeSegment },
      EeSubSegment: { type: EeSubSegment },
      EeEpisode: { type: EeEpisode },
      EePodcast: { type: EePodcast },
      EeTag: { type: EeTag },
      EeCollection: { type: EeCollection },
      EeTrack: { type: EeTrack },
      EeAlbum: { type: EeAlbum },
      EeLiveClip: { type: EeLiveClip },
      EeShow: { type: EeShow },
      EeFolder: { type: EeFolder },
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
      eeLiveClipOf: {
        type: eeLiveClipOf,
        from: [EeLiveClip],
        to: [EeShow],
        cardinality: "oneActive",
      },
      eeFolderOf: {
        type: eeFolderOf,
        from: [EeFolder],
        to: [EeFolder],
        cardinality: "one",
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
      // EeSubSegment is never declared its own composition pair — it
      // inherits EeSegment's required existence purely through subsumption
      // (subclass existence inheritance, below).
      subClassOf(EeSubSegment, EeSegment),
      // EeTag is optional-existence.
      partOf(EeTag, EeCollection, { via: eeTagOf }),
      // EeTrack is required-existence under a `has_*`-shaped edge.
      hasPart(EeAlbum, EeTrack, { via: eeHasTrack, existence: "required" }),
      // `population: "oneActive"` (`cardinality: "oneActive"` above):
      // ending the window is a genuine detachment, unlike EeSegment's
      // `population: "one"` pair (the temporal coverage below).
      partOf(EeLiveClip, EeShow, {
        via: eeLiveClipOf,
        existence: "required",
      }),
      // Reflexive, so the orientation must be stated explicitly.
      partOf(EeFolder, EeFolder, { via: eeFolderOf, partSide: "from" }),
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
      expect((error as CompositionExistenceError).code).toBe(
        "COMPOSITION_WHOLE_REQUIRED",
      );
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

    it("case 3: a failed edge (whole does not exist) aborts the node — no orphan row survives", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      // `resolveCompositionCreate` finds the declared pair and returns work
      // (no synchronous refusal, unlike cases 3b/4): the failure is reached
      // only once `runWritePlan` tries to insert the composition edge and
      // its endpoint-liveness check finds no such `EeEpisode` row. Proving
      // atomicity requires exactly this shape — a failure INSIDE the write
      // plan, after the node row would otherwise have been prepared.
      const before = await store.nodes.EeSegment.count();
      const error = await store.nodes.EeSegment.create(
        {},
        { partOf: { kind: "EeEpisode", id: "does-not-exist" } },
      ).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(EndpointNotFoundError);
      expect(await store.nodes.EeSegment.count()).toBe(before);
    });
    // MUTATION CHECK: build two separate write plans instead of one
    // `mixedWritePlan` in `executeNodeCreateInternal`
    // (src/store/operations/node-operations.ts) — the node row then commits
    // in its own transaction before the edge leg's endpoint check ever
    // runs, and `EeSegment.count()` grows past `before`.

    it("case 3b: a failed edge (whole does not exist) in a bulk create aborts the WHOLE batch — no orphan row survives", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});
      const before = await store.nodes.EeSegment.count();
      const error = await store.nodes.EeSegment.bulkCreate([
        { props: {}, partOf: { kind: "EeEpisode", id: episode.id } },
        { props: {}, partOf: { kind: "EeEpisode", id: "does-not-exist" } },
      ]).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(EndpointNotFoundError);
      expect(await store.nodes.EeSegment.count()).toBe(before);
    });
    // MUTATION CHECK: build separate write plans per item instead of one
    // `mixedWritePlan` covering the whole batch in
    // `executeNodeBulkCreateInternal` (src/store/operations/node-operations.ts)
    // — the first item's node+edge rows then commit even though the second
    // item's endpoint check throws, and `EeSegment.count()` grows to
    // `before + 1` instead of staying at `before`.

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

    it("case 6c: the batch's ONE acyclicity probe attributes a self-attaching item to that item's own edge, and no row of the batch survives", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const root = await store.nodes.EeFolder.create({});
      const error = await store.nodes.EeFolder.bulkCreate([
        {
          id: "ee-folder-ok",
          props: {},
          partOf: { kind: "EeFolder", id: root.id },
        },
        // Names ITSELF as its whole: the cycle this batch closes.
        {
          id: "ee-folder-loop",
          props: {},
          partOf: { kind: "EeFolder", id: "ee-folder-loop" },
        },
      ]).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(EdgeAcyclicityError);
      expect((error as EdgeAcyclicityError).details).toMatchObject({
        selfLoop: true,
        fromKind: "EeFolder",
        fromId: "ee-folder-loop",
        toKind: "EeFolder",
        toId: "ee-folder-loop",
      });
      // The whole batch rolled back: neither item's node row, and no edge.
      expect(await store.nodes.EeFolder.count()).toBe(1);
      expect(await store.edges.eeFolderOf.find({})).toHaveLength(0);
    });
    // MUTATION CHECK: drop the `assertPreparedEdgeCreatesAcyclic` call at the
    // end of `attachBatchCompositionCreateEdges`
    // (src/store/operations/node-operations.ts) — nothing probes a batch's
    // composition edges at all (each item prepares with
    // `validateAcyclicity: false`), so this batch commits the self-attaching
    // folder and `count()` reads 3.

    it("case 6d: an in-batch composition cycle spanning two items is refused, and no row of the batch survives", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const error = await store.nodes.EeFolder.bulkCreate([
        {
          id: "ee-cycle-a",
          props: {},
          partOf: { kind: "EeFolder", id: "ee-cycle-b" },
        },
        {
          id: "ee-cycle-b",
          props: {},
          partOf: { kind: "EeFolder", id: "ee-cycle-a" },
        },
      ]).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(EdgeAcyclicityError);
      const details = (error as EdgeAcyclicityError).details;
      expect(details.selfLoop).toBe(false);
      // Both items' edges lie on the cycle; the probe names the first of them
      // it is given, which is the batch's own input order.
      expect(details.edgeKind).toBe("eeFolderOf");
      expect(details.fromId).toBe("ee-cycle-a");
      expect(details.toId).toBe("ee-cycle-b");
      expect(await store.nodes.EeFolder.count()).toBe(0);
      expect(await store.edges.eeFolderOf.find({})).toHaveLength(0);
    });
    // MUTATION CHECK: same as case 6c — with the batch-level probe gone, the
    // mutual cycle commits and `count()` reads 2. (Probing per item BEFORE
    // each insert cannot see this cycle either: the first item's walk runs
    // before the second item's edge exists.)

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
      expect((error as CompositionExistenceError).code).toBe(
        "COMPOSITION_DETACH_REFUSED",
      );
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
        .update(
          requireDefined(edge).id,
          {},
          { validTo: new Date().toISOString() },
        )
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
      const remaining = await store.nodes.EeSegment.getById(segment.id);
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

    it("case 11b: verifyConstraintFences reports an unattached SUBCLASS of a required part kind", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      // EeSubSegment is never named by any composition pair directly — it
      // is required-existence only because it is a subclass of EeSegment.
      await store.backend.insertNode({
        graphId: store.graphId,
        kind: "EeSubSegment",
        id: "ee-sub-orphan-1",
        props: {},
      });
      const violations = await store.verifyConstraintFences();
      const violation = violations.find(
        (candidate) =>
          candidate.family === "compositionExistence" &&
          candidate.partKind === "EeSubSegment",
      );
      expect(violation).toBeDefined();
      if (violation?.family !== "compositionExistence") {
        throw new Error("expected a compositionExistence violation");
      }
      expect(violation.parts).toEqual([
        { kind: "EeSubSegment", id: "ee-sub-orphan-1" },
      ]);
    });
    // MUTATION CHECK: in `requiredCompositionPartKinds`
    // (src/store/operations/composition-create.ts), replace
    // `registry.expandSubClasses(pair.partKind)` with `[pair.partKind]` —
    // the planted `EeSubSegment` orphan above becomes invisible to
    // `verifyConstraintFences` even though `EeSegment`'s own orphan (case
    // 11) still reports.

    it("case 12: a create whose `oneActive` composition edge would be born already-ended (unattaching) is refused, and writes no row", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const show = await store.nodes.EeShow.create({});
      // `validTo` is forwarded straight onto the composition edge
      // (`attachCompositionCreateEdge`): a `population: "oneActive"` edge
      // born with its window already closed would never attach its part at
      // all, which `resolveCompositionCreate`'s "a required part always has
      // a live whole" rule must refuse just as it refuses a bare create
      // with no `partOf` — admitting it would leave a state
      // `store.verifyConstraintFences()` immediately reports as a
      // violation.
      const error = await store.nodes.EeLiveClip.create(
        {},
        {
          partOf: { kind: "EeShow", id: show.id },
          validTo: "2000-01-01T00:00:00.000Z",
        },
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(CompositionExistenceError);
      expect((error as CompositionExistenceError).details.situation).toBe(
        "create",
      );
      expect((error as CompositionExistenceError).details.partKind).toBe(
        "EeLiveClip",
      );

      // No node row, and no composition edge row, survive the refused
      // create — the whole write plan (node + composition edge) is one
      // transaction.
      expect(await store.nodes.EeLiveClip.find({})).toEqual([]);
      const connectedEdges = await store.backend.findEdgesConnectedTo({
        graphId: store.graphId,
        nodeKind: "EeShow",
        nodeId: show.id,
      });
      expect(connectedEdges).toEqual([]);

      // The graph never reaches a state `verifyConstraintFences` would
      // have to report — refused at create time, not merely detected
      // afterward.
      const violations = await store.verifyConstraintFences();
      expect(
        violations.some(
          (candidate) =>
            candidate.family === "compositionExistence" &&
            candidate.partKind === "EeLiveClip",
        ),
      ).toBe(false);
    });
    // MUTATION CHECK: in `attachCompositionCreateEdge`
    // (src/store/operations/node-operations.ts), delete the
    // `edgeCurrentlyAttachesPart` guard this fix added (the create then
    // succeeds unconditionally once the composition edge is built). The
    // `create` call above then resolves instead of rejecting, and the
    // subsequent `find({})`/`verifyConstraintFences` assertions fail.

    it("case 12b: an already-unattached `oneActive` composition edge (planted through the RAW backend, bypassing case 12's create-time guard) is unattached, and cleaning it up is not refused", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const show = await store.nodes.EeShow.create({});
      // Born attaching, through the ordinary store path.
      const clip = await store.nodes.EeLiveClip.create(
        {},
        { partOf: { kind: "EeShow", id: show.id } },
      );
      const [connectedEdge] = await store.backend.findEdgesConnectedTo({
        graphId: store.graphId,
        nodeKind: "EeLiveClip",
        nodeId: clip.id,
      });
      const edgeId = requireDefined(connectedEdge).id;

      // Backdates the window through the RAW backend member, bypassing the
      // store's own `assertCompositionExistencePreserved` refusal entirely
      // (case 7c already proves the ORDINARY store path refuses this same
      // mutation) — the dirty-database / bypassed-validation shape case 8
      // uses for the analogous node-side scenario. `population: "oneActive"`
      // ends the attachment the moment the window closes, so this part is
      // now unattached — verifyConstraintFences must say so, not report the
      // graph clean.
      await store.backend.updateEdge({
        graphId: store.graphId,
        id: edgeId,
        props: {},
        validTo: "2000-01-01T00:00:00.000Z",
      });

      const violations = await store.verifyConstraintFences();
      const violation = violations.find(
        (candidate) =>
          candidate.family === "compositionExistence" &&
          candidate.partKind === "EeLiveClip",
      );
      expect(violation).toBeDefined();
      if (violation?.family !== "compositionExistence") {
        throw new Error("expected a compositionExistence violation");
      }
      expect(violation.parts).toEqual([{ kind: "EeLiveClip", id: clip.id }]);

      // The edge is no longer an attachment, so deleting it is not what
      // would orphan the part — it is already orphaned.
      await expect(
        store.edges.eeLiveClipOf.hardDelete(asEdgeId(edgeId)),
      ).resolves.toBeUndefined();
    });
    // MUTATION CHECK: in `assertCompositionExistencePreserved`
    // (src/store/operations/composition-create.ts), delete the
    // `edgeCurrentlyAttachesPart` guard (refuse unconditionally once
    // `compositionExistence(part.kind) === "required"` and the part is
    // live, regardless of the edge's own valid-time window). The
    // `hardDelete` above then rejects with `CompositionExistenceError`
    // instead of resolving.

    it("getOrCreateByConstraint: partOf applied on created, refused on found/updated naming the current whole", async () => {
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
    // MUTATION CHECK: stop resolving the attachment on the existing-row legs
    // of `executeNodeGetOrCreateByConstraint` (drop both
    // `resolveGetOrCreateAttachmentRequest` calls,
    // src/store/operations/node-operations.ts) — the `"found"` and
    // `ifExists: "update"` calls above then silently drop `partOf` instead of
    // refusing the contradicting whole. (The postcondition replaced the
    // blanket refusal this comment once named: a found node with NO live
    // whole is now attached rather than refused, which is why the mutation is
    // stated as removing the calls rather than as restoring a condition.)

    it("bulkGetOrCreateByConstraint: a within-batch duplicate of a row THIS CALL just created honors the same stated whole", async () => {
      const store = await context.createStore(buildKeyedGraph(nextGraphId()));
      const episode = await store.nodes.EeEpisode.create({});

      // Two items with the SAME constraint key, in ONE call, naming the
      // whole this exact call is about to attach the first occurrence to —
      // the duplicate must be a plain "found" hit, not a refusal.
      const results =
        await store.nodes.EeKeyedSegment.bulkGetOrCreateByConstraint(
          "byKey",
          [{ props: { key: "dup-1" } }, { props: { key: "dup-1" } }],
          { partOf: { kind: "EeEpisode", id: episode.id } },
        );
      expect(results[0]?.action).toBe("created");
      expect(results[1]?.action).toBe("found");
      expect(results[1]?.node.id).toBe(results[0]?.node.id);
      const edges = await store.edges.eeKeyedSegmentOf.find({});
      expect(edges).toHaveLength(1);
    });
    // MUTATION CHECK: in step 6's duplicate-resolution loop in
    // `executeNodeBulkGetOrCreateByConstraint`
    // (src/store/operations/node-operations.ts), copy the source's own action
    // (`action: sourceResult.action`) instead of `"found"` — the duplicate
    // then reports `"created"` and the `results[1]` assertion above fails.
    //
    // The mutation this comment used to name — calling `refuseExistingPartOf`
    // unconditionally here — is no longer performable: that function and its
    // blanket refusal are gone. `partOf` on a found node is now a
    // POSTCONDITION (`applyExistingPartOfPostcondition`, or the update leg's
    // own write plan), discharged in steps 4/5, and re-running it for a
    // duplicate of the row this same call just attached would be SATISFIED
    // rather than a refusal. Step 6 deliberately
    // does not re-run it; see the comment there.
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
