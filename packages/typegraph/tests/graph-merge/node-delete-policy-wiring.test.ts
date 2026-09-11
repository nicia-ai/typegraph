/**
 * Merge apply's node deletion routes through the internal runtime port
 * `transactionDeleteNodeWithPolicy`, passing
 * `{ enforceDeleteBehavior: true, cascadeComposition: false }`. This does NOT
 * cover the facade-to-port switch itself: merge's own delete already went
 * through `txNodeOperations`, built from the same `txNodeOperationContext`
 * (`store.ts`), so its hooks were already buffered before that switch — the
 * switch is behavior-neutral in production today. What these two tests DO
 * guard, each under its own case:
 *
 * - ENFORCEMENT: the policy merge apply passes does not drop delete-behavior
 *   enforcement — a target node's own `restrict` edge still aborts the
 *   merge, and zero rows change on that refusal.
 * - ROUTING: the delete is bound to the SAME transaction merge apply is
 *   already running in — its buffered hook runner and attempt — not a
 *   freshly-built context off the outer Store. A delete inside a merge that
 *   later rolls back must never report `onOperationEnd`; a context built
 *   fresh from the outer Store fires that hook the instant the delete runs,
 *   before the enclosing transaction's outcome is known.
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
const Other = defineNode("Other", { schema: z.object({}) });
const holds = defineEdge("holds", { schema: z.object({}) });

const graph = defineGraph({
  id: "node-delete-policy-wiring",
  nodes: {
    Whole: { type: Whole, onDelete: "restrict" },
    Part: { type: Part },
    Other: { type: Other },
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
    identityReconciliations: [],
    identityConflicts: [],
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

    it("does not report a hook success for a delete the rolled-back merge never committed", async () => {
      cleanups = [];
      // `onError`'s context is the generic `HookContext` (it also fires for
      // query and bulk-operation failures, neither of which has a single
      // node kind/id) so it carries no `kind`/`id` at the type level; capture
      // the label from the fully-typed `onOperationStart` context and
      // correlate by `operationId`, the field both contexts DO share.
      const operationLabels = new Map<string, string>();
      const endedIds: string[] = [];
      const erroredIds: string[] = [];
      const [target] = await createStoreWithSchema(graph, await makeBackend(), {
        hooks: {
          onOperationStart: (ctx) =>
            operationLabels.set(ctx.operationId, `${ctx.kind}:${ctx.id}`),
          onOperationEnd: (ctx) => endedIds.push(`${ctx.kind}:${ctx.id}`),
          onError: (ctx) => {
            const label = operationLabels.get(ctx.operationId);
            if (label !== undefined) erroredIds.push(label);
          },
        },
      });

      const whole = requireDefined(
        (await target.nodes.Whole.bulkCreate([{ id: "w1", props: {} }]))[0],
      );
      const part = requireDefined(
        (await target.nodes.Part.bulkCreate([{ id: "p1", props: {} }]))[0],
      );
      await target.edges.holds.create(whole, part, {});
      const other = requireDefined(
        (await target.nodes.Other.bulkCreate([{ id: "o1", props: {} }]))[0],
      );

      operationLabels.clear();
      endedIds.length = 0;
      erroredIds.length = 0;

      // The plan deletes Other FIRST (unrestricted — it would succeed on its
      // own) and Whole SECOND (blocked by its live `holds` edge to Part). Map
      // iteration order is insertion order, so applyNodeRows runs Other's
      // delete before Whole's, inside the same merge transaction; Whole's
      // RestrictedDeleteError then rolls the whole transaction back.
      const plan: MergePlan<G> = {
        ...emptyPlan(),
        nodeDeletions: new Map([
          [mergeKey("Other", "o1"), "Other"],
          [mergeKey("Whole", "w1"), "Whole"],
        ]),
      };

      await expect(commitPlan(target, plan)).rejects.toThrow(
        /RESTRICTED_DELETE|connected edge/i,
      );

      // Other's delete ran and would have committed had the transaction
      // succeeded — routed through the Store's OWN immediate-hook context
      // (the pre-fix bug) it reports `onOperationEnd` right there, before the
      // rollback. Routed through this transaction's own buffered hook runner
      // (the fix), a rolled-back attempt's outcomes are discarded and
      // reported as `onError` instead, once the failure is final.
      expect(endedIds).not.toContain("Other:o1");
      expect(erroredIds).toContain("Other:o1");
      await expect(target.nodes.Other.getById(other.id)).resolves.toBeDefined();
    });
  },
);
