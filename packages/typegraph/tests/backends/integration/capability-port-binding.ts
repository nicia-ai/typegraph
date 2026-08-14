/**
 * T22(c) — the `claims` bundle's binding is off the PORT a write actually
 * executes on, never off the `GraphBackend` its verdict was resolved
 * against (ruling B-1's port-typing, generalized from `claimSupport`'s move
 * onto the framework). `uniqueSidecarBatch`'s equivalent is B8's.
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
}
