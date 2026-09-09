/**
 * Pruning correctness: bounding `diffAgainstBase`'s reads to a lineage delta
 * must never change what the diff reports, only which rows it reads to
 * produce it.
 *
 * The base and fork stores here are both constructed with `history: true`
 * directly (rather than via `branch()`'s default clone strategy, which
 * deliberately does NOT copy history into the working copy — see
 * `working-copy.ts` — so a clone built that way never resolves a
 * recorded-relations `lineage` and this pruning path stays dormant for it).
 * Building both sides with history enabled is exactly the shape a custom,
 * engine-native `lineage` backend gives `branch()` for free regardless of the
 * store's own `history` option, so this exercises the SAME `diffAgainstBase`/
 * `branchPruneTo` machinery a real engine-native backend would drive.
 */
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { asEdgeId, asNodeId } from "../../../src/core/types";
import { computeBaseVersion } from "../../../src/graph-merge/base-version";
import { branchPruneTo } from "../../../src/graph-merge/staging";
import { diffAgainstBase } from "../../../src/graph-merge/state-diff";
import type { GraphBranch } from "../../../src/graph-merge/types";
import { asBranchId } from "../../../src/graph-merge/types";
import { resolveLineage } from "../../../src/store/recorded-capture";
import { storeBackend } from "../../../src/store/runtime-port";
import type { Store } from "../../../src/store/store";
import {
  backendMatrix,
  type MergeBackendFixture,
} from "../../graph-merge/test-utils";

const Item = defineNode("LineagePrunedDiffItem", {
  schema: z.object({ name: z.string() }),
});
const link = defineEdge("lineagePrunedDiffLink", {
  schema: z.object({ weight: z.number() }),
});
// A second edge KIND over the same endpoints. Edge ids are unique per graph,
// not per kind, so a fork can hard-delete an id under this kind and recreate
// it under the other — the `switchKind` op below drives exactly that, and
// `fetchEdgesByIds`'s kind filter is what keeps the pruned read from mixing
// the two kinds' rows together.
const linkAlt = defineEdge("lineagePrunedDiffLinkAlt", {
  schema: z.object({ weight: z.number() }),
});
const pruneGraph = defineGraph({
  id: "lineage-pruned-diff",
  nodes: {
    // "cascade" so a random `hardDelete` op on an endpoint never refuses on
    // a connected edge — the write ops below are generated independently of
    // one another, with no ordering guarantee between a node op and the
    // edge ops that touch its endpoints.
    LineagePrunedDiffItem: { type: Item, onDelete: "cascade" },
  },
  edges: {
    lineagePrunedDiffLink: { type: link, from: [Item], to: [Item] },
    lineagePrunedDiffLinkAlt: { type: linkAlt, from: [Item], to: [Item] },
  },
});
type PruneGraph = typeof pruneGraph;

const NODE_IDS = ["n0", "n1", "n2", "n3", "n4", "n5"] as const;
const EDGE_SPECS = [
  { id: "e0", from: "n0", to: "n1" },
  { id: "e1", from: "n1", to: "n2" },
  { id: "e2", from: "n2", to: "n3" },
] as const;
const EDGE_IDS = EDGE_SPECS.map((spec) => spec.id);

const EDGE_KIND_PRIMARY = "lineagePrunedDiffLink" as const;
const EDGE_KIND_ALT = "lineagePrunedDiffLinkAlt" as const;
type EdgeKindName = typeof EDGE_KIND_PRIMARY | typeof EDGE_KIND_ALT;

/** The other of the two edge kinds — `switchKind` flips between them. */
function otherEdgeKind(kind: EdgeKindName): EdgeKindName {
  return kind === EDGE_KIND_PRIMARY ? EDGE_KIND_ALT : EDGE_KIND_PRIMARY;
}

/** Narrows a raw row's `kind: string` to one of this graph's two edge kinds. */
function asEdgeKindName(kind: string): EdgeKindName | undefined {
  return kind === EDGE_KIND_PRIMARY || kind === EDGE_KIND_ALT ?
      kind
    : undefined;
}

/**
 * The five edge mutations `applyEdgeOp` needs, all typed against ONE kind's
 * collection. Selected once per op application via {@link edgeKindOps} so the
 * switch lives in exactly one place rather than at every call site — an id
 * that has switched kind is otherwise indistinguishable from one that has
 * not, since {@link EdgeRow} identifies both by the same string `id`.
 */
type EdgeKindOps = Readonly<{
  hardDelete: (id: string) => Promise<void>;
  softDelete: (id: string) => Promise<void>;
  update: (id: string, weight: number) => Promise<void>;
  setValidTo: (id: string, validTo: string) => Promise<void>;
  create: (spec: (typeof EDGE_SPECS)[number], weight: number) => Promise<void>;
}>;

function edgeKindOps(
  store: Store<PruneGraph>,
  kind: EdgeKindName,
): EdgeKindOps {
  switch (kind) {
    case EDGE_KIND_PRIMARY: {
      const collection = store.edges.lineagePrunedDiffLink;
      return {
        hardDelete: async (id) => {
          await collection.hardDelete(asEdgeId<typeof link>(id));
        },
        softDelete: async (id) => {
          await collection.delete(asEdgeId<typeof link>(id));
        },
        update: async (id, weight) => {
          await collection.update(asEdgeId<typeof link>(id), { weight });
        },
        setValidTo: async (id, validTo) => {
          await collection.update(asEdgeId<typeof link>(id), {}, { validTo });
        },
        create: async (spec, weight) => {
          await collection.create(
            { kind: "LineagePrunedDiffItem", id: spec.from },
            { kind: "LineagePrunedDiffItem", id: spec.to },
            { weight },
            { id: spec.id },
          );
        },
      };
    }
    case EDGE_KIND_ALT: {
      const collection = store.edges.lineagePrunedDiffLinkAlt;
      return {
        hardDelete: async (id) => {
          await collection.hardDelete(asEdgeId<typeof linkAlt>(id));
        },
        softDelete: async (id) => {
          await collection.delete(asEdgeId<typeof linkAlt>(id));
        },
        update: async (id, weight) => {
          await collection.update(asEdgeId<typeof linkAlt>(id), { weight });
        },
        setValidTo: async (id, validTo) => {
          await collection.update(
            asEdgeId<typeof linkAlt>(id),
            {},
            { validTo },
          );
        },
        create: async (spec, weight) => {
          await collection.create(
            { kind: "LineagePrunedDiffItem", id: spec.from },
            { kind: "LineagePrunedDiffItem", id: spec.to },
            { weight },
            { id: spec.id },
          );
        },
      };
    }
  }
}

/** A fixed far-future instant selected by `tag`, for validity-window edits. */
const WINDOW_INSTANTS = [
  "2031-01-01T00:00:00.000Z",
  "2032-06-15T00:00:00.000Z",
  "2033-12-31T23:59:59.000Z",
] as const;

/**
 * A shared `validFrom` for every seeded row, on BOTH stores. Base and fork
 * here are two INDEPENDENT stores rather than an interchange clone of one
 * another (see the module doc), so an omitted `validFrom` would default to
 * each store's own wall-clock write instant and every seeded row would
 * spuriously diff as `windowed` — a divergence the pruning correctness
 * property must not have to tolerate, since a real `branch()` clone
 * preserves the base's exact `validFrom` (`includeTemporal: true`).
 */
const SEED_VALID_FROM = "2020-01-01T00:00:00.000Z";

async function seedStore(store: Store<PruneGraph>): Promise<void> {
  for (const id of NODE_IDS) {
    await store.nodes.LineagePrunedDiffItem.create(
      { name: `seed-${id}` },
      { id, validFrom: SEED_VALID_FROM },
    );
  }
  for (const spec of EDGE_SPECS) {
    await store.edges.lineagePrunedDiffLink.create(
      { kind: "LineagePrunedDiffItem", id: spec.from },
      { kind: "LineagePrunedDiffItem", id: spec.to },
      { weight: 1 },
      { id: spec.id, validFrom: SEED_VALID_FROM },
    );
  }
}

const NODE_OP_KINDS = [
  "update",
  "softDelete",
  "hardDelete",
  "window",
  "resurrect",
] as const;
type NodeOpKind = (typeof NODE_OP_KINDS)[number];
type NodeOp = Readonly<{ id: string; op: NodeOpKind; tag: number }>;

const EDGE_OP_KINDS = [
  "update",
  "softDelete",
  "hardDelete",
  "window",
  "resurrect",
  "switchKind",
] as const;
type EdgeOpKind = (typeof EDGE_OP_KINDS)[number];
type EdgeOp = Readonly<{ id: string; op: EdgeOpKind; tag: number }>;

/**
 * Applies one node op, no-op-safe against whatever the id's current state is
 * (checked via a raw backend read, matching `diffAgainstBase`'s own
 * `excludeDeleted: false` view): every generated op is therefore safe to run
 * regardless of prior ops in the same sequence, without a stateful model.
 */
async function applyNodeOp(
  store: Store<PruneGraph>,
  op: NodeOp,
): Promise<void> {
  const backend = storeBackend(store);
  const row = await backend.getNode(
    store.graphId,
    "LineagePrunedDiffItem",
    op.id,
  );
  const brandedId = asNodeId<typeof Item>(op.id);
  switch (op.op) {
    case "update": {
      if (row !== undefined && row.deleted_at === undefined) {
        await store.nodes.LineagePrunedDiffItem.update(brandedId, {
          name: `updated-${op.tag}`,
        });
      }
      break;
    }
    case "softDelete": {
      if (row !== undefined && row.deleted_at === undefined) {
        await store.nodes.LineagePrunedDiffItem.delete(brandedId);
      }
      break;
    }
    case "hardDelete": {
      if (row !== undefined) {
        await store.nodes.LineagePrunedDiffItem.hardDelete(brandedId);
      }
      break;
    }
    case "window": {
      if (row !== undefined && row.deleted_at === undefined) {
        const validTo =
          WINDOW_INSTANTS[op.tag % WINDOW_INSTANTS.length] ??
          WINDOW_INSTANTS[0];
        await store.nodes.LineagePrunedDiffItem.update(
          brandedId,
          {},
          { validTo },
        );
      }
      break;
    }
    case "resurrect": {
      if (row !== undefined) {
        await store.nodes.LineagePrunedDiffItem.hardDelete(brandedId);
      }
      await store.nodes.LineagePrunedDiffItem.create(
        { name: `resurrected-${op.tag}` },
        { id: op.id },
      );
      break;
    }
  }
}

/**
 * The edge analogue of {@link applyNodeOp}. `row` is read by id alone (the
 * backend's `getEdge` carries no kind parameter), so its CURRENT kind is
 * whichever of the two this id presently lives under — every op below
 * dispatches through {@link edgeKindOps} for that kind rather than assuming
 * the primary one, so an id `switchKind` has moved stays correctly targeted.
 */
async function applyEdgeOp(
  store: Store<PruneGraph>,
  op: EdgeOp,
): Promise<void> {
  const spec = EDGE_SPECS.find((entry) => entry.id === op.id);
  if (spec === undefined) return;
  const backend = storeBackend(store);
  const row = await backend.getEdge(store.graphId, op.id);
  const currentKind = row === undefined ? undefined : asEdgeKindName(row.kind);
  switch (op.op) {
    case "update": {
      if (row !== undefined && row.deleted_at === undefined) {
        if (currentKind === undefined) break;
        await edgeKindOps(store, currentKind).update(op.id, op.tag);
      }
      break;
    }
    case "softDelete": {
      if (row !== undefined && row.deleted_at === undefined) {
        if (currentKind === undefined) break;
        await edgeKindOps(store, currentKind).softDelete(op.id);
      }
      break;
    }
    case "hardDelete": {
      if (row !== undefined) {
        if (currentKind === undefined) break;
        await edgeKindOps(store, currentKind).hardDelete(op.id);
      }
      break;
    }
    case "window": {
      if (row !== undefined && row.deleted_at === undefined) {
        if (currentKind === undefined) break;
        const validTo =
          WINDOW_INSTANTS[op.tag % WINDOW_INSTANTS.length] ??
          WINDOW_INSTANTS[0];
        await edgeKindOps(store, currentKind).setValidTo(op.id, validTo);
      }
      break;
    }
    case "resurrect": {
      if (row !== undefined && currentKind !== undefined) {
        await edgeKindOps(store, currentKind).hardDelete(op.id);
      }
      // A prior op in this same sequence may have hard-deleted an endpoint
      // (node ops and edge ops are generated independently of one another,
      // with no ordering contract between them) — creating against a
      // missing endpoint refuses, so skip rather than treat that as a bug.
      if (await bothEndpointsLive(store, spec)) {
        await edgeKindOps(store, currentKind ?? EDGE_KIND_PRIMARY).create(
          spec,
          op.tag,
        );
      }
      break;
    }
    case "switchKind": {
      // Hard-delete the id under whichever kind currently holds it — LIVE OR
      // SOFT-DELETED, matching `resurrect`'s own no-op-safety condition
      // above: a tombstoned row still occupies the id (edge ids are unique
      // per graph, not per kind), so leaving it in place would collide with
      // the create below. Then recreate the SAME id under the OTHER kind —
      // the cross-kind id-reuse shape `fetchEdgesByIds`'s kind filter exists
      // to keep correct: a pruned read that ignored kind would resolve this
      // id's fetch, for BOTH kinds' diff passes, to whichever row is live
      // right now.
      if (row !== undefined && currentKind !== undefined) {
        await edgeKindOps(store, currentKind).hardDelete(op.id);
      }
      if (await bothEndpointsLive(store, spec)) {
        const targetKind = otherEdgeKind(currentKind ?? EDGE_KIND_PRIMARY);
        await edgeKindOps(store, targetKind).create(spec, op.tag);
      }
      break;
    }
  }
}

/** True when both of `spec`'s endpoint nodes are currently live. */
async function bothEndpointsLive(
  store: Store<PruneGraph>,
  spec: (typeof EDGE_SPECS)[number],
): Promise<boolean> {
  const backend = storeBackend(store);
  const [fromRow, toRow] = await Promise.all([
    backend.getNode(store.graphId, "LineagePrunedDiffItem", spec.from),
    backend.getNode(store.graphId, "LineagePrunedDiffItem", spec.to),
  ]);
  return (
    fromRow !== undefined &&
    fromRow.deleted_at === undefined &&
    toRow !== undefined &&
    toRow.deleted_at === undefined
  );
}

const nodeOpArb: fc.Arbitrary<NodeOp> = fc.record({
  id: fc.constantFrom(...NODE_IDS),
  op: fc.constantFrom(...NODE_OP_KINDS),
  tag: fc.nat({ max: 1000 }),
});
const edgeOpArb: fc.Arbitrary<EdgeOp> = fc.record({
  id: fc.constantFrom(...EDGE_IDS),
  op: fc.constantFrom(...EDGE_OP_KINDS),
  tag: fc.nat({ max: 1000 }),
});

type Scenario = Readonly<{
  baseNodeOps: readonly NodeOp[];
  forkNodeOps: readonly NodeOp[];
  baseEdgeOps: readonly EdgeOp[];
  forkEdgeOps: readonly EdgeOp[];
  /**
   * Drives BOTH `diffAgainstBase` calls below (the full comparison AND the
   * pruned one always run with the SAME flag — comparing them under
   * DIFFERENT flags would trivially differ on `forkNodeVersions`/
   * `forkEdgeSignatures` alone, proving nothing about pruning). `false`
   * exercises the production-dominant fork read (an id-set fetch, not the
   * full version-map enumeration `captureTargetStateFor` needs) under
   * pruning — every prior run of this property hardcoded `true`, so that
   * path never saw a random write sequence.
   */
  captureForkState: boolean;
}>;

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  baseNodeOps: fc.array(nodeOpArb, { maxLength: 5 }),
  forkNodeOps: fc.array(nodeOpArb, { maxLength: 5 }),
  captureForkState: fc.boolean(),
  baseEdgeOps: fc.array(edgeOpArb, { maxLength: 4 }),
  forkEdgeOps: fc.array(edgeOpArb, { maxLength: 4 }),
});

/**
 * fast-check iterations. Each run boots two backends (base + fork) with
 * `history: true` and applies up to 18 sequential writes across them; kept
 * modest so PGlite's WASM boot cost does not dominate CI.
 */
const RUNS = process.env["CI"] ? 10 : 20;

/**
 * Builds a base+fork pair sharing the seeded state, an accepted
 * `GraphBranch<PruneGraph>` carrying the fork's `forkRevision`, and the
 * disposers both backends need. Both stores are constructed with
 * `history: true` directly (see the module doc for why `branch()`'s default
 * clone strategy cannot produce this shape today).
 */
async function makeForkedPair(
  makeBackend: () => Promise<MergeBackendFixture>,
): Promise<
  Readonly<{
    baseStore: Store<PruneGraph>;
    forkStore: Store<PruneGraph>;
    branch: GraphBranch<PruneGraph>;
    dispose: () => Promise<void>;
  }>
> {
  const baseFixture = await makeBackend();
  const forkFixture = await makeBackend();
  const [baseStore] = await createStoreWithSchema(
    pruneGraph,
    baseFixture.backend,
    { history: true },
  );
  const [forkStore] = await createStoreWithSchema(
    pruneGraph,
    forkFixture.backend,
    { history: true },
  );
  await seedStore(baseStore);
  await seedStore(forkStore);

  const base = await computeBaseVersion(baseStore);
  const forkLineage = resolveLineage(forkStore);
  if (forkLineage === undefined) {
    throw new Error(
      "resolveLineage(forkStore) was undefined for a store constructed with history: true.",
    );
  }
  const forkRevision = await forkLineage.revision(forkFixture.backend);
  const branch: GraphBranch<PruneGraph> = {
    id: asBranchId("fork"),
    base,
    store: forkStore,
    // `forkStore` is disposed via `dispose()` below, not through this
    // branch — see `merge.ts`'s committed-target stand-ins for the same
    // pattern of modeling a caller-owned store as a branch.
    close: (): Promise<void> => Promise.resolve(),
    forkRevision,
  };

  return {
    baseStore,
    forkStore,
    branch,
    dispose: async () => {
      await baseFixture.cleanup();
      await forkFixture.cleanup();
    },
  };
}

describe.each(backendMatrix())(
  "lineage-pruned diff equals the full diff [$name]",
  (entry) => {
    it(
      "diffAgainstBase(pruned) deep-equals diffAgainstBase(full) for random post-fork writes",
      { timeout: 300_000 },
      async () => {
        await fc.assert(
          fc.asyncProperty(scenarioArb, async (scenario) => {
            const { baseStore, forkStore, branch, dispose } =
              await makeForkedPair(entry.make);
            try {
              for (const op of scenario.baseNodeOps) {
                await applyNodeOp(baseStore, op);
              }
              for (const op of scenario.forkNodeOps) {
                await applyNodeOp(forkStore, op);
              }
              for (const op of scenario.baseEdgeOps) {
                await applyEdgeOp(baseStore, op);
              }
              for (const op of scenario.forkEdgeOps) {
                await applyEdgeOp(forkStore, op);
              }

              const pruneTo = await branchPruneTo(baseStore, branch);
              const fullDiff = await diffAgainstBase(
                baseStore,
                forkStore,
                scenario.captureForkState,
              );
              const prunedDiff = await diffAgainstBase(
                baseStore,
                forkStore,
                scenario.captureForkState,
                pruneTo,
              );

              expect(prunedDiff).toEqual(fullDiff);
            } finally {
              await dispose();
            }
          }),
          { numRuns: RUNS },
        );
      },
    );

    it("mutation proof: dropping a changed key from the delta breaks the pruned diff", async () => {
      const { baseStore, forkStore, branch, dispose } = await makeForkedPair(
        entry.make,
      );
      try {
        await applyNodeOp(forkStore, { id: "n0", op: "update", tag: 7 });

        const pruneTo = await branchPruneTo(baseStore, branch);
        expect(pruneTo?.kind).toBe("keys");
        if (pruneTo?.kind !== "keys") return;
        expect(
          pruneTo.nodes.some(
            (key) => key.kind === "LineagePrunedDiffItem" && key.id === "n0",
          ),
        ).toBe(true);

        const fullDiff = await diffAgainstBase(baseStore, forkStore, false);
        expect(fullDiff.nodes.modified.map((node) => node.id)).toContain("n0");

        // Mutate the delta: drop the ONLY key naming the real change.
        const brokenPruneTo = { kind: "keys" as const, nodes: [], edges: [] };
        const brokenDiff = await diffAgainstBase(
          baseStore,
          forkStore,
          false,
          brokenPruneTo,
        );

        expect(brokenDiff.nodes.modified).toEqual([]);
        expect(brokenDiff).not.toEqual(fullDiff);
      } finally {
        await dispose();
      }
    });

    it("mutation proof: a cross-kind id reuse still equals the full diff (dropping the kind filter breaks it)", async () => {
      const { baseStore, forkStore, branch, dispose } = await makeForkedPair(
        entry.make,
      );
      try {
        // The fork hard-deletes "e0" under its seeded kind and recreates the
        // same id under the OTHER kind — exactly the shape a pruned fetch
        // that ignored kind would mis-resolve for one of the two kinds' diff
        // passes.
        await applyEdgeOp(forkStore, { id: "e0", op: "switchKind", tag: 1 });

        const pruneTo = await branchPruneTo(baseStore, branch);
        const fullDiff = await diffAgainstBase(baseStore, forkStore, true);
        const prunedDiff = await diffAgainstBase(
          baseStore,
          forkStore,
          true,
          pruneTo,
        );

        expect(prunedDiff).toEqual(fullDiff);
        // The full diff itself must show the reuse as a delete under the
        // original kind and a create under the other — confirming the
        // scenario actually exercises the hazard, not a no-op.
        expect(fullDiff.edges.deleted).toContainEqual(
          expect.objectContaining({ id: "e0", kind: EDGE_KIND_PRIMARY }),
        );
        expect(fullDiff.edges.new).toContainEqual(
          expect.objectContaining({ id: "e0", kind: EDGE_KIND_ALT }),
        );
      } finally {
        await dispose();
      }
    });
  },
);

describe.each(backendMatrix())(
  "lineage-pruned diff issues no full enumeration [$name]",
  (entry) => {
    let pair: Awaited<ReturnType<typeof makeForkedPair>> | undefined;

    beforeEach(async () => {
      pair = await makeForkedPair(entry.make);
    });

    afterEach(async () => {
      await pair?.dispose();
      pair = undefined;
    });

    it("reads the fork by id set instead of enumerating its kinds", async () => {
      if (pair === undefined) throw new Error("pair not initialized");
      const { baseStore, forkStore, branch } = pair;
      await applyNodeOp(forkStore, { id: "n0", op: "update", tag: 1 });
      await applyEdgeOp(forkStore, { id: "e0", op: "update", tag: 1 });

      const pruneTo = await branchPruneTo(baseStore, branch);
      expect(pruneTo?.kind).toBe("keys");

      const baseBackend = storeBackend(baseStore);
      const forkBackend = storeBackend(forkStore);
      const baseNodeEnumeration = vi.spyOn(baseBackend, "findNodesByKind");
      const baseEdgeEnumeration = vi.spyOn(baseBackend, "findEdgesByKind");
      const forkNodeEnumeration = vi.spyOn(forkBackend, "findNodesByKind");
      const forkEdgeEnumeration = vi.spyOn(forkBackend, "findEdgesByKind");
      const forkNodeBatchRead = vi.spyOn(forkBackend, "getNodes");
      const forkEdgeBatchRead = vi.spyOn(forkBackend, "getEdges");

      // `captureForkState: false` — matching `stageBranches`' call for every
      // branch except the one incremental merge captures in full — is the
      // shape that must skip enumeration entirely on BOTH sides.
      await diffAgainstBase(baseStore, forkStore, false, pruneTo);

      expect(baseNodeEnumeration).not.toHaveBeenCalled();
      expect(baseEdgeEnumeration).not.toHaveBeenCalled();
      expect(forkNodeEnumeration).not.toHaveBeenCalled();
      expect(forkEdgeEnumeration).not.toHaveBeenCalled();
      expect(forkNodeBatchRead).toHaveBeenCalled();
      expect(forkEdgeBatchRead).toHaveBeenCalled();
    });
  },
);
