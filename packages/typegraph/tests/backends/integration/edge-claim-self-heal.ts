/**
 * Edge claims heal themselves (I8), on every backend.
 *
 * The edge fence deliberately has NO release path: no delete, end, cascade or
 * kind-removal code participates in it. What makes that safe is the takeover
 * statement's liveness predicate — a claim whose holder is no longer an edge
 * the axis and key describe is takeable in place. Both cases here therefore
 * bypass the store entirely when they retire the incumbent, so nothing but that
 * predicate can be what lets the replacement through.
 *
 * The second case is the one that says WHY the predicate names more than the
 * holder's id: edge ids are caller-suppliable and graph-unique, so a
 * hard-deleted id can be reused by a completely different edge. A fence that
 * compared ids alone would read that unrelated edge as a live holder and block
 * the axis forever, with no repair path — the exact failure mode "no release
 * path needed" would otherwise trade for.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { type IntegrationTestContext } from "./test-context";

const SelfHealPerson = defineNode("SelfHealPerson", {
  schema: z.object({ name: z.string() }),
});

/** The constrained kind: at most one live edge of this kind per source. */
const selfHealReportsTo = defineEdge("selfHealReportsTo", {
  schema: z.object({}),
});
/** An UNCONSTRAINED kind, so case 2 can re-use an id under a different kind. */
const selfHealKnows = defineEdge("selfHealKnows", { schema: z.object({}) });

let graphIdCounter = 0;

function buildSelfHealGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: { SelfHealPerson: { type: SelfHealPerson } },
    edges: {
      selfHealReportsTo: {
        type: selfHealReportsTo,
        from: [SelfHealPerson],
        to: [SelfHealPerson],
        cardinality: "one",
      },
      selfHealKnows: {
        type: selfHealKnows,
        from: [SelfHealPerson],
        to: [SelfHealPerson],
      },
    },
  });
}

export function registerEdgeClaimSelfHealIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge claims are takeable once their holder is gone", () => {
    it("lets a replacement claim an axis whose holder was soft-deleted behind the store's back", async () => {
      graphIdCounter += 1;
      const graph = buildSelfHealGraph(
        `edge_claim_self_heal_${graphIdCounter}`,
      );
      const store = await context.createStore(graph);
      const backend = store.backend;

      const alice = await store.nodes.SelfHealPerson.create({ name: "Alice" });
      const bob = await store.nodes.SelfHealPerson.create({ name: "Bob" });
      const carol = await store.nodes.SelfHealPerson.create({ name: "Carol" });

      const incumbent = await store.edges.selfHealReportsTo.create(
        alice,
        bob,
        {},
      );

      // Retire the incumbent through the raw backend, so no store path — and
      // therefore nothing that could release a claim, if such a thing existed —
      // runs. The claim row still names this edge.
      await backend.deleteEdge({
        graphId: graph.id,
        id: incumbent.id,
        kind: "selfHealReportsTo",
      });

      const replacement = await store.edges.selfHealReportsTo.create(
        alice,
        carol,
        {},
      );
      expect(replacement.toId).toBe(carol.id);

      // And the axis is genuinely held by the replacement afterwards: a second
      // live edge from the same source is still refused.
      await expect(
        store.edges.selfHealReportsTo.create(alice, bob, {}),
      ).rejects.toThrow(/[Cc]ardinality/u);
    });

    it("takes over a claim whose holder id was reused by an unrelated edge", async () => {
      graphIdCounter += 1;
      const graph = buildSelfHealGraph(`edge_claim_id_reuse_${graphIdCounter}`);
      const store = await context.createStore(graph);
      const backend = store.backend;

      const alice = await store.nodes.SelfHealPerson.create({ name: "Alice" });
      const bob = await store.nodes.SelfHealPerson.create({ name: "Bob" });
      const carol = await store.nodes.SelfHealPerson.create({ name: "Carol" });

      const incumbent = await store.edges.selfHealReportsTo.create(
        alice,
        bob,
        {},
        { id: "reused-edge-id" },
      );
      expect(incumbent.id).toBe("reused-edge-id");

      // Hard delete past the store, then re-use the id for a LIVE edge of a
      // different kind from a different source. The claim row still names
      // "reused-edge-id", and that id now belongs to something the axis does
      // not describe.
      await backend.hardDeleteEdge({
        graphId: graph.id,
        id: "reused-edge-id",
        kind: "selfHealReportsTo",
      });
      await backend.insertEdge({
        graphId: graph.id,
        id: "reused-edge-id",
        kind: "selfHealKnows",
        fromKind: "SelfHealPerson",
        fromId: carol.id,
        toKind: "SelfHealPerson",
        toId: bob.id,
        props: {},
      });

      const replacement = await store.edges.selfHealReportsTo.create(
        alice,
        carol,
        {},
      );
      expect(replacement.fromId).toBe(alice.id);
    });
  });
}
