/**
 * T22(c) — the `claims` bundle's binding is off the PORT a write actually
 * executes on, never off the `GraphBackend` its verdict was resolved
 * against (ruling B-1's port-typing, generalized from `claimSupport`'s move
 * onto the framework). `uniqueSidecarBatch`'s equivalent is B8's, added below.
 *
 * Two rows:
 *
 * 1. **Binding is off the port.** A spy on the TOP-LEVEL (resolved) backend's
 *    `claimEdgeCardinality` must see ZERO calls when a claimed edge write runs
 *    inside `store.transaction()` — the write binds off the transaction's OWN
 *    member. The same test's second half proves the converse: when the
 *    transaction's own target genuinely lacks a member the resolved verdict
 *    says is present, the per-write port check (`bindNames`, I20) still
 *    fires — `CONSTRAINT_CLAIM_SURFACE_MISMATCH` — which only happens if the
 *    bind reads off THAT object rather than off the fully-served resolved
 *    backend.
 * 2. **Rollback.** A claimed edge write that throws inside
 *    `store.transaction()` must leave neither the edge row nor its claim row
 *    behind — a second create on the SAME axis afterward must still succeed.
 *
 * B8 adds the `uniqueSidecarBatch` REFUSE-arm row this docblock deferred:
 * a set-based update's resolved-claims validation, which — unlike the
 * fallback rows (`node-fetch.ts`/`edge-fetch.ts`, `search.ts`, `import.ts`,
 * ...) — must THROW when the transaction's own target lacks a member the
 * threaded verdict (resolved against the top-level backend) says is
 * present, rather than silently degrade.
 *
 * Unlike `claims`'s row above, `uniqueSidecarBatch`'s three refuse-dispositioned
 * operations (`"unique reap by node ids"`, `"set-based node update"`,
 * `"resolved node write"`) each keep an EXISTING, pinned refusal — a
 * `TypeError` or a specific `ConfigurationError` code predating the capability
 * model — rather than falling through to the bundle's generic
 * `BUNDLE_PORT_SURFACE_MISMATCH` (`tests/graph-merge/ingestion-branch.test.ts`
 * pins exactly this for the same scenario). The binding is still off the
 * PORT, not the verdict — `resolved-node-claims.ts`'s `requireBatchProbe` uses
 * `bindExtraIfReachable` precisely so a port that cannot serve the member
 * collapses into the SAME pinned refusal a verdict that says absent would
 * produce, rather than the bundle's own code.
 *
 * B8 fixup — `insertUniqueBatch` was the one member of these three REFUSE
 * operations whose port re-check was missing: `applyNodeSetUpdate`
 * (`node-write-pipeline.ts`) and `applyResolvedNodeClaims`
 * (`resolved-node-claims.ts`) both re-claim through `withNodeCreateClaimsBatch`,
 * which reaches `insertUniqueBatch` only via the shared, fallback-dispositioned
 * `issueClaimsBatched` (`node-claims.ts`) — the SAME helper the plain create
 * path uses, which silently degrades to per-row `insertUnique` on a port
 * mismatch instead of refusing. The row below (for "set-based node update")
 * and the sibling in `tests/graph-merge/ingestion-branch.test.ts` (for
 * "resolved node write") pin that both operations now re-check the PORT for
 * `insertUniqueBatch` before ever reaching that shared helper.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { type ClaimEdgeCardinalityParams } from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const PortBindingPerson = defineNode("PortBindingPerson", {
  schema: z.object({ name: z.string() }),
});
const portBindingHasPassport = defineEdge("portBindingHasPassport", {
  schema: z.object({}),
});

const portBindingGraph = defineGraph({
  id: "capability_port_binding",
  nodes: { PortBindingPerson: { type: PortBindingPerson } },
  edges: {
    portBindingHasPassport: {
      type: portBindingHasPassport,
      from: [PortBindingPerson],
      to: [PortBindingPerson],
      cardinality: "one",
    },
  },
});

const PortBindingWidget = defineNode("PortBindingWidget", {
  schema: z.object({ code: z.string() }),
});

const portBindingUniqueGraph = defineGraph({
  id: "capability_port_binding_unique_sidecar",
  nodes: {
    PortBindingWidget: {
      type: PortBindingWidget,
      unique: [
        {
          name: "unique_code",
          fields: ["code"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

export function registerCapabilityPortBindingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("claims binding is off the port (T22(c))", () => {
    it("binds off the transaction target, not off the resolved backend", async () => {
      const store = await context.createStore(portBindingGraph);

      // A spy on the OUTER (resolved) backend's own member: if the bind ever
      // read off the resolved `GraphBackend` instead of the write's own
      // target, a claimed write inside a transaction would call THIS.
      let topLevelSpyCount = 0;
      const spiedBackend = deriveBackend(projectGraphBackend(store.backend), {
        claimEdgeCardinality: (params: ClaimEdgeCardinalityParams) => {
          topLevelSpyCount += 1;
          return requireDefined(store.backend.claimEdgeCardinality)(params);
        },
      });
      const spiedStore = createStore(portBindingGraph, spiedBackend);

      await spiedStore.transaction(async (tx) => {
        const alice = await tx.nodes.PortBindingPerson.create({
          name: "Alice",
        });
        const bob = await tx.nodes.PortBindingPerson.create({ name: "Bob" });
        await tx.edges.portBindingHasPassport.create(alice, bob, {});
      });

      expect(topLevelSpyCount).toBe(0);

      // The converse: a transaction TARGET that genuinely lacks a member the
      // resolved verdict says is present still reports the per-write port
      // mismatch (I20) — proof the bind is reading off that object at all,
      // not skipping the check because the resolved backend is fully served.
      const narrowedPortBackend = deriveBackend(
        projectGraphBackend(store.backend),
        {
          transaction: (fn, options) =>
            store.backend.transaction(
              (tx) => fn(projectBackendWithout(tx, ["claimEdgeCardinality"])),
              options,
            ),
        },
      );
      const narrowedStore = createStore(portBindingGraph, narrowedPortBackend);
      const carol = await store.nodes.PortBindingPerson.create({
        name: "Carol",
      });
      const dave = await store.nodes.PortBindingPerson.create({
        name: "Dave",
      });

      let caught: unknown;
      try {
        await narrowedStore.transaction(async (tx) => {
          await tx.edges.portBindingHasPassport.create(carol, dave, {});
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        details: Readonly<Record<string, unknown>>;
      };
      expect(error.details["code"]).toBe("CONSTRAINT_CLAIM_SURFACE_MISMATCH");
    });

    it("rolls the claim back with the row it gated: the axis is free again after a rollback", async () => {
      const store = await context.createStore(portBindingGraph);
      const alice = await store.nodes.PortBindingPerson.create({
        name: "Alice",
      });
      const bob = await store.nodes.PortBindingPerson.create({ name: "Bob" });

      const INJECTED_FAILURE = "injected rollback failure (T22(c))";
      await expect(
        store.transaction(async (tx) => {
          await tx.edges.portBindingHasPassport.create(alice, bob, {});
          throw new Error(INJECTED_FAILURE);
        }),
      ).rejects.toThrow(INJECTED_FAILURE);

      const afterRollback = await store.edges.portBindingHasPassport.find();
      expect(afterRollback).toEqual([]);

      // The claim row did not survive the rollback: the SAME axis (`alice`
      // as `from`) can be claimed again by a fresh, ordinary create.
      const created = await store.edges.portBindingHasPassport.create(
        alice,
        bob,
        {},
      );
      expect(created).toBeDefined();
    });
  });

  describe("uniqueSidecarBatch refuse-row binding is off the port (T22(c), B8)", () => {
    it("a transaction target projected without checkUniqueBatch, while the top-level verdict says present, still refuses RESOLVED_NODE_UNIQUENESS_UNSUPPORTED on a set-based update", async () => {
      const store = await context.createStore(portBindingUniqueGraph);
      const narrowedPortBackend = deriveBackend(
        projectGraphBackend(store.backend),
        {
          transaction: (fn, options) =>
            store.backend.transaction(
              (tx) => fn(projectBackendWithout(tx, ["checkUniqueBatch"])),
              options,
            ),
        },
      );
      const narrowedStore = createStore(
        portBindingUniqueGraph,
        narrowedPortBackend,
      );
      await narrowedStore.nodes.PortBindingWidget.create({ code: "widget-1" });

      let caught: unknown;
      try {
        await narrowedStore.nodes.PortBindingWidget.updateWhere({
          all: true,
          patch: { code: "widget-2" },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        details: Readonly<Record<string, unknown>>;
      };
      // The verdict (resolved against the top-level backend) says
      // `checkUniqueBatch` is present; only the transaction PORT lacks it.
      // `resolved-node-claims.ts`'s `requireBatchProbe` binds through
      // `bindExtraIfReachable`, so this collapses into the SAME pinned
      // refusal a verdict-level absence produces, not the bundle's generic
      // `BUNDLE_PORT_SURFACE_MISMATCH` — proof the bind reads off the PORT
      // (a `bindExtra` read off the resolved backend, or a call that never
      // consulted the port at all, would not observe this absence).
      expect(error.details["code"]).toBe(
        "RESOLVED_NODE_UNIQUENESS_UNSUPPORTED",
      );
    });

    it("a transaction target projected without insertUniqueBatch, while the top-level verdict says present, refuses SET_UPDATE_UNIQUENESS_UNSUPPORTED on a set-based update instead of silently falling back to per-row inserts", async () => {
      const store = await context.createStore(portBindingUniqueGraph);
      const narrowedPortBackend = deriveBackend(
        projectGraphBackend(store.backend),
        {
          transaction: (fn, options) =>
            store.backend.transaction(
              (tx) => fn(projectBackendWithout(tx, ["insertUniqueBatch"])),
              options,
            ),
        },
      );
      const narrowedStore = createStore(
        portBindingUniqueGraph,
        narrowedPortBackend,
      );
      await narrowedStore.nodes.PortBindingWidget.create({ code: "widget-1" });

      let caught: unknown;
      try {
        await narrowedStore.nodes.PortBindingWidget.updateWhere({
          all: true,
          patch: { code: "widget-2" },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const error = caught as Error & {
        details: Readonly<Record<string, unknown>>;
      };
      // The verdict (resolved against the top-level backend) says
      // `insertUniqueBatch` is present; only the transaction PORT lacks it.
      // `applyNodeSetUpdate`'s re-claim reaches this member only through the
      // shared, fallback-dispositioned `issueClaimsBatched` (`node-claims.ts`),
      // which silently degrades to per-row `insertUnique` calls on a port
      // mismatch instead of refusing — the right answer for a plain create,
      // but not for this REFUSE operation.
      expect(error.details["code"]).toBe("SET_UPDATE_UNIQUENESS_UNSUPPORTED");

      // Not just the right error — the row must be untouched: a silent
      // per-row fallback would have already renamed it before this refusal.
      const rows = await store.nodes.PortBindingWidget.find();
      expect(rows.map((row) => row.code)).toEqual(["widget-1"]);
    });
  });
}
