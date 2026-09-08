/**
 * Merge apply's node deletion no longer goes through the public collection
 * facade (`nodeCollection(...).delete(id)`); it routes through the internal
 * runtime port `deleteNodeWithPolicy` instead, passing
 * `{ enforceDeleteBehavior: true, cascadeComposition: false }`. This proves
 * the switch is behavior-preserving where it must be: enforcement stays ON,
 * so a target node's own `restrict` edge still aborts the merge exactly as
 * it did through the old facade call — and zero rows change on that refusal.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { MergePlan } from "../../src/graph-merge/merge";
import { commitPlan } from "../../src/graph-merge/merge";
import { mergeKey } from "../../src/graph-merge/node-key";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

const Whole = defineNode("Whole", { schema: z.object({}) });
const Part = defineNode("Part", { schema: z.object({}) });
const holds = defineEdge("holds", { schema: z.object({}) });

const graph = defineGraph({
  id: "node-delete-policy-wiring",
  nodes: {
    Whole: { type: Whole, onDelete: "restrict" },
    Part: { type: Part },
  },
  edges: {
    holds: { type: holds, from: [Whole], to: [Part] },
  },
});
type G = typeof graph;

/** An empty plan; the test overrides only the slice it exercises. */
function emptyPlan(): MergePlan<G> {
  return {
    canonicalEntities: [],
    survivingModifications: [],
    nodeDeletions: new Map(),
    edgeDeletions: new Map(),
    mergedEdges: [],
    inheritedEdgeBaseProps: new Map(),
    retypeMap: new Map(),
    nodeValidityEnds: new Map(),
    edgeValidityEnds: new Map(),
    validityEnds: [],
    resolutions: [],
    propertyConflicts: [],
    deleteModifyConflicts: [],
    typeReconciliations: [],
    dropped: [],
    baseAmbiguities: [],
    provenanceRecords: [],
    warnings: [],
    identityAssertions: [],
    identityRetractions: [],
    canonicalOf: new Map(),
  };
}

describe.each(backendMatrix())(
  "merge apply's deleteNodeWithPolicy wiring [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    afterEach(async () => {
      for (const cleanup of cleanups ?? []) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    it("a target-only restrict edge still aborts the merge, and nothing changes", async () => {
      cleanups = [];
      const [target] = await createStoreWithSchema(graph, await makeBackend());

      const whole = requireDefined(
        (await target.nodes.Whole.bulkCreate([{ id: "w1", props: {} }]))[0],
      );
      const part = requireDefined(
        (await target.nodes.Part.bulkCreate([{ id: "p1", props: {} }]))[0],
      );
      await target.edges.holds.create(whole, part, {});

      // The plan deletes the Whole but knows nothing of its `holds` edge to
      // the Part — exactly the shape a plan built before that edge existed
      // would have. Deleting through the old public `.delete(id)` facade
      // would already refuse this; the assertion is that the new port
      // preserves that refusal instead of silently dropping enforcement.
      const plan: MergePlan<G> = {
        ...emptyPlan(),
        nodeDeletions: new Map([[mergeKey("Whole", "w1"), "Whole"]]),
      };

      await expect(commitPlan(target, plan)).rejects.toThrow(
        /RESTRICTED_DELETE|connected edge/i,
      );

      // Zero rows changed: the Whole is still live, and its edge survives.
      await expect(target.nodes.Whole.getById(whole.id)).resolves.toBeDefined();
      await expect(target.nodes.Part.getById(part.id)).resolves.toBeDefined();
      const survivingEdges = await target.edges.holds.findFrom(whole);
      expect(survivingEdges).toHaveLength(1);
    });
  },
);
