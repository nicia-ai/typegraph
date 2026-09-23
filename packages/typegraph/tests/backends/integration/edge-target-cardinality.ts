/**
 * Target-side edge cardinality (issue #610), on every backend.
 *
 * `targetCardinality` bounds the edges that point AT one node, independent of
 * `cardinality`, which bounds the edges leaving one source. These cases pin
 * acceptance criteria 1, 2, 3 and 9: the reservation is scoped to
 * `(graph, edge kind, target kind, target id)` and nothing else, it counts
 * edges rather than distinct neighbours, and an idempotent reopen of an
 * already-held axis does not refuse against itself.
 *
 * Each case states the mutation that must make it fail; the revert/mutation
 * checks actually performed are recorded in the scratchpad
 * `lane-D1-load-bearing.md` note.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CardinalityError,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("TgcPerson", { schema: z.object({}) });
const Contractor = defineNode("TgcContractor", { schema: z.object({}) });
const Target = defineNode("TgcTarget", { schema: z.object({}) });
const OtherTarget = defineNode("TgcOtherTarget", { schema: z.object({}) });

const assignedTo = defineEdge("tgcAssignedTo", { schema: z.object({}) });
const caresFor = defineEdge("tgcCaresFor", { schema: z.object({}) });
const ownsAsset = defineEdge("tgcOwnsAsset", { schema: z.object({}) });
const assignedToActive = defineEdge("tgcAssignedToActive", {
  schema: z.object({}),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      TgcPerson: { type: Person },
      TgcContractor: { type: Contractor },
      TgcTarget: { type: Target },
      TgcOtherTarget: { type: OtherTarget },
    },
    edges: {
      // Target-only constrained: any source may point at a Target/OtherTarget
      // once. Two source kinds share the SAME allowance, and the two target
      // node kinds are independent axes.
      tgcAssignedTo: {
        type: assignedTo,
        from: [Person, Contractor],
        to: [Target, OtherTarget],
        targetCardinality: "one",
      },
      // A second target-`one` edge KIND over the same target kind, to prove
      // the axis is scoped by edge kind too.
      tgcCaresFor: {
        type: caresFor,
        from: [Person],
        to: [Target],
        targetCardinality: "one",
      },
      // Both axes declared: strict 1:1 over the live population.
      tgcOwnsAsset: {
        type: ownsAsset,
        from: [Person],
        to: [Target],
        cardinality: "one",
        targetCardinality: "one",
      },
      // Target-`oneActive`: the axis a reopened window can reclaim.
      tgcAssignedToActive: {
        type: assignedToActive,
        from: [Person],
        to: [Target],
        targetCardinality: "oneActive",
      },
    },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `edge_target_cardinality_${graphIdCounter}`;
}

export function registerEdgeTargetCardinalityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("target-side edge cardinality", () => {
    it("refuses a second source assigned to an already-targeted node", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const alice = await store.nodes.TgcPerson.create({});
      const bob = await store.nodes.TgcPerson.create({});
      const target = await store.nodes.TgcTarget.create({});

      await store.edges.tgcAssignedTo.create(alice, target, {});

      const error = await store.edges.tgcAssignedTo
        .create(bob, target, {})
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(CardinalityError);
      const details = (error as CardinalityError).details;
      expect(details.direction).toBe("target");
      expect(details.toKind).toBe("TgcTarget");
      expect(details.toId).toBe(target.id);

      expect(await store.edges.tgcAssignedTo.findTo(target)).toHaveLength(1);
    });
    // MUTATION CHECK (verified): set
    // `EDGE_CARDINALITY_SPECS["target:one"].keyShape` to `"from"` in
    // `src/store/claims/edge-claims.ts`. Bob's create then succeeds (the
    // claim keys on the SOURCE instead of the target) and this test fails.

    it("refuses a second distinct edge from the SAME source to the same target (count, not distinct neighbours)", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const alice = await store.nodes.TgcPerson.create({});
      const target = await store.nodes.TgcTarget.create({});

      await store.edges.tgcAssignedTo.create(alice, target, {});
      await expect(
        store.edges.tgcAssignedTo.create(alice, target, {}),
      ).rejects.toBeInstanceOf(CardinalityError);

      expect(await store.edges.tgcAssignedTo.findTo(target)).toHaveLength(1);
    });

    it("lets two permitted source kinds share one target allowance, refusing the second", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const alice = await store.nodes.TgcPerson.create({});
      const carl = await store.nodes.TgcContractor.create({});
      const target = await store.nodes.TgcTarget.create({});

      await store.edges.tgcAssignedTo.create(alice, target, {});
      await expect(
        store.edges.tgcAssignedTo.create(carl, target, {}),
      ).rejects.toBeInstanceOf(CardinalityError);
    });

    it("keeps the target axis scoped to (graph, edge kind, target kind, target id)", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const a1 = await store.nodes.TgcPerson.create({});
      const a2 = await store.nodes.TgcPerson.create({});
      const a3 = await store.nodes.TgcPerson.create({});

      // A different TARGET KIND with the same literal id succeeds.
      const target = await store.nodes.TgcTarget.create({}, { id: "dup-id" });
      const otherTarget = await store.nodes.TgcOtherTarget.create(
        {},
        { id: "dup-id" },
      );
      await store.edges.tgcAssignedTo.create(a1, target, {});
      await expect(
        store.edges.tgcAssignedTo.create(a2, otherTarget, {}),
      ).resolves.toBeDefined();

      // A different EDGE KIND over the SAME target kind and id succeeds.
      await expect(
        store.edges.tgcCaresFor.create(a3, target, {}),
      ).resolves.toBeDefined();

      // A different GRAPH with the same ids succeeds.
      const otherStore = await context.createStore(buildGraph(nextGraphId()));
      const b1 = await otherStore.nodes.TgcPerson.create({});
      const otherGraphTarget = await otherStore.nodes.TgcTarget.create(
        {},
        { id: "dup-id" },
      );
      await expect(
        otherStore.edges.tgcAssignedTo.create(b1, otherGraphTarget, {}),
      ).resolves.toBeDefined();
    });

    it("enforces both axes together and leaves no residue from a refused two-axis write", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const alice = await store.nodes.TgcPerson.create({});
      const dave = await store.nodes.TgcPerson.create({});
      const assetA = await store.nodes.TgcTarget.create({});
      const assetB = await store.nodes.TgcTarget.create({});
      const assetC = await store.nodes.TgcTarget.create({});

      await store.edges.tgcOwnsAsset.create(alice, assetA, {});

      // Source axis: alice already owns one asset.
      await expect(
        store.edges.tgcOwnsAsset.create(alice, assetB, {}),
      ).rejects.toBeInstanceOf(CardinalityError);
      // Target axis: assetA is already owned.
      const targetRefusal = await store.edges.tgcOwnsAsset
        .create(dave, assetA, {})
        .catch((error_: unknown) => error_);
      expect(targetRefusal).toBeInstanceOf(CardinalityError);

      // dave's source axis must not have been left "occupied" by the
      // refused two-axis attempt above: a fresh, otherwise-valid write on
      // dave's source axis still succeeds.
      await expect(
        store.edges.tgcOwnsAsset.create(dave, assetC, {}),
      ).resolves.toBeDefined();

      expect(await store.edges.tgcOwnsAsset.findFrom(alice)).toHaveLength(1);
      expect(await store.edges.tgcOwnsAsset.findTo(assetA)).toHaveLength(1);
    });
    // MUTATION CHECK (verified): declaring `tgcOwnsAsset` with only
    // `cardinality: "one"` (drop `targetCardinality`) makes `dave`'s create
    // against the already-owned `assetA` succeed, and the fourth `expect`
    // above (`findTo(assetA)` has length 1) fails.

    it("reopens a target-oneActive window on the SAME edge without refusing against itself, but re-probes for real", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const alice = await store.nodes.TgcPerson.create({});
      const bob = await store.nodes.TgcPerson.create({});
      const target = await store.nodes.TgcTarget.create({});

      const edge = await store.edges.tgcAssignedToActive.create(
        alice,
        target,
        {},
        { validFrom: "2019-01-01T00:00:00.000Z" },
      );
      // End it: the active-only slot is freed, and the claim row becomes
      // takeable in place.
      await store.edges.tgcAssignedToActive.update(
        edge.id,
        {},
        {
          validTo: "2020-01-01T00:00:00.000Z",
        },
      );

      // Reopening the SAME edge immediately (nothing else has taken the
      // freed slot) must not read its own prior row as a competing
      // incumbent.
      await expect(
        store.edges.tgcAssignedToActive.update(
          edge.id,
          {},
          {
            clearValidTo: true,
          },
        ),
      ).resolves.toBeDefined();
      const reopened = await store.edges.tgcAssignedToActive.getById(edge.id);
      expect(reopened?.meta.validTo).toBeUndefined();
      // End it again, and let bob legitimately take the now-freed slot.
      await store.edges.tgcAssignedToActive.update(
        edge.id,
        {},
        {
          validTo: "2021-01-01T00:00:00.000Z",
        },
      );
      await store.edges.tgcAssignedToActive.create(bob, target, {});

      // Reopening alice's edge NOW must refuse: the reopen is a real
      // re-probe against the CURRENT holder, not a rubber stamp for an
      // edge id this write has seen before.
      await expect(
        store.edges.tgcAssignedToActive.update(
          edge.id,
          {},
          {
            clearValidTo: true,
          },
        ),
      ).rejects.toBeInstanceOf(CardinalityError);
    });
    // MUTATION CHECK (verified): in `performEdgeUpdate`
    // (`src/store/operations/edge-operations.ts`), force
    // `reentersActivePopulation` to `false` unconditionally. Reopening
    // alice's edge after bob's takeover then skips the re-probe entirely and
    // succeeds, and the final `rejects.toBeInstanceOf(CardinalityError)`
    // assertion above fails.
  });
}
