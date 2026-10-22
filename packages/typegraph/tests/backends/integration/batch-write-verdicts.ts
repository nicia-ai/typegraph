/**
 * Batch writes reach every item's verdict before their first write, on every
 * backend.
 *
 * `bulkUpsertById`, `bulkReplaceById` and `bulkGetOrCreateByEndpoints` write
 * row by row: the creates first, then the updates, restores and
 * resurrections. Each row's own write
 * plan orders its reads before its statement, which is enough for one row and
 * not for several: inside a caller's `store.transaction(...)` there is no
 * nested frame to roll back, so a refusal reached at a later row would leave
 * every earlier row committed with a batch that threw. Each case below catches
 * the refusal inside a transaction and asserts nothing was left behind — and,
 * for the batches that must still succeed, that the batch is judged as the
 * state its earlier rows leave rather than the stored one.
 *
 * Fixture shape:
 *
 *   BvClip   --(bvClipOf,     partOf, required, oneActive)-- BvShow
 *   BvPerson --(bvTagged,     many)----------------------- BvDesk
 *   BvPerson --(bvOwns,       cardinality "one")---------- BvDesk
 *   BvPerson --(bvSeatedAt,   cardinality "oneActive")---- BvDesk
 *   BvPerson --(bvAssignedTo, targetCardinality "one")---- BvDesk
 *
 *   BvStamp carries a unique `label`; BvGhost is disjoint with BvSpirit, so a
 *   tombstoned ghost whose id a spirit now holds cannot be restored. A second
 *   graph adds identity (`sameIdAcrossKinds: "fold"`) for the verdicts only
 *   an identity graph reaches, with a BvWisp (unique `slug`, disjoint with
 *   BvSpirit) for the writes that match a row by a unique key.
 *
 * Each case states, in a comment, the mutation/revert that must make it
 * fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  CardinalityError,
  CompositionExistenceError,
  defineEdge,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  IdentityContradictionError,
  IdentityEndpointValidityError,
  partOf,
  UniquenessError,
  ValidationError,
} from "../../../src";
import { FORMAT_VERSION, importGraph } from "../../../src/interchange";
import { transactionReviveNode } from "../../../src/store/runtime-port";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const BvShow = defineNode("BvShow", { schema: z.object({}) });
const BvClip = defineNode("BvClip", { schema: z.object({}) });
const BvPerson = defineNode("BvPerson", { schema: z.object({}) });
const BvDesk = defineNode("BvDesk", { schema: z.object({}) });
const BvStamp = defineNode("BvStamp", {
  schema: z.object({ label: z.string() }),
});
const BvGhost = defineNode("BvGhost", {
  schema: z.object({ note: z.string().optional() }),
});
const BvSpirit = defineNode("BvSpirit", { schema: z.object({}) });
const BvWisp = defineNode("BvWisp", { schema: z.object({ slug: z.string() }) });
const BvOther = defineNode("BvOther", { schema: z.object({}) });

const noteSchema = z.object({ note: z.string().optional() });
const bvClipOf = defineEdge("bvClipOf", { schema: noteSchema });
const bvTagged = defineEdge("bvTagged", { schema: noteSchema });
const bvOwns = defineEdge("bvOwns", { schema: z.object({}) });
const bvSeatedAt = defineEdge("bvSeatedAt", { schema: z.object({}) });
const bvAssignedTo = defineEdge("bvAssignedTo", { schema: noteSchema });

/** The caller-chosen ids the batches below create. */
const NEW_ASSIGNMENT_ID = asEdgeId<typeof bvAssignedTo>("bv-new-edge");
const CREATED_TAG_ID = asEdgeId<typeof bvTagged>("bv-created");
const NEW_STAMP_ID = asNodeId<typeof BvStamp>("bv-new-stamp");
const FOLDING_GHOST_ID = "bv-folding-ghost";
const RESTORED_FOLD_ID = "bv-restored-fold";

const BV_STAMP_LABEL_UNIQUE = {
  name: "bv_stamp_label",
  fields: ["label"],
  scope: "kind",
  collation: "binary",
} as const;

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      BvShow: { type: BvShow },
      BvClip: { type: BvClip },
      BvPerson: { type: BvPerson },
      BvDesk: { type: BvDesk },
      BvStamp: { type: BvStamp, unique: [BV_STAMP_LABEL_UNIQUE] },
      BvGhost: { type: BvGhost },
      BvSpirit: { type: BvSpirit },
    },
    edges: {
      bvClipOf: {
        type: bvClipOf,
        from: [BvClip],
        to: [BvShow],
        cardinality: "oneActive",
      },
      bvTagged: { type: bvTagged, from: [BvPerson], to: [BvDesk] },
      bvOwns: {
        type: bvOwns,
        from: [BvPerson],
        to: [BvDesk],
        cardinality: "one",
      },
      bvSeatedAt: {
        type: bvSeatedAt,
        from: [BvPerson],
        to: [BvDesk],
        cardinality: "oneActive",
      },
      bvAssignedTo: {
        type: bvAssignedTo,
        from: [BvPerson],
        to: [BvDesk],
        targetCardinality: "one",
      },
    },
    ontology: [
      partOf(BvClip, BvShow, { via: bvClipOf, existence: "required" }),
      disjointWith(BvGhost, BvSpirit),
    ],
  });
}

const BV_WISP_SLUG_UNIQUE = {
  name: "bv_wisp_slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;

/** The identity graph: a ghost and a wisp disjoint with a spirit, folded by id. */
function buildIdentityGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      BvGhost: { type: BvGhost },
      BvSpirit: { type: BvSpirit },
      BvOther: { type: BvOther },
      BvWisp: { type: BvWisp, unique: [BV_WISP_SLUG_UNIQUE] },
    },
    edges: {},
    ontology: [disjointWith(BvGhost, BvSpirit), disjointWith(BvWisp, BvSpirit)],
    identity: { sameIdAcrossKinds: "fold" },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `batch_write_verdicts_${graphIdCounter}`;
}

/**
 * An identity graph where creating a BvGhost at `FOLDING_GHOST_ID` folds it
 * with a live BvOther whose class holds a BvSpirit, which is disjoint with
 * BvGhost: no read of the node rows at that id sees the conflict, only the
 * identity fold does.
 */
async function createFoldConflictStore(context: IntegrationTestContext) {
  const store = await context.createStore(buildIdentityGraph(nextGraphId()));
  const other = await store.nodes.BvOther.create({}, { id: FOLDING_GHOST_ID });
  const spirit = await store.nodes.BvSpirit.create({});
  await store.identity.assertSame(other, spirit);
  return store;
}

/**
 * An identity graph whose `RESTORED_FOLD_ID` names a tombstoned BvGhost and a
 * tombstoned BvWisp, and a live BvOther whose class holds a BvSpirit: bringing
 * either tombstone back folds it into a class holding a kind disjoint with its
 * own. No read of the node rows at that id sees the conflict, only the
 * identity fold does.
 */
async function createRestoreFoldConflictStore(context: IntegrationTestContext) {
  const store = await context.createStore(buildIdentityGraph(nextGraphId()));
  const ghost = await store.nodes.BvGhost.create(
    { note: "before" },
    { id: RESTORED_FOLD_ID },
  );
  const wisp = await store.nodes.BvWisp.create(
    { slug: "restored" },
    { id: RESTORED_FOLD_ID },
  );
  await store.nodes.BvGhost.delete(ghost.id);
  await store.nodes.BvWisp.delete(wisp.id);
  const other = await store.nodes.BvOther.create({}, { id: RESTORED_FOLD_ID });
  const spirit = await store.nodes.BvSpirit.create({});
  await store.identity.assertSame(other, spirit);
  return { store, other };
}

type RestoreFoldConflict = Awaited<
  ReturnType<typeof createRestoreFoldConflictStore>
>;

/**
 * The tombstones and the identity class a refused restore must leave as they
 * were: each tombstone's stored version, and the live BvOther's class.
 */
async function restoreFoldState({ store, other }: RestoreFoldConflict) {
  const tombstones = { temporalMode: "includeTombstones" } as const;
  const ghost = await store.nodes.BvGhost.getById(
    asNodeId<typeof BvGhost>(RESTORED_FOLD_ID),
    tombstones,
  );
  const wisp = await store.nodes.BvWisp.getById(
    asNodeId<typeof BvWisp>(RESTORED_FOLD_ID),
    tombstones,
  );
  return {
    ghost: {
      deleted: ghost?.meta.deletedAt !== undefined,
      version: ghost?.meta.version,
    },
    wisp: {
      deleted: wisp?.meta.deletedAt !== undefined,
      version: wisp?.meta.version,
    },
    otherClass: await store.identity.membersOf(other),
  };
}

async function ghostIds(
  store: Awaited<ReturnType<typeof createFoldConflictStore>>,
): Promise<readonly string[]> {
  const ghosts = await store.nodes.BvGhost.find();
  return ghosts.map((ghost) => ghost.id).toSorted();
}

export function registerBatchWriteVerdictIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("node batch writes decide every item before the first write", () => {
    for (const method of ["bulkUpsertById", "bulkReplaceById"] as const) {
      it(`${method} keeps no earlier update when a later one loses a unique key`, async () => {
        const store = await context.createStore(buildGraph(nextGraphId()));
        const first = await store.nodes.BvStamp.create({ label: "one" });
        const second = await store.nodes.BvStamp.create({ label: "two" });
        const holder = await store.nodes.BvStamp.create({ label: "taken" });

        // MUTATION CHECK: write each entry of `executeNodeUpsertUpdateBatch`
        // right after preparing it (`writeNodeUpdateSet` without its
        // `prepareNodeUpdateSet` frame, src/store/operations/node-operations.ts)
        // — the first stamp is then renamed before the second loses its key,
        // and keeps the new label after the caught refusal.
        let caught: unknown;
        await store.transaction(async (tx) => {
          try {
            await tx.nodes.BvStamp[method]([
              { id: first.id, props: { label: "renamed" } },
              { id: second.id, props: { label: "taken" } },
            ]);
          } catch (error) {
            caught = error;
          }
        });

        expect(caught).toBeInstanceOf(UniquenessError);
        expect((caught as UniquenessError).details.existingId).toBe(holder.id);
        const after = requireDefined(
          await store.nodes.BvStamp.getById(first.id),
        );
        expect(after.label).toBe("one");
        expect(after.meta.version).toBe(first.meta.version);
      });

      it(`${method} creates nothing when an update in the same batch loses a unique key`, async () => {
        const store = await context.createStore(buildGraph(nextGraphId()));
        const second = await store.nodes.BvStamp.create({ label: "two" });
        await store.nodes.BvStamp.create({ label: "taken" });

        // MUTATION CHECK: hand `executeNodeCreateBatch` no `pairedUpdates`
        // from the collection (src/store/collections/node-collection.ts) —
        // the new stamp is then inserted before the update loses its key,
        // and survives the caught refusal.
        let caught: unknown;
        await store.transaction(async (tx) => {
          try {
            await tx.nodes.BvStamp[method]([
              { id: NEW_STAMP_ID, props: { label: "fresh" } },
              { id: second.id, props: { label: "taken" } },
            ]);
          } catch (error) {
            caught = error;
          }
        });

        expect(caught).toBeInstanceOf(UniquenessError);
        expect(await store.nodes.BvStamp.getById(NEW_STAMP_ID)).toBeUndefined();
        expect(
          requireDefined(await store.nodes.BvStamp.getById(second.id)).label,
        ).toBe("two");
      });
    }

    it("bulkUpsertById refuses an update a create of the same batch takes the key from, writing neither", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const existing = await store.nodes.BvStamp.create({ label: "two" });

      // The create is written first, so the update that asks for its label
      // after loses it — judged before either.
      //
      // MUTATION CHECK: leave the pending creates' claim transitions out of
      // `prepareNodeUpdateSet` (src/store/operations/node-operations.ts) —
      // the update is then judged against the stored keys alone, the create
      // is inserted, and the update is refused after it.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvStamp.bulkUpsertById([
            { id: NEW_STAMP_ID, props: { label: "shared" } },
            { id: existing.id, props: { label: "shared" } },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(UniquenessError);
      expect((caught as UniquenessError).details.existingId).toBe(NEW_STAMP_ID);
      expect(await store.nodes.BvStamp.getById(NEW_STAMP_ID)).toBeUndefined();
      expect(
        requireDefined(await store.nodes.BvStamp.getById(existing.id)).label,
      ).toBe("two");
    });

    it("bulkUpsertById keeps no earlier update when a later restore's id is held by a disjoint kind", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const live = await store.nodes.BvGhost.create({ note: "before" });
      const gone = await store.nodes.BvGhost.create({});
      await store.nodes.BvGhost.delete(gone.id);
      await store.nodes.BvSpirit.create({}, { id: gone.id });

      // MUTATION CHECK: drop the `checkDisjointnessConstraint` read for a
      // restoring entry in `prepareNodeUpdateSet`
      // (src/store/operations/node-operations.ts) — "live" is then updated
      // before the restore's claim refuses, and survives the caught refusal.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.bulkUpsertById([
            { id: live.id, props: { note: "changed" } },
            { id: gone.id, props: {} },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(DisjointError);
      const after = requireDefined(await store.nodes.BvGhost.getById(live.id));
      expect(after.note).toBe("before");
      expect(await store.nodes.BvGhost.getById(gone.id)).toBeUndefined();
    });

    it("bulkUpsertById keeps no earlier update when a later restore's identity fold would contradict", async () => {
      const store = await context.createStore(
        buildIdentityGraph(nextGraphId()),
      );
      const live = await store.nodes.BvGhost.create({ note: "before" });
      const gone = await store.nodes.BvGhost.create({});
      await store.nodes.BvGhost.delete(gone.id);
      // The tombstone's id now names a live BvOther whose class holds a
      // BvSpirit, which is disjoint with BvGhost: only the identity fold
      // sees that, no read of the node rows at that id does.
      const other = await store.nodes.BvOther.create({}, { id: gone.id });
      const spirit = await store.nodes.BvSpirit.create({});
      await store.identity.assertSame(other, spirit);

      // MUTATION CHECK: drop the `ctx.identity?.assertFoldable` read from
      // `prepareNodeUpdateSet` (src/store/operations/node-operations.ts) —
      // "live" is then updated before the restore's fold refuses.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.bulkUpsertById([
            { id: live.id, props: { note: "changed" } },
            { id: gone.id, props: {} },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      const after = requireDefined(await store.nodes.BvGhost.getById(live.id));
      expect(after.note).toBe("before");
      expect(after.meta.version).toBe(live.meta.version);
    });

    // ========================================================
    // A created row's own identity fold, on caller-chosen ids
    // ========================================================
    //
    // MUTATION CHECK for every case below: in the create frame named in the
    // case (src/store/operations/node-operations.ts), let the fold decide its
    // verdict when it writes (`prepareNodeCreatesFold` called after the
    // insert) instead of before it — the rows are then written before their
    // fold refuses, and the caught refusal leaves them.

    it("bulkUpsertById keeps no update or create when a create's own identity fold would contradict", async () => {
      // Create frame: `executeNodeCreateBatch`.
      const store = await createFoldConflictStore(context);
      const live = await store.nodes.BvGhost.create({ note: "before" });

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.bulkUpsertById([
            { id: live.id, props: { note: "changed" } },
            { id: "bv-fresh-ghost", props: {} },
            { id: FOLDING_GHOST_ID, props: {} },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      expect(await ghostIds(store)).toEqual([live.id]);
      const after = requireDefined(await store.nodes.BvGhost.getById(live.id));
      expect(after.note).toBe("before");
      expect(after.meta.version).toBe(live.meta.version);
    });

    it("bulkCreate creates nothing when a row's own identity fold would contradict", async () => {
      // Create frame: `executeNodeCreateBatch`.
      const store = await createFoldConflictStore(context);

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.bulkCreate([
            { props: {} },
            { props: {}, id: FOLDING_GHOST_ID },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      expect(await ghostIds(store)).toEqual([]);
    });

    it("bulkInsert creates nothing when a row's own identity fold would contradict", async () => {
      // Create frame: `executeNodeCreateNoReturnBatch`.
      const store = await createFoldConflictStore(context);

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.bulkInsert([
            { props: {}, id: "bv-fresh-ghost" },
            { props: {}, id: FOLDING_GHOST_ID },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      expect(await ghostIds(store)).toEqual([]);
    });

    it("create leaves no row when its own identity fold would contradict", async () => {
      // Create frame: `executeNodeCreateInternal`.
      const store = await createFoldConflictStore(context);

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.create({}, { id: FOLDING_GHOST_ID });
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      expect(await ghostIds(store)).toEqual([]);
    });

    it("bulkCreate resurrects no tombstone when its own identity fold would contradict", async () => {
      // Create frame: `executeNodeCreateBatch`, its resurrection leg.
      const store = await context.createStore(
        buildIdentityGraph(nextGraphId()),
      );
      const gone = await store.nodes.BvGhost.create({});
      await store.nodes.BvGhost.delete(gone.id);
      const other = await store.nodes.BvOther.create({}, { id: gone.id });
      const spirit = await store.nodes.BvSpirit.create({});
      await store.identity.assertSame(other, spirit);

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.bulkCreate([
            { props: {} },
            { props: {}, id: gone.id },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      expect(await store.nodes.BvGhost.find()).toEqual([]);
    });

    // ========================================================
    // A restored row's own identity fold
    // ========================================================
    //
    // MUTATION CHECK for every case below: in the restore frame named in the
    // case (src/store/operations/node-operations.ts), decide the fold after
    // the row write instead of before it (`prepareNodeFold` moved below the
    // write) — the tombstone is then brought back before its fold refuses,
    // and the caught refusal leaves it live.

    it("upsertById brings back no tombstone when its identity fold would contradict", async () => {
      // Restore frame: `executeNodeUpdate`.
      const conflict = await createRestoreFoldConflictStore(context);
      const { store } = conflict;
      const before = await restoreFoldState(conflict);

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.upsertById(RESTORED_FOLD_ID, {
            note: "changed",
          });
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      expect(await ghostIds(store)).toEqual([]);
      expect(await restoreFoldState(conflict)).toEqual(before);
    });

    it("getOrCreateByConstraint brings back no tombstone when its identity fold would contradict", async () => {
      // Restore frame: `executeNodeUpsertUpdate`.
      const conflict = await createRestoreFoldConflictStore(context);
      const { store } = conflict;
      const before = await restoreFoldState(conflict);

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvWisp.getOrCreateByConstraint("bv_wisp_slug", {
            slug: "restored",
          });
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      expect(await store.nodes.BvWisp.find()).toEqual([]);
      expect(await restoreFoldState(conflict)).toEqual(before);
    });

    it("a revive brings back no tombstone when its identity fold would contradict", async () => {
      // Restore frame: `executeNodeRevive`, through `reviveNodeRowInFrame`.
      const conflict = await createRestoreFoldConflictStore(context);
      const { store } = conflict;
      const before = await restoreFoldState(conflict);

      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await transactionReviveNode(tx, {
            kind: "BvGhost",
            id: RESTORED_FOLD_ID,
          });
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityContradictionError);
      expect(await ghostIds(store)).toEqual([]);
      expect(await restoreFoldState(conflict)).toEqual(before);
    });

    it("importGraph writes none of its rows when an imported node's identity fold would contradict", async () => {
      // The import folds its nodes after writing them, in its own
      // transaction: a fold may join two rows of the same document, which no
      // read before their inserts can see, so the refusal rolls that
      // transaction back rather than being reached before the first row.
      //
      // MUTATION CHECK: run `foldImportedIdentityNodes` after the import's
      // write plan returns instead of inside `runImportWritePlanAttempt`
      // (src/interchange/import.ts) — the rows then commit before the fold
      // refuses, and the fresh ghost survives the rejected import.
      const store = await createFoldConflictStore(context);

      await expect(
        importGraph(
          store,
          {
            formatVersion: FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            source: { type: "external" as const },
            nodes: [
              { kind: "BvGhost", id: "bv-fresh-ghost", properties: {} },
              { kind: "BvGhost", id: FOLDING_GHOST_ID, properties: {} },
            ],
            edges: [],
          },
          { onConflict: "error" },
        ),
      ).rejects.toBeInstanceOf(IdentityContradictionError);
      expect(await ghostIds(store)).toEqual([]);
    });

    it("bulkUpsertById keeps no earlier update when a later window end would strand an identity assertion", async () => {
      const store = await context.createStore(
        buildIdentityGraph(nextGraphId()),
      );
      const live = await store.nodes.BvGhost.create({ note: "before" });
      const asserted = await store.nodes.BvGhost.create({});
      const other = await store.nodes.BvOther.create({});
      await store.identity.assertSame(asserted, other);

      // MUTATION CHECK: drop the window-end identity verdict from
      // `prepareNodeUpdateSet` (src/store/operations/node-operations.ts) —
      // "live" is then updated before the second entry's window end is
      // refused.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.nodes.BvGhost.bulkUpsertById([
            { id: live.id, props: { note: "changed" } },
            {
              id: asserted.id,
              props: {},
              validTo: new Date(Date.now() + 60_000).toISOString(),
            },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(IdentityEndpointValidityError);
      const after = requireDefined(await store.nodes.BvGhost.getById(live.id));
      expect(after.note).toBe("before");
    });
  });

  describe("edge batch writes decide every item before the first write", () => {
    // ========================================================
    // bulkUpsertById: the update half on its own
    // ========================================================

    it("bulkUpsertById keeps no earlier update when a later item would detach a required part", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const show = await store.nodes.BvShow.create({});
      const first = await store.nodes.BvClip.create(
        {},
        { partOf: { whole: show } },
      );
      const second = await store.nodes.BvClip.create(
        {},
        { partOf: { whole: show } },
      );
      const [firstEdge] = await store.edges.bvClipOf.findFrom(first);
      const [secondEdge] = await store.edges.bvClipOf.findFrom(second);

      // MUTATION CHECK: write each entry of `executeEdgeUpsertUpdateBatch`
      // right after preparing it (`performEdgeUpdateConverging` per entry in
      // place of `writeEdgeUpdateSet`, src/store/operations/edge-operations.ts)
      // — the first clip's note is then written before the second entry's
      // existence refusal, and survives the caught refusal.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.edges.bvClipOf.bulkUpsertById([
            {
              id: requireDefined(firstEdge).id,
              from: first,
              to: show,
              props: { note: "changed" },
            },
            {
              id: requireDefined(secondEdge).id,
              from: second,
              to: show,
              validTo: new Date().toISOString(),
            },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CompositionExistenceError);
      const after = await store.edges.bvClipOf.getById(
        requireDefined(firstEdge).id,
      );
      expect(after?.note).toBeUndefined();
    });

    it("bulkUpsertById keeps no earlier update when a later item's window would end before it starts", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const person = await store.nodes.BvPerson.create({});
      const desk = await store.nodes.BvDesk.create({});
      const other = await store.nodes.BvDesk.create({});
      const first = await store.edges.bvTagged.create(person, desk, {});
      const second = await store.edges.bvTagged.create(person, other, {});

      // MUTATION CHECK: as above — the first edge's note is then written
      // before the second entry's window verdict refuses.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.edges.bvTagged.bulkUpsertById([
            {
              id: first.id,
              from: person,
              to: desk,
              props: { note: "changed" },
            },
            {
              id: second.id,
              from: person,
              to: other,
              validTo: "2000-01-01T00:00:00.000Z",
            },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(ValidationError);
      const after = await store.edges.bvTagged.getById(first.id);
      expect(after?.note).toBeUndefined();
      const secondAfter = await store.edges.bvTagged.getById(second.id);
      expect(secondAfter?.meta.validTo).toBeUndefined();
    });

    it("bulkUpsertById resurrects neither of two tombstones that would share one source allowance", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const person = await store.nodes.BvPerson.create({});
      const desk = await store.nodes.BvDesk.create({});
      const other = await store.nodes.BvDesk.create({});
      const first = await store.edges.bvOwns.create(person, desk, {});
      await store.edges.bvOwns.delete(first.id);
      const second = await store.edges.bvOwns.create(person, other, {});
      await store.edges.bvOwns.delete(second.id);

      // Each resurrection alone fits the allowance; together they do not.
      //
      // MUTATION CHECK: drop the `registerEdgeTransition` call after each
      // entry in `prepareEdgeUpdateSet`
      // (src/store/operations/edge-operations.ts) — both entries then pass
      // against the stored counts, the first is resurrected, and the second
      // is refused at its write.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.edges.bvOwns.bulkUpsertById([
            { id: first.id, from: person, to: desk },
            { id: second.id, from: person, to: other },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CardinalityError);
      expect(await store.edges.bvOwns.findFrom(person)).toEqual([]);
    });

    it("bulkUpsertById lets a later resurrection take the allowance an earlier item's window end frees", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const person = await store.nodes.BvPerson.create({});
      const desk = await store.nodes.BvDesk.create({});
      const other = await store.nodes.BvDesk.create({});
      const tombstone = await store.edges.bvSeatedAt.create(person, other, {});
      await store.edges.bvSeatedAt.delete(tombstone.id);
      const current = await store.edges.bvSeatedAt.create(person, desk, {});

      // MUTATION CHECK: count only what a transition ADDS in
      // `createEdgeTransitionValidationBackend`
      // (src/store/operations/edge-batch-validation.ts) — the resurrection is
      // then judged against the open window the first item ends, and refused.
      const results = await store.edges.bvSeatedAt.bulkUpsertById([
        {
          id: current.id,
          from: person,
          to: desk,
          validTo: new Date().toISOString(),
        },
        { id: tombstone.id, from: person, to: other },
      ]);

      expect(results.map((edge) => edge.id)).toEqual([
        current.id,
        tombstone.id,
      ]);
      expect(results[0]?.meta.validTo).toBeDefined();
      expect(results[1]?.meta.validTo).toBeUndefined();
    });

    // ========================================================
    // bulkUpsertById and bulkGetOrCreateByEndpoints: the creates, then the
    // update half
    // ========================================================

    it("bulkUpsertById creates nothing when a resurrection in the same batch is refused", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const [a, b, c] = await Promise.all([
        store.nodes.BvPerson.create({}),
        store.nodes.BvPerson.create({}),
        store.nodes.BvPerson.create({}),
      ]);
      const taken = await store.nodes.BvDesk.create({});
      const free = await store.nodes.BvDesk.create({});
      const tombstone = await store.edges.bvAssignedTo.create(b, taken, {});
      await store.edges.bvAssignedTo.delete(tombstone.id);
      await store.edges.bvAssignedTo.create(c, taken, {});

      // MUTATION CHECK: drop the paired-update preparation from
      // `executeEdgeCreateBatch` (`prepareEdgeUpdateSet` over
      // `pairedUpdates`, src/store/operations/edge-operations.ts) — the new
      // edge is then inserted before the resurrection's target allowance
      // refuses, and survives the caught refusal.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.edges.bvAssignedTo.bulkUpsertById([
            { id: NEW_ASSIGNMENT_ID, from: a, to: free },
            { id: tombstone.id, from: b, to: taken },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CardinalityError);
      expect(await store.edges.bvAssignedTo.getById(NEW_ASSIGNMENT_ID)).toBe(
        undefined,
      );
      expect(await store.edges.bvAssignedTo.findTo(free)).toEqual([]);
    });

    it("bulkUpsertById refuses a resurrection a create of the same batch takes the allowance from, writing neither", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const a = await store.nodes.BvPerson.create({});
      const b = await store.nodes.BvPerson.create({});
      const desk = await store.nodes.BvDesk.create({});
      const tombstone = await store.edges.bvAssignedTo.create(b, desk, {});
      await store.edges.bvAssignedTo.delete(tombstone.id);

      // The create is written first, so the resurrection that follows it
      // finds the desk taken — judged before either.
      //
      // MUTATION CHECK: leave `pendingCreates` out of the paired-update
      // preparation in `executeEdgeCreateBatch`
      // (src/store/operations/edge-operations.ts) — the resurrection is then
      // judged against the stored desk alone, the create is inserted, and
      // the resurrection is refused after it.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.edges.bvAssignedTo.bulkUpsertById([
            { id: NEW_ASSIGNMENT_ID, from: a, to: desk },
            { id: tombstone.id, from: b, to: desk },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CardinalityError);
      expect(await store.edges.bvAssignedTo.findTo(desk)).toEqual([]);
    });

    it("bulkUpsertById still updates, in the same batch, a row it creates", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const person = await store.nodes.BvPerson.create({});
      const desk = await store.nodes.BvDesk.create({});
      const other = await store.nodes.BvDesk.create({});
      const tombstone = await store.edges.bvTagged.create(person, other, {});
      await store.edges.bvTagged.delete(tombstone.id);

      // The second item updates the row the first creates: the update half
      // is prepared against the row the create will write.
      const results = await store.edges.bvTagged.bulkUpsertById([
        { id: CREATED_TAG_ID, from: person, to: desk, props: {} },
        {
          id: CREATED_TAG_ID,
          from: person,
          to: desk,
          props: { note: "later" },
        },
        { id: tombstone.id, from: person, to: other, props: {} },
      ]);

      expect(results.map((edge) => edge.note)).toEqual([
        undefined,
        "later",
        undefined,
      ]);
      const created = await store.edges.bvTagged.getById(CREATED_TAG_ID);
      expect(created?.note).toBe("later");
    });

    it("bulkGetOrCreateByEndpoints creates nothing when a resurrection in the same batch is refused", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const [a, b, c] = await Promise.all([
        store.nodes.BvPerson.create({}),
        store.nodes.BvPerson.create({}),
        store.nodes.BvPerson.create({}),
      ]);
      const taken = await store.nodes.BvDesk.create({});
      const free = await store.nodes.BvDesk.create({});
      const tombstone = await store.edges.bvAssignedTo.create(b, taken, {});
      await store.edges.bvAssignedTo.delete(tombstone.id);
      await store.edges.bvAssignedTo.create(c, taken, {});

      // MUTATION CHECK: hand `executeEdgeCreateBatch` no `pairedUpdates` in
      // `executeEdgeBulkGetOrCreateByEndpoints`
      // (src/store/operations/edge-operations.ts) — the new edge is then
      // inserted before the resurrection refuses, and survives the caught
      // refusal.
      let caught: unknown;
      await store.transaction(async (tx) => {
        try {
          await tx.edges.bvAssignedTo.bulkGetOrCreateByEndpoints([
            { from: a, to: free, props: {} },
            { from: b, to: taken, props: {} },
          ]);
        } catch (error) {
          caught = error;
        }
      });

      expect(caught).toBeInstanceOf(CardinalityError);
      expect(await store.edges.bvAssignedTo.findTo(free)).toEqual([]);
    });

    for (const coalesceUnchangedUpserts of [false, true]) {
      it(`bulkGetOrCreateByEndpoints with ifExists "update" updates no earlier match when a later resurrection is refused${coalesceUnchangedUpserts ? " (coalescing store)" : ""}`, async () => {
        const store = await context.createStore(buildGraph(nextGraphId()), {
          coalesceUnchangedUpserts,
        });
        const [a, b, c] = await Promise.all([
          store.nodes.BvPerson.create({}),
          store.nodes.BvPerson.create({}),
          store.nodes.BvPerson.create({}),
        ]);
        const taken = await store.nodes.BvDesk.create({});
        const mine = await store.nodes.BvDesk.create({});
        const matched = await store.edges.bvAssignedTo.create(a, mine, {
          note: "before",
        });
        const tombstone = await store.edges.bvAssignedTo.create(b, taken, {});
        await store.edges.bvAssignedTo.delete(tombstone.id);
        await store.edges.bvAssignedTo.create(c, taken, {});

        // MUTATION CHECK: without a coalescing store, write each entry of
        // `executeEdgeUpsertUpdateBatch` right after preparing it; with
        // one, drop the `prepareEdgeUpdateSet` call over `owedUpdates` in
        // `executeEdgeBulkGetOrCreateByEndpoints`
        // (src/store/operations/edge-operations.ts) — the matched edge's note
        // is then written before the resurrection refuses.
        let caught: unknown;
        await store.transaction(async (tx) => {
          try {
            await tx.edges.bvAssignedTo.bulkGetOrCreateByEndpoints(
              [
                { from: a, to: mine, props: { note: "after" } },
                { from: b, to: taken, props: {} },
              ],
              { ifExists: "update" },
            );
          } catch (error) {
            caught = error;
          }
        });

        expect(caught).toBeInstanceOf(CardinalityError);
        const matchedAfter = await store.edges.bvAssignedTo.getById(matched.id);
        expect(matchedAfter?.note).toBe("before");
      });
    }
  });
}
