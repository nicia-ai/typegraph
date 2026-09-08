/**
 * Target-side edge cardinality during `importGraph` / `importGraphStream`
 * (issue #610, acceptance criterion 5, import half).
 *
 * `registerPendingEdgeForCardinality` (`src/store/operations/edge-batch-validation.ts`)
 * is the pending-batch overlay every axis import reads: a same-chunk pair
 * that targets the same node must be caught the same way a persisted
 * conflict is, without waiting for a flush round trip.
 *
 * Every case states, in its own comment, the mutation that must make it
 * fail; the revert/mutation checks actually performed are recorded in the
 * scratchpad `lane-D1-load-bearing.md` note.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { asNodeId, defineEdge, defineGraph, defineNode } from "../../../src";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("ItcPerson", { schema: z.object({}) });
const Target = defineNode("ItcTarget", { schema: z.object({}) });
const assignedTo = defineEdge("itcAssignedTo", { schema: z.object({}) });
/** A two-axis kind: bob's row can fail on ONE axis while its OTHER axis is
 * genuinely free — the shape that isolates "was a REJECTED row's endpoint
 * ever registered as pending" from "was its own occupied key re-registered",
 * which a single-axis kind cannot distinguish (a row rejected for occupying
 * a key can only ever re-register that SAME, already-occupied key). */
const ownsBoth = defineEdge("itcOwnsBoth", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { ItcPerson: { type: Person }, ItcTarget: { type: Target } },
    edges: {
      itcAssignedTo: {
        type: assignedTo,
        from: [Person],
        to: [Target],
        targetCardinality: "one",
      },
      itcOwnsBoth: {
        type: ownsBoth,
        from: [Person],
        to: [Target],
        cardinality: "one",
        targetCardinality: "one",
      },
    },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `import_target_cardinality_${graphIdCounter}`;
}

function edgeRow(
  id: string,
  fromId: string,
  toId: string,
): GraphData["edges"][number] {
  return {
    kind: "itcAssignedTo",
    id,
    from: { kind: "ItcPerson", id: fromId },
    to: { kind: "ItcTarget", id: toId },
    properties: {},
  };
}

function ownsBothEdgeRow(
  id: string,
  fromId: string,
  toId: string,
): GraphData["edges"][number] {
  return {
    kind: "itcOwnsBoth",
    id,
    from: { kind: "ItcPerson", id: fromId },
    to: { kind: "ItcTarget", id: toId },
    properties: {},
  };
}

function payload(
  nodes: GraphData["nodes"],
  edges: GraphData["edges"],
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "import target cardinality" },
    nodes,
    edges,
  };
}

const IMPORT_OPTIONS: ImportOptions = {
  onConflict: "error",
  onUnknownProperty: "error",
  validateReferences: true,
  refreshStatistics: false,
};

export function registerImportTargetCardinalityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("target-side edge cardinality during import", () => {
    it("accepts the first same-chunk edge to a target and reports the second as a per-row error", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const result = await importGraph(
        store,
        payload(
          [
            { kind: "ItcPerson", id: "alice", properties: {} },
            { kind: "ItcPerson", id: "bob", properties: {} },
            { kind: "ItcTarget", id: "target", properties: {} },
          ],
          [
            edgeRow("edge-alice", "alice", "target"),
            edgeRow("edge-bob", "bob", "target"),
          ],
        ),
        IMPORT_OPTIONS,
      );

      expect(result.edges.created).toBe(1);
      expect(result.errors).toEqual([
        expect.objectContaining({ entityType: "edge", id: "edge-bob" }),
      ]);
      // The chunk's other rows still commit: both nodes exist.
      expect(
        await store.nodes.ItcPerson.getById(asNodeId("alice")),
      ).toBeDefined();
      expect(
        await store.nodes.ItcPerson.getById(asNodeId("bob")),
      ).toBeDefined();
      expect(
        await store.edges.itcAssignedTo.findTo({
          kind: "ItcTarget",
          id: "target",
        }),
      ).toHaveLength(1);
    });
    // MUTATION CHECK (verified): in `registerPendingEdgeForCardinality`
    // (`src/store/operations/edge-batch-validation.ts`), add an early
    // `if (spec.keyShape === "to") continue;` (register nothing for a
    // `keyShape === "to"` axis). Both same-chunk edges then reach the
    // insert batch as unfiltered candidates and this case fails — not with
    // `created` reading 2 as first guessed, but with the whole slice
    // throwing `DatabaseOperationError: Two edge claims in one batch name
    // the same cardinality axis and key`, because the downstream claim
    // batcher's OWN same-key guard (a second, independent line of defense)
    // catches the duplicate the pending overlay was supposed to prevent
    // from ever reaching it. Either failure mode proves the overlay
    // load-bearing.

    it("reports a row conflicting with an already-persisted edge the same way", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const alice = await store.nodes.ItcPerson.create({}, { id: "alice" });
      const target = await store.nodes.ItcTarget.create({}, { id: "target" });
      await store.edges.itcAssignedTo.create(
        alice,
        target,
        {},
        { id: "persisted-edge" },
      );

      const bob = await store.nodes.ItcPerson.create({}, { id: "bob" });
      const result = await importGraph(
        store,
        payload([], [edgeRow("edge-bob", bob.id, target.id)]),
        IMPORT_OPTIONS,
      );

      expect(result.edges.created).toBe(0);
      expect(result.errors).toEqual([
        expect.objectContaining({ entityType: "edge", id: "edge-bob" }),
      ]);
    });
    // MUTATION CHECK (verified): stub `checkEdgeCardinalityConstraints`
    // (`src/store/constraints.ts`) to `return;` unconditionally. The per-row
    // probe this test exercises no longer catches the persisted conflict at
    // all; the row reaches the real claim write, which refuses it there
    // instead — but as an UNCAUGHT `CardinalityError` that aborts the whole
    // import with a thrown exception rather than a clean per-row
    // `result.errors` entry, so this test still fails (on the thrown
    // exception) even though a *different* layer happened to catch the
    // underlying conflict.

    it("a row rejected on ONE axis leaves its OTHER, unoccupied axis unclaimed for a later same-chunk row", async () => {
      // `itcOwnsBoth` constrains BOTH axes. alice already owns `target`
      // (both her source and the target axis are occupied). bob's row to
      // `target` is rejected — on the TARGET axis, since bob's OWN source
      // axis (bob has created nothing yet) is genuinely free. A LATER row
      // in the SAME chunk, bob -> a FRESH target, must still succeed: bob's
      // rejected attempt never actually held anything. If a rejected row's
      // full declaration were registered in the pending overlay regardless
      // of which axis rejected it, bob's free source axis would be wrongly
      // poisoned by his own rejected attempt.
      const store = await context.createStore(buildGraph(nextGraphId()));
      const alice = await store.nodes.ItcPerson.create({}, { id: "alice" });
      const target = await store.nodes.ItcTarget.create({}, { id: "target" });
      await store.edges.itcOwnsBoth.create(alice, target, {});

      const result = await importGraph(
        store,
        payload(
          [
            { kind: "ItcPerson", id: "bob", properties: {} },
            { kind: "ItcTarget", id: "fresh-target", properties: {} },
          ],
          [
            ownsBothEdgeRow("edge-bob-rejected", "bob", "target"),
            ownsBothEdgeRow("edge-bob-fresh", "bob", "fresh-target"),
          ],
        ),
        IMPORT_OPTIONS,
      );

      expect(result.errors).toEqual([
        expect.objectContaining({
          entityType: "edge",
          id: "edge-bob-rejected",
        }),
      ]);
      expect(result.edges.created).toBe(1);
      const bob = requireDefined(
        await store.nodes.ItcPerson.getById(asNodeId("bob")),
      );
      expect(await store.edges.itcOwnsBoth.findFrom(bob)).toHaveLength(1);
    });
    // MUTATION CHECK (verified): in `src/interchange/import.ts`, call
    // `registerPendingEdgeForCardinality(params, declarations)`
    // UNCONDITIONALLY (moved above the `if (!cardinalityResult.ok)` early
    // return) instead of only for accepted rows. Verified this does NOT
    // move the sibling single-axis "same-chunk" case above (a row rejected
    // for occupying a key can only ever re-register that SAME,
    // already-occupied key, so poisoning it changes nothing observable) —
    // it DOES break this two-axis case: with the mutation,
    // `edge-bob-rejected`'s rejection ALSO registers bob's otherwise-free
    // SOURCE axis as pending, and `edge-bob-fresh` (which shares no key with
    // alice at all) is then wrongly reported as a second error;
    // `result.edges.created` reads 0 instead of 1.

    // `graphOwesClaims` (src/store/constraints.ts) refusing a
    // target-only-constrained graph up front is exercised in
    // `tests/constraint-fence-capability.test.ts` ("refuses an import into a
    // graph whose only hazard is a target-cardinality claim") — that case
    // needs a genuine transactionless backend construction
    // (`transactionMode: "none"`), which this suite's registered backends
    // are not, so it lives there rather than as a no-op here.
  });
}
