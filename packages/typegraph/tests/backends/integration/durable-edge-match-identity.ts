import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  EdgeMatchIdentityConflictError,
} from "../../../src";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ label: z.string(), note: z.string().optional() }),
});

function durableIdentityGraph(
  id: string,
  options: Readonly<{ cardinality?: "one" }> = {},
) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {
      knows: {
        type: knows,
        from: [Person],
        to: [Person],
        ...options,
        matchIdentity: { name: "knows-label", fields: ["label"] },
      },
    },
  });
}

export function registerDurableEdgeMatchIdentityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("durable edge match identity", () => {
    it("arbitrates direct duplicate creates in storage", async () => {
      const store = await context.createStore(
        durableIdentityGraph("durable_identity_direct_conflict"),
      );
      const from = await store.nodes.Person.create(
        { name: "From" },
        { id: "from" },
      );
      const to = await store.nodes.Person.create({ name: "To" }, { id: "to" });
      await store.edges.knows.create(
        from,
        to,
        { label: "same" },
        { id: "first" },
      );

      await expect(
        store.edges.knows.create(
          from,
          to,
          { label: "same", note: "different payload" },
          { id: "second" },
        ),
      ).rejects.toBeInstanceOf(EdgeMatchIdentityConflictError);
      await expect(store.edges.knows.find()).resolves.toHaveLength(1);
    });

    it("refuses a constrained direct create before writing, so a caught refusal leaves no second edge", async () => {
      const store = await context.createStore(
        durableIdentityGraph("durable_identity_cardinality_refusal", {
          cardinality: "one",
        }),
      );
      const source = await store.nodes.Person.create({ name: "Source" });
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });
      const incumbent = await store.edges.knows.create(source, first, {
        label: "first",
      });

      const refusals: unknown[] = [];
      await store.transaction(async (tx) => {
        await tx.edges.knows
          .create(source, second, { label: "second" })
          .catch((error: unknown) => refusals.push(error));
      });

      expect(refusals).toEqual([
        expect.objectContaining({ name: "CardinalityError" }),
      ]);
      const stored = await store.edges.knows.find();
      expect(stored.map((edge) => edge.id)).toEqual([incumbent.id]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("returns the durable incumbent without creating a duplicate", async () => {
      const store = await context.createStore(
        durableIdentityGraph("durable_identity_convergence"),
      );
      const from = await store.nodes.Person.create(
        { name: "From" },
        { id: "from" },
      );
      const to = await store.nodes.Person.create({ name: "To" }, { id: "to" });
      const incumbent = await store.edges.knows.create(
        from,
        to,
        { label: "same" },
        { id: "incumbent" },
      );

      const result = await store.edges.knows.getOrCreateByEndpoints(
        from,
        to,
        { label: "same", note: "ignored in return mode" },
        { matchOn: ["label"], ifExists: "return" },
      );

      expect(result).toMatchObject({
        action: "found",
        edge: { id: incumbent.id, label: "same" },
      });
      await expect(store.edges.knows.find()).resolves.toHaveLength(1);
    });

    it("resurrects the durable tombstone instead of allocating a new id", async () => {
      const store = await context.createStore(
        durableIdentityGraph("durable_identity_tombstone"),
      );
      const from = await store.nodes.Person.create(
        { name: "From" },
        { id: "from" },
      );
      const to = await store.nodes.Person.create({ name: "To" }, { id: "to" });
      const original = await store.edges.knows.create(
        from,
        to,
        { label: "same" },
        { id: "original" },
      );
      await store.edges.knows.delete(original.id);

      const result = await store.edges.knows.getOrCreateByEndpoints(
        from,
        to,
        { label: "same", note: "resurrected" },
        { matchOn: ["label"], ifExists: "return" },
      );

      expect(result).toMatchObject({
        action: "resurrected",
        edge: { id: original.id, label: "same", note: "resurrected" },
      });
    });

    it("reads the exact durable owner including its tombstone", async () => {
      const store = await context.createStore(
        durableIdentityGraph("durable_identity_owner_read"),
      );
      const from = await store.nodes.Person.create({ name: "From" });
      const to = await store.nodes.Person.create({ name: "To" });
      const edge = await store.edges.knows.create(
        from,
        to,
        { label: "owner" },
        { id: "owner" },
      );
      await store.edges.knows.create(
        from,
        to,
        { label: "unrelated" },
        { id: "unrelated" },
      );
      const backend = store.backend;
      expect(backend.findEdgesByMatchIdentity).toBeDefined();
      const storedRows = await backend.findEdgesByKind({
        graphId: store.graphId,
        kind: "knows",
        excludeDeleted: false,
        orderBy: "id",
      });
      const stored = storedRows.find((row) => row.id === edge.id);
      expect(stored?.match_identity_key).toEqual(expect.any(String));
      await store.edges.knows.delete(edge.id);

      const owners = await backend.findEdgesByMatchIdentity?.({
        graphId: store.graphId,
        identities: [
          {
            kind: "knows",
            name: "knows-label",
            key: stored?.match_identity_key ?? "missing",
          },
        ],
      });

      expect(owners).toHaveLength(1);
      expect(owners?.[0]).toMatchObject({ id: edge.id, kind: "knows" });
      expect(owners?.[0]?.deleted_at).toBeDefined();
      await expect(
        backend.findEdgesByMatchIdentity?.({
          graphId: store.graphId,
          identities: [
            {
              kind: "knows",
              name: "wrong-name",
              key: stored?.match_identity_key ?? "missing",
            },
          ],
        }),
      ).resolves.toEqual([]);
      await expect(
        backend.findEdgesByMatchIdentity?.({
          graphId: store.graphId,
          identities: [
            {
              kind: "wrong-kind",
              name: "knows-label",
              key: stored?.match_identity_key ?? "missing",
            },
          ],
        }),
      ).resolves.toEqual([]);
    });
  });
}
